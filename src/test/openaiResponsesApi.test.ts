import * as assert from "assert";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";

suite("openaiResponsesApi", () => {
	test("sanitizes unsupported websocket parameters and forces store false", () => {
		const api = new OpenaiResponsesApi("gpt-5.5");
		const sanitized = api.sanitizeRequestBody(
			{
				model: "gpt-5.5",
				input: "hello",
				stream: true,
				temperature: 0,
				top_p: 1,
				max_output_tokens: 4096,
				previous_response_id: "resp_previous",
				presence_penalty: 0,
				frequency_penalty: 0,
				prompt_cache_retention: "24h",
				safety_identifier: "user-123",
				store: true,
				prompt_cache_key: "kong-chat-bridge-gpt-5.5",
				reasoning: { effort: "high" },
				parallel_tool_calls: true,
				text: { verbosity: "medium" },
			},
			"websocket"
		);

		assert.deepStrictEqual(sanitized, {
			model: "gpt-5.5",
			input: "hello",
			stream: true,
			previous_response_id: "resp_previous",
			store: false,
			prompt_cache_key: "kong-chat-bridge-gpt-5.5",
			reasoning: { effort: "high" },
			parallel_tool_calls: true,
			text: { verbosity: "medium" },
		});
	});

	test("sanitizes redundant http parameters and preserves useful extras", () => {
		const api = new OpenaiResponsesApi("gpt-5.5");
		const sanitized = api.sanitizeRequestBody(
			{
				model: "gpt-5.5",
				input: "hello",
				stream: true,
				temperature: 0,
				top_p: 1,
				max_output_tokens: 4096,
				presence_penalty: 0,
				frequency_penalty: 0,
				prompt_cache_retention: "24h",
				safety_identifier: "user-123",
				store: true,
				tool_choice: "auto",
				tools: [{ type: "function", name: "example" }],
				service_tier: "priority",
				prompt_cache_key: "kong-chat-bridge-gpt-5.5",
			},
			"http"
		);

		assert.deepStrictEqual(sanitized, {
			model: "gpt-5.5",
			input: "hello",
			stream: true,
			store: false,
			tool_choice: "auto",
			tools: [{ type: "function", name: "example" }],
			service_tier: "priority",
			prompt_cache_key: "kong-chat-bridge-gpt-5.5",
		});
	});
});
