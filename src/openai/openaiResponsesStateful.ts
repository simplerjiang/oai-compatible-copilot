import type { ResponsesInputItem } from "./openaiResponsesApi";

export interface OpenAIResponsesStatefulMarkerLocation {
	marker: string;
	index: number;
}

export interface OpenAIResponsesStatefulCacheEntry {
	conversationFingerprint: string;
	canonicalInputItems: string[];
	previousResponseId: string;
}

export interface OpenAIResponsesStatefulCacheMatch {
	entry: OpenAIResponsesStatefulCacheEntry;
	matchedInputLength: number;
}

export interface OpenAIResponsesPreviousResponseCandidate {
	previousResponseId: string;
	source: "marker" | "cache";
}

export interface OpenAIResponsesStatefulPlan {
	input: ResponsesInputItem[];
	previousResponseId?: string;
	addedPreviousResponseId: boolean;
	previousResponseIdSource?: "marker" | "cache";
	isGptModel: boolean;
	unsupportedKey: string;
}

export interface BuildOpenAIResponsesStatefulPlanParams {
	requestModel: string;
	normalizedBaseUrl: string;
	fullInput: ResponsesInputItem[];
	deltaInput: ResponsesInputItem[] | null;
	marker: OpenAIResponsesStatefulMarkerLocation | null;
	cacheCandidate?: OpenAIResponsesPreviousResponseCandidate | null;
	hasDeltaMessages: boolean;
	explicitPreviousResponseId: boolean;
	unsupportedPreviousResponseIdKeys: ReadonlySet<string>;
	modelFamily?: string;
	displayName?: string;
	modelId?: string;
}

function normalizeModelHint(value: string | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function getLastModelSegment(value: string): string {
	const normalized = normalizeModelHint(value);
	if (!normalized) {
		return "";
	}
	const segments = normalized.split(/[\/:]/).filter(Boolean);
	return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

function isGptLikeModelName(value: string): boolean {
	const candidate = getLastModelSegment(value);
	return /^gpt(?:$|[-_])/.test(candidate);
}

export function isGptResponsesModel(requestModel: string, hints?: { modelFamily?: string; displayName?: string; modelId?: string }): boolean {
	const requestModelNormalized = normalizeModelHint(requestModel);
	if (requestModelNormalized) {
		return isGptLikeModelName(requestModelNormalized);
	}

	for (const hint of [hints?.modelFamily, hints?.displayName, hints?.modelId]) {
		if (normalizeModelHint(hint) && isGptLikeModelName(hint ?? "")) {
			return true;
		}
	}

	return false;
}

export function createPreviousResponseUnsupportedKey(normalizedBaseUrl: string, requestModel: string, isGptModel: boolean): string {
	return isGptModel ? `${normalizedBaseUrl}::${requestModel}` : normalizedBaseUrl;
}

export function createOpenAIResponsesStatefulCacheBucketKey(normalizedBaseUrl: string, requestModel: string): string {
	return `${normalizedBaseUrl}::${requestModel}`;
}

export function hasExplicitPreviousResponseIdValue(value: unknown): boolean {
	if (typeof value === "string") {
		return value.trim().length > 0;
	}

	return value !== undefined && value !== null;
}

function canonicalizeResponsesInputItem(item: ResponsesInputItem): Record<string, unknown> {
	if (item.type === "function_call") {
		return {
			type: item.type,
			call_id: item.call_id,
			name: item.name,
			arguments: item.arguments,
		};
	}

	if (item.type === "function_call_output") {
		return {
			type: item.type,
			call_id: item.call_id,
			output: item.output,
		};
	}

	if (item.type === "reasoning") {
		return {
			type: item.type,
			summary: item.summary.map((part) => ({ type: part.type, text: part.text ?? "" })),
		};
	}

	return {
		type: item.type ?? "message",
		role: item.role,
		content: item.content.map((part) => ({
			type: part.type,
			text: part.text ?? "",
			image_url: part.image_url ?? "",
			detail: part.detail ?? "",
		})),
	};
}

function serializeCanonicalResponsesInputItem(item: ResponsesInputItem): string {
	return JSON.stringify(canonicalizeResponsesInputItem(item));
}

function createConversationFingerprintFromCanonicalItems(canonicalInputItems: string[]): string {
	let hash = 2166136261;
	const joined = canonicalInputItems.join("\u001f");
	for (let i = 0; i < joined.length; i++) {
		hash ^= joined.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function createOpenAIResponsesStatefulCacheEntry(
	input: ResponsesInputItem[],
	previousResponseId: string
): OpenAIResponsesStatefulCacheEntry {
	const canonicalInputItems = input.map(serializeCanonicalResponsesInputItem);
	return {
		conversationFingerprint: createConversationFingerprintFromCanonicalItems(canonicalInputItems),
		canonicalInputItems,
		previousResponseId,
	};
}

export function findBestMatchingOpenAIResponsesStatefulCacheEntry(
	entries: readonly OpenAIResponsesStatefulCacheEntry[],
	currentInput: ResponsesInputItem[]
): OpenAIResponsesStatefulCacheMatch | null {
	if (entries.length === 0 || currentInput.length === 0) {
		return null;
	}

	const canonicalCurrentInputItems = currentInput.map(serializeCanonicalResponsesInputItem);
	let bestMatch: OpenAIResponsesStatefulCacheMatch | null = null;

	for (const entry of entries) {
		const candidateLength = entry.canonicalInputItems.length;
		if (candidateLength === 0 || candidateLength >= canonicalCurrentInputItems.length) {
			continue;
		}

		let isPrefixMatch = true;
		for (let i = 0; i < candidateLength; i++) {
			if (entry.canonicalInputItems[i] !== canonicalCurrentInputItems[i]) {
				isPrefixMatch = false;
				break;
			}
		}

		if (!isPrefixMatch) {
			continue;
		}

		if (!bestMatch || candidateLength > bestMatch.matchedInputLength) {
			bestMatch = {
				entry,
				matchedInputLength: candidateLength,
			};
		}
	}

	return bestMatch;
}

export function upsertOpenAIResponsesStatefulCacheEntry(
	entries: readonly OpenAIResponsesStatefulCacheEntry[],
	entry: OpenAIResponsesStatefulCacheEntry,
	limit = 8
): OpenAIResponsesStatefulCacheEntry[] {
	const filtered = entries.filter((existing) => existing.conversationFingerprint !== entry.conversationFingerprint);
	filtered.push(entry);
	if (filtered.length <= limit) {
		return filtered;
	}
	return filtered.slice(filtered.length - limit);
}

export function buildOpenAIResponsesStatefulPlan(
	params: BuildOpenAIResponsesStatefulPlanParams
): OpenAIResponsesStatefulPlan {
	const isGptModel = isGptResponsesModel(params.requestModel, {
		modelFamily: params.modelFamily,
		displayName: params.displayName,
		modelId: params.modelId,
	});
	const unsupportedKey = createPreviousResponseUnsupportedKey(
		params.normalizedBaseUrl,
		params.requestModel,
		isGptModel
	);

	if (params.explicitPreviousResponseId) {
		return {
			input: params.fullInput,
			addedPreviousResponseId: false,
			isGptModel,
			unsupportedKey,
		};
	}

	const previousResponseCandidate = params.marker?.marker
		? { previousResponseId: params.marker.marker, source: "marker" as const }
		: isGptModel
			? params.cacheCandidate ?? null
			: null;
	const hasReusablePreviousResponseId = !!previousResponseCandidate?.previousResponseId;
	const isUnsupported = params.unsupportedPreviousResponseIdKeys.has(unsupportedKey);
	const canUseDeltaInput = Array.isArray(params.deltaInput) && params.deltaInput.length > 0;
	const canUsePreviousResponseId =
		hasReusablePreviousResponseId &&
		!isUnsupported &&
		(isGptModel ? params.hasDeltaMessages : canUseDeltaInput);

	return {
		input: canUsePreviousResponseId ? (params.deltaInput ?? []) : params.fullInput,
		previousResponseId: canUsePreviousResponseId ? previousResponseCandidate!.previousResponseId : undefined,
		addedPreviousResponseId: canUsePreviousResponseId,
		previousResponseIdSource: canUsePreviousResponseId ? previousResponseCandidate!.source : undefined,
		isGptModel,
		unsupportedKey,
	};
}
