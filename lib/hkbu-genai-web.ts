import { createHash, randomUUID } from "node:crypto";

export const HKBU_WEB_PROVIDER_ID = "hkbu-genai-web";
export const HKBU_WEB_BASE_URL = "https://genai.hkbu.edu.hk/api/v0/general";
export const HKBU_WEB_COMPLETIONS_URL = `${HKBU_WEB_BASE_URL}/chat/completions`;
export const HKBU_WEB_UPLOADS_URL = `${HKBU_WEB_BASE_URL}/chat/uploads`;
export const HKBU_WEB_DEFAULT_PAST_MESSAGES = 20;

const SUPPORTED_IMAGE_MIME_TO_EXT: Record<string, { mimeType: string; ext: string }> = {
	"image/png": { mimeType: "image/png", ext: "png" },
	"image/jpeg": { mimeType: "image/jpeg", ext: "jpg" },
	"image/jpg": { mimeType: "image/jpeg", ext: "jpg" },
	"image/webp": { mimeType: "image/webp", ext: "webp" },
	"image/tiff": { mimeType: "image/tiff", ext: "tiff" },
};

export interface WebPendingImage {
	filename: string;
	mimeType: string;
	bytes: Buffer;
}

export const HKBU_WEB_TOOL_TAG = "pi_tool_call";

export function isHkbuWebModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	return (
		model.provider === HKBU_WEB_PROVIDER_ID ||
		(model.baseUrl ?? "").includes("genai.hkbu.edu.hk/api/v0")
	);
}

export interface JwtTokenInfo {
	validFormat: boolean;
	sub?: string;
	email?: string;
	name?: string;
	type?: string;
	iat?: number;
	exp?: number;
	expiresAtIso?: string;
	expiresInMs?: number;
	isExpired: boolean;
	isExpiringSoon: boolean;
}

/**
 * Locally decode an HKBU GenAI web JWT (NextAuth session token) without verifying signature,
 * so the extension can warn proactively when the ~30-day token is expired or near expiry.
 */
export function inspectHkbuWebToken(token: string | undefined, nowMs = Date.now()): JwtTokenInfo {
	if (!token || typeof token !== "string") {
		return { validFormat: false, isExpired: false, isExpiringSoon: false };
	}
	const trimmed = token.replace(/^Bearer\s+/i, "").trim();
	const parts = trimmed.split(".");
	if (parts.length !== 3) {
		return { validFormat: false, isExpired: false, isExpiringSoon: false };
	}
	try {
		const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
		const exp = typeof payload.exp === "number" ? payload.exp : undefined;
		const iat = typeof payload.iat === "number" ? payload.iat : undefined;
		const expiresInMs = exp !== undefined ? exp * 1000 - nowMs : undefined;
		const isExpired = expiresInMs !== undefined ? expiresInMs <= 0 : false;
		const isExpiringSoon = expiresInMs !== undefined ? expiresInMs > 0 && expiresInMs <= 48 * 3600 * 1000 : false;
		return {
			validFormat: true,
			sub: typeof payload.sub === "string" ? payload.sub : undefined,
			email: typeof payload.email === "string" ? payload.email : undefined,
			name: typeof payload.name === "string" ? payload.name : undefined,
			type: typeof payload.type === "string" ? payload.type : undefined,
			iat,
			exp,
			expiresAtIso: exp !== undefined ? new Date(exp * 1000).toISOString() : undefined,
			expiresInMs,
			isExpired,
			isExpiringSoon,
		};
	} catch {
		return { validFormat: false, isExpired: false, isExpiringSoon: false };
	}
}

export interface PiToolDef {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

function summarizeSchemaProperties(schema: Record<string, unknown> | undefined): string {
	if (!schema || typeof schema !== "object") return "{}";
	const props = schema.properties as Record<string, any> | undefined;
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
	if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
		return "{}";
	}
	const entries = Object.entries(props).map(([key, val]) => {
		const opt = required.has(key) ? "" : "?";
		const typeStr = Array.isArray(val?.type)
			? val.type.join("|")
			: typeof val?.type === "string"
				? val.type
				: val?.enum
					? `enum(${(val.enum as unknown[]).slice(0, 6).join("|")})`
					: "any";
		const desc = typeof val?.description === "string" ? val.description.replace(/\s+/g, " ").trim() : "";
		const shortDesc = desc.length > 90 ? `${desc.slice(0, 87)}...` : desc;
		return shortDesc ? `${key}${opt}: ${typeStr} /* ${shortDesc} */` : `${key}${opt}: ${typeStr}`;
	});
	return `{ ${entries.join(", ")} }`;
}

export function formatToolsForWebInstructions(tools: PiToolDef[] | undefined): string {
	if (!tools || tools.length === 0) return "";
	const lines: string[] = [
		"[Pi Coding Agent Tool Calling Protocol]",
		"You are connected to a local Pi coding-agent host on the user's machine. Even if your base web environment says you cannot access local files or run shell commands, you CAN invoke local tools through the Pi host.",
		"Native function calling is disabled on this endpoint. Instead, invoke tools by emitting one or more XML blocks in your FINAL visible response (NEVER only inside <think>...</think>) using this EXACT format:",
		"",
		`<${HKBU_WEB_TOOL_TAG}>`,
		'{"name": "tool_name", "arguments": {"param": "value"}}',
		`</${HKBU_WEB_TOOL_TAG}>`,
		"",
		"Strict rules:",
		`- Emit <${HKBU_WEB_TOOL_TAG}>...</${HKBU_WEB_TOOL_TAG}> in your FINAL visible message AFTER closing </think>, then STOP generating immediately.`,
		`- Inside <${HKBU_WEB_TOOL_TAG}>...</${HKBU_WEB_TOOL_TAG}> output ONLY a single valid JSON object with keys "name" (string) and "arguments" (object).`,
		"- The local Pi host will parse your final message, execute the tool(s) locally, and return the real output in the next turn inside <pi_tool_result>...</pi_tool_result>.",
		"- Do not wrap tool calls in markdown code fences and do not fabricate tool outputs.",
		"- If no tool is needed, answer directly in plain text without tool tags.",
		"",
		"Available local tools:",
	];
	for (const t of tools) {
		const desc = (t.description ?? "").replace(/\s+/g, " ").trim();
		const shortDesc = desc.length > 180 ? `${desc.slice(0, 177)}...` : desc;
		const sig = summarizeSchemaProperties(t.parameters);
		lines.push(`- ${t.name}(${sig})${shortDesc ? `: ${shortDesc}` : ""}`);
	}
	return lines.join("\n");
}

export function buildWebInstructions(systemPrompt: string | undefined, tools: PiToolDef[] | undefined): string {
	const base = (systemPrompt ?? "").trim();
	const toolSection = formatToolsForWebInstructions(tools);
	if (!base && !toolSection) return "";
	if (!toolSection) return base;
	if (!base) return toolSection;
	return `${base}\n\n${toolSection}`;
}

/**
 * Extract system prompt text, active tool definitions, and non-system conversation messages
 * from a Pi `TranscriptContext` (handling both Pi 1.5+ `role: "system"` messages with
 * `sections` / `toolsAdded` / `toolsRemoved` and legacy `context.systemPrompt` / `context.tools`).
 */
export function extractTranscriptParts(context: any): {
	systemPrompt: string;
	tools: PiToolDef[];
	messages: any[];
} {
	const systemParts: string[] = [];
	const toolMap = new Map<string, PiToolDef>();
	const chatMessages: any[] = [];

	if (typeof context?.systemPrompt === "string" && context.systemPrompt.trim()) {
		systemParts.push(context.systemPrompt.trim());
	}
	if (Array.isArray(context?.tools)) {
		for (const t of context.tools) {
			if (t && typeof t.name === "string" && t.name) {
				toolMap.set(t.name, {
					name: t.name,
					description: typeof t.description === "string" ? t.description : undefined,
					parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : undefined,
				});
			}
		}
	}

	const rawMessages = Array.isArray(context?.messages) ? context.messages : [];
	for (const msg of rawMessages) {
		if (!msg || typeof msg !== "object") continue;
		if (msg.role === "system" || msg.role === "developer") {
			if (typeof msg.content === "string" && msg.content.trim()) {
				systemParts.push(msg.content.trim());
			}
			if (msg.sections && typeof msg.sections === "object") {
				for (const val of Object.values(msg.sections)) {
					if (typeof val === "string" && val.trim()) {
						systemParts.push(val.trim());
					}
				}
			}
			if (Array.isArray(msg.toolsAdded)) {
				for (const t of msg.toolsAdded) {
					if (t && typeof t.name === "string" && t.name) {
						toolMap.set(t.name, {
							name: t.name,
							description: typeof t.description === "string" ? t.description : undefined,
							parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : undefined,
						});
					}
				}
			}
			if (Array.isArray(msg.toolsRemoved)) {
				for (const name of msg.toolsRemoved) {
					if (typeof name === "string") toolMap.delete(name);
				}
			}
			continue;
		}
		chatMessages.push(msg);
	}

	return {
		systemPrompt: systemParts.join("\n\n"),
		tools: Array.from(toolMap.values()),
		messages: chatMessages,
	};
}

export function extractPendingImageFromBlock(block: any, index: number): WebPendingImage | null {
	if (!block || typeof block !== "object" || block.type !== "image") return null;
	let rawMime = typeof block.mimeType === "string" ? block.mimeType : typeof block.source?.media_type === "string" ? block.source.media_type : "";
	let rawData = typeof block.data === "string" ? block.data : typeof block.source?.data === "string" ? block.source.data : "";

	if (!rawData && typeof block.image_url?.url === "string") {
		rawData = block.image_url.url;
	}
	const dataUriMatch = rawData.match(/^data:([^;]+);base64,([\s\S]+)$/i);
	if (dataUriMatch) {
		rawMime = rawMime || dataUriMatch[1];
		rawData = dataUriMatch[2];
	}
	if (!rawData) return null;

	const spec = SUPPORTED_IMAGE_MIME_TO_EXT[rawMime.trim().toLowerCase()];
	if (!spec) return null;

	const bytes = Buffer.from(rawData.replace(/\s+/g, ""), "base64");
	if (bytes.length === 0) return null;

	return {
		filename: `attachment-${index + 1}.${spec.ext}`,
		mimeType: spec.mimeType,
		bytes,
	};
}

function extractMessageContentBlocks(msg: any, collectedImages?: WebPendingImage[]): string {
	if (!msg) return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : String(content);

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.length > 0) parts.push(block.text);
		} else if (block.type === "toolCall") {
			const payload = JSON.stringify({
				name: block.name ?? "tool",
				arguments: block.arguments ?? {},
			});
			parts.push(`<${HKBU_WEB_TOOL_TAG}>\n${payload}\n</${HKBU_WEB_TOOL_TAG}>`);
		} else if (block.type === "image") {
			if (collectedImages) {
				const img = extractPendingImageFromBlock(block, collectedImages.length);
				if (img) {
					collectedImages.push(img);
					parts.push(`[Attached image: ${img.filename}]`);
					continue;
				}
			}
			const mimeLabel = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
			parts.push(`[Image attachment${mimeLabel} omitted — unsupported format or historical turn]`);
		}
	}
	return parts.join("\n");
}

export function serializeSingleMessageForWeb(msg: any, collectedImages?: WebPendingImage[]): string {
	if (!msg || typeof msg !== "object") return "";
	if (msg.role === "toolResult") {
		const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
		const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
		const isError = Boolean(msg.isError);
		const body = extractMessageContentBlocks(msg, collectedImages);
		const attrs = [
			`name="${toolName}"`,
			toolCallId ? `id="${toolCallId}"` : "",
			isError ? 'status="error"' : 'status="ok"',
		]
			.filter(Boolean)
			.join(" ");
		return `<pi_tool_result ${attrs}>\n${body}\n</pi_tool_result>`;
	}
	return extractMessageContentBlocks(msg, collectedImages);
}

/**
 * Serialize a full Pi message list into a single string prompt (used when starting
 * a fresh /api/v0 conversation after model switch, context compaction, or 404).
 * Only collects pending images from the latest trailing turn (after the last assistant
 * message) so earlier screenshots are not redundantly re-uploaded.
 */
export function serializeMessagesToFullPrompt(
	messages: any[],
	maxChars = 120_000,
	collectedImages?: WebPendingImage[],
): string {
	let lastAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant" && messages[i]?.stopReason !== "error") {
			lastAssistantIdx = i;
			break;
		}
	}

	const chunks: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || (msg.role === "assistant" && msg.stopReason === "error")) continue;
		const imgSink = collectedImages && i > lastAssistantIdx ? collectedImages : undefined;
		const body = serializeSingleMessageForWeb(msg, imgSink).trim();
		if (!body) continue;
		if (msg.role === "toolResult") {
			chunks.push(body);
		} else if (msg.role === "assistant") {
			chunks.push(`[Assistant]\n${body}`);
		} else if (msg.role === "user") {
			chunks.push(`[User]\n${body}`);
		} else {
			chunks.push(`[${String(msg.role ?? "Message")}]\n${body}`);
		}
	}

	if (chunks.length === 1 && messages.length === 1 && messages[0]?.role === "user") {
		return chunks[0].replace(/^\[User\]\n/, "");
	}

	let joined = chunks.join("\n\n");
	if (joined.length > maxChars) {
		const head = joined.slice(0, Math.floor(maxChars * 0.2));
		const tail = joined.slice(-Math.floor(maxChars * 0.75));
		joined = `${head}\n\n... [earlier transcript truncated from ${joined.length} chars] ...\n\n${tail}`;
	}
	return joined;
}

export function fingerprintMessages(messages: any[]): string {
	const h = createHash("sha256");
	for (const msg of messages) {
		h.update(String(msg?.role ?? ""));
		h.update("\0");
		h.update(String(msg?.toolCallId ?? ""));
		h.update("\0");
		h.update(extractMessageContentBlocks(msg));
		h.update("\n");
	}
	return h.digest("hex").slice(0, 24);
}

export interface WebSessionState {
	conversationUuid: string | null;
	modelId: string | null;
	syncedMessageCount: number;
	syncedPrefixFingerprint: string | null;
}

export function createWebSessionState(): WebSessionState {
	return {
		conversationUuid: null,
		modelId: null,
		syncedMessageCount: 0,
		syncedPrefixFingerprint: null,
	};
}

export interface WebTurnPlan {
	reusedSession: boolean;
	chatSessionId?: string;
	prompt: string;
	instructions: string;
	pastMessagesCount: number;
	images: WebPendingImage[];
	/** Message count to record as synced once this turn completes. */
	nextSyncedMessageCount: number;
	nextSyncedFingerprint: string;
}

/**
 * Decide whether to reuse the active server-side `chat_session_id` (sending only the new
 * user / toolResult delta) or start a fresh conversation (sending the full transcript).
 *
 * Automatically rotates whenever:
 * - No active `conversationUuid` exists yet,
 * - The user switched models (because /api/v0 locks `model` per `chat_session_id`),
 * - Pi compacted, rewound, or edited earlier messages (prefix fingerprint mismatch).
 */
export function planWebTurn(
	session: WebSessionState,
	modelId: string,
	messages: any[],
	systemPrompt: string | undefined,
	tools: PiToolDef[] | undefined,
	pastMessagesCount = HKBU_WEB_DEFAULT_PAST_MESSAGES,
): WebTurnPlan {
	const instructions = buildWebInstructions(systemPrompt, tools);
	const validMessages = messages.filter((m) => m && !(m.role === "assistant" && m.stopReason === "error"));
	const fullFingerprint = fingerprintMessages(validMessages);

	const canReuse =
		Boolean(session.conversationUuid) &&
		session.modelId === modelId &&
		session.syncedMessageCount > 0 &&
		validMessages.length > session.syncedMessageCount &&
		fingerprintMessages(validMessages.slice(0, session.syncedMessageCount)) === session.syncedPrefixFingerprint;

	if (canReuse && session.conversationUuid) {
		let delta = validMessages.slice(session.syncedMessageCount);
		// The server already persisted its own previous assistant reply in this conversation.
		if (delta.length > 0 && delta[0]?.role === "assistant") {
			delta = delta.slice(1);
		}
		if (delta.length > 0) {
			const images: WebPendingImage[] = [];
			const deltaParts = delta.map((m) => serializeSingleMessageForWeb(m, images).trim()).filter(Boolean);
			const prompt = deltaParts.join("\n\n");
			if (prompt.length > 0 || images.length > 0) {
				return {
					reusedSession: true,
					chatSessionId: session.conversationUuid,
					prompt: prompt || "See attached image(s).",
					instructions,
					pastMessagesCount,
					images,
					nextSyncedMessageCount: validMessages.length,
					nextSyncedFingerprint: fullFingerprint,
				};
			}
		}
	}

	const images: WebPendingImage[] = [];
	const prompt = serializeMessagesToFullPrompt(validMessages, 120_000, images);
	return {
		reusedSession: false,
		prompt: prompt || "Continue.",
		instructions,
		pastMessagesCount,
		images,
		nextSyncedMessageCount: validMessages.length,
		nextSyncedFingerprint: fullFingerprint,
	};
}

export interface WebRequestBody {
	chat_session_id?: string;
	prompt: string;
	instructions?: string;
	model: string;
	useGoogle: boolean;
	pastMessagesCount: number;
	uploadIds: string[];
	stream: boolean;
}

export function buildWebRequestBody(
	plan: WebTurnPlan,
	modelId: string,
	options?: { useGoogle?: boolean; stream?: boolean; uploadIds?: string[] },
): WebRequestBody {
	const body: WebRequestBody = {
		prompt: plan.prompt,
		model: modelId,
		useGoogle: options?.useGoogle ?? false,
		pastMessagesCount: plan.pastMessagesCount,
		uploadIds: options?.uploadIds ?? [],
		stream: options?.stream ?? true,
	};
	if (plan.chatSessionId) {
		body.chat_session_id = plan.chatSessionId;
	}
	if (plan.instructions) {
		body.instructions = plan.instructions;
	}
	return body;
}

/**
 * Upload a single image/file to HKBU GenAI's 2-step `/api/v0/general/chat/uploads` endpoint:
 * 1) `POST /chat/uploads` with `{ filename, mimeType, size }` -> `{ id, uploadToken }`
 * 2) `PUT /chat/uploads/{id}/content` with `multipart/form-data` (`file`) + `x-upload-token`
 * Returns the ready `uploadId` to attach in `uploadIds` alongside an `idempotency-key`.
 */
export async function uploadFileToHkbuWeb(
	file: WebPendingImage,
	token: string,
	options?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; uploadsUrl?: string },
): Promise<string> {
	const doFetch = options?.fetch ?? globalThis.fetch;
	const uploadsUrl = options?.uploadsUrl ?? HKBU_WEB_UPLOADS_URL;
	const authHeader = `Bearer ${token.replace(/^Bearer\s+/i, "").trim()}`;

	const initRes = await doFetch(uploadsUrl, {
		method: "POST",
		headers: {
			Authorization: authHeader,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			filename: file.filename,
			mimeType: file.mimeType,
			size: file.bytes.length,
		}),
		signal: options?.signal,
	});
	if (!initRes.ok) {
		const errText = await initRes.text().catch(() => "");
		throw new Error(`HKBU upload init failed (${initRes.status}): ${errText}`);
	}
	const ticket = (await initRes.json()) as { id?: string; uploadToken?: string };
	if (!ticket.id || !ticket.uploadToken) {
		throw new Error("HKBU upload init response missing id or uploadToken.");
	}

	const form = new FormData();
	form.append("file", new Blob([file.bytes], { type: file.mimeType }), file.filename);

	const putRes = await doFetch(`${uploadsUrl}/${ticket.id}/content`, {
		method: "PUT",
		headers: {
			Authorization: authHeader,
			"x-upload-token": ticket.uploadToken,
			Accept: "application/json",
		},
		body: form,
		signal: options?.signal,
	});
	if (!putRes.ok) {
		const errText = await putRes.text().catch(() => "");
		throw new Error(`HKBU upload content failed (${putRes.status}): ${errText}`);
	}
	const uploaded = (await putRes.json().catch(() => ({}))) as { status?: string; failureCode?: string | null };
	if (uploaded.status === "ready") {
		return ticket.id;
	}
	if (uploaded.status === "failed") {
		throw new Error(`HKBU upload processing failed: ${uploaded.failureCode ?? "unknown"}`);
	}

	// Poll briefly if backend marks upload as asynchronously processing
	for (let attempt = 0; attempt < 8; attempt++) {
		await new Promise((r) => setTimeout(r, 500));
		const statusRes = await doFetch(`${uploadsUrl}/${ticket.id}`, {
			method: "GET",
			headers: { Authorization: authHeader, Accept: "application/json" },
			signal: options?.signal,
		});
		if (!statusRes.ok) continue;
		const statusObj = (await statusRes.json().catch(() => ({}))) as { status?: string; failureCode?: string | null };
		if (statusObj.status === "ready") return ticket.id;
		if (statusObj.status === "failed") {
			throw new Error(`HKBU upload processing failed: ${statusObj.failureCode ?? "unknown"}`);
		}
	}
	return ticket.id;
}

export type ParsedSseEvent =
	| { kind: "ignore" }
	| { kind: "done" }
	| { kind: "tool_status"; toolName?: string; status?: string; conversationUuid?: string }
	| { kind: "duplicate"; runId?: string; conversationUuid?: string }
	| {
			kind: "chunk";
			contentDelta: string;
			reasoningDelta: string;
			finishReason: string | null;
			conversationUuid?: string;
			model?: string;
			usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
	  };

/**
 * Parse a single SSE `data:` line (or raw JSON payload) from `/api/v0/general/chat/completions`.
 */
export function parseWebSseDataLine(rawLine: string): ParsedSseEvent {
	const trimmed = rawLine.trim();
	if (!trimmed) return { kind: "ignore" };
	let payload = trimmed;
	if (payload.startsWith("data:")) {
		payload = payload.slice(5).trim();
	} else if (payload.startsWith(":") || payload.startsWith("event:") || payload.startsWith("id:")) {
		return { kind: "ignore" };
	}
	if (!payload) return { kind: "ignore" };
	if (payload === "[DONE]") return { kind: "done" };

	let obj: any;
	try {
		obj = JSON.parse(payload);
	} catch {
		return { kind: "ignore" };
	}
	if (!obj || typeof obj !== "object") return { kind: "ignore" };

	if (obj.type === "tool_status") {
		return {
			kind: "tool_status",
			toolName: typeof obj.tool?.name === "string" ? obj.tool.name : undefined,
			status: typeof obj.tool?.status === "string" ? obj.tool.status : undefined,
			conversationUuid: typeof obj.conversation_uuid === "string" ? obj.conversation_uuid : undefined,
		};
	}

	if (obj.duplicate === true) {
		return {
			kind: "duplicate",
			runId: typeof obj.run?.id === "string" ? obj.run.id : undefined,
			conversationUuid: typeof obj.run?.conversationId === "string" ? obj.run.conversationId : undefined,
		};
	}

	const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
	const deltaObj = choice?.delta ?? choice?.message ?? {};
	const contentDelta = typeof deltaObj.content === "string" ? deltaObj.content : "";
	const reasoningDelta =
		typeof deltaObj.reasoning_content === "string"
			? deltaObj.reasoning_content
			: typeof deltaObj.reasoning === "string"
				? deltaObj.reasoning
				: "";
	const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
	const usage =
		obj.usage && typeof obj.usage === "object"
			? {
					promptTokens: Number(obj.usage.prompt_tokens ?? 0) || 0,
					completionTokens: Number(obj.usage.completion_tokens ?? 0) || 0,
					totalTokens: Number(obj.usage.total_tokens ?? 0) || 0,
				}
			: undefined;

	return {
		kind: "chunk",
		contentDelta,
		reasoningDelta,
		finishReason,
		conversationUuid: typeof obj.conversation_uuid === "string" ? obj.conversation_uuid : undefined,
		model: typeof obj.model === "string" ? obj.model : undefined,
		usage,
	};
}

export type StreamSegment =
	| { type: "thinking"; delta: string }
	| { type: "text"; delta: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> };

export interface WebContentParserOptions {
	enableToolEmulation?: boolean;
	knownToolNames?: Set<string>;
}

const OPEN_THINK = "<think>";
const CLOSE_THINK = "</think>";
const OPEN_PI_TOOL = `<${HKBU_WEB_TOOL_TAG}>`;
const CLOSE_PI_TOOL = `</${HKBU_WEB_TOOL_TAG}>`;
const OPEN_FALLBACK_TOOL = "<tool_call>";
const CLOSE_FALLBACK_TOOL = "</tool_call>";

function longestTagPrefix(text: string, tags: string[]): number {
	let best = 0;
	for (const tag of tags) {
		const maxCheck = Math.min(text.length, tag.length - 1);
		for (let len = maxCheck; len > best; len--) {
			if (text.endsWith(tag.slice(0, len))) {
				best = len;
				break;
			}
		}
	}
	return best;
}

function tryParseToolCallJson(
	rawInner: string,
	knownToolNames: Set<string> | undefined,
	strictKnownName: boolean,
): { name: string; arguments: Record<string, unknown> } | null {
	let candidate = rawInner.trim();
	// Strip accidental ```json ... ``` wrapper inside tool tag
	if (candidate.startsWith("```")) {
		candidate = candidate.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "").trim();
	}
	if (!candidate.startsWith("{")) return null;
	let parsed: any;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
	if (!name) return null;
	if (strictKnownName && knownToolNames && knownToolNames.size > 0 && !knownToolNames.has(name)) {
		return null;
	}
	let args: Record<string, unknown> = {};
	if (parsed.arguments !== undefined) {
		if (typeof parsed.arguments === "string") {
			try {
				const parsedArgs = JSON.parse(parsed.arguments);
				if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
					args = parsedArgs as Record<string, unknown>;
				} else {
					return null;
				}
			} catch {
				return null;
			}
		} else if (parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)) {
			args = parsed.arguments as Record<string, unknown>;
		} else {
			return null;
		}
	}
	return { name, arguments: args };
}

/**
 * Incremental streaming parser for `/api/v0/general/chat/completions` `delta.content`.
 * Separates inline `<think>...</think>` blocks into thinking deltas and
 * `<pi_tool_call>...</pi_tool_call>` (plus fallback `<tool_call>...</tool_call>` when
 * matching a known tool) into structured Pi tool calls across arbitrary chunk boundaries.
 */
export class WebContentStreamParser {
	private mode: "text" | "thinking" | "tool_call" = "text";
	private activeCloseTag = "";
	private activeOpenTag = "";
	private activeIsFallback = false;
	private buffer = "";
	private toolBuffer = "";
	private readonly enableToolEmulation: boolean;
	private readonly knownToolNames?: Set<string>;

	constructor(options: WebContentParserOptions = {}) {
		this.enableToolEmulation = Boolean(options.enableToolEmulation);
		this.knownToolNames = options.knownToolNames;
	}

	push(chunk: string): StreamSegment[] {
		if (!chunk) return [];
		this.buffer += chunk;
		return this.drain(false);
	}

	flush(): StreamSegment[] {
		return this.drain(true);
	}

	private drain(isFinal: boolean): StreamSegment[] {
		const out: StreamSegment[] = [];

		while (this.buffer.length > 0) {
			if (this.mode === "text") {
				const openTags = this.enableToolEmulation
					? [OPEN_THINK, OPEN_PI_TOOL, OPEN_FALLBACK_TOOL]
					: [OPEN_THINK];

				let earliestIdx = -1;
				let matchedTag = "";
				for (const tag of openTags) {
					const idx = this.buffer.indexOf(tag);
					if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
						earliestIdx = idx;
						matchedTag = tag;
					}
				}

				if (earliestIdx !== -1) {
					if (earliestIdx > 0) {
						out.push({ type: "text", delta: this.buffer.slice(0, earliestIdx) });
					}
					this.buffer = this.buffer.slice(earliestIdx + matchedTag.length);
					if (matchedTag === OPEN_THINK) {
						this.mode = "thinking";
						this.activeCloseTag = CLOSE_THINK;
					} else {
						this.mode = "tool_call";
						this.activeOpenTag = matchedTag;
						this.activeCloseTag = matchedTag === OPEN_PI_TOOL ? CLOSE_PI_TOOL : CLOSE_FALLBACK_TOOL;
						this.activeIsFallback = matchedTag === OPEN_FALLBACK_TOOL;
						this.toolBuffer = "";
					}
					continue;
				}

				if (isFinal) {
					out.push({ type: "text", delta: this.buffer });
					this.buffer = "";
					break;
				}

				const hold = longestTagPrefix(this.buffer, openTags);
				const emitLen = this.buffer.length - hold;
				if (emitLen > 0) {
					out.push({ type: "text", delta: this.buffer.slice(0, emitLen) });
					this.buffer = this.buffer.slice(emitLen);
				}
				break;
			}

			if (this.mode === "thinking") {
				const closeIdx = this.buffer.indexOf(CLOSE_THINK);
				if (closeIdx !== -1) {
					if (closeIdx > 0) {
						out.push({ type: "thinking", delta: this.buffer.slice(0, closeIdx) });
					}
					this.buffer = this.buffer.slice(closeIdx + CLOSE_THINK.length);
					// Trim leading blank newlines right after </think>
					if (this.buffer.startsWith("\n\n")) {
						this.buffer = this.buffer.slice(2);
					} else if (this.buffer.startsWith("\n")) {
						this.buffer = this.buffer.slice(1);
					}
					this.mode = "text";
					continue;
				}

				if (isFinal) {
					out.push({ type: "thinking", delta: this.buffer });
					this.buffer = "";
					break;
				}

				const hold = longestTagPrefix(this.buffer, [CLOSE_THINK]);
				const emitLen = this.buffer.length - hold;
				if (emitLen > 0) {
					out.push({ type: "thinking", delta: this.buffer.slice(0, emitLen) });
					this.buffer = this.buffer.slice(emitLen);
				}
				break;
			}

			if (this.mode === "tool_call") {
				const closeIdx = this.buffer.indexOf(this.activeCloseTag);
				if (closeIdx !== -1) {
					this.toolBuffer += this.buffer.slice(0, closeIdx);
					this.buffer = this.buffer.slice(closeIdx + this.activeCloseTag.length);
					const parsed = tryParseToolCallJson(
						this.toolBuffer,
						this.knownToolNames,
						this.activeIsFallback,
					);
					if (parsed) {
						out.push({
							type: "tool_call",
							id: `call_web_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
							name: parsed.name,
							arguments: parsed.arguments,
						});
					} else {
						// Malformed or non-tool tag: degrade safely to text
						out.push({
							type: "text",
							delta: `${this.activeOpenTag}${this.toolBuffer}${this.activeCloseTag}`,
						});
					}
					this.toolBuffer = "";
					this.mode = "text";
					continue;
				}

				if (isFinal) {
					this.toolBuffer += this.buffer;
					this.buffer = "";
					const parsed = tryParseToolCallJson(
						this.toolBuffer,
						this.knownToolNames,
						this.activeIsFallback,
					);
					if (parsed) {
						out.push({
							type: "tool_call",
							id: `call_web_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
							name: parsed.name,
							arguments: parsed.arguments,
						});
					} else {
						out.push({ type: "text", delta: `${this.activeOpenTag}${this.toolBuffer}` });
					}
					this.toolBuffer = "";
					this.mode = "text";
					break;
				}

				const hold = longestTagPrefix(this.buffer, [this.activeCloseTag]);
				const emitLen = this.buffer.length - hold;
				if (emitLen > 0) {
					this.toolBuffer += this.buffer.slice(0, emitLen);
					this.buffer = this.buffer.slice(emitLen);
				}
				break;
			}
		}

		return out;
	}
}
