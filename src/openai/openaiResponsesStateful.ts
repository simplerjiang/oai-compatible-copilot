import type { ResponsesInputItem } from "./openaiResponsesApi";

export interface OpenAIResponsesStatefulMarkerLocation {
	marker: string;
	index: number;
}

export interface OpenAIResponsesStatefulPlan {
	input: ResponsesInputItem[];
	previousResponseId?: string;
	addedPreviousResponseId: boolean;
	isGptModel: boolean;
	unsupportedKey: string;
}

export interface BuildOpenAIResponsesStatefulPlanParams {
	requestModel: string;
	normalizedBaseUrl: string;
	fullInput: ResponsesInputItem[];
	deltaInput: ResponsesInputItem[] | null;
	marker: OpenAIResponsesStatefulMarkerLocation | null;
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

	const hasReusableMarker = !!params.marker?.marker;
	const isUnsupported = params.unsupportedPreviousResponseIdKeys.has(unsupportedKey);
	const canUseDeltaInput = Array.isArray(params.deltaInput) && params.deltaInput.length > 0;
	const canUsePreviousResponseId =
		hasReusableMarker &&
		!isUnsupported &&
		(isGptModel ? params.hasDeltaMessages : canUseDeltaInput);

	return {
		input: canUsePreviousResponseId ? (params.deltaInput ?? []) : params.fullInput,
		previousResponseId: canUsePreviousResponseId ? params.marker!.marker : undefined,
		addedPreviousResponseId: canUsePreviousResponseId,
		isGptModel,
		unsupportedKey,
	};
}
