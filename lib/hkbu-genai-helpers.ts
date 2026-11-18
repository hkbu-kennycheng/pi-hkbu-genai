import { createHash } from "node:crypto";

export const HKBU_PROVIDER_ID = "hkbu-genai";
export const HKBU_GENAI_BASE_URL = "https://genai.hkbu.edu.hk/api/v1";

export const HKBU_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens" as const,
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresNonNullAssistantContent: false,
	requiresToolsWithToolHistory: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai" as const,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	promptCacheKeyMode: "disabled" as const,
	supportsLongCacheRetention: false,
};

export interface HkbuModelCatalogEntry {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const HKBU_DEFAULT_MODELS: HkbuModelCatalogEntry[] = [
	{
		id: "gpt-6.1-terra",
		name: "GPT-6.1 Terra (HKBU)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-6-luna",
		name: "GPT-6 Luna (HKBU)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol (HKBU)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra (HKBU)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash (HKBU)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview (HKBU)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "grok-4.7",
		name: "Grok 4.7 (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "qwen3.8-max",
		name: "Qwen 3.8 Max (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "qwen3.7-plus",
		name: "Qwen 3.7 Plus (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "kimi-k3",
		name: "Kimi K3 (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2 (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "deepSeek-V4-Pro-hkbu",
		name: "DeepSeek V4 Pro (HKBU)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

const ANSI_ESCAPE_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const WAF_LINE_PATTERNS = [/<script\b/i, /\beval\s*\(/i, /\balert\s*\(/i];

export function isHkbuEndpointModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	return model.provider === HKBU_PROVIDER_ID || (model.baseUrl ?? "").includes("genai.hkbu.edu.hk");
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface ToolCallCheckResult {
	blocked: boolean;
	reason?: string;
}

/**
 * Check tool calls locally before execution so patterns known to trigger
 * HKBU Akamai 403 when replayed in `tool_calls[].function.arguments` are caught early.
 */
export function checkToolCallSafety(toolName: string, input: Record<string, unknown> | undefined): ToolCallCheckResult {
	if (!input) return { blocked: false };

	if (toolName === "bash" && typeof input.command === "string") {
		const cmd = input.command;
		if (cmd.includes(";") || cmd.includes("&&") || cmd.includes("||")) {
			return {
				blocked: true,
				reason:
					"Blocked locally before execution: shell chaining operators (semicolon, double-ampersand, or double-pipe) inside bash tool arguments trigger HKBU Akamai 403 when tool history is replayed. Run one simple command per bash call, write a script file first with write, or use built-in read/ls/find/grep tools.",
			};
		}
		if (WAF_LINE_PATTERNS.some((re) => re.test(cmd))) {
			return {
				blocked: true,
				reason:
					"Blocked locally before execution: HTML script tags or JS eval/alert calls inside bash tool arguments trigger HKBU Akamai 403 when tool history is replayed. Write code to a file with write instead of passing it inline in bash arguments.",
			};
		}
	}

	if (toolName === "codemode" && typeof input.code === "string") {
		const code = input.code;
		if (WAF_LINE_PATTERNS.some((re) => re.test(code))) {
			return {
				blocked: true,
				reason:
					"Blocked locally before execution: HTML script tags or eval/alert calls inside codemode arguments trigger HKBU Akamai 403 when tool history is replayed.",
			};
		}
		const bashCmdRegex = /tools\.bash\s*\(\s*\{[\s\S]*?command\s*:\s*(["'`])([\s\S]*?)\1/g;
		for (const match of code.matchAll(bashCmdRegex)) {
			const bashCmd = match[2] ?? "";
			if (bashCmd.includes(";") || bashCmd.includes("&&") || bashCmd.includes("||")) {
				return {
					blocked: true,
					reason:
						"Blocked locally before execution: shell chaining inside tools.bash command triggers HKBU Akamai 403 when tool history is replayed. Use separate tools.bash calls with one simple command each.",
				};
			}
		}
	}

	return { blocked: false };
}

export interface SanitizeOutputOptions {
	maxBytes: number;
	maxLines: number;
	headRatio?: number;
	redactWafTriggers?: boolean;
	spilloverPath?: string;
}

export interface SanitizeOutputResult {
	text: string;
	rawCleanText: string;
	modified: boolean;
	redactedCount: number;
	truncated: boolean;
}

/**
 * Strip ANSI control sequences, optionally redact command-log lines matching
 * confirmed Akamai 403 WP triggers, and truncate oversized output to head+tail.
 */
export function sanitizeToolOutputText(rawText: string, options: SanitizeOutputOptions): SanitizeOutputResult {
	const clean = stripAnsi(rawText);
	let working = clean;
	let redactedCount = 0;

	if (options.redactWafTriggers) {
		const lines = clean.split("\n");
		const filtered: string[] = [];
		let consecutiveOmitted = 0;
		const flushOmitted = () => {
			if (consecutiveOmitted > 0) {
				const where = options.spilloverPath ? `full output saved at ${options.spilloverPath}` : "see local spillover log";
				filtered.push(
					`[... ${consecutiveOmitted} line(s) omitted by HKBU WAF guard (contained HTML script tag or eval call triggering Akamai 403 WP) — ${where}]`,
				);
				consecutiveOmitted = 0;
			}
		};
		for (const line of lines) {
			if (WAF_LINE_PATTERNS.some((re) => re.test(line))) {
				redactedCount++;
				consecutiveOmitted++;
			} else {
				flushOmitted();
				filtered.push(line);
			}
		}
		flushOmitted();
		working = filtered.join("\n");
	}

	const truncatedRes = truncateHeadTail(working, options.maxBytes, options.maxLines, options.headRatio ?? 0.35);
	let finalText = truncatedRes.text;
	if (truncatedRes.truncated || redactedCount > 0) {
		const notes: string[] = [];
		if (truncatedRes.truncated) {
			notes.push(`truncated from ${Buffer.byteLength(working, "utf8")} bytes / ${working.split("\n").length} lines`);
		}
		if (redactedCount > 0) {
			notes.push(`${redactedCount} line(s) omitted by HKBU WAF guard`);
		}
		if (options.spilloverPath) {
			notes.push(`full raw output saved to ${options.spilloverPath} (use read with offset/limit to inspect)`);
		}
		finalText += `\n\n[hkbu-genai output notice: ${notes.join("; ")}]`;
	}

	return {
		text: finalText,
		rawCleanText: clean,
		modified: finalText !== rawText,
		redactedCount,
		truncated: truncatedRes.truncated,
	};
}

function truncateHeadTail(
	text: string,
	maxBytes: number,
	maxLines: number,
	headRatio: number,
): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return { text, truncated: false };
	}

	const headLinesCount = Math.max(1, Math.floor(maxLines * headRatio));
	const tailLinesCount = Math.max(1, maxLines - headLinesCount);

	let selectedLines: string[];
	if (lines.length > maxLines) {
		const omittedLines = lines.length - headLinesCount - tailLinesCount;
		selectedLines = [
			...lines.slice(0, headLinesCount),
			`\n... [${omittedLines} lines omitted] ...\n`,
			...lines.slice(lines.length - tailLinesCount),
		];
	} else {
		selectedLines = lines;
	}

	let candidate = selectedLines.join("\n");
	if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
		return { text: candidate, truncated: true };
	}

	const headBytes = Math.max(256, Math.floor(maxBytes * headRatio));
	const tailBytes = Math.max(256, maxBytes - headBytes - 128);
	const buf = Buffer.from(candidate, "utf8");
	const headStr = buf.subarray(0, headBytes).toString("utf8");
	const tailStr = buf.subarray(Math.max(0, buf.length - tailBytes)).toString("utf8");
	candidate = `${headStr}\n\n... [${buf.length - headBytes - tailBytes} bytes omitted] ...\n\n${tailStr}`;
	return { text: candidate, truncated: true };
}

function isGeminiModelId(modelId: string): boolean {
	return /^gemini/i.test(modelId);
}

function shortToolId(id: string): string {
	const hash = createHash("sha256").update(id).digest("hex").slice(0, 24);
	return `call_${hash}`;
}

function extractToolText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p: any) => (p?.type === "text" ? String(p.text ?? "") : p?.type ? `[${p.type}]` : ""))
			.filter(Boolean)
			.join("\n");
	}
	return content == null ? "" : String(content);
}

/**
 * Normalize an outgoing OpenAI `chat/completions` payload right before it hits the wire
 * to prevent known 400 errors on https://genai.hkbu.edu.hk/api/v1.
 */
export function sanitizeProviderPayload(payload: unknown, fallbackModelId = ""): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const p = structuredClone(payload) as Record<string, any>;

	// 1. Remove fields known to cause incompatibilities across multi-vendor backends
	delete p.prompt_cache_key;
	delete p.prompt_cache_retention;
	delete p.prompt_cache_options;

	// 2. Strip `strict` from function tool schemas (prevents 400 'additionalProperties' required)
	if (Array.isArray(p.tools)) {
		p.tools = p.tools.map((tool: any) => {
			if (tool?.type === "function" && tool.function && typeof tool.function === "object" && "strict" in tool.function) {
				const fn = { ...tool.function };
				delete fn.strict;
				return { ...tool, function: fn };
			}
			return tool;
		});
	}

	// 3. Enforce minimum output token floor so reasoning models don't truncate with empty text
	if (typeof p.max_completion_tokens === "number" && p.max_completion_tokens < 256) {
		p.max_completion_tokens = 256;
	}
	if (typeof p.max_tokens === "number" && p.max_tokens < 256) {
		p.max_tokens = 256;
	}

	if (!Array.isArray(p.messages)) {
		return p;
	}

	const modelId = typeof p.model === "string" && p.model.length > 0 ? p.model : fallbackModelId;
	const isGemini = isGeminiModelId(modelId);

	// 4. Cross-model tool_calls compatibility:
	//    - Non-Gemini models (e.g. gpt-6*) reject tool_call_id > 64 chars (Gemini emits ~600-char call_gctx_v1_... IDs).
	//    - Gemini models reject assistant tool_calls lacking a call_gctx_* thought signature with 400.
	if (isGemini) {
		const convertedMessages: any[] = [];
		const droppedCallIds = new Set<string>();
		for (const msg of p.messages) {
			if (msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
				const hasForeignCall = msg.tool_calls.some((tc: any) => typeof tc?.id !== "string" || !tc.id.startsWith("call_gctx_"));
				if (hasForeignCall) {
					const callSummaries = msg.tool_calls.map((tc: any) => {
						if (typeof tc?.id === "string") droppedCallIds.add(tc.id);
						return `[Previous tool call ${tc?.function?.name ?? "tool"}(${tc?.function?.arguments ?? "{}"})]`;
					});
					const text = [extractToolText(msg.content), ...callSummaries].filter(Boolean).join("\n");
					convertedMessages.push({ role: "assistant", content: text || "(tool calls)" });
					continue;
				}
			}
			if (msg?.role === "tool" && typeof msg.tool_call_id === "string" && droppedCallIds.has(msg.tool_call_id)) {
				const outText = extractToolText(msg.content);
				convertedMessages.push({
					role: "user",
					content: `[Previous tool output]\n${outText}`,
				});
				continue;
			}
			convertedMessages.push(msg);
		}
		p.messages = convertedMessages;
	} else {
		const idMap = new Map<string, string>();
		for (const msg of p.messages) {
			if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					if (typeof tc?.id === "string" && tc.id.length > 64) {
						const mapped = idMap.get(tc.id) ?? shortToolId(tc.id);
						idMap.set(tc.id, mapped);
						tc.id = mapped;
					}
				}
			} else if (msg?.role === "tool" && typeof msg.tool_call_id === "string" && msg.tool_call_id.length > 64) {
				msg.tool_call_id = idMap.get(msg.tool_call_id) ?? shortToolId(msg.tool_call_id);
			}
		}
	}

	// 5. Clean empty user text arrays or empty assistant stubs
	p.messages = p.messages.filter((msg: any) => {
		if (!msg || typeof msg !== "object") return false;
		if (msg.role === "assistant") {
			const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
			const hasContent = extractToolText(msg.content).trim().length > 0;
			if (!hasTools && !hasContent) return false;
		}
		return true;
	});

	return p;
}

export interface CompactionState {
	blockedToolCallIds: Set<string>;
	droppedMessageTimestamps: Set<number>;
	replacedToolResults: Map<string, string>;
}

export interface CompactionOptions {
	keepRecentToolResults?: number;
	olderToolResultMaxChars?: number;
	maxTotalContextChars?: number;
}

function estimateMessageChars(msg: any): number {
	if (!msg) return 0;
	return JSON.stringify(msg).length;
}

/**
 * Keep Pi conversation context bounded across long-running agent tasks and
 * strip preflight-blocked or error-poisoned entries so sessions never get wedged.
 */
export function compactMessagesForBudget(
	messages: any[],
	state: CompactionState,
	options: CompactionOptions = {},
): { messages: any[]; changed: boolean } {
	const keepRecent = options.keepRecentToolResults ?? 4;
	const olderMaxChars = options.olderToolResultMaxChars ?? 1200;
	const maxTotalChars = options.maxTotalContextChars ?? 160_000;

	let changed = false;
	const cleaned: any[] = [];

	for (const msg of messages) {
		if (!msg) continue;

		// Omit assistant messages that ended in error or were marked dropped
		if (msg.role === "assistant" && (msg.stopReason === "error" || state.droppedMessageTimestamps.has(msg.timestamp))) {
			changed = true;
			continue;
		}

		// Clean assistant messages containing preflight-blocked tool calls so Akamai never sees blocked args
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const hasBlockedToolCall = msg.content.some(
				(b: any) => b?.type === "toolCall" && state.blockedToolCallIds.has(b.id),
			);
			if (hasBlockedToolCall) {
				changed = true;
				const keptBlocks = msg.content.map((b: any) => {
					if (b?.type === "toolCall" && state.blockedToolCallIds.has(b.id)) {
						return {
							type: "text",
							text: `[Blocked local ${b.name} tool call before execution to avoid HKBU Akamai 403]`,
						};
					}
					return b;
				});
				cleaned.push({ ...msg, content: keptBlocks });
				continue;
			}
		}

		if (msg.role === "toolResult") {
			if (state.blockedToolCallIds.has(msg.toolCallId)) {
				changed = true;
				const reasonText = extractToolText(msg.content) || "Blocked preflight before execution.";
				cleaned.push({
					role: "user",
					content: [{ type: "text", text: `[Preflight tool notice] ${reasonText}` }],
					timestamp: msg.timestamp ?? Date.now(),
				});
				continue;
			}
			const override = state.replacedToolResults.get(msg.toolCallId);
			if (override !== undefined) {
				changed = true;
				cleaned.push({
					...msg,
					content: [{ type: "text", text: override }],
				});
				continue;
			}
		}

		cleaned.push(msg);
	}

	// Compact older toolResults beyond the most recent `keepRecent`
	const toolResultIndices: number[] = [];
	for (let i = 0; i < cleaned.length; i++) {
		if (cleaned[i]?.role === "toolResult") {
			toolResultIndices.push(i);
		}
	}

	const cutoff = Math.max(0, toolResultIndices.length - keepRecent);
	const result = cleaned.map((m) => m);

	for (let k = 0; k < cutoff; k++) {
		const idx = toolResultIndices[k];
		const tr = result[idx];
		const text = extractToolText(tr.content);
		if (text.length > olderMaxChars) {
			changed = true;
			const head = text.slice(0, Math.floor(olderMaxChars * 0.45));
			const tail = text.slice(-Math.floor(olderMaxChars * 0.35));
			result[idx] = {
				...tr,
				content: [
					{
						type: "text",
						text: `${head}\n\n... [older toolResult compacted from ${text.length} chars for long-running context budget] ...\n\n${tail}`,
					},
				],
			};
		}
	}

	// If still over maxTotalChars, aggressively trim oldest toolResults down to 250 chars
	let totalChars = result.reduce((sum, m) => sum + estimateMessageChars(m), 0);
	if (totalChars > maxTotalChars) {
		for (let k = 0; k < toolResultIndices.length && totalChars > maxTotalChars; k++) {
			const idx = toolResultIndices[k];
			const tr = result[idx];
			const text = extractToolText(tr.content);
			if (text.length > 300) {
				changed = true;
				const before = estimateMessageChars(tr);
				const compactText = `${text.slice(0, 200)}\n... [trimmed ${text.length} chars to stay under context byte budget]`;
				result[idx] = {
					...tr,
					content: [{ type: "text", text: compactText }],
				};
				totalChars -= before - estimateMessageChars(result[idx]);
			}
		}
	}

	return { messages: result, changed };
}

export interface ErrorDiagnosis {
	kind: "akamai_403" | "http_400" | "other";
	summary: string;
	referenceCode?: string;
	deniedReason?: string;
}

export function diagnoseProviderError(errorMessage: string | undefined): ErrorDiagnosis {
	if (!errorMessage) {
		return { kind: "other", summary: "Unknown provider error" };
	}

	if (errorMessage.includes("403") && (errorMessage.includes("Access Denied") || errorMessage.includes("Denied Reason:"))) {
		const reasonMatch = errorMessage.match(/Denied Reason:\s*([^\s<]+)/i);
		const refMatch = errorMessage.match(/Reference Code:\s*([^\s<]+)/i);
		const deniedReason = reasonMatch?.[1];
		const referenceCode = refMatch?.[1];
		return {
			kind: "akamai_403",
			deniedReason,
			referenceCode,
			summary: `Akamai WAF 403 (${deniedReason ? `Reason=${deniedReason}` : "Web Policy"}${referenceCode ? `, Ref=${referenceCode}` : ""}). Likely triggered by an HTML script tag, eval call, or semicolon command chain inside tool arguments/output.`,
		};
	}

	if (errorMessage.includes("400") || errorMessage.includes("invalid_request_error") || errorMessage.includes("content_filter")) {
		return {
			kind: "http_400",
			summary: `HTTP 400 from HKBU backend: ${errorMessage.slice(0, 240)}`,
		};
	}

	return { kind: "other", summary: errorMessage.slice(0, 240) };
}
