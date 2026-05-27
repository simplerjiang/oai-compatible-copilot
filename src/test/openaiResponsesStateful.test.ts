import * as assert from "assert";
import {
	buildOpenAIResponsesStatefulPlan,
	createPreviousResponseUnsupportedKey,
	isGptResponsesModel,
} from "../openai/openaiResponsesStateful";
import type { ResponsesInputItem } from "../openai/openaiResponsesApi";

suite("openaiResponsesStateful", () => {
	const normalizedBaseUrl = "https://example.test/v1";
	const fullInput: ResponsesInputItem[] = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }], status: "completed" },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }], status: "completed" },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }], status: "incomplete" },
	];
	const deltaInput: ResponsesInputItem[] = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }], status: "incomplete" },
	];

	test("identifies gpt responses models from the request model", () => {
		assert.strictEqual(isGptResponsesModel("gpt-5.5"), true);
		assert.strictEqual(isGptResponsesModel("openai/gpt-5-codex"), true);
		assert.strictEqual(isGptResponsesModel("claude-3-7-sonnet"), false);
	});

	test("gpt models prefer previous_response_id with delta-only input", () => {
		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5.5",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: { marker: "resp_prev_1", index: 1 },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.isGptModel, true);
		assert.strictEqual(plan.addedPreviousResponseId, true);
		assert.strictEqual(plan.previousResponseId, "resp_prev_1");
		assert.deepStrictEqual(plan.input, deltaInput);
	});

	test("non-gpt models keep current behavior when delta conversion is empty", () => {
		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "claude-3-7-sonnet",
			normalizedBaseUrl,
			fullInput,
			deltaInput: null,
			marker: { marker: "resp_prev_1", index: 1 },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.isGptModel, false);
		assert.strictEqual(plan.addedPreviousResponseId, false);
		assert.strictEqual(plan.previousResponseId, undefined);
		assert.deepStrictEqual(plan.input, fullInput);
	});

	test("gpt models still avoid replaying history when only tool-output delta remains", () => {
		const toolDelta: ResponsesInputItem[] = [
			{
				type: "function_call_output",
				call_id: "call_123",
				output: "{\"result\":true}",
				id: "fco_123",
				status: "completed",
			},
		];
		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5-codex",
			normalizedBaseUrl,
			fullInput,
			deltaInput: toolDelta,
			marker: { marker: "resp_prev_2", index: 1 },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.addedPreviousResponseId, true);
		assert.deepStrictEqual(plan.input, toolDelta);
	});

	test("explicit previous_response_id keeps full input untouched", () => {
		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5.4",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: { marker: "resp_prev_3", index: 1 },
			hasDeltaMessages: true,
			explicitPreviousResponseId: true,
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.addedPreviousResponseId, false);
		assert.strictEqual(plan.previousResponseId, undefined);
		assert.deepStrictEqual(plan.input, fullInput);
	});

	test("unsupported previous_response_id fallback is scoped to the gpt model", () => {
		const unsupportedKey = createPreviousResponseUnsupportedKey(normalizedBaseUrl, "gpt-5.5", true);
		const blockedPlan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5.5",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: { marker: "resp_prev_4", index: 1 },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>([unsupportedKey]),
		});
		const otherModelPlan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5-codex",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: { marker: "resp_prev_5", index: 1 },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>([unsupportedKey]),
		});

		assert.strictEqual(blockedPlan.addedPreviousResponseId, false);
		assert.deepStrictEqual(blockedPlan.input, fullInput);
		assert.strictEqual(otherModelPlan.addedPreviousResponseId, true);
		assert.deepStrictEqual(otherModelPlan.input, deltaInput);
	});
});
