import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LanguageModelTextPart } from "vscode";
import { OpenaiResponsesWebsocketApi } from "../openai/openaiResponsesWebsocketApi";

async function sendProbe(
	api: OpenaiResponsesWebsocketApi,
	sessionKey: string,
	key: string,
	prompt: string,
	previousResponseId?: string
): Promise<string> {
	const cts = new vscode.CancellationTokenSource();
	let text = "";
	try {
		const requestBody: Record<string, unknown> = {
			model: "gpt-5.5",
			input: [{
				role: "user",
				content: [{ type: "input_text", text: prompt }],
				type: "message",
				status: "incomplete",
			}],
			stream: true,
			store: false,
			prompt_cache_key: "kong-chat-bridge-gpt-5.5",
			reasoning: { effort: "high" },
			service_tier: "priority",
		};
		if (previousResponseId) {
			requestBody.previous_response_id = previousResponseId;
		}
		await api.sendOverWebsocket({
			sessionKey,
			baseUrl: "http://165.232.161.99/v1",
			headers: {
				Authorization: `Bearer ${key}`,
				"User-Agent": "kong-chat-bridge/1.0.0 VSCode/1.122.0",
				"X-Client-Request-Id": `kong-chat-bridge-probe-${sessionKey}`,
			},
			requestBody,
			progress: {
				report(part) {
					if (part instanceof LanguageModelTextPart) {
						text += part.value;
					}
				},
			},
			token: cts.token,
		});
		return text.trim();
	} finally {
		cts.dispose();
	}
}

suite("remoteWsProbe", () => {
	test("reuses one WebSocket and previous_response_id for sequential extension-host sends when enabled", async function () {
		if (process.env.OAICOPILOT_REMOTE_WS_PROBE !== "1") {
			this.skip();
		}

		this.timeout(60000);

		const keyFile = path.resolve(__dirname, "..", "..", "..", "..", "key.txt");
		const raw = fs.readFileSync(keyFile, "utf8");
		const bearerMatches = [...raw.matchAll(/Bearer\s+([^\s]+)/gi)];
		const key = (bearerMatches.length > 0
			? bearerMatches[bearerMatches.length - 1][1]
			: raw.match(/[A-Za-z0-9._-]{20,}/)?.[0] ?? "").trim();
		assert.ok(key, "API key not found");

		const api = new OpenaiResponsesWebsocketApi("gpt-5.5");
		const sessionKey = `probe-${Date.now()}`;
		const token = `EXT_HOST_WS_MEMORY_${Date.now().toString(36)}`;

		assert.strictEqual(await sendProbe(api, sessionKey, key, `Remember token ${token}. Answer exactly READY.`), "READY");
		assert.ok(api.responseId, "first response id missing");
		const previousResponseId = api.responseId;
		assert.strictEqual(
			await sendProbe(api, sessionKey, key, `What token did I ask you to remember? Answer exactly ${token}.`, previousResponseId),
			token
		);
		assert.ok(api.responseId, "response id missing");
	});
});
