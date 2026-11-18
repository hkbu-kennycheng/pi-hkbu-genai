import assert from "node:assert/strict";
import test from "node:test";
import {
	checkToolCallSafety,
	compactMessagesForBudget,
	diagnoseProviderError,
	isHkbuEndpointModel,
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
