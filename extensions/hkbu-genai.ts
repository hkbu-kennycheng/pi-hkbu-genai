import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	openAICompletionsApi,
	type Api,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkToolCallSafety,
	compactMessagesForBudget,
	computeHkbu429RetryDelayMs,
	diagnoseProviderError,
	HKBU_COMPAT,
	HKBU_DEFAULT_MODELS,
	HKBU_GENAI_BASE_URL,
	HKBU_PROVIDER_ID,
	isHkbuEndpointModel,
	isSuspectToolCallArgs,
	isTransientStreamError,
	normalizeTransientStreamErrorMessage,
	parseRateLimitErrorDetails,
	sanitizeProviderPayload,
	sanitizeToolOutputText,
	type CompactionState,
	type HkbuModelCatalogEntry,
} from "../lib/hkbu-genai-helpers.ts";
import {
	buildWebRequestBody,
	createWebSessionState,
	extractTranscriptParts,
	HKBU_WEB_BASE_URL,
	HKBU_WEB_COMPLETIONS_URL,
	HKBU_WEB_PROVIDER_ID,
	inspectHkbuWebToken,
	isHkbuWebModel,
	parseWebSseDataLine,
	planWebTurn,
	uploadFileToHkbuWeb,
	WebContentStreamParser,
	type StreamSegment,
	type WebSessionState,
} from "../lib/hkbu-genai-web.ts";
import { createHkbuWebOAuthProvider } from "../lib/hkbu-genai-web-auth.ts";

const BASH_MAX_BYTES = 6 * 1024;
const BASH_MAX_LINES = 100;
const CODEMODE_MAX_BYTES = 3584;
const CODEMODE_MAX_LINES = 45;
const READ_MAX_BYTES = 3584;
const READ_MAX_LINES = 36;
const OTHER_TOOL_MAX_BYTES = 5 * 1024;
const OTHER_TOOL_MAX_LINES = 90;

function getToolOutputLimits(toolName: string): { maxBytes: number; maxLines: number; redactWafTriggers: boolean } {
	switch (toolName) {
		case "codemode":
			return { maxBytes: CODEMODE_MAX_BYTES, maxLines: CODEMODE_MAX_LINES, redactWafTriggers: true };
		case "bash":
			return { maxBytes: BASH_MAX_BYTES, maxLines: BASH_MAX_LINES, redactWafTriggers: true };
		case "read":
			return { maxBytes: READ_MAX_BYTES, maxLines: READ_MAX_LINES, redactWafTriggers: false };
		default:
			return {
				maxBytes: OTHER_TOOL_MAX_BYTES,
				maxLines: OTHER_TOOL_MAX_LINES,
				redactWafTriggers: toolName.startsWith("mcp__"),
			};
	}
}

const MAX_429_RETRY_WAIT_MS = 20_000;
const MAX_TRANSIENT_STREAM_RETRIES = 2;
const modelRequestQueues = new Map<string, Promise<void>>();

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function makeAbortErrorEvent(model: Model<Api>, errorMessage: string, aborted: boolean) {
	return {
		type: "error" as const,
		reason: (aborted ? "aborted" : "error") as "aborted" | "error",
		error: {
			role: "assistant" as const,
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: (aborted ? "aborted" : "error") as "aborted" | "error",
			errorMessage,
			timestamp: Date.now(),
		},
	};
}

/**
 * Wraps OpenAI completions streaming for HKBU GenAI so:
 * 1) In-process requests to the same model run sequentially (reducing in-flight quota collisions
 *    such as `gpt-6-astra`'s account-wide `MODEL_DAILY_QUOTA_IN_FLIGHT` `limit: 3`), and
 * 2) HTTP 429 responses wait for `Retry-After` / `retryAfterSeconds` once before failing when
 *    Pi's inner `provider-retry` (`maxRetries: undefined`) would otherwise fail immediately into
 *    Pi's 2s/4s/8s outer backoff loop.
 */
function hkbuStreamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	const outStream = createAssistantMessageEventStream();
	const queueKey = model.id || "__default__";
	const prevLock = modelRequestQueues.get(queueKey) ?? Promise.resolve();
	let releaseLock!: () => void;
	const currentLock = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	const tailLock = prevLock.then(
		() => currentLock,
		() => currentLock,
	);
	modelRequestQueues.set(queueKey, tailLock);

	(async () => {
		let emittedError = false;
		try {
			await prevLock;
			if (options?.signal?.aborted) {
				emittedError = true;
				outStream.push(makeAbortErrorEvent(model, "Request aborted", true));
				return;
			}

			const baseFetch = options?.fetch ?? globalThis.fetch;
			const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
				const signal = init?.signal ?? options?.signal;
				const retryRequest = typeof input === "string" || input instanceof URL ? undefined : input.clone();
				const res = await baseFetch(input, init);
				if (res.status !== 429 || signal?.aborted) {
					return res;
				}

				const bodyText = await res
					.clone()
					.text()
					.catch(() => "");
				const details = parseRateLimitErrorDetails(bodyText, res.headers.get("retry-after"));
				const waitMs = computeHkbu429RetryDelayMs(details, 1, MAX_429_RETRY_WAIT_MS);
				if (waitMs === null) {
					return res;
				}

				try {
					await sleepWithAbort(waitMs, signal);
				} catch {
					return res;
				}
				if (signal?.aborted) {
					return res;
				}

				return retryRequest ? baseFetch(retryRequest, init) : baseFetch(input, init);
			};

			for (let attempt = 0; attempt <= MAX_TRANSIENT_STREAM_RETRIES; attempt++) {
				let pendingStart: any;
				let hasStreamedContent = false;
				let retryWaitMs: number | undefined;

				try {
					const innerStream = openAICompletionsApi().streamSimple(
						model as Model<"openai-completions">,
						context,
						{
							...options,
							fetch: wrappedFetch,
						},
					);

					for await (const event of innerStream) {
						if (event.type === "start") {
							if (!hasStreamedContent) {
								pendingStart = event;
								continue;
							}
						}

						if (event.type === "error") {
							const errMsg = event.error?.errorMessage ?? "";
							if (
								!hasStreamedContent &&
								attempt < MAX_TRANSIENT_STREAM_RETRIES &&
								!options?.signal?.aborted &&
								event.reason !== "aborted" &&
								isTransientStreamError(errMsg)
							) {
								retryWaitMs = 1_500 * (attempt + 1);
								break;
							}

							const hadRealContent = hasStreamedContent;
							if (pendingStart) {
								outStream.push(pendingStart);
								pendingStart = undefined;
								hasStreamedContent = true;
							}
							emittedError = true;
							if (hadRealContent && isTransientStreamError(errMsg) && event.error) {
								outStream.push({
									...event,
									error: {
										...event.error,
										errorMessage: normalizeTransientStreamErrorMessage(errMsg),
									},
								});
							} else {
								outStream.push(event);
							}
							return;
						}

						if (pendingStart) {
							outStream.push(pendingStart);
							pendingStart = undefined;
							hasStreamedContent = true;
						}
						if (event.type !== "start") {
							hasStreamedContent = true;
						}
						outStream.push(event);
						if (event.type === "done") {
							return;
						}
					}

					if (retryWaitMs !== undefined) {
						await sleepWithAbort(retryWaitMs, options?.signal);
						continue;
					}

					if (!hasStreamedContent && attempt < MAX_TRANSIENT_STREAM_RETRIES && !options?.signal?.aborted) {
						await sleepWithAbort(1_500 * (attempt + 1), options?.signal);
						continue;
					}

					emittedError = true;
					outStream.push(
						makeAbortErrorEvent(
							model,
							hasStreamedContent
								? "Provider stream ended before completion (stream ended without completion)."
								: "Provider stream ended before completion.",
							Boolean(options?.signal?.aborted),
						),
					);
					return;
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					if (
						!hasStreamedContent &&
						attempt < MAX_TRANSIENT_STREAM_RETRIES &&
						!options?.signal?.aborted &&
						isTransientStreamError(errMsg)
					) {
						await sleepWithAbort(1_500 * (attempt + 1), options?.signal);
						continue;
					}
					throw err;
				}
			}
		} catch (err) {
			if (!emittedError) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				outStream.push(makeAbortErrorEvent(model, errorMessage, Boolean(options?.signal?.aborted)));
			}
		} finally {
			outStream.end();
			releaseLock();
			if (modelRequestQueues.get(queueKey) === tailLock) {
				modelRequestQueues.delete(queueKey);
			}
		}
	})();

	return outStream;
}

/**
 * Custom streamSimple adapter for HKBU GenAI's web-chat endpoint
 * (`POST https://genai.hkbu.edu.hk/api/v0/general/chat/completions`),
 * supporting hybrid `chat_session_id` reuse, inline `<think>` parsing,
 * and prompt-emulated tool calling for Pi's coding tools.
 */
function createHkbuWebStreamSimple(webSession: WebSessionState) {
	return function hkbuWebStreamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) {
		const outStream = createAssistantMessageEventStream();
		const queueKey = `web:${model.id || "__default__"}`;
		const prevLock = modelRequestQueues.get(queueKey) ?? Promise.resolve();
		let releaseLock!: () => void;
		const currentLock = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const tailLock = prevLock.then(
			() => currentLock,
			() => currentLock,
		);
		modelRequestQueues.set(queueKey, tailLock);

		(async () => {
			let emittedError = false;
			try {
				await prevLock;
				if (options?.signal?.aborted) {
					emittedError = true;
					outStream.push(makeAbortErrorEvent(model, "Request aborted", true));
					return;
				}

				const rawToken = (options as any)?.apiKey || process.env.HKBU_GENAI_WEB_TOKEN || "";
				const token = String(rawToken).replace(/^Bearer\s+/i, "").trim();
				if (!token) {
					emittedError = true;
					outStream.push(
						makeAbortErrorEvent(
							model,
							"Missing HKBU_GENAI_WEB_TOKEN for hkbu-genai-web provider. Export your HKBU GenAI web Bearer JWT in HKBU_GENAI_WEB_TOKEN.",
							false,
						),
					);
					return;
				}

				const tokenInfo = inspectHkbuWebToken(token);
				if (tokenInfo.validFormat && tokenInfo.isExpired) {
					emittedError = true;
					outStream.push(
						makeAbortErrorEvent(
							model,
							`HKBU_GENAI_WEB_TOKEN expired at ${tokenInfo.expiresAtIso}. Sign in to https://genai.hkbu.edu.hk and update HKBU_GENAI_WEB_TOKEN.`,
							false,
						),
					);
					return;
				}

				const baseFetch = options?.fetch ?? globalThis.fetch;
				const { systemPrompt, tools, messages: chatMessages } = extractTranscriptParts(context);
				const enableToolEmulation = tools.length > 0;
				const knownToolNames = new Set(tools.map((t) => t.name));
				const useGoogle = /^(1|true|yes)$/i.test(process.env.HKBU_GENAI_WEB_USE_GOOGLE ?? "");

				let forceFreshSession = false;

				for (let attempt = 0; attempt <= MAX_TRANSIENT_STREAM_RETRIES; attempt++) {
					if (forceFreshSession) {
						webSession.conversationUuid = null;
						webSession.modelId = null;
						webSession.syncedMessageCount = 0;
						webSession.syncedPrefixFingerprint = null;
						forceFreshSession = false;
					}

					const plan = planWebTurn(
						webSession,
						model.id,
						chatMessages,
						systemPrompt,
						tools,
					);
					const uploadIds =
						plan.images.length > 0
							? await Promise.all(
									plan.images.map((img) =>
										uploadFileToHkbuWeb(img, token, {
											fetch: baseFetch,
											signal: options?.signal,
										}),
									),
								)
							: [];
					const body = buildWebRequestBody(plan, model.id, { useGoogle, stream: true, uploadIds });
					if (process.env.HKBU_GENAI_WEB_DEBUG) {
						process.stderr.write(
							`[hkbu-genai-web debug] tools=${tools.length} reused=${plan.reusedSession} uploads=${uploadIds.length} instLen=${body.instructions?.length ?? 0} promptLen=${body.prompt.length}\n`,
						);
					}

					const doFetch = async () =>
						baseFetch(HKBU_WEB_COMPLETIONS_URL, {
							method: "POST",
							headers: {
								Accept: "text/event-stream, application/json",
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
								"idempotency-key": randomUUID(),
							},
							body: JSON.stringify(body),
							signal: options?.signal,
						});

					let res = await doFetch();

					// Handle 404 Conversation not found on reused session by rotating cleanly once
					if (res.status === 404 && plan.reusedSession && attempt < MAX_TRANSIENT_STREAM_RETRIES) {
						const errBody = await res.text().catch(() => "");
						if (/conversation not found/i.test(errBody)) {
							forceFreshSession = true;
							continue;
						}
						emittedError = true;
						outStream.push(makeAbortErrorEvent(model, `API error (404): ${errBody}`, false));
						return;
					}

					// Handle HTTP 429 once using Retry-After / retryAfterSeconds
					if (res.status === 429 && !options?.signal?.aborted) {
						const bodyText = await res.clone().text().catch(() => "");
						const details = parseRateLimitErrorDetails(bodyText, res.headers.get("retry-after"));
						const waitMs = computeHkbu429RetryDelayMs(details, 1, MAX_429_RETRY_WAIT_MS);
						if (waitMs !== null) {
							await sleepWithAbort(waitMs, options?.signal);
							res = await doFetch();
						}
					}

					if (!res.ok) {
						const errBody = await res.text().catch(() => "");
						const errMsg = `API error (${res.status}): ${errBody}`;
						if (
							attempt < MAX_TRANSIENT_STREAM_RETRIES &&
							!options?.signal?.aborted &&
							isTransientStreamError(errMsg)
						) {
							await sleepWithAbort(1_500 * (attempt + 1), options?.signal);
							continue;
						}
						emittedError = true;
						outStream.push(makeAbortErrorEvent(model, errMsg, false));
						return;
					}

					const output: any = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};

					let started = false;
					let activeBlockType: "text" | "thinking" | null = null;
					let activeBlockIndex = -1;
					let hasToolCalls = false;
					let sawFinish = false;
					let finishReason: string | null = null;
					let returnedConversationUuid: string | undefined;

					const ensureStarted = () => {
						if (!started) {
							started = true;
							outStream.push({ type: "start", partial: output });
						}
					};

					const closeActiveBlock = () => {
						if (activeBlockType === "text" && activeBlockIndex >= 0) {
							const blk = output.content[activeBlockIndex];
							outStream.push({
								type: "text_end",
								contentIndex: activeBlockIndex,
								content: blk?.text ?? "",
								partial: output,
							});
						} else if (activeBlockType === "thinking" && activeBlockIndex >= 0) {
							const blk = output.content[activeBlockIndex];
							outStream.push({
								type: "thinking_end",
								contentIndex: activeBlockIndex,
								content: blk?.thinking ?? "",
								partial: output,
							});
						}
						activeBlockType = null;
						activeBlockIndex = -1;
					};

					const emitSegments = (segments: StreamSegment[]) => {
						for (const seg of segments) {
							ensureStarted();
							if (seg.type === "thinking") {
								if (activeBlockType !== "thinking") {
									closeActiveBlock();
									activeBlockIndex = output.content.length;
									output.content.push({ type: "thinking", thinking: "" });
									activeBlockType = "thinking";
									outStream.push({
										type: "thinking_start",
										contentIndex: activeBlockIndex,
										partial: output,
									});
								}
								output.content[activeBlockIndex].thinking += seg.delta;
								outStream.push({
									type: "thinking_delta",
									contentIndex: activeBlockIndex,
									delta: seg.delta,
									partial: output,
								});
							} else if (seg.type === "text") {
								if (activeBlockType !== "text") {
									closeActiveBlock();
									activeBlockIndex = output.content.length;
									output.content.push({ type: "text", text: "" });
									activeBlockType = "text";
									outStream.push({
										type: "text_start",
										contentIndex: activeBlockIndex,
										partial: output,
									});
								}
								output.content[activeBlockIndex].text += seg.delta;
								outStream.push({
									type: "text_delta",
									contentIndex: activeBlockIndex,
									delta: seg.delta,
									partial: output,
								});
							} else if (seg.type === "tool_call") {
								closeActiveBlock();
								hasToolCalls = true;
								const idx = output.content.length;
								const toolCall = {
									type: "toolCall" as const,
									id: seg.id,
									name: seg.name,
									arguments: seg.arguments,
								};
								output.content.push(toolCall);
								outStream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
								outStream.push({
									type: "toolcall_delta",
									contentIndex: idx,
									delta: JSON.stringify(seg.arguments),
									partial: output,
								});
								outStream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
							}
						}
					};

					const parser = new WebContentStreamParser({ enableToolEmulation, knownToolNames });
					const contentType = res.headers.get("content-type") ?? "";

					const processEventLine = (line: string) => {
						const parsed = parseWebSseDataLine(line);
						if (parsed.kind === "ignore") return;
						if (parsed.kind === "tool_status") {
							if (parsed.conversationUuid) returnedConversationUuid = parsed.conversationUuid;
							return;
						}
						if (parsed.kind === "done") {
							sawFinish = true;
							return;
						}
						if (parsed.kind === "duplicate") {
							throw new Error("Duplicate idempotency-key response from HKBU GenAI web backend.");
						}
						if (parsed.conversationUuid) returnedConversationUuid = parsed.conversationUuid;
						if (parsed.usage) {
							output.usage.input = parsed.usage.promptTokens;
							output.usage.output = parsed.usage.completionTokens;
							output.usage.totalTokens = parsed.usage.totalTokens;
						}
						if (parsed.reasoningDelta) {
							emitSegments([{ type: "thinking", delta: parsed.reasoningDelta }]);
						}
						if (parsed.contentDelta) {
							emitSegments(parser.push(parsed.contentDelta));
						}
						if (parsed.finishReason) {
							finishReason = parsed.finishReason;
							sawFinish = true;
						}
					};

					if (contentType.includes("application/json")) {
						const rawJson = await res.text();
						processEventLine(rawJson);
						sawFinish = true;
					} else if (res.body) {
						const reader = res.body.getReader();
						const decoder = new TextDecoder();
						let lineBuf = "";
						while (true) {
							const { value, done } = await reader.read();
							if (done) break;
							lineBuf += decoder.decode(value, { stream: true });
							let nlIdx: number;
							while ((nlIdx = lineBuf.indexOf("\n")) !== -1) {
								const line = lineBuf.slice(0, nlIdx);
								lineBuf = lineBuf.slice(nlIdx + 1);
								processEventLine(line);
							}
						}
						lineBuf += decoder.decode();
						if (lineBuf.trim()) {
							processEventLine(lineBuf);
						}
					}

					emitSegments(parser.flush());
					closeActiveBlock();

					if (!started && !sawFinish) {
						if (attempt < MAX_TRANSIENT_STREAM_RETRIES && !options?.signal?.aborted) {
							await sleepWithAbort(1_500 * (attempt + 1), options?.signal);
							continue;
						}
						emittedError = true;
						outStream.push(
							makeAbortErrorEvent(
								model,
								"Provider stream ended before completion.",
								Boolean(options?.signal?.aborted),
							),
						);
						return;
					}

					ensureStarted();
					const finalReason: "stop" | "length" | "toolUse" = hasToolCalls
						? "toolUse"
						: finishReason === "length"
							? "length"
							: "stop";
					output.stopReason = finalReason;

					if (returnedConversationUuid) {
						webSession.conversationUuid = returnedConversationUuid;
						webSession.modelId = model.id;
						webSession.syncedMessageCount = plan.nextSyncedMessageCount;
						webSession.syncedPrefixFingerprint = plan.nextSyncedFingerprint;
					}

					outStream.push({ type: "done", reason: finalReason, message: output });
					return;
				}
			} catch (err) {
				if (!emittedError) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					outStream.push(makeAbortErrorEvent(model, errorMessage, Boolean(options?.signal?.aborted)));
				}
			} finally {
				outStream.end();
				releaseLock();
				if (modelRequestQueues.get(queueKey) === tailLock) {
					modelRequestQueues.delete(queueKey);
				}
			}
		})();

		return outStream;
	};
}

export default function hkbuGenAiExtension(pi: ExtensionAPI) {
	const logDir = join(tmpdir(), "pi-hkbu-genai", String(process.pid));
	let spilloverCounter = 0;

	const state: CompactionState = {
		blockedToolCallIds: new Set<string>(),
		droppedMessageTimestamps: new Set<number>(),
		replacedToolResults: new Map<string, string>(),
		compactedToolCallIds: new Set<string>(),
	};
	const webSession: WebSessionState = createWebSessionState();

	const stats = {
		preflightBlocks: 0,
		redactedOutputs: 0,
		truncatedOutputs: 0,
		recoveredErrors: 0,
		lastDiagnosis: "" as string,
	};

	const saveSpillover = (toolName: string, content: string): string => {
		mkdirSync(logDir, { recursive: true });
		const filePath = join(logDir, `${++spilloverCounter}-${toolName}.log`);
		writeFileSync(filePath, content, "utf8");
		return filePath;
	};

	const envApiKey = process.env.HKBU_GENAI_API_KEY
		? "$HKBU_GENAI_API_KEY"
		: process.env.OPENAI_API_KEY
			? "$OPENAI_API_KEY"
			: undefined;

	const envWebToken = process.env.HKBU_GENAI_WEB_TOKEN ? "$HKBU_GENAI_WEB_TOKEN" : undefined;

	const toModelDef = (entry: HkbuModelCatalogEntry) => ({
		...entry,
		compat: HKBU_COMPAT,
	});

	pi.registerProvider(HKBU_PROVIDER_ID, {
		name: "HKBU GenAI (Akamai/OpenAI Safe)",
		baseUrl: HKBU_GENAI_BASE_URL,
		...(envApiKey ? { apiKey: envApiKey } : {}),
		authHeader: true,
		api: "openai-completions",
		streamSimple: hkbuStreamSimple,
		models: HKBU_DEFAULT_MODELS.map(toModelDef),
		async refreshModels({ signal, credential }: { signal: AbortSignal; credential?: { key?: string } }) {
			const token =
				credential?.key || process.env.HKBU_GENAI_API_KEY || process.env.OPENAI_API_KEY || "";
			if (!token) {
				return HKBU_DEFAULT_MODELS.map(toModelDef);
			}
			try {
				const res = await fetch(`${HKBU_GENAI_BASE_URL}/models`, {
					headers: { Authorization: `Bearer ${token}` },
					signal,
				});
				if (!res.ok) {
					return HKBU_DEFAULT_MODELS.map(toModelDef);
				}
				const json = (await res.json()) as { data?: Array<{ id: string }> };
				const byId = new Map(HKBU_DEFAULT_MODELS.map((m) => [m.id, m]));
				const chatModels = (json.data ?? [])
					.filter((m) => m.id && !m.id.startsWith("text-embedding-"))
					.map((m) => {
						const known = byId.get(m.id);
						if (known) return toModelDef(known);
						return toModelDef({
							id: m.id,
							name: `${m.id} (HKBU)`,
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						});
					});
				return chatModels.length > 0 ? chatModels : HKBU_DEFAULT_MODELS.map(toModelDef);
			} catch {
				return HKBU_DEFAULT_MODELS.map(toModelDef);
			}
		},
	});

	pi.registerProvider(HKBU_WEB_PROVIDER_ID, {
		name: "HKBU GenAI Web (/api/v0, Tool-Emulated)",
		baseUrl: HKBU_WEB_BASE_URL,
		...(envWebToken ? { apiKey: envWebToken } : {}),
		authHeader: true,
		api: "openai-completions",
		oauth: createHkbuWebOAuthProvider(),
		streamSimple: createHkbuWebStreamSimple(webSession),
		models: HKBU_DEFAULT_MODELS.map((entry) =>
			toModelDef({
				...entry,
				name: entry.name.replace("(HKBU)", "(HKBU Web)"),
			}),
		),
	});

	const notifyUser = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "warning") => {
		if (ctx.hasUI) {
			ctx.ui.notify(msg, level);
		}
	};

	pi.on("session_start", () => {
		state.blockedToolCallIds.clear();
		state.droppedMessageTimestamps.clear();
		state.replacedToolResults.clear();
		state.compactedToolCallIds?.clear();
		webSession.conversationUuid = null;
		webSession.modelId = null;
		webSession.syncedMessageCount = 0;
		webSession.syncedPrefixFingerprint = null;
	});

	// 1. Prompt hygiene so the agent avoids Akamai-triggering patterns naturally
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[HKBU GenAI Gateway Rules]
- Prefer calling structured tools (read, ls, find, grep, edit, write) and direct MCP tools directly rather than wrapping tools.read or verbose JSON.stringify dumps inside codemode.
- When using read on docs or code files, read small targeted ranges (offset/limit of ~30 lines) rather than loading long files at once.
- When using bash, run ONE simple command per call (no shell chaining operators like semicolon, double-ampersand, or double-pipe in bash arguments). If multiple steps are needed, make separate bash tool calls or write a script file with write and execute it.
- Never embed HTML script tags, eval calls, or alert calls inside bash or codemode arguments.
- Keep command and codemode outputs concise (< 3.5 KB) instead of dumping raw file contents or full accessibility trees.`,
		};
	});

	// 2. Preflight guard on bash / codemode tool calls before execution
	pi.on("tool_call", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		const check = checkToolCallSafety(event.toolName, event.input as Record<string, unknown>);
		if (!check.blocked) return undefined;

		stats.preflightBlocks++;
		state.blockedToolCallIds.add(event.toolCallId);
		notifyUser(ctx, `[hkbu-genai] ${check.reason}`, "warning");
		return {
			block: true,
			reason: check.reason,
		};
	});

	// 3. Bound long tool/MCP outputs & redact lines matching Akamai 403 WP signatures
	pi.on("tool_result", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;

		const textBlocks = event.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
		if (textBlocks.length === 0) return undefined;

		const combined = textBlocks.map((b) => b.text).join("\n");
		const { maxBytes, maxLines, redactWafTriggers } = getToolOutputLimits(event.toolName);

		// Pre-check if output needs spillover saving before constructing notice
		const probe = sanitizeToolOutputText(combined, {
			maxBytes,
			maxLines,
			redactWafTriggers,
		});

		if (!probe.modified) return undefined;

		const safeToolLabel = event.toolName.replace(/[^a-zA-Z0-9_-]+/g, "_");
		const spilloverPath = saveSpillover(safeToolLabel, probe.rawCleanText);
		const finalRes = sanitizeToolOutputText(combined, {
			maxBytes,
			maxLines,
			redactWafTriggers,
			spilloverPath,
		});

		if (finalRes.redactedCount > 0) stats.redactedOutputs++;
		if (finalRes.truncated) stats.truncatedOutputs++;

		const nonTextBlocks = event.content.filter((b) => b.type !== "text");
		return {
			content: [{ type: "text", text: finalRes.text }, ...nonTextBlocks],
		};
	});

	// 4. Keep context within budget & strip blocked/poisoned entries before LLM calls
	pi.on("context", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		const res = compactMessagesForBudget(event.messages, state);
		return res.changed ? { messages: res.messages } : undefined;
	});

	// 5. Ensure no unsupported Content-Encoding headers are sent
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return;
		event.headers["content-encoding"] = null;
	});

	// 6. Normalize outgoing chat/completions payloads to prevent 400 errors
	pi.on("before_provider_request", (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		return sanitizeProviderPayload(event.payload, ctx.model?.id ?? "");
	});

	// 7. Diagnose 403 / 400 / 429 / stream failures and unbrick context for subsequent turns
	pi.on("turn_end", async (event, ctx) => {
		const isV1 = isHkbuEndpointModel(ctx.model);
		const isWeb = isHkbuWebModel(ctx.model);
		if (!isV1 && !isWeb) return undefined;
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; timestamp?: number };
		if (msg?.role !== "assistant" || msg.stopReason !== "error") return undefined;

		if (isWeb) {
			const webDiag = diagnoseProviderError(msg.errorMessage);
			stats.recoveredErrors++;
			stats.lastDiagnosis = webDiag.summary;
			notifyUser(ctx, `[hkbu-genai-web] ${webDiag.summary}`, "warning");
			if (event.messageEntryId) {
				return {
					entries: [
						...event.entries,
						{ type: "context_edit" as const, targetId: event.messageEntryId, replacement: null },
					],
				};
			}
			return undefined;
		}

		const diagnosis = diagnoseProviderError(msg.errorMessage);
		if (diagnosis.kind === "other") return undefined;

		if (diagnosis.kind === "rate_limit_429" || diagnosis.kind === "stream_error") {
			stats.recoveredErrors++;
			stats.lastDiagnosis = diagnosis.summary;
			notifyUser(ctx, `[hkbu-genai] ${diagnosis.summary}`, "warning");
			if (typeof msg.timestamp === "number") {
				state.droppedMessageTimestamps.add(msg.timestamp);
			}
			if (event.messageEntryId) {
				return {
					entries: [
						...event.entries,
						{ type: "context_edit" as const, targetId: event.messageEntryId, replacement: null },
					],
				};
			}
			return undefined;
		}

		stats.recoveredErrors++;
		stats.lastDiagnosis = diagnosis.summary;
		notifyUser(ctx, `[hkbu-genai] ${diagnosis.summary}`, "error");

		if (typeof msg.timestamp === "number") {
			state.droppedMessageTimestamps.add(msg.timestamp);
		}

		const edits: Array<
			| { type: "context_edit"; targetId: string; replacement: { content: string } | null }
			| { type: "custom_message"; customType: string; content: string; display: boolean }
		> = [];
		if (event.messageEntryId) {
			edits.push({ type: "context_edit", targetId: event.messageEntryId, replacement: null });
		}

		// Walk back through the active projected entries (ignoring already-omitted entries)
		// to find any toolResult(s) + paired assistant toolCall turn right before this error.
		const activeEntries = (event.context?.contextEntries ?? []).filter(
			(pe) => pe.messages.length > 0 && pe.sourceEntry?.id !== event.messageEntryId,
		);
		const targetToolEntryIds: string[] = [];
		let pairedAssistantEntryId: string | undefined;
		let pairedAssistantTimestamp: number | undefined;

		for (let i = activeEntries.length - 1; i >= 0; i--) {
			const pe = activeEntries[i];
			const entryId = pe.sourceEntry?.id;
			const entryMsg: any = pe.messages[0];
			if (entryMsg?.role === "toolResult") {
				if (entryId) targetToolEntryIds.push(entryId);
				if (typeof entryMsg.toolCallId === "string") {
					state.blockedToolCallIds.add(entryMsg.toolCallId);
				}
				continue;
			}
			if (entryMsg?.role === "assistant") {
				if (targetToolEntryIds.length > 0 && Array.isArray(entryMsg.content)) {
					pairedAssistantEntryId = entryId;
					pairedAssistantTimestamp = entryMsg.timestamp;
					for (const block of entryMsg.content) {
						if (block?.type === "toolCall" && typeof block.id === "string") {
							state.blockedToolCallIds.add(block.id);
						}
					}
				}
				break;
			}
			if (entryMsg?.role === "user") {
				break;
			}
		}

		if (pairedAssistantEntryId && targetToolEntryIds.length > 0) {
			if (typeof pairedAssistantTimestamp === "number") {
				state.droppedMessageTimestamps.add(pairedAssistantTimestamp);
			}
			edits.push({ type: "context_edit", targetId: pairedAssistantEntryId, replacement: null });
			for (const tid of targetToolEntryIds) {
				edits.push({ type: "context_edit", targetId: tid, replacement: null });
			}
		}

		// Also compact any older active large toolResult entries and flag suspect historical
		// toolCall arguments (e.g. write/edit HTML/JS or large scripts replayed before `continue`).
		const droppedToolIds = new Set(targetToolEntryIds);
		let compactedHistorical = false;
		for (let i = activeEntries.length - 1; i >= 0; i--) {
			const pe = activeEntries[i];
			const entryId = pe.sourceEntry?.id;
			const entryMsg: any = pe.messages[0];
			if (entryMsg?.role === "assistant" && Array.isArray(entryMsg.content)) {
				if (entryId && entryId === pairedAssistantEntryId) continue;
				for (const block of entryMsg.content) {
					if (
						block?.type === "toolCall" &&
						typeof block.id === "string" &&
						!state.compactedToolCallIds?.has(block.id) &&
						isSuspectToolCallArgs(block.name ?? "", block.arguments)
					) {
						state.compactedToolCallIds?.add(block.id);
						compactedHistorical = true;
					}
				}
				continue;
			}
			if (entryMsg?.role !== "toolResult") continue;
			if (entryId && droppedToolIds.has(entryId)) continue;
			const textLen = (entryMsg.content ?? [])
				.filter((b: any) => b?.type === "text")
				.reduce((acc: number, b: any) => acc + String(b.text ?? "").length, 0);
			if (textLen > 400) {
				const trId = entryMsg.toolCallId as string | undefined;
				const replacement = `[Tool result (${entryMsg.toolName ?? "tool"}, ${textLen} chars) compacted after ${diagnosis.summary}. Re-read smaller targeted ranges if needed.]`;
				if (trId && state.replacedToolResults.get(trId) !== replacement) {
					state.replacedToolResults.set(trId, replacement);
					compactedHistorical = true;
				}
				if (entryId) {
					edits.push({ type: "context_edit", targetId: entryId, replacement: { content: replacement } });
				}
			}
		}

		if ((pairedAssistantEntryId && targetToolEntryIds.length > 0) || compactedHistorical) {
			edits.push({
				type: "custom_message",
				customType: "hkbu-genai-recovery",
				content: `[hkbu-genai recovery] Cleaned triggering tool history and compacted large historical tool payloads after ${diagnosis.summary}. Local logs remain saved under ${logDir}. Continue using single commands, smaller read ranges (<=30 lines), or write/edit tools.`,
				display: true,
			});
		}

		if (edits.length > 0) {
			return {
				entries: [...event.entries, ...edits],
			};
		}
		return undefined;
	});

	pi.registerCommand("hkbu-status", {
		description: "Show HKBU GenAI gateway compatibility and guard statistics",
		handler: async (_args, ctx) => {
			if (isHkbuWebModel(ctx.model)) {
				const tokenInfo = inspectHkbuWebToken(process.env.HKBU_GENAI_WEB_TOKEN);
				const tokenSummary = tokenInfo.validFormat
					? tokenInfo.isExpired
						? `EXPIRED(${tokenInfo.expiresAtIso})`
						: `validUntil=${tokenInfo.expiresAtIso}`
					: process.env.HKBU_GENAI_WEB_TOKEN
						? "set(non-JWT)"
						: "unset";
				notifyUser(
					ctx,
					`hkbu-genai-web status | model=${ctx.model?.provider}/${ctx.model?.id} | session=${webSession.conversationUuid ?? "new"} | syncedMsgs=${webSession.syncedMessageCount} | token=${tokenSummary} | recoveredErrors=${stats.recoveredErrors}${stats.lastDiagnosis ? ` | lastError=${stats.lastDiagnosis}` : ""}`,
					"info",
				);
				return;
			}
			notifyUser(
				ctx,
				`hkbu-genai status | model=${ctx.model?.provider}/${ctx.model?.id} | preflightBlocks=${stats.preflightBlocks} | redactedOutputs=${stats.redactedOutputs} | truncatedOutputs=${stats.truncatedOutputs} | recoveredErrors=${stats.recoveredErrors} | logs=${logDir}${stats.lastDiagnosis ? ` | lastError=${stats.lastDiagnosis}` : ""}`,
				"info",
			);
		},
	});
}
