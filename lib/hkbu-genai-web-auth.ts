import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectHkbuWebToken } from "./hkbu-genai-web.ts";

export const HKBU_WEB_ORIGIN = "https://genai.hkbu.edu.hk";
export const HKBU_WEB_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const HKBU_WEB_BROWSER_STARTUP_TIMEOUT_MS = 15_000;

export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
}

export interface OAuthLoginCallbacks {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

function isExecutable(filePath: string): boolean {
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function getCandidateChromiumPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const candidates: string[] = [];
	if (env.HKBU_GENAI_CHROME_PATH) {
		candidates.push(env.HKBU_GENAI_CHROME_PATH);
	}
	if (platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Arc.app/Contents/MacOS/Arc",
		);
	} else if (platform === "win32") {
		const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
			(v): v is string => Boolean(v),
		);
		for (const root of roots) {
			candidates.push(
				join(root, "Google", "Chrome", "Application", "chrome.exe"),
				join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
				join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
			);
		}
	} else {
		const pathDirs = (env.PATH ?? "/usr/bin:/usr/local/bin").split(":").filter(Boolean);
		const bins = [
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
			"brave-browser",
			"microsoft-edge",
		];
		for (const dir of pathDirs) {
			for (const bin of bins) {
				candidates.push(join(dir, bin));
			}
		}
	}
	return candidates;
}

export function findChromiumExecutable(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	checkExec: (p: string) => boolean = isExecutable,
): string | null {
	for (const candidate of getCandidateChromiumPaths(platform, env)) {
		if (checkExec(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Normalize and validate a candidate HKBU GenAI web Bearer JWT string.
 * Returns `{ token, expires }` (with `expires` in ms since epoch) or `null` if invalid/expired.
 */
export function extractValidHkbuWebJwt(
	raw: string | undefined | null,
	nowMs = Date.now(),
): { token: string; expires: number } | null {
	if (!raw || typeof raw !== "string") return null;
	const token = raw.replace(/^Bearer\s+/i, "").trim();
	const info = inspectHkbuWebToken(token, nowMs);
	if (!info.validFormat || info.isExpired || !info.exp) return null;
	return {
		token,
		expires: info.exp * 1000,
	};
}

/**
 * Extract a valid HKBU Bearer JWT from a CDP `Network.requestWillBeSent` params object.
 */
export function extractJwtFromCdpRequestParams(params: any, nowMs = Date.now()): { token: string; expires: number } | null {
	const url = typeof params?.request?.url === "string" ? params.request.url : "";
	if (!url.startsWith(HKBU_WEB_ORIGIN)) return null;
	const headers = params?.request?.headers;
	if (!headers || typeof headers !== "object") return null;
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === "authorization" && typeof v === "string") {
			const match = extractValidHkbuWebJwt(v, nowMs);
			if (match) return match;
		}
	}
	return null;
}

/**
 * Recursively scan a JSON object (e.g. `/api/auth/session` response) for a valid HKBU web JWT.
 */
export function findJwtInSessionJson(obj: unknown, nowMs = Date.now(), depth = 0): { token: string; expires: number } | null {
	if (depth > 5 || obj == null) return null;
	if (typeof obj === "string") {
		if (obj.startsWith("eyJ")) {
			return extractValidHkbuWebJwt(obj, nowMs);
		}
		return null;
	}
	if (Array.isArray(obj)) {
		for (const item of obj) {
			const found = findJwtInSessionJson(item, nowMs, depth + 1);
			if (found) return found;
		}
		return null;
	}
	if (typeof obj === "object") {
		// Prioritize common token field names first
		const record = obj as Record<string, unknown>;
		for (const key of ["accessToken", "access_token", "token", "bearerToken", "jwt", "idToken"]) {
			if (key in record) {
				const found = findJwtInSessionJson(record[key], nowMs, depth + 1);
				if (found) return found;
			}
		}
		for (const val of Object.values(record)) {
			const found = findJwtInSessionJson(val, nowMs, depth + 1);
			if (found) return found;
		}
	}
	return null;
}

export function parseDevToolsWsUrlFromStderr(chunk: string): string | null {
	const m = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
	return m ? m[1] : null;
}

function killBrowserProcess(proc: ChildProcess) {
	if (proc.killed || proc.exitCode !== null) return;
	try {
		proc.kill("SIGTERM");
	} catch {
		return;
	}
	const timer = setTimeout(() => {
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Ignore
			}
		}
	}, 2_000);
	timer.unref?.();
}

export interface CdpCaptureOptions {
	chromePath: string;
	profileDir?: string;
	loginUrl?: string;
	timeoutMs?: number;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

/**
 * Launch a local Chromium browser with remote debugging enabled, let the user complete
 * HKBU SSO + 2FA in the browser window, and automatically capture the `genai.hkbu.edu.hk`
 * Bearer JWT via CDP (`Network.requestWillBeSent` or `/api/auth/session` polling).
 */
export async function captureHkbuWebTokenViaCdp(options: CdpCaptureOptions): Promise<OAuthCredentials> {
	const loginUrl = options.loginUrl ?? HKBU_WEB_ORIGIN;
	const timeoutMs = options.timeoutMs ?? HKBU_WEB_LOGIN_TIMEOUT_MS;
	const profileDir = options.profileDir ?? join(homedir(), ".pi", "agent", "hkbu-chrome-profile");
	mkdirSync(profileDir, { recursive: true });

	if (options.signal?.aborted) {
		throw new Error("Login aborted.");
	}

	const proc = spawn(
		options.chromePath,
		[
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--new-window",
			loginUrl,
		],
		{
			stdio: ["ignore", "ignore", "pipe"],
		},
	);

	let ws: WebSocket | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let overallTimer: ReturnType<typeof setTimeout> | undefined;

	const cleanup = () => {
		if (pollTimer) clearInterval(pollTimer);
		if (overallTimer) clearTimeout(overallTimer);
		try {
			ws?.close();
		} catch {
			// Ignore
		}
		killBrowserProcess(proc);
	};

	try {
		// 1. Wait for DevTools WebSocket URL from Chrome stderr
		const browserWsUrl = await new Promise<string>((resolve, reject) => {
			let stderrAcc = "";
			const startupTimer = setTimeout(() => {
				reject(new Error("Timed out waiting for Chrome DevTools endpoint to start."));
			}, HKBU_WEB_BROWSER_STARTUP_TIMEOUT_MS);

			const onAbort = () => {
				clearTimeout(startupTimer);
				reject(new Error("Login aborted."));
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			proc.once("error", (err) => {
				clearTimeout(startupTimer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Failed to launch browser (${options.chromePath}): ${err.message}`));
			});
			proc.once("exit", (code) => {
				clearTimeout(startupTimer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Browser exited before DevTools started (code=${code}).`));
			});
			proc.stderr?.on("data", (buf: Buffer) => {
				stderrAcc += buf.toString("utf8");
				const url = parseDevToolsWsUrlFromStderr(stderrAcc);
				if (url) {
					clearTimeout(startupTimer);
					options.signal?.removeEventListener("abort", onAbort);
					resolve(url);
				}
			});
		});

		options.onProgress?.("Browser opened. Complete HKBU SSO sign-in in the Chrome window...");

		// 2. Connect to browser CDP WebSocket and monitor all attached page targets
		const captured = await new Promise<{ token: string; expires: number }>((resolve, reject) => {
			let settled = false;
			let nextId = 1;
			const pageSessions = new Set<string>();
			const pendingEvalIds = new Set<number>();

			const finish = (err: Error | null, res?: { token: string; expires: number }) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				if (err) reject(err);
				else if (res) resolve(res);
			};

			const onAbort = () => finish(new Error("Login aborted."));
			options.signal?.addEventListener("abort", onAbort, { once: true });

			overallTimer = setTimeout(() => {
				finish(new Error("Timed out waiting for HKBU SSO login (5 minutes)."));
			}, timeoutMs);

			proc.once("exit", () => {
				finish(new Error("Browser window was closed before HKBU web token was captured."));
			});

			const socket = new WebSocket(browserWsUrl);
			ws = socket;

			const sendCdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string): number => {
				const id = nextId++;
				const payload: Record<string, unknown> = { id, method, params };
				if (sessionId) payload.sessionId = sessionId;
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify(payload));
				}
				return id;
			};

			socket.addEventListener("open", () => {
				sendCdp("Target.setDiscoverTargets", { discover: true });
				sendCdp("Target.setAutoAttach", {
					autoAttach: true,
					waitForDebuggerOnStart: false,
					flatten: true,
				});

				// Poll /api/auth/session inside attached genai.hkbu.edu.hk tabs every 2s
				pollTimer = setInterval(() => {
					for (const sid of pageSessions) {
						const evalId = sendCdp(
							"Runtime.evaluate",
							{
								expression: `(async () => {
									if (!location.origin.startsWith(${JSON.stringify(HKBU_WEB_ORIGIN)})) return null;
									try {
										const r = await fetch('/api/auth/session', { credentials: 'include' });
										if (!r.ok) return null;
										return await r.json();
									} catch { return null; }
								})()`,
								awaitPromise: true,
								returnByValue: true,
							},
							sid,
						);
						pendingEvalIds.add(evalId);
					}
				}, 2_000);
			});

			socket.addEventListener("error", () => {
				finish(new Error("CDP WebSocket connection error."));
			});

			socket.addEventListener("message", (event) => {
				let msg: any;
				try {
					msg = JSON.parse(String(event.data));
				} catch {
					return;
				}

				if (msg.method === "Target.attachedToTarget") {
					const sessionId = msg.params?.sessionId;
					const targetType = msg.params?.targetInfo?.type;
					if (typeof sessionId === "string" && targetType === "page") {
						pageSessions.add(sessionId);
						sendCdp("Network.enable", {}, sessionId);
					}
					return;
				}

				if (msg.method === "Target.detachedFromTarget") {
					const sessionId = msg.params?.sessionId;
					if (typeof sessionId === "string") {
						pageSessions.delete(sessionId);
					}
					return;
				}

				if (msg.method === "Network.requestWillBeSent") {
					const found = extractJwtFromCdpRequestParams(msg.params);
					if (found) {
						finish(null, found);
					}
					return;
				}

				if (typeof msg.id === "number" && pendingEvalIds.has(msg.id)) {
					pendingEvalIds.delete(msg.id);
					const val = msg.result?.result?.value;
					const found = findJwtInSessionJson(val);
					if (found) {
						finish(null, found);
					}
				}
			});
		});

		options.onProgress?.(
			`Captured HKBU GenAI web token (valid until ${new Date(captured.expires).toISOString()}).`,
		);
		return {
			access: captured.token,
			refresh: captured.token,
			expires: captured.expires,
		};
	} finally {
		cleanup();
	}
}

async function promptForManualWebToken(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onAuth({
		url: HKBU_WEB_ORIGIN,
		instructions:
			"Sign in to https://genai.hkbu.edu.hk via HKBU SSO, open DevTools -> Network, send a chat message, and copy the Authorization: Bearer JWT from /api/v0/general/chat/completions.",
	});
	const pasted = await callbacks.onPrompt({
		message: "Paste your HKBU GenAI web Bearer JWT:",
		placeholder: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
	});
	const parsed = extractValidHkbuWebJwt(pasted);
	if (!parsed) {
		const info = inspectHkbuWebToken(pasted);
		if (info.validFormat && info.isExpired) {
			throw new Error(`The pasted HKBU GenAI web token expired at ${info.expiresAtIso}.`);
		}
		throw new Error("Invalid HKBU GenAI web Bearer JWT. Expected a valid, unexpired JWT.");
	}
	return {
		access: parsed.token,
		refresh: parsed.token,
		expires: parsed.expires,
	};
}

/**
 * Create Pi's `oauth` provider config for `hkbu-genai-web`:
 * - Uses a dedicated local Chromium window + CDP to capture the JWT automatically after HKBU SSO.
 * - Falls back cleanly to opening the URL + paste prompt if no Chromium browser is found,
 *   if `HKBU_GENAI_NO_BROWSER=1`, or if browser launch fails.
 */
export function createHkbuWebOAuthProvider() {
	return {
		name: "HKBU GenAI Web SSO",
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const noBrowser = /^(1|true|yes)$/i.test(process.env.HKBU_GENAI_NO_BROWSER ?? "");
			const chromePath = noBrowser ? null : findChromiumExecutable();

			if (chromePath) {
				try {
					callbacks.onProgress?.(`Launching browser for HKBU SSO (${HKBU_WEB_ORIGIN})...`);
					return await captureHkbuWebTokenViaCdp({
						chromePath,
						onProgress: callbacks.onProgress,
						signal: callbacks.signal,
					});
				} catch (err) {
					if (callbacks.signal?.aborted) {
						throw err;
					}
					const msg = err instanceof Error ? err.message : String(err);
					callbacks.onProgress?.(`Automatic browser capture failed (${msg}). Falling back to manual paste...`);
				}
			}

			return promptForManualWebToken(callbacks);
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			const existing = extractValidHkbuWebJwt(credentials.access);
			if (existing) {
				return {
					access: existing.token,
					refresh: existing.token,
					expires: existing.expires,
				};
			}
			const envFallback = extractValidHkbuWebJwt(process.env.HKBU_GENAI_WEB_TOKEN);
			if (envFallback) {
				return {
					access: envFallback.token,
					refresh: envFallback.token,
					expires: envFallback.expires,
				};
			}
			throw new Error(
				"HKBU GenAI web token expired. Run 'pi auth login hkbu-genai-web' (or /login) to sign in again via HKBU SSO.",
			);
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}
