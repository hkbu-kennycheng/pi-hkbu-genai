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
const HTML_OR_WAF_ARGS_RE = /<script\b|<style\b|<!doctype\b|<html\b|@import\b|\beval\s*\(|\balert\s*\(/i;
const HEREDOC_RE = /<<\s*['"]?[A-Z_a-z0-9-]+['"]?/;
const MAX_REPLAYED_FILE_TOOL_ARG_CHARS = 350;

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
		if (HTML_OR_WAF_ARGS_RE.test(cmd) || (HEREDOC_RE.test(cmd) && cmd.length > 250)) {
			return {
				blocked: true,
				reason:
					"Blocked locally before execution: HTML/CSS/script tags, JS eval/alert calls, or large heredocs inside bash tool arguments trigger HKBU Akamai 403 when tool history is replayed. Use the write tool instead.",
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
			notes.push(`truncated from ${Buffer.byteLength(working, "utf8")}B / ${working.split("\n").length}L`);
		}
		if (redactedCount > 0) {
			notes.push(`${redactedCount} WAF lines omitted`);
		}
		if (options.spilloverPath) {
			notes.push(`full log at ${options.spilloverPath}`);
		}
		finalText += `\n\n[hkbu-genai ${notes.join(", ")}]`;
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

function parseToolArgs(rawArgs: unknown): { obj: Record<string, any> | null; serialized: string } {
	if (typeof rawArgs === "string") {
		try {
			const parsed = JSON.parse(rawArgs);
			return { obj: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null, serialized: rawArgs };
		} catch {
			return { obj: null, serialized: rawArgs };
		}
	}
	if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
		return { obj: rawArgs as Record<string, any>, serialized: JSON.stringify(rawArgs) };
	}
	return { obj: null, serialized: rawArgs == null ? "" : String(rawArgs) };
}

export function isSuspectToolCallArgs(toolName: string, rawArgs: unknown): boolean {
	const { serialized } = parseToolArgs(rawArgs);
	return serialized.length > MAX_REPLAYED_FILE_TOOL_ARG_CHARS || HTML_OR_WAF_ARGS_RE.test(serialized);
}

/**
 * Compact completed file-mutation (`write`/`edit`) tool call arguments — or explicitly flagged
 * tool calls after a 403/400 — when replaying conversation history so large code/HTML/script
 * bodies already written to disk do not re-trigger HKBU Akamai 403 in `tool_calls[].function.arguments`.
 */
export function compactToolCallArgsIfNeeded(
	toolName: string,
	rawArgs: unknown,
	forceCompact = false,
): { compacted: boolean; compactedArgs: Record<string, unknown> } {
	const { obj, serialized } = parseToolArgs(rawArgs);
	const isFileTool = toolName === "write" || toolName === "edit";
	const suspect = serialized.length > MAX_REPLAYED_FILE_TOOL_ARG_CHARS || HTML_OR_WAF_ARGS_RE.test(serialized);

	if (!forceCompact && !(isFileTool && suspect)) {
		return { compacted: false, compactedArgs: obj ?? {} };
	}

	if (toolName === "write") {
		const filePath = typeof obj?.path === "string" ? obj.path : "";
		const contentLen = typeof obj?.content === "string" ? obj.content.length : serialized.length;
		return {
			compacted: true,
			compactedArgs: {
				path: filePath,
				content: `[${contentLen} chars written to ${filePath || "file"}; full contents stored on disk]`,
			},
		};
	}

	if (toolName === "edit") {
		const filePath = typeof obj?.path === "string" ? obj.path : "";
		let editChars = 0;
		if (Array.isArray(obj?.edits)) {
			for (const e of obj.edits) {
				if (e && typeof e === "object") {
					editChars += String(e.oldText ?? "").length + String(e.newText ?? "").length;
				}
			}
			return {
				compacted: true,
				compactedArgs: {
					path: filePath,
					edits: [
						{
							oldText: "[omitted]",
							newText: `[${editChars || serialized.length} chars edited in ${filePath || "file"}; full file stored on disk]`,
						},
					],
				},
			};
		}
		editChars = String(obj?.oldText ?? "").length + String(obj?.newText ?? "").length || serialized.length;
		return {
			compacted: true,
			compactedArgs: {
				path: filePath,
				oldText: "[omitted]",
				newText: `[${editChars} chars edited in ${filePath || "file"}; full file stored on disk]`,
			},
		};
	}

	if (!forceCompact) {
		return { compacted: false, compactedArgs: obj ?? {} };
	}

	if (toolName === "bash") {
		return {
			compacted: true,
			compactedArgs: { command: `[${serialized.length} chars omitted after gateway 403/400]` },
		};
	}
	if (toolName === "codemode") {
		return {
			compacted: true,
			compactedArgs: { code: `// [${serialized.length} chars omitted after gateway 403/400]` },
		};
	}
	return {
		compacted: true,
		compactedArgs: { _compacted: `[${serialized.length} chars omitted after gateway 403/400]` },
	};
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

	// Compact completed write/edit tool_calls arguments on replay so HTML/JS payloads on disk
	// do not trigger Akamai WAF 403 when re-sent in conversation history or folded for Gemini.
	const completedToolIds = new Set<string>();
	for (const msg of p.messages) {
		if (msg?.role === "tool" && typeof msg.tool_call_id === "string") {
			completedToolIds.add(msg.tool_call_id);
		}
	}
	for (const msg of p.messages) {
		if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
			for (const tc of msg.tool_calls) {
				if (typeof tc?.id === "string" && completedToolIds.has(tc.id) && tc.function) {
					const res = compactToolCallArgsIfNeeded(tc.function.name ?? "", tc.function.arguments, false);
					if (res.compacted) {
						tc.function.arguments = JSON.stringify(res.compactedArgs);
					}
				}
			}
		}
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

	// 5. Clean empty user text arrays, empty assistant stubs, and orphaned tool messages
	const activeToolCallIds = new Set<string>();
	p.messages = p.messages.filter((msg: any) => {
		if (!msg || typeof msg !== "object") return false;
		if (msg.role === "assistant") {
			const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
			const hasContent = extractToolText(msg.content).trim().length > 0;
			if (!hasTools && !hasContent) return false;
			if (hasTools) {
				for (const tc of msg.tool_calls) {
					if (typeof tc?.id === "string") activeToolCallIds.add(tc.id);
				}
			}
		} else if (msg.role === "tool") {
			if (typeof msg.tool_call_id !== "string" || !activeToolCallIds.has(msg.tool_call_id)) {
				return false;
			}
		}
		return true;
	});

	return p;
}

export interface CompactionState {
	blockedToolCallIds: Set<string>;
	droppedMessageTimestamps: Set<number>;
	replacedToolResults: Map<string, string>;
	compactedToolCallIds?: Set<string>;
}

export interface CompactionOptions {
	keepRecentToolResults?: number;
	olderToolResultMaxChars?: number;
	recentToolResultBudgetChars?: number;
	maxTotalContextChars?: number;
}

function estimateMessageChars(msg: any): number {
	if (!msg) return 0;
	return JSON.stringify(msg).length;
}

function buildCompactedToolResult(tr: any, text: string, maxChars: number, reasonNote: string) {
	const head = text.slice(0, Math.floor(maxChars * 0.45));
	const tail = text.slice(-Math.floor(maxChars * 0.35));
	return {
		...tr,
		content: [
			{
				type: "text",
				text: `${head}\n\n... [${reasonNote}: compacted from ${text.length} chars] ...\n\n${tail}`,
			},
		],
	};
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
	const keepRecent = options.keepRecentToolResults ?? 2;
	const olderMaxChars = options.olderToolResultMaxChars ?? 600;
	const recentBudgetChars = options.recentToolResultBudgetChars ?? 6500;
	const maxTotalChars = options.maxTotalContextChars ?? 160_000;

	let changed = false;
	const cleaned: any[] = [];
	const completedToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
			completedToolCallIds.add(msg.toolCallId);
		}
	}

	for (const msg of messages) {
		if (!msg) continue;

		// Omit assistant messages that ended in error or were marked dropped
		if (msg.role === "assistant" && (msg.stopReason === "error" || state.droppedMessageTimestamps.has(msg.timestamp))) {
			changed = true;
			continue;
		}

		// Clean assistant messages containing preflight-blocked tool calls or large/HTML write/edit args
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			let msgModified = false;
			const keptBlocks = msg.content.map((b: any) => {
				if (b?.type === "toolCall") {
					if (state.blockedToolCallIds.has(b.id)) {
						msgModified = true;
						return {
							type: "text",
							text: `[Blocked local ${b.name} tool call before execution to avoid HKBU Akamai 403]`,
						};
					}
					const forced = Boolean(state.compactedToolCallIds?.has(b.id));
					if (completedToolCallIds.has(b.id) || forced) {
						const res = compactToolCallArgsIfNeeded(b.name ?? "", b.arguments, forced);
						if (res.compacted) {
							msgModified = true;
							return { ...b, arguments: res.compactedArgs };
						}
					}
				}
				return b;
			});
			if (msgModified) {
				changed = true;
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

	// Drop orphaned toolResult messages whose paired assistant toolCall was omitted or removed
	const validToolCallIds = new Set<string>();
	const pairedCleaned: any[] = [];
	for (const msg of cleaned) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b?.type === "toolCall" && typeof b.id === "string") {
					validToolCallIds.add(b.id);
				}
			}
			pairedCleaned.push(msg);
		} else if (msg.role === "toolResult") {
			if (!validToolCallIds.has(msg.toolCallId)) {
				changed = true;
				continue;
			}
			pairedCleaned.push(msg);
		} else {
			pairedCleaned.push(msg);
		}
	}

	// Compact older toolResults beyond the most recent `keepRecent`
	const toolResultIndices: number[] = [];
	for (let i = 0; i < pairedCleaned.length; i++) {
		if (pairedCleaned[i]?.role === "toolResult") {
			toolResultIndices.push(i);
		}
	}

	const cutoff = Math.max(0, toolResultIndices.length - keepRecent);
	const result = pairedCleaned.map((m) => m);

	for (let k = 0; k < cutoff; k++) {
		const idx = toolResultIndices[k];
		const tr = result[idx];
		const text = extractToolText(tr.content);
		if (text.length > olderMaxChars) {
			changed = true;
			result[idx] = buildCompactedToolResult(tr, text, olderMaxChars, "older toolResult");
		}
	}

	// Keep the latest toolResult verbatim; compact any earlier kept-window toolResult if
	// their combined size would exceed recentBudgetChars (prevents cumulative WAF 403s).
	if (toolResultIndices.length > 0 && recentBudgetChars > 0) {
		const newestIdx = toolResultIndices[toolResultIndices.length - 1];
		let runningRecentChars = extractToolText(result[newestIdx].content).length;
		for (let k = toolResultIndices.length - 2; k >= cutoff; k--) {
			const idx = toolResultIndices[k];
			const tr = result[idx];
			const text = extractToolText(tr.content);
			if (text.length > olderMaxChars && runningRecentChars + text.length > recentBudgetChars) {
				changed = true;
				result[idx] = buildCompactedToolResult(tr, text, olderMaxChars, "recent toolResult budget");
				runningRecentChars += extractToolText(result[idx].content).length;
			} else {
				runningRecentChars += text.length;
			}
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

export interface RateLimitDetails {
	code?: string;
	message?: string;
	model?: string;
	limit?: number;
	used?: number;
	reserved?: number;
	remaining?: number;
	retryAfterSeconds?: number;
	resetAt?: string;
}

export interface ErrorDiagnosis {
	kind: "akamai_403" | "http_400" | "rate_limit_429" | "other";
	summary: string;
	referenceCode?: string;
	deniedReason?: string;
	rateLimit?: RateLimitDetails;
}

export function parseRateLimitErrorDetails(
	rawText: string | undefined,
	retryAfterHeader?: string | null,
): RateLimitDetails | undefined {
	let obj: Record<string, any> | undefined;
	if (rawText) {
		const jsonStart = rawText.indexOf("{");
		if (jsonStart !== -1) {
			const slice = rawText.slice(jsonStart);
			for (let end = slice.lastIndexOf("}"); end > 0; end = slice.lastIndexOf("}", end - 1)) {
				try {
					const parsed = JSON.parse(slice.slice(0, end + 1));
					if (parsed && typeof parsed === "object") {
						obj = parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
						break;
					}
				} catch {
					// Continue narrowing in case trailing text (e.g. `(stopReason=error...)`) contains braces
				}
			}
		}
	}

	const headerSec = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : Number.NaN;
	const retryAfterSeconds =
		typeof obj?.retryAfterSeconds === "number"
			? obj.retryAfterSeconds
			: Number.isFinite(headerSec)
				? headerSec
				: undefined;

	if (!obj && retryAfterSeconds === undefined) return undefined;

	const details: RateLimitDetails = {
		code: typeof obj?.code === "string" ? obj.code : undefined,
		message: typeof obj?.message === "string" ? obj.message : undefined,
		model: typeof obj?.model === "string" ? obj.model : undefined,
		limit: typeof obj?.limit === "number" ? obj.limit : undefined,
		used: typeof obj?.used === "number" ? obj.used : undefined,
		reserved: typeof obj?.reserved === "number" ? obj.reserved : undefined,
		remaining: typeof obj?.remaining === "number" ? obj.remaining : undefined,
		retryAfterSeconds,
		resetAt: typeof obj?.resetAt === "string" ? obj.resetAt : undefined,
	};
	return details;
}

export function isHardQuotaExhausted(details: RateLimitDetails | undefined): boolean {
	if (!details) return false;
	return (
		details.limit !== undefined &&
		details.remaining === 0 &&
		(details.reserved ?? 0) === 0 &&
		(details.used ?? 0) >= details.limit
	);
}

/**
 * Compute how long (ms) to wait after an HKBU GenAI 429 response before one retry attempt.
 * Honors `retryAfterSeconds` / `Retry-After` (+500 ms clock margin) instead of Pi's short 2s/4s/8s backoff,
 * and skips sleeping if daily quota is hard-exhausted (`reserved === 0` and `used >= limit`).
 */
export function computeHkbu429RetryDelayMs(
	details: RateLimitDetails | undefined,
	attempt: number,
	maxWaitMs = 20_000,
): number | null {
	if (attempt !== 1 || isHardQuotaExhausted(details)) return null;
	const sec = details?.retryAfterSeconds;
	const rawMs = sec !== undefined && Number.isFinite(sec) && sec > 0 ? Math.ceil(sec * 1000) + 500 : 5_000;
	return Math.min(maxWaitMs, Math.max(1_000, rawMs));
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

	if (
		/(?<![a-z0-9])429(?![a-z0-9])/.test(errorMessage) ||
		errorMessage.includes("rate_limit_error") ||
		errorMessage.includes("MODEL_DAILY_QUOTA")
	) {
		const rateLimit = parseRateLimitErrorDetails(errorMessage);
		const statsParts: string[] = [];
		if (rateLimit?.code) statsParts.push(rateLimit.code);
		if (rateLimit?.used !== undefined && rateLimit?.limit !== undefined) {
			statsParts.push(`used=${rateLimit.used}/${rateLimit.limit}`);
		}
		if (rateLimit?.reserved !== undefined) statsParts.push(`reserved=${rateLimit.reserved}`);
		if (rateLimit?.remaining !== undefined) statsParts.push(`remaining=${rateLimit.remaining}`);
		if (rateLimit?.retryAfterSeconds !== undefined) statsParts.push(`retryAfter=${rateLimit.retryAfterSeconds}s`);
		if (rateLimit?.resetAt) statsParts.push(`resetAt=${rateLimit.resetAt}`);
		const modelLabel = rateLimit?.model ? ` on ${rateLimit.model}` : "";
		const detailSuffix = statsParts.length > 0 ? ` (${statsParts.join(", ")})` : "";
		const advice = isHardQuotaExhausted(rateLimit)
			? "Daily prompt quota exhausted; switch to gpt-6.1-terra, gpt-6.1-sol, or gpt-6-luna."
			: "In-flight/rate quota slots are saturated on this model; wait for server reservations to clear or switch to gpt-6.1-terra, gpt-6.1-sol, or gpt-6-luna.";
		return {
			kind: "rate_limit_429",
			rateLimit,
			summary: `HKBU GenAI 429 rate/quota limit${modelLabel}${detailSuffix}. ${advice}`,
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
