import assert from "node:assert/strict";
import test from "node:test";
import { isHkbuEndpointModel } from "../lib/hkbu-genai-helpers.ts";
import {
	buildWebInstructions,
	buildWebRequestBody,
	createWebSessionState,
	extractPendingImageFromBlock,
	extractTranscriptParts,
	HKBU_WEB_BASE_URL,
	HKBU_WEB_PROVIDER_ID,
	inspectHkbuWebToken,
	isHkbuWebModel,
	parseWebSseDataLine,
	planWebTurn,
	uploadFileToHkbuWeb,
	WebContentStreamParser,
	type PiToolDef,
} from "../lib/hkbu-genai-web.ts";
import {
	createHkbuWebOAuthProvider,
	extractJwtFromCdpRequestParams,
	extractValidHkbuWebJwt,
	findChromiumExecutable,
	findJwtInSessionJson,
	parseDevToolsWsUrlFromStderr,
} from "../lib/hkbu-genai-web-auth.ts";

function makeFakeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.fakesig`;
}

test("isHkbuWebModel and isHkbuEndpointModel are mutually exclusive", () => {
	assert.equal(isHkbuWebModel({ provider: HKBU_WEB_PROVIDER_ID, baseUrl: HKBU_WEB_BASE_URL }), true);
	assert.equal(isHkbuWebModel({ provider: "custom", baseUrl: "https://genai.hkbu.edu.hk/api/v0/general" }), true);
	assert.equal(isHkbuWebModel({ provider: "hkbu-genai", baseUrl: "https://genai.hkbu.edu.hk/api/v1" }), false);

	assert.equal(isHkbuEndpointModel({ provider: HKBU_WEB_PROVIDER_ID, baseUrl: HKBU_WEB_BASE_URL }), false);
	assert.equal(isHkbuEndpointModel({ provider: "custom", baseUrl: "https://genai.hkbu.edu.hk/api/v0/general" }), false);
	assert.equal(isHkbuEndpointModel({ provider: "hkbu-genai", baseUrl: "https://genai.hkbu.edu.hk/api/v1" }), true);
});

test("inspectHkbuWebToken decodes expiry, near-expiry, and malformed tokens", () => {
	const now = 1_800_000_000_000;
	const validToken = makeFakeJwt({ sub: "USER1", email: "u@hkbu.edu.hk", exp: Math.floor(now / 1000) + 10 * 86400 });
	const infoValid = inspectHkbuWebToken(`Bearer ${validToken}`, now);
	assert.equal(infoValid.validFormat, true);
	assert.equal(infoValid.sub, "USER1");
	assert.equal(infoValid.isExpired, false);
	assert.equal(infoValid.isExpiringSoon, false);

	const soonToken = makeFakeJwt({ exp: Math.floor(now / 1000) + 3600 });
	const infoSoon = inspectHkbuWebToken(soonToken, now);
	assert.equal(infoSoon.isExpired, false);
	assert.equal(infoSoon.isExpiringSoon, true);

	const expiredToken = makeFakeJwt({ exp: Math.floor(now / 1000) - 60 });
	const infoExpired = inspectHkbuWebToken(expiredToken, now);
	assert.equal(infoExpired.isExpired, true);

	assert.equal(inspectHkbuWebToken("not-a-jwt", now).validFormat, false);
	assert.equal(inspectHkbuWebToken(undefined, now).validFormat, false);
});

test("buildWebInstructions embeds compact tool schema and protocol only when tools exist", () => {
	assert.equal(buildWebInstructions("Be concise.", []), "Be concise.");
	const tools: PiToolDef[] = [
		{
			name: "read",
			description: "Read a file from disk.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path to file" },
					limit: { type: "number" },
				},
				required: ["path"],
			},
		},
	];
	const inst = buildWebInstructions("Be concise.", tools);
	assert.ok(inst.includes("Be concise."));
	assert.ok(inst.includes("<pi_tool_call>"));
	assert.ok(inst.includes("read({ path: string /* Path to file */, limit?: number })"));
});

test("planWebTurn reuses chat_session_id for incremental turns and rotates on model switch or compaction", () => {
	const session = createWebSessionState();
	const tools: PiToolDef[] = [{ name: "read", description: "Read file" }];

	// Turn 1: fresh session
	const m1 = [{ role: "user", content: [{ type: "text", text: "Inspect package.json" }] }];
	const plan1 = planWebTurn(session, "gpt-6-luna", m1, "System rules", tools);
	assert.equal(plan1.reusedSession, false);
	assert.equal(plan1.chatSessionId, undefined);
	assert.equal(plan1.prompt, "Inspect package.json");
	const body1 = buildWebRequestBody(plan1, "gpt-6-luna");
	assert.equal(body1.chat_session_id, undefined);
	assert.ok(body1.instructions?.includes("<pi_tool_call>"));

	// Simulate server returning conversation_uuid
	session.conversationUuid = "11111111-2222-3333-4444-555555555555";
	session.modelId = "gpt-6-luna";
	session.syncedMessageCount = plan1.nextSyncedMessageCount;
	session.syncedPrefixFingerprint = plan1.nextSyncedFingerprint;

	// Turn 2: assistant emitted toolCall + Pi ran tool -> toolResult appended
	const m2 = [
		...m1,
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_web_1", name: "read", arguments: { path: "package.json" } }],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "call_web_1",
			toolName: "read",
			content: [{ type: "text", text: '{"name":"pi-hkbu-genai"}' }],
			isError: false,
		},
	];
	const plan2 = planWebTurn(session, "gpt-6-luna", m2, "System rules", tools);
	assert.equal(plan2.reusedSession, true);
	assert.equal(plan2.chatSessionId, "11111111-2222-3333-4444-555555555555");
	assert.ok(plan2.prompt.includes('<pi_tool_result name="read" id="call_web_1" status="ok">'));
	assert.ok(plan2.prompt.includes('{"name":"pi-hkbu-genai"}'));
	// Should NOT re-send user1 or assistant1
	assert.equal(plan2.prompt.includes("Inspect package.json"), false);

	session.syncedMessageCount = plan2.nextSyncedMessageCount;
	session.syncedPrefixFingerprint = plan2.nextSyncedFingerprint;

	// Turn 3: model switch forces fresh session with full serialized transcript
	const m3 = [...m2, { role: "assistant", content: [{ type: "text", text: "Done." }] }, { role: "user", content: "Next?" }];
	const plan3 = planWebTurn(session, "gemini-3.8-flash", m3, "System rules", tools);
	assert.equal(plan3.reusedSession, false);
	assert.equal(plan3.chatSessionId, undefined);
	assert.ok(plan3.prompt.includes("Inspect package.json"));
	assert.ok(plan3.prompt.includes("<pi_tool_call>"));
	assert.ok(plan3.prompt.includes("<pi_tool_result"));
	assert.ok(plan3.prompt.includes("Next?"));

	// Turn 4: prefix mutation (compaction/rewind) forces fresh session even with same model
	const compacted = [{ role: "user", content: "Compacted summary" }, { role: "user", content: "Continue" }];
	const plan4 = planWebTurn(session, "gpt-6-luna", compacted, "System rules", tools);
	assert.equal(plan4.reusedSession, false);
	assert.equal(plan4.chatSessionId, undefined);
});

test("parseWebSseDataLine handles chunks, tool_status, duplicate, DONE, and non-streaming JSON", () => {
	const chunk = parseWebSseDataLine(
		'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","conversation_uuid":"uuid-1","model":"gpt-6-luna","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
	);
	assert.equal(chunk.kind, "chunk");
	if (chunk.kind === "chunk") {
		assert.equal(chunk.contentDelta, "Hi");
		assert.equal(chunk.conversationUuid, "uuid-1");
		assert.equal(chunk.finishReason, null);
	}

	const finalChunk = parseWebSseDataLine(
		'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":12,"total_tokens":112}}',
	);
	assert.equal(finalChunk.kind, "chunk");
	if (finalChunk.kind === "chunk") {
		assert.equal(finalChunk.finishReason, "stop");
		assert.deepEqual(finalChunk.usage, { promptTokens: 100, completionTokens: 12, totalTokens: 112 });
	}

	const toolStatus = parseWebSseDataLine(
		'data: {"type":"tool_status","tool":{"name":"provider_web_search","status":"completed"},"conversation_uuid":"uuid-2"}',
	);
	assert.equal(toolStatus.kind, "tool_status");
	if (toolStatus.kind === "tool_status") {
		assert.equal(toolStatus.conversationUuid, "uuid-2");
	}

	assert.equal(parseWebSseDataLine("data: [DONE]").kind, "done");
	assert.equal(parseWebSseDataLine('{"duplicate":true,"run":{"id":"r1","conversationId":"c1"}}').kind, "duplicate");

	const nonStream = parseWebSseDataLine(
		'{"id":"1","object":"chat.completion","conversation_uuid":"uuid-3","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}',
	);
	assert.equal(nonStream.kind, "chunk");
	if (nonStream.kind === "chunk") {
		assert.equal(nonStream.contentDelta, "OK");
		assert.equal(nonStream.finishReason, "stop");
	}
});

test("WebContentStreamParser parses split <think> and multiple <pi_tool_call> blocks accurately", () => {
	const parser = new WebContentStreamParser({
		enableToolEmulation: true,
		knownToolNames: new Set(["read", "bash"]),
	});
	const raw =
		'<think>\nPlanning to inspect files.\n</think>\n\nLet me read that.\n' +
		'<pi_tool_call>\n{"name": "read", "arguments": {"path": "package.json"}}\n</pi_tool_call>\n' +
		'<pi_tool_call>\n{"name": "bash", "arguments": {"command": "ls -la"}}\n</pi_tool_call>';

	// Feed 3 characters at a time to stress-test tag boundary splitting
	const segments: any[] = [];
	for (let i = 0; i < raw.length; i += 3) {
		segments.push(...parser.push(raw.slice(i, i + 3)));
	}
	segments.push(...parser.flush());

	const thinking = segments
		.filter((s) => s.type === "thinking")
		.map((s) => s.delta)
		.join("");
	const text = segments
		.filter((s) => s.type === "text")
		.map((s) => s.delta)
		.join("")
		.trim();
	const toolCalls = segments.filter((s) => s.type === "tool_call");

	assert.equal(thinking, "\nPlanning to inspect files.\n");
	assert.equal(text, "Let me read that.");
	assert.equal(toolCalls.length, 2);
	assert.equal(toolCalls[0].name, "read");
	assert.deepEqual(toolCalls[0].arguments, { path: "package.json" });
	assert.equal(toolCalls[1].name, "bash");
	assert.deepEqual(toolCalls[1].arguments, { command: "ls -la" });
});

test("WebContentStreamParser handles fallback <tool_call>, malformed JSON degradation, and disabled emulation", () => {
	const parser = new WebContentStreamParser({
		enableToolEmulation: true,
		knownToolNames: new Set(["read"]),
	});
	const segs = [
		...parser.push('<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>'),
		...parser.push('<tool_call>{"name":"unknown_tool","arguments":{}}</tool_call>'),
		...parser.push("<pi_tool_call>{bad json}</pi_tool_call>"),
		...parser.flush(),
	];
	const calls = segs.filter((s) => s.type === "tool_call");
	assert.equal(calls.length, 1);
	if (calls[0].type === "tool_call") {
		assert.equal(calls[0].name, "read");
		assert.deepEqual(calls[0].arguments, { path: "README.md" });
	}
	const fallbackText = segs
		.filter((s) => s.type === "text")
		.map((s) => s.delta)
		.join("");
	assert.ok(fallbackText.includes("unknown_tool"));
	assert.ok(fallbackText.includes("{bad json}"));

	// Disabled tool emulation leaves <pi_tool_call> as plain text
	const plainParser = new WebContentStreamParser({ enableToolEmulation: false });
	const plainSegs = [
		...plainParser.push('<pi_tool_call>{"name":"read","arguments":{}}</pi_tool_call>'),
		...plainParser.flush(),
	];
	assert.equal(plainSegs.some((s) => s.type === "tool_call"), false);
	assert.ok(
		plainSegs
			.filter((s) => s.type === "text")
			.map((s) => s.delta)
			.join("")
			.includes("<pi_tool_call>"),
	);
});

test("extractTranscriptParts reads Pi 1.5 system sections, toolsAdded, toolsRemoved, and chat messages", () => {
	const parts = extractTranscriptParts({
		messages: [
			{
				role: "system",
				content: "",
				sections: { preamble: "You are pi.", guidelines: "Be helpful." },
				toolsAdded: [
					{ name: "read", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
					{ name: "bash", description: "Run shell" },
				],
			},
			{ role: "user", content: [{ type: "text", text: "Hello" }] },
			{ role: "system", content: "Extra rule", toolsRemoved: ["bash"] },
		],
	});
	assert.ok(parts.systemPrompt.includes("You are pi."));
	assert.ok(parts.systemPrompt.includes("Be helpful."));
	assert.ok(parts.systemPrompt.includes("Extra rule"));
	assert.deepEqual(
		parts.tools.map((t) => t.name),
		["read"],
	);
	assert.equal(parts.messages.length, 1);
	assert.equal(parts.messages[0].role, "user");
});

test("extractPendingImageFromBlock and planWebTurn collect images from latest turn and toolResults", () => {
	const b64Png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
	const img1 = extractPendingImageFromBlock({ type: "image", data: b64Png, mimeType: "image/png" }, 0);
	assert.ok(img1);
	assert.equal(img1.filename, "attachment-1.png");
	assert.equal(img1.mimeType, "image/png");
	assert.equal(img1.bytes.length, 4);

	const imgJpg = extractPendingImageFromBlock(
		{ type: "image", data: `data:image/jpg;base64,${b64Png}` },
		1,
	);
	assert.ok(imgJpg);
	assert.equal(imgJpg.filename, "attachment-2.jpg");
	assert.equal(imgJpg.mimeType, "image/jpeg");

	assert.equal(extractPendingImageFromBlock({ type: "image", data: b64Png, mimeType: "image/gif" }, 0), null);

	// Fresh session collects images from trailing toolResult, not older turns
	const session = createWebSessionState();
	const plan = planWebTurn(
		session,
		"gpt-6-luna",
		[
			{ role: "user", content: [{ type: "text", text: "old" }, { type: "image", data: b64Png, mimeType: "image/png" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "img.png" } }] },
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "image", data: b64Png, mimeType: "image/webp" }],
			},
		],
		"sys",
		[],
	);
	assert.equal(plan.images.length, 1);
	assert.equal(plan.images[0].filename, "attachment-1.webp");
	assert.ok(plan.prompt.includes("[Attached image: attachment-1.webp]"));
	const body = buildWebRequestBody(plan, "gpt-6-luna", { uploadIds: ["upload-123"] });
	assert.deepEqual(body.uploadIds, ["upload-123"]);
});

test("uploadFileToHkbuWeb performs 2-step POST init and PUT multipart content upload", async () => {
	const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
	const fakeFetch: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url, method, headers, body: init?.body });
		if (method === "POST") {
			return new Response(JSON.stringify({ id: "up-uuid-1", uploadToken: "tok-xyz", status: "created" }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ id: "up-uuid-1", status: "ready" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const id = await uploadFileToHkbuWeb(
		{ filename: "attachment-1.png", mimeType: "image/png", bytes: Buffer.from([1, 2, 3]) },
		"fake.jwt.token",
		{ fetch: fakeFetch },
	);
	assert.equal(id, "up-uuid-1");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].method, "POST");
	assert.ok(calls[0].url.endsWith("/chat/uploads"));
	assert.equal(calls[0].headers.Authorization, "Bearer fake.jwt.token");
	assert.equal(calls[1].method, "PUT");
	assert.ok(calls[1].url.endsWith("/chat/uploads/up-uuid-1/content"));
	assert.equal(calls[1].headers["x-upload-token"], "tok-xyz");
	assert.ok(calls[1].body instanceof FormData);
});

test("hkbu-genai-web-auth extracts JWTs from CDP headers, session JSON, stderr URLs, and browser paths", () => {
	const now = 1_800_000_000_000;
	const validExp = Math.floor(now / 1000) + 86400;
	const jwt = makeFakeJwt({ sub: "USER1", exp: validExp });
	const expiredJwt = makeFakeJwt({ sub: "USER1", exp: Math.floor(now / 1000) - 10 });

	assert.deepEqual(extractValidHkbuWebJwt(`Bearer ${jwt}`, now), { token: jwt, expires: validExp * 1000 });
	assert.equal(extractValidHkbuWebJwt(expiredJwt, now), null);

	const fromCdp = extractJwtFromCdpRequestParams(
		{
			request: {
				url: "https://genai.hkbu.edu.hk/api/v0/general/chat/completions",
				headers: { Authorization: `Bearer ${jwt}` },
			},
		},
		now,
	);
	assert.deepEqual(fromCdp, { token: jwt, expires: validExp * 1000 });
	assert.equal(
		extractJwtFromCdpRequestParams(
			{ request: { url: "https://other.example.com/api", headers: { Authorization: `Bearer ${jwt}` } } },
			now,
		),
		null,
	);

	const fromSession = findJwtInSessionJson({ user: { name: "Test" }, accessToken: jwt }, now);
	assert.deepEqual(fromSession, { token: jwt, expires: validExp * 1000 });

	assert.equal(
		parseDevToolsWsUrlFromStderr("DevTools listening on ws://127.0.0.1:54321/devtools/browser/abc-123\n"),
		"ws://127.0.0.1:54321/devtools/browser/abc-123",
	);

	const foundChrome = findChromiumExecutable("darwin", { HKBU_GENAI_CHROME_PATH: "/custom/chrome" }, (p) => p === "/custom/chrome");
	assert.equal(foundChrome, "/custom/chrome");
});

test("createHkbuWebOAuthProvider falls back to manual paste when HKBU_GENAI_NO_BROWSER=1", async () => {
	const prevNoBrowser = process.env.HKBU_GENAI_NO_BROWSER;
	process.env.HKBU_GENAI_NO_BROWSER = "1";
	try {
		const futureExp = Math.floor(Date.now() / 1000) + 3600;
		const jwt = makeFakeJwt({ sub: "USER1", exp: futureExp });
		const oauth = createHkbuWebOAuthProvider();
		let authUrl = "";
		const creds = await oauth.login({
			onAuth(info) {
				authUrl = info.url;
			},
			async onPrompt() {
				return `Bearer ${jwt}`;
			},
		});
		assert.equal(authUrl, "https://genai.hkbu.edu.hk");
		assert.equal(creds.access, jwt);
		assert.equal(creds.expires, futureExp * 1000);
		assert.equal(oauth.getApiKey(creds), jwt);
		const refreshed = await oauth.refreshToken(creds);
		assert.equal(refreshed.access, jwt);
	} finally {
		if (prevNoBrowser === undefined) delete process.env.HKBU_GENAI_NO_BROWSER;
		else process.env.HKBU_GENAI_NO_BROWSER = prevNoBrowser;
	}
});
