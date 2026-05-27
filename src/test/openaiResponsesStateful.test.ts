import * as assert from "assert";
import {
	buildOpenAIResponsesStatefulPlan,
	createOpenAIResponsesStatefulCacheBucketKey,
	createOpenAIResponsesStatefulCacheEntry,
	createPreviousResponseUnsupportedKey,
	findBestMatchingOpenAIResponsesStatefulCacheEntry,
	hasExplicitPreviousResponseIdValue,
	isGptResponsesModel,
	upsertOpenAIResponsesStatefulCacheEntry,
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
			cacheCandidate: null,
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
			cacheCandidate: null,
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
			cacheCandidate: null,
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
			cacheCandidate: null,
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
			cacheCandidate: null,
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
			cacheCandidate: null,
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>([unsupportedKey]),
		});

		assert.strictEqual(blockedPlan.addedPreviousResponseId, false);
		assert.deepStrictEqual(blockedPlan.input, fullInput);
		assert.strictEqual(otherModelPlan.addedPreviousResponseId, true);
		assert.deepStrictEqual(otherModelPlan.input, deltaInput);
	});

	test("gpt models can reuse provider cache when marker is missing", () => {
		const firstTurnInput: ResponsesInputItem[] = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }], status: "incomplete" },
		];
		const continuedConversationInput: ResponsesInputItem[] = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }], status: "completed" },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hi" }],
				id: "msg_assistant_1",
				status: "completed",
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }], status: "incomplete" },
		];
		const continuedDeltaInput: ResponsesInputItem[] = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }], status: "incomplete" },
		];

		const cacheEntry = createOpenAIResponsesStatefulCacheEntry(firstTurnInput, "resp_prev_cache_1");
		const cacheMatch = findBestMatchingOpenAIResponsesStatefulCacheEntry([cacheEntry], continuedConversationInput);
		assert.ok(cacheMatch);
		assert.strictEqual(cacheMatch?.matchedInputLength, 1);
		assert.strictEqual(cacheMatch?.entry.previousResponseId, "resp_prev_cache_1");

		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5.5",
			normalizedBaseUrl,
			fullInput: continuedConversationInput,
			deltaInput: continuedDeltaInput,
			marker: null,
			cacheCandidate: { previousResponseId: cacheMatch!.entry.previousResponseId, source: "cache" },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.addedPreviousResponseId, true);
		assert.strictEqual(plan.previousResponseId, "resp_prev_cache_1");
		assert.strictEqual(plan.previousResponseIdSource, "cache");
		assert.deepStrictEqual(plan.input, continuedDeltaInput);
	});

	test("provider cache fallback does not affect non-gpt models", () => {
		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "claude-3-7-sonnet",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: null,
			cacheCandidate: { previousResponseId: "resp_prev_cache_2", source: "cache" },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.isGptModel, false);
		assert.strictEqual(plan.addedPreviousResponseId, false);
		assert.deepStrictEqual(plan.input, fullInput);
	});

	test("cache-based previous_response_id is blocked after 4xx fallback marks the target unsupported", () => {
		const unsupportedKey = createPreviousResponseUnsupportedKey(normalizedBaseUrl, "gpt-5.5", true);
		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5.5",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: null,
			cacheCandidate: { previousResponseId: "resp_prev_cache_3", source: "cache" },
			hasDeltaMessages: true,
			explicitPreviousResponseId: false,
			unsupportedPreviousResponseIdKeys: new Set<string>([unsupportedKey]),
		});

		assert.strictEqual(plan.addedPreviousResponseId, false);
		assert.strictEqual(plan.previousResponseId, undefined);
		assert.deepStrictEqual(plan.input, fullInput);
	});

	test("null and empty previous_response_id do not disable automatic injection", () => {
		assert.strictEqual(hasExplicitPreviousResponseIdValue(undefined), false);
		assert.strictEqual(hasExplicitPreviousResponseIdValue(null), false);
		assert.strictEqual(hasExplicitPreviousResponseIdValue(""), false);
		assert.strictEqual(hasExplicitPreviousResponseIdValue("   "), false);
		assert.strictEqual(hasExplicitPreviousResponseIdValue("resp_manual_1"), true);

		const plan = buildOpenAIResponsesStatefulPlan({
			requestModel: "gpt-5.5",
			normalizedBaseUrl,
			fullInput,
			deltaInput,
			marker: null,
			cacheCandidate: { previousResponseId: "resp_prev_cache_4", source: "cache" },
			hasDeltaMessages: true,
			explicitPreviousResponseId: hasExplicitPreviousResponseIdValue(""),
			unsupportedPreviousResponseIdKeys: new Set<string>(),
		});

		assert.strictEqual(plan.addedPreviousResponseId, true);
		assert.strictEqual(plan.previousResponseId, "resp_prev_cache_4");
	});

	test("cache upsert keeps the latest conversation entry and trims old ones", () => {
		const bucketKey = createOpenAIResponsesStatefulCacheBucketKey(normalizedBaseUrl, "gpt-5.5");
		assert.strictEqual(bucketKey, "https://example.test/v1::gpt-5.5");

		const first = createOpenAIResponsesStatefulCacheEntry(fullInput, "resp_prev_old");
		const updated = createOpenAIResponsesStatefulCacheEntry(fullInput, "resp_prev_new");
		const another = createOpenAIResponsesStatefulCacheEntry(deltaInput, "resp_prev_delta");

		const upsertedOnce = upsertOpenAIResponsesStatefulCacheEntry([first], updated, 2);
		assert.strictEqual(upsertedOnce.length, 1);
		assert.strictEqual(upsertedOnce[0].previousResponseId, "resp_prev_new");

		const trimmed = upsertOpenAIResponsesStatefulCacheEntry([...upsertedOnce, another], first, 2);
		assert.strictEqual(trimmed.length, 2);
		assert.strictEqual(trimmed[trimmed.length - 1].previousResponseId, "resp_prev_old");
	});
});
