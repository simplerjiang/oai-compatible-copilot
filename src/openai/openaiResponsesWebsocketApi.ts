/* eslint-disable @typescript-eslint/no-explicit-any */
import * as crypto from "crypto";
import * as net from "net";
import * as tls from "tls";
import type { CancellationToken, LanguageModelResponsePart2, Progress } from "vscode";
import { WebSocket, type RawData as WsRawData } from "ws";
import { logger } from "../logger";
import { OpenaiResponsesApi } from "./openaiResponsesApi";

/**
 * Thrown when the WebSocket transport cannot be used and the caller should
 * fall back to the regular HTTP `openai-responses` path. Examples:
 *  - handshake failure (network / HTTP upgrade rejected)
 *  - upstream sends an `error` frame before/while completing the response
 *  - unexpected close before `response.completed`
 *  - a concurrent request is already in flight on the same session
 */
export class WsUnsupportedError extends Error {
	public readonly cause?: unknown;
	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "WsUnsupportedError";
		this.cause = cause;
	}
}

interface WsSession {
	ws: WebSocket;
	url: string;
	sessionKey: string;
	lastResponseId: string | null;
	busy: boolean;
	closed: boolean;
	heartbeatTimer: NodeJS.Timeout | null;
	awaitingPong: boolean;
	missedPongs: number;
	// Active request callbacks (only one in flight per session)
	onFrame: ((raw: string) => void) | null;
	onError: ((err: Error) => void) | null;
}

const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_MISSES_BEFORE_CLOSE = 5;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sessions = new Map<string, WsSession>();
const pendingSessions = new Map<string, Promise<WsSession>>();
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

function clearHeartbeatTimer(session: WsSession): void {
	if (session.heartbeatTimer) {
		clearInterval(session.heartbeatTimer);
		session.heartbeatTimer = null;
	}
}

function startHeartbeat(session: WsSession): void {
	clearHeartbeatTimer(session);
	session.heartbeatTimer = setInterval(() => {
		if (session.closed) {
			clearHeartbeatTimer(session);
			return;
		}
		if (session.ws.readyState !== WebSocket.OPEN) {
			closeSessionInternal(session, "heartbeat-not-open");
			return;
		}
		if (session.awaitingPong) {
			session.missedPongs++;
			logger.warn("responses.ws.heartbeat.miss", {
				sessionKey: session.sessionKey,
				missedPongs: session.missedPongs,
				lastResponseId: session.lastResponseId ?? "",
			});
			if (session.missedPongs >= HEARTBEAT_MISSES_BEFORE_CLOSE) {
				closeSessionInternal(session, "heartbeat-timeout");
				return;
			}
		}
		session.awaitingPong = true;
		try {
			session.ws.ping();
		} catch (e) {
			closeSessionInternal(session, `heartbeat-ping-failed:${e instanceof Error ? e.message : String(e)}`);
		}
	}, HEARTBEAT_INTERVAL_MS);
	session.heartbeatTimer.unref?.();
}

function closeSessionInternal(session: WsSession, reason: string): void {
	if (session.closed) {
		return;
	}
	session.closed = true;
	clearHeartbeatTimer(session);
	sessions.delete(session.sessionKey);
	try {
		session.ws.close(1000, reason.slice(0, 120));
	} catch {
		// ignore
	}
}

function snapshotProxyEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of PROXY_ENV_KEYS) {
		if (process.env[key]) {
			out[key] = "<set>";
		}
	}
	return out;
}

function headerLine(name: string, value: string): string | null {
	if (!name || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) {
		return null;
	}
	return `${name}: ${value}`;
}

function parseHttpHeaders(raw: string): { statusCode: number; statusMessage: string; headers: Record<string, string> } {
	const lines = raw.split("\r\n");
	const status = lines.shift() ?? "";
	const match = status.match(/^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/i);
	const headers: Record<string, string> = {};
	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx <= 0) {
			continue;
		}
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
	}
	return {
		statusCode: match ? Number(match[1]) : 0,
		statusMessage: match?.[2] ?? "",
		headers,
	};
}

function expectedAccept(key: string): string {
	return crypto.createHash("sha1").update(key + WS_ACCEPT_GUID).digest("base64");
}

async function openRawWebSocket(wsUrl: string, headers: Record<string, string>): Promise<WebSocket> {
	const url = new URL(wsUrl);
	const secure = url.protocol === "wss:";
	const host = url.hostname;
	const port = Number(url.port || (secure ? 443 : 80));
	const path = `${url.pathname || "/"}${url.search || ""}`;
	const hostHeader = url.port ? `${host}:${url.port}` : host;
	const key = crypto.randomBytes(16).toString("base64");

	return await new Promise<WebSocket>((resolve, reject) => {
		let settled = false;
		let buffer = Buffer.alloc(0);
		const socket = secure
			? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ["http/1.1"] })
			: net.connect({ host, port });

		const fail = (err: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			reject(err);
		};

		const timer = setTimeout(() => fail(new WsUnsupportedError("WebSocket raw handshake timed out")), HANDSHAKE_TIMEOUT_MS);

		socket.once("error", (err) => {
			clearTimeout(timer);
			fail(new WsUnsupportedError(`WebSocket raw socket error: ${err.message}`, err));
		});

		socket.once("connect", () => {
			const lines = [
				`GET ${path} HTTP/1.1`,
				`Host: ${hostHeader}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
			];
			for (const [name, value] of Object.entries(headers)) {
				const lower = name.toLowerCase();
				if (lower === "host" || lower === "upgrade" || lower === "connection" || lower.startsWith("sec-websocket-")) {
					continue;
				}
				const line = headerLine(name, value);
				if (line) {
					lines.push(line);
				}
			}
			socket.write(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
		});

		socket.on("data", (chunk) => {
			if (settled) {
				return;
			}
			buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (buffer.length > 65536) {
					clearTimeout(timer);
					fail(new WsUnsupportedError("WebSocket raw handshake response too large"));
				}
				return;
			}

			clearTimeout(timer);
			const headerText = buffer.subarray(0, headerEnd).toString("latin1");
			const head = buffer.subarray(headerEnd + 4);
			const parsed = parseHttpHeaders(headerText);
			if (parsed.statusCode !== 101) {
				logger.warn("responses.ws.unexpected_response", {
					statusCode: parsed.statusCode,
					statusMessage: parsed.statusMessage,
					headers: parsed.headers,
					body: head.toString("utf8").slice(0, 2048),
				});
				fail(new WsUnsupportedError(`WebSocket unexpected response: ${parsed.statusCode} ${parsed.statusMessage}`.trim()));
				return;
			}

			if (!parsed.headers.upgrade || parsed.headers.upgrade.toLowerCase() !== "websocket") {
				fail(new WsUnsupportedError("WebSocket raw handshake missing upgrade response"));
				return;
			}
			if (!parsed.headers.connection || !parsed.headers.connection.toLowerCase().split(",").map((s) => s.trim()).includes("upgrade")) {
				fail(new WsUnsupportedError("WebSocket raw handshake missing connection upgrade response"));
				return;
			}
			if (parsed.headers["sec-websocket-accept"] !== expectedAccept(key)) {
				fail(new WsUnsupportedError("WebSocket raw handshake accept key mismatch"));
				return;
			}

			settled = true;
			socket.removeAllListeners("data");
			socket.removeAllListeners("error");
			const ws = new (WebSocket as any)(null, undefined, {
				autoPong: true,
				closeTimeout: 30_000,
			}) as WebSocket;
			(ws as any)._isServer = false;
			(ws as any).setSocket(socket, head, {
				allowSynchronousEvents: true,
				maxBufferedChunks: 1024 * 1024,
				maxFragments: 128 * 1024,
				maxPayload: 100 * 1024 * 1024,
				skipUTF8Validation: false,
			});
			resolve(ws);
		});
	});
}

/**
 * Convert an HTTP(S) base URL to a WebSocket URL pointing at the `/responses` WS endpoint
 * exposed by cliproxy-style upstreams. The cliproxy server registers the WS handler at
 * `GET /v1/responses` (no `/ws` suffix), so we must NOT append `/ws`.
 *  - `https://host/v1`            -> `wss://host/v1/responses`
 *  - `http://host/v1`             -> `ws://host/v1/responses`
 *  - `https://host/v1/responses`  -> `wss://host/v1/responses`
 *  - `ws://host/v1/responses`     -> unchanged (caller already provided WS URL)
 *  - `wss://host/v1/responses/ws` -> `wss://host/v1/responses` (legacy/typo tolerance)
 *  - `http://host/v1/responses/ws`-> `ws://host/v1/responses` (legacy/typo tolerance)
 */
function deriveWsUrl(baseUrl: string): string {
	let url = baseUrl.replace(/\/+$/, "");
	// Strip a stray `/ws` suffix to tolerate users who copied old docs.
	url = url.replace(/\/responses\/ws$/i, "/responses");
	if (url.startsWith("ws://") || url.startsWith("wss://")) {
		// Already a WS URL; if it doesn't end with `/responses`, append it.
		return /\/responses$/i.test(url) ? url : `${url}/responses`;
	}
	if (url.startsWith("https://")) {
		url = "wss://" + url.slice("https://".length);
	} else if (url.startsWith("http://")) {
		url = "ws://" + url.slice("http://".length);
	} else {
		// Bare host -> default to wss
		url = "wss://" + url;
	}
	if (/\/responses$/i.test(url)) {
		return url;
	}
	return url + "/responses";
}

/**
 * Open a fresh WebSocket session. Resolves once the handshake succeeds; rejects with
 * `WsUnsupportedError` on handshake failure / immediate close.
 */
async function openSession(sessionKey: string, wsUrl: string, headers: Record<string, string>): Promise<WsSession> {
	logger.debug("responses.ws.connect", {
		sessionKey,
		wsUrl,
		headers: logger.sanitizeHeaders(headers),
		rawHandshake: true,
		proxyEnv: snapshotProxyEnv(),
	});
	return await new Promise<WsSession>((resolve, reject) => {
		openRawWebSocket(wsUrl, headers).then((ws) => {
			const session: WsSession = {
				ws,
				url: wsUrl,
				sessionKey,
				lastResponseId: null,
				busy: false,
				closed: false,
				heartbeatTimer: null,
				awaitingPong: false,
				missedPongs: 0,
				onFrame: null,
				onError: null,
			};
			startHeartbeat(session);

			ws.on("message", (data: WsRawData) => {
				session.awaitingPong = false;
				session.missedPongs = 0;
				const text = data.toString("utf8");
				if (session.onFrame) {
					try {
						session.onFrame(text);
					} catch (e) {
						const err = e instanceof Error ? e : new Error(String(e));
						session.onError?.(err);
					}
				}
			});

			ws.on("pong", () => {
				session.awaitingPong = false;
				session.missedPongs = 0;
			});

			ws.on("error", (err: Error) => {
				logger.warn("responses.ws.error", { sessionKey, error: err.message });
				session.onError?.(err);
			});

			ws.on("close", (code: number, reason: Buffer) => {
				const reasonText = reason?.toString("utf8") ?? "";
				logger.debug("responses.ws.close", { sessionKey, code, reason: reasonText });
				session.closed = true;
				clearHeartbeatTimer(session);
				sessions.delete(sessionKey);
				if (session.busy) {
					session.onError?.(new WsUnsupportedError(`WebSocket closed mid-response: code=${code} reason=${reasonText}`));
				}
			});
			resolve(session);
		}, reject);
	});
}

async function acquireSession(
	sessionKey: string,
	wsUrl: string,
	headers: Record<string, string>
): Promise<WsSession> {
	const existing = sessions.get(sessionKey);
	if (existing && !existing.closed && existing.ws.readyState === WebSocket.OPEN) {
		return existing;
	}
	if (existing) {
		sessions.delete(sessionKey);
	}
	const pending = pendingSessions.get(sessionKey);
	if (pending) {
		const session = await pending;
		if (!session.closed && session.ws.readyState === WebSocket.OPEN) {
			return session;
		}
	}

	const opening = openSession(sessionKey, wsUrl, headers);
	pendingSessions.set(sessionKey, opening);
	try {
		const session = await opening;
		sessions.set(sessionKey, session);
		return session;
	} finally {
		if (pendingSessions.get(sessionKey) === opening) {
			pendingSessions.delete(sessionKey);
		}
	}
}

/**
 * Close + drop the WS session for `sessionKey` (e.g. on cancellation or fatal error).
 */
export function closeOpenAIResponsesWebsocketSession(sessionKey: string, reason = "explicit-close"): void {
	const session = sessions.get(sessionKey);
	if (session) {
		closeSessionInternal(session, reason);
	}
}

export function hasOpenAIResponsesWebsocketSession(sessionKey: string): boolean {
	const session = sessions.get(sessionKey);
	return !!session && !session.closed && session.ws.readyState === WebSocket.OPEN;
}

/**
 * Drop ALL active WS sessions. Useful for `deactivate()`.
 */
export function closeAllOpenAIResponsesWebsocketSessions(): void {
	for (const session of [...sessions.values()]) {
		closeSessionInternal(session, "shutdown");
	}
}

export class OpenaiResponsesWebsocketApi extends OpenaiResponsesApi {
	/**
	 * Send `requestBody` over a reused WebSocket session and pipe events through
	 * the parent's `processStreamingResponse` by synthesising an SSE-shaped ReadableStream.
	 *
	 * On any transport-level problem this throws `WsUnsupportedError` so the caller can
	 * transparently retry over the HTTP `openai-responses` path.
	 *
	 * Stateful semantics:
	 *  - The client sends the sanitized request body as-is. Follow-up frames may
	 *    include `previous_response_id` when they stay on the same WS session.
	 *  - The session's lastResponseId is kept only for diagnostics.
	 */
	async sendOverWebsocket(args: {
		sessionKey: string;
		baseUrl: string;
		headers: Record<string, string>;
		requestBody: Record<string, unknown>;
		progress: Progress<LanguageModelResponsePart2>;
		token: CancellationToken;
	}): Promise<void> {
		const { sessionKey, baseUrl, headers, progress, token } = args;
		const { requestBody } = args;

		if (token.isCancellationRequested) {
			throw new WsUnsupportedError("Cancelled before WS send");
		}

		const wsUrl = deriveWsUrl(baseUrl);
		// `ws` does not accept body-only headers — Authorization etc must come from `headers`.
		// Strip Content-Type / Content-Length which only make sense for HTTP bodies.
		const wsHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(headers)) {
			const lk = k.toLowerCase();
			if (lk === "content-type" || lk === "content-length" || lk === "accept") {
				continue;
			}
			wsHeaders[k] = v;
		}

		let session: WsSession;
		try {
			session = await acquireSession(sessionKey, wsUrl, wsHeaders);
		} catch (e) {
			if (e instanceof WsUnsupportedError) {
				throw e;
			}
			throw new WsUnsupportedError(`Failed to open WebSocket session: ${e instanceof Error ? e.message : String(e)}`, e);
		}

		if (session.busy) {
			// Concurrent request on the same session -> drop to HTTP for this turn.
			throw new WsUnsupportedError("WebSocket session is busy with another in-flight response");
		}
		session.busy = true;

		const framePayload = { type: "response.create", ...requestBody };
		logger.debug("responses.ws.send", { sessionKey, model: requestBody.model });

		const cancelSub = token.onCancellationRequested(() => {
			logger.debug("responses.ws.cancelled", { sessionKey });
			session.onError?.(new WsUnsupportedError("Cancelled by caller"));
			closeSessionInternal(session, "cancelled");
		});

		try {
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					const encoder = new TextEncoder();
					let closed = false;
					const safeEnqueue = (chunk: string) => {
						if (closed) {
							return;
						}
						try {
							controller.enqueue(encoder.encode(chunk));
						} catch {
							// stream already closed by reader cancellation
						}
					};
					const safeClose = () => {
						if (closed) {
							return;
						}
						closed = true;
						try {
							controller.close();
						} catch {
							// ignore
						}
					};
					const safeError = (err: Error) => {
						if (closed) {
							return;
						}
						closed = true;
						try {
							controller.error(err);
						} catch {
							// ignore
						}
					};

					session.onError = (err: Error) => {
						safeError(err);
					};

					session.onFrame = (raw: string) => {
						let parsed: any;
						try {
							parsed = JSON.parse(raw);
						} catch (e) {
							safeError(new Error(`Malformed WS frame: ${e instanceof Error ? e.message : String(e)}`));
							return;
						}
						const evtType: string | undefined = typeof parsed?.type === "string" ? parsed.type : undefined;
						if (evtType === "error") {
							const errMsg = typeof parsed.error === "string"
								? parsed.error
								: parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed);
							safeError(new WsUnsupportedError(`Upstream WS error frame: ${errMsg}`));
							return;
						}
						// Pipe the frame into the SSE parser as a single `data:` line.
						safeEnqueue(`data: ${raw}\n\n`);
						if (evtType === "response.completed" || evtType === "response.failed") {
							const respId: unknown = parsed?.response?.id;
							if (typeof respId === "string" && respId.length > 0) {
								session.lastResponseId = respId;
							}
							safeEnqueue(`data: [DONE]\n\n`);
							safeClose();
							session.onFrame = null;
							session.onError = null;
						}
					};

					try {
						session.ws.send(JSON.stringify(framePayload));
					} catch (e) {
						safeError(new WsUnsupportedError(`Failed to send response.create frame: ${e instanceof Error ? e.message : String(e)}`, e));
					}
				},
				cancel: () => {
					session.onFrame = null;
					session.onError = null;
				},
			});

			await this.processStreamingResponse(stream, progress, token);

			// Mirror the parent's captured response id into the session diagnostics.
			if (this.responseId) {
				session.lastResponseId = this.responseId;
			}
		} catch (e) {
			if (e instanceof WsUnsupportedError) {
				closeSessionInternal(session, "ws-error");
				throw e;
			}
			closeSessionInternal(session, "stream-error");
			throw new WsUnsupportedError(`WebSocket stream failed: ${e instanceof Error ? e.message : String(e)}`, e);
		} finally {
			cancelSub.dispose();
			session.onFrame = null;
			session.onError = null;
			session.busy = false;
		}
	}
}
