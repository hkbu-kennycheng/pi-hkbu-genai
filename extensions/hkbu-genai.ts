import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkToolCallSafety,
	compactMessagesForBudget,
	diagnoseProviderError,
	HKBU_COMPAT,
	HKBU_DEFAULT_MODELS,
	HKBU_GENAI_BASE_URL,
	HKBU_PROVIDER_ID,
	isHkbuEndpointModel,
	sanitizeProviderPayload,
	sanitizeToolOutputText,
	type CompactionState,
	type HkbuModelCatalogEntry,
} from "../lib/hkbu-genai-helpers.ts";

const BASH_MAX_BYTES = 12 * 1024;
const BASH_MAX_LINES = 180;
const READ_MAX_BYTES = 6 * 1024;
const READ_MAX_LINES = 80;

export default function hkbuGenAiExtension(pi: ExtensionAPI) {
	const logDir = join(tmpdir(), "pi-hkbu-genai", String(process.pid));
	let spilloverCounter = 0;

	const state: CompactionState = {
		blockedToolCallIds: new Set<string>(),
		droppedMessageTimestamps: new Set<number>(),
		replacedToolResults: new Map<string, string>(),
	};

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

	const notifyUser = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "warning") => {
		if (ctx.hasUI) {
			ctx.ui.notify(msg, level);
		}
	};

	pi.on("session_start", () => {
		state.blockedToolCallIds.clear();
		state.droppedMessageTimestamps.clear();
		state.replacedToolResults.clear();
	});

	// 1. Prompt hygiene so the agent avoids Akamai-triggering patterns naturally
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[HKBU GenAI Gateway Rules]
- Prefer structured built-in tools (read, ls, find, grep, edit, write) over bash or codemode for file inspection and edits.
- When using read on docs or code files, read small targeted ranges (offset/limit of ~80 lines) rather than loading long files at once.
- When using bash, run ONE simple command per call (no shell chaining operators like semicolon, double-ampersand, or double-pipe in bash arguments). If multiple steps are needed, make separate bash tool calls or write a script file with write and execute it.
- Never embed HTML script tags, eval calls, or alert calls inside bash tool command arguments.
- Keep command outputs concise instead of dumping massive unfiltered logs.`,
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

	// 3. Bound long command outputs & redact lines matching Akamai 403 WP signatures
	pi.on("tool_result", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		if (!["bash", "codemode", "read"].includes(event.toolName)) return undefined;

		const textBlocks = event.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
		if (textBlocks.length === 0) return undefined;

		const combined = textBlocks.map((b) => b.text).join("\n");
		const isCommand = event.toolName === "bash" || event.toolName === "codemode";
		const maxBytes = isCommand ? BASH_MAX_BYTES : READ_MAX_BYTES;
		const maxLines = isCommand ? BASH_MAX_LINES : READ_MAX_LINES;

		// Pre-check if output needs spillover saving before constructing notice
		const probe = sanitizeToolOutputText(combined, {
			maxBytes,
			maxLines,
			redactWafTriggers: isCommand,
		});

		if (!probe.modified) return undefined;

		const spilloverPath = saveSpillover(event.toolName, probe.rawCleanText);
		const finalRes = sanitizeToolOutputText(combined, {
			maxBytes,
			maxLines,
			redactWafTriggers: isCommand,
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

	// 7. Diagnose 403 / 400 failures and unbrick context for subsequent turns
	pi.on("turn_end", async (event, ctx) => {
		if (!isHkbuEndpointModel(ctx.model)) return undefined;
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; timestamp?: number };
		if (msg?.role !== "assistant" || msg.stopReason !== "error") return undefined;

		const diagnosis = diagnoseProviderError(msg.errorMessage);
		if (diagnosis.kind === "other") return undefined;

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

		// Also compact any older active large toolResult entries (e.g. an earlier `read`
		// of a long reference doc whose cumulative WAF anomaly score triggered 403 once earlier
		// messages were compacted into Akamai's inspection buffer).
		const droppedToolIds = new Set(targetToolEntryIds);
		for (let i = activeEntries.length - 1; i >= 0; i--) {
			const pe = activeEntries[i];
			const entryId = pe.sourceEntry?.id;
			const entryMsg: any = pe.messages[0];
			if (entryMsg?.role !== "toolResult") continue;
			if (entryId && droppedToolIds.has(entryId)) continue;
			const textLen = (entryMsg.content ?? [])
				.filter((b: any) => b?.type === "text")
				.reduce((acc: number, b: any) => acc + String(b.text ?? "").length, 0);
			if (textLen > 400) {
				const trId = entryMsg.toolCallId as string | undefined;
				const replacement = `[Tool result (${entryMsg.toolName ?? "tool"}, ${textLen} chars) compacted after ${diagnosis.summary}. Re-read smaller targeted ranges if needed.]`;
				if (trId) {
					state.replacedToolResults.set(trId, replacement);
				}
				if (entryId) {
					edits.push({ type: "context_edit", targetId: entryId, replacement: { content: replacement } });
				}
			}
		}

		if (pairedAssistantEntryId && targetToolEntryIds.length > 0) {
			edits.push({
				type: "custom_message",
				customType: "hkbu-genai-recovery",
				content: `[hkbu-genai recovery] Removed the preceding tool turn and compacted large historical tool outputs after ${diagnosis.summary}. Local logs remain saved under ${logDir}. Continue using single commands, smaller read ranges (<=80 lines), or structured tools.`,
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
			notifyUser(
				ctx,
				`hkbu-genai status | model=${ctx.model?.provider}/${ctx.model?.id} | preflightBlocks=${stats.preflightBlocks} | redactedOutputs=${stats.redactedOutputs} | truncatedOutputs=${stats.truncatedOutputs} | recoveredErrors=${stats.recoveredErrors} | logs=${logDir}${stats.lastDiagnosis ? ` | lastError=${stats.lastDiagnosis}` : ""}`,
				"info",
			);
		},
	});
}
