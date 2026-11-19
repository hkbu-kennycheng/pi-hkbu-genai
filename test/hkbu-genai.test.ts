import assert from "node:assert/strict";
import test from "node:test";
import {
	checkToolCallSafety,
	compactMessagesForBudget,
	computeHkbu429RetryDelayMs,
	diagnoseProviderError,
	isHardQuotaExhausted,
	isHkbuEndpointModel,
	parseRateLimitErrorDetails,
	sanitizeProviderPayload,
	sanitizeToolOutputText,
	stripAnsi,
	type CompactionState,
} from "../lib/hkbu-genai-helpers.ts";

test("isHkbuEndpointModel detects provider id and baseUrl", () => {
	assert.equal(isHkbuEndpointModel({ provider: "hkbu-genai", baseUrl: "https://example.com" }), true);
	assert.equal(isHkbuEndpointModel({ provider: "custom", baseUrl: "https://genai.hkbu.edu.hk/api/v1" }), true);
	assert.equal(isHkbuEndpointModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" }), false);
	assert.equal(isHkbuEndpointModel(undefined), false);
});

test("checkToolCallSafety blocks bash semicolon/chaining, script tag, eval, and alert", () => {
	assert.equal(checkToolCallSafety("bash", { command: "pwd; ls -la" }).blocked, true);
	assert.equal(checkToolCallSafety("bash", { command: "pwd && ls -la" }).blocked, true);
	assert.equal(checkToolCallSafety("bash", { command: "ls missing || echo fallback" }).blocked, true);
	assert.equal(checkToolCallSafety("bash", { command: "echo '<script>alert(1)</script>'" }).blocked, true);
	assert.equal(checkToolCallSafety("bash", { command: "node -e 'eval(\"1+1\")'" }).blocked, true);
	assert.equal(checkToolCallSafety("bash", { command: "ls -la" }).blocked, false);
	assert.equal(checkToolCallSafety("bash", { command: "python3 run_check.py" }).blocked, false);
	assert.equal(checkToolCallSafety("codemode", { code: 'const x = 1; return x;' }).blocked, false);
	assert.equal(
		checkToolCallSafety("codemode", { code: 'await tools.bash({ command: "pwd; ls" });' }).blocked,
		true,
	);
	assert.equal(
		checkToolCallSafety("codemode", { code: 'await tools.bash({ command: "pwd && ls" });' }).blocked,
		true,
	);
	assert.equal(checkToolCallSafety("codemode", { code: 'eval("2+2")' }).blocked, true);
});

test("sanitizeToolOutputText strips ANSI, redacts WAF lines, and truncates long logs", () => {
	const lines = [
		"\u001b[32mPASS\u001b[0m line 1",
		'const bad = eval("1+1");',
		'<script src="app.js"></script>',
		...Array.from({ length: 250 }, (_, i) => `log line ${i + 1}`),
		"FINAL_MARKER_OK",
	];
	const res = sanitizeToolOutputText(lines.join("\n"), {
		maxBytes: 4096,
		maxLines: 60,
		redactWafTriggers: true,
		spilloverPath: "/tmp/test.log",
	});
	assert.equal(res.modified, true);
	assert.equal(res.redactedCount, 2);
	assert.equal(res.truncated, true);
	assert.equal(res.text.includes("\u001b"), false);
	assert.equal(res.text.includes("<script"), false);
	assert.equal(res.text.includes("eval("), false);
	assert.equal(res.text.includes("FINAL_MARKER_OK"), true);
	assert.equal(res.text.includes("/tmp/test.log"), true);
	assert.equal(stripAnsi("\u001b[31mERR\u001b[0m\r\n"), "ERR\n");
});

test("sanitizeProviderPayload fixes strict, token floor, cache fields, and cross-model tool IDs", () => {
	const longGeminiId = `call_gctx_v1_${"a".repeat(580)}`;
	const payload = {
		model: "gpt-6.1-terra",
		prompt_cache_key: "abc",
		prompt_cache_retention: "24h",
		max_completion_tokens: 16,
		tools: [
			{
				type: "function",
				function: { name: "read", strict: true, parameters: { type: "object", properties: {} } },
			},
		],
		messages: [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: longGeminiId, type: "function", function: { name: "read", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: longGeminiId, content: "ok" },
			{ role: "assistant", content: "" },
		],
	};

	const sanitized = sanitizeProviderPayload(payload) as any;
	assert.equal("prompt_cache_key" in sanitized, false);
	assert.equal("prompt_cache_retention" in sanitized, false);
	assert.equal(sanitized.max_completion_tokens, 256);
	assert.equal("strict" in sanitized.tools[0].function, false);
	assert.equal(sanitized.messages.length, 3);
	const mappedId = sanitized.messages[1].tool_calls[0].id;
	assert.ok(mappedId.length <= 40);
	assert.equal(sanitized.messages[2].tool_call_id, mappedId);

	// Drops orphaned tool messages with no matching assistant tool_call
	const withOrphan = sanitizeProviderPayload({
		model: "gpt-6.1-terra",
		messages: [
			{ role: "user", content: "hi" },
			{ role: "tool", tool_call_id: "call_orphan", content: "stale" },
		],
	}) as any;
	assert.equal(withOrphan.messages.length, 1);

	// Switching from non-Gemini tool call to Gemini model folds foreign tool_calls to text
	const toGemini = sanitizeProviderPayload({
		model: "gemini-3.8-flash",
		messages: [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_abc123", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
			},
			{ role: "tool", tool_call_id: "call_abc123", content: "README.md" },
		],
	}) as any;
	assert.equal(toGemini.messages.length, 3);
	assert.equal(toGemini.messages[1].tool_calls, undefined);
	assert.equal(toGemini.messages[2].role, "user");
	assert.ok(toGemini.messages[2].content.includes("README.md"));
});

test("compactMessagesForBudget strips blocked/errored/orphaned entries and compacts older toolResults", () => {
	const state: CompactionState = {
		blockedToolCallIds: new Set(["tc_blocked"]),
		droppedMessageTimestamps: new Set([999]),
		replacedToolResults: new Map([["tc_403", "[Tool result removed]"]]),
	};
	const toolTurns = Array.from({ length: 6 }, (_, i) => {
		const id = i === 5 ? "tc_403" : `tc_${i}`;
		return [
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "bash", arguments: { command: "echo ok" } }],
				stopReason: "toolUse",
				timestamp: 200 + i * 2,
			},
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: "X".repeat(2500) }],
				isError: false,
				timestamp: 201 + i * 2,
			},
		];
	}).flat();

	const messages = [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tc_blocked", name: "bash", arguments: { command: "pwd; ls" } }],
			stopReason: "toolUse",
			timestamp: 100,
		},
		{
			role: "toolResult",
			toolCallId: "tc_blocked",
			toolName: "bash",
			content: [{ type: "text", text: "Blocked locally" }],
			isError: true,
			timestamp: 101,
		},
		{
			role: "toolResult",
			toolCallId: "tc_orphan_missing_assistant",
			toolName: "bash",
			content: [{ type: "text", text: "orphaned output" }],
			isError: false,
			timestamp: 150,
		},
		...toolTurns,
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "403", timestamp: 999 },
	];

	const { messages: out, changed } = compactMessagesForBudget(messages, state, {
		keepRecentToolResults: 2,
		olderToolResultMaxChars: 400,
	});
	assert.equal(changed, true);
	// Blocked toolCall stripped from assistant content
	assert.equal(out[1].content[0].type, "text");
	// Blocked toolResult converted to plain user notice
	assert.equal(out[2].role, "user");
	// Orphaned toolResult dropped
	assert.equal(out.some((m) => m.toolCallId === "tc_orphan_missing_assistant"), false);
	// Older toolResults compacted while recent ones kept (except tc_403 replaced)
	assert.ok(out[4].content[0].text.includes("compacted"));
	assert.equal(out[out.length - 1].content[0].text, "[Tool result removed]");
	assert.equal(out.some((m) => m.stopReason === "error"), false);

	// Combined recent budget compacts -2 when -1 + -2 exceed recentToolResultBudgetChars
	const recentPairState: CompactionState = {
		blockedToolCallIds: new Set(),
		droppedMessageTimestamps: new Set(),
		replacedToolResults: new Map(),
	};
	const pairRes = compactMessagesForBudget(
		[
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: {} }],
				timestamp: 1,
			},
			{ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "A".repeat(4500) }], timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "r2", name: "read", arguments: {} }],
				timestamp: 3,
			},
			{ role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "B".repeat(4500) }], timestamp: 4 },
		],
		recentPairState,
		{ keepRecentToolResults: 2, olderToolResultMaxChars: 500, recentToolResultBudgetChars: 7500 },
	);
	assert.equal(pairRes.changed, true);
	assert.ok(pairRes.messages[2].content[0].text.includes("compacted from 4500 chars"));
	assert.equal(pairRes.messages[4].content[0].text, "B".repeat(4500));

	// Compacts completed write/edit HTML+JS toolCall arguments on replay (keeps tiny write intact)
	const writeState: CompactionState = {
		blockedToolCallIds: new Set(),
		droppedMessageTimestamps: new Set(),
		replacedToolResults: new Map(),
		compactedToolCallIds: new Set(["tc_forced"]),
	};
	const writeCompacted = compactMessagesForBudget(
		[
			{ role: "user", content: [{ type: "text", text: "build 3D page" }] },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "w_html",
						name: "write",
						arguments: { path: "index.html", content: "<!doctype html><html><script src='app.js'></script></html>" },
					},
				],
				timestamp: 10,
			},
			{ role: "toolResult", toolCallId: "w_html", toolName: "write", content: [{ type: "text", text: "ok" }], timestamp: 11 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "w_small",
						name: "write",
						arguments: { path: "cfg.json", content: '{"ok":true}' },
					},
				],
				timestamp: 12,
			},
			{ role: "toolResult", toolCallId: "w_small", toolName: "write", content: [{ type: "text", text: "ok" }], timestamp: 13 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "e_large",
						name: "edit",
						arguments: { path: "scene.js", edits: [{ oldText: "a", newText: "x".repeat(600) }] },
					},
				],
				timestamp: 14,
			},
			{ role: "toolResult", toolCallId: "e_large", toolName: "edit", content: [{ type: "text", text: "ok" }], timestamp: 15 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc_forced", name: "bash", arguments: { command: "echo " + "z".repeat(400) } }],
				timestamp: 16,
			},
			{ role: "toolResult", toolCallId: "tc_forced", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: 17 },
		],
		writeState,
	);
	assert.equal(writeCompacted.changed, true);
	assert.equal(writeCompacted.messages[1].content[0].arguments.content.includes("<script"), false);
	assert.ok(writeCompacted.messages[1].content[0].arguments.content.includes("index.html"));
	assert.equal(writeCompacted.messages[3].content[0].arguments.content, '{"ok":true}');
	assert.ok(writeCompacted.messages[5].content[0].arguments.edits[0].newText.includes("scene.js"));
	assert.ok(writeCompacted.messages[7].content[0].arguments.command.includes("omitted after gateway 403/400"));
});

test("sanitizeProviderPayload compacts completed write/edit tool_calls before Gemini folding", () => {
	const out = sanitizeProviderPayload({
		model: "gemini-3.8-flash",
		messages: [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_w1",
						type: "function",
						function: {
							name: "write",
							arguments: JSON.stringify({ path: "scene.js", content: "const x = 1;\n".repeat(400) }),
						},
					},
				],
			},
			{ role: "tool", tool_call_id: "call_w1", content: "Successfully wrote" },
		],
	}) as any;
	assert.equal(out.messages[1].tool_calls, undefined);
	assert.equal(out.messages[1].content.includes("const x = 1;"), false);
	assert.ok(out.messages[1].content.includes("full contents stored on disk"));
});

test("diagnoseProviderError extracts Akamai reference code and 400 reason", () => {
	const d403 = diagnoseProviderError(
		"API error (403): 403 <!DOCTYPE html><title>Access Denied</title>Denied Reason: WP</br>Reference Code: 0.118fd317.1794974247.2982609</br>",
	);
	assert.equal(d403.kind, "akamai_403");
	assert.equal(d403.deniedReason, "WP");
	assert.equal(d403.referenceCode, "0.118fd317.1794974247.2982609");

	const d400 = diagnoseProviderError('API error (400): {"error":{"message":"Invalid schema"}}');
	assert.equal(d400.kind, "http_400");
});

test("parseRateLimitErrorDetails & computeHkbu429RetryDelayMs handle MODEL_DAILY_QUOTA_IN_FLIGHT vs hard exhaustion", () => {
	const rawInFlight =
		'API error (429): 429 {"message":"Your remaining GPT-6 Astra prompts are currently in progress. Please wait for a response to finish.","type":"rate_limit_error","param":null,"code":"MODEL_DAILY_QUOTA_IN_FLIGHT","limit":3,"used":0,"reserved":3,"remaining":0,"retryAfterSeconds":15,"resetAt":"2026-11-19T16:00:00.000Z","model":"gpt-6-astra"}';

	const inFlight = parseRateLimitErrorDetails(rawInFlight, "15");
	assert.ok(inFlight);
	assert.equal(inFlight.code, "MODEL_DAILY_QUOTA_IN_FLIGHT");
	assert.equal(inFlight.model, "gpt-6-astra");
	assert.equal(inFlight.limit, 3);
	assert.equal(inFlight.used, 0);
	assert.equal(inFlight.reserved, 3);
	assert.equal(inFlight.remaining, 0);
	assert.equal(inFlight.retryAfterSeconds, 15);
	assert.equal(isHardQuotaExhausted(inFlight), false);
	assert.equal(computeHkbu429RetryDelayMs(inFlight, 1, 20_000), 15_500);
	assert.equal(computeHkbu429RetryDelayMs(inFlight, 1, 10_000), 10_000);
	assert.equal(computeHkbu429RetryDelayMs(inFlight, 2, 20_000), null);

	const headerOnly = parseRateLimitErrorDetails("Rate limited", "1.2");
	assert.equal(headerOnly?.retryAfterSeconds, 1.2);
	assert.equal(computeHkbu429RetryDelayMs(headerOnly, 1, 20_000), 1_700);

	const hardExhausted = parseRateLimitErrorDetails(
		JSON.stringify({
			code: "MODEL_DAILY_QUOTA_EXHAUSTED",
			model: "gpt-6-astra",
			limit: 3,
			used: 3,
			reserved: 0,
			remaining: 0,
			retryAfterSeconds: 3600,
			resetAt: "2026-11-19T16:00:00.000Z",
		}),
	);
	assert.equal(isHardQuotaExhausted(hardExhausted), true);
	assert.equal(computeHkbu429RetryDelayMs(hardExhausted, 1, 20_000), null);
});

test("diagnoseProviderError classifies 429 quota errors and suggests fallback models", () => {
	const d429InFlight = diagnoseProviderError(
		'API error (429): 429 {"message":"Your remaining GPT-6 Astra prompts are currently in progress.","type":"rate_limit_error","code":"MODEL_DAILY_QUOTA_IN_FLIGHT","limit":3,"used":0,"reserved":3,"remaining":0,"retryAfterSeconds":15,"resetAt":"2026-11-19T16:00:00.000Z","model":"gpt-6-astra"}',
	);
	assert.equal(d429InFlight.kind, "rate_limit_429");
	assert.equal(d429InFlight.rateLimit?.code, "MODEL_DAILY_QUOTA_IN_FLIGHT");
	assert.ok(d429InFlight.summary.includes("gpt-6-astra"));
	assert.ok(d429InFlight.summary.includes("used=0/3"));
	assert.ok(d429InFlight.summary.includes("reserved=3"));
	assert.ok(d429InFlight.summary.includes("gpt-6.1-terra"));

	const d429Hard = diagnoseProviderError(
		'429 {"code":"MODEL_DAILY_QUOTA_EXHAUSTED","limit":3,"used":3,"reserved":0,"remaining":0,"model":"gpt-6-astra"}',
	);
	assert.equal(d429Hard.kind, "rate_limit_429");
	assert.ok(d429Hard.summary.includes("Daily prompt quota exhausted"));
});
