import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation } from "vscode";

import type { HFApiMode, HFModelItem, HFModelsResponse } from "./types";
import {
	createReasoningEffortConfigurationSchema,
	type ModelPickerChatInformation,
	isReasoningEffortValue,
} from "./modelConfiguration";
import { normalizeUserModels } from "./utils";
import { VersionManager } from "./versionManager";
import { fetchGeminiModels } from "./gemini/geminiApi";
import { fetchOllamaModels } from "./ollama/ollamaApi";
import { logger } from "./logger";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL_FAMILY = "oai-compatible";
const EXTENSION_LABEL = "Kong-chat-bridge";
const COPILOT_UTILITY_SMALL_FAMILY = "gpt-4o-mini";
const COPILOT_UTILITY_SMALL_ALIAS_SUFFIX = "::__copilot_utility_gpt4o_mini";

type SelectableModelPickerChatInformation = ModelPickerChatInformation & {
	readonly isUserSelectable?: boolean;
};

function lastModelSegment(modelId: string): string {
	const normalized = modelId.trim().toLowerCase();
	const parts = normalized.split(/[/:]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function inferHostModelFamily(modelId: string): string | undefined {
	const candidate = lastModelSegment(modelId);
	if (!candidate) {
		return undefined;
	}
	if (/^gpt(?:$|[-_])/.test(candidate) || /^gpt-5\.\d+/.test(candidate)) {
		return candidate;
	}
	if (/^o[34](?:$|-)/.test(candidate)) {
		return candidate;
	}
	if (candidate === "claude" || candidate.startsWith("claude-")) {
		return candidate;
	}
	if (candidate === "gemini" || candidate.startsWith("gemini-")) {
		return candidate;
	}
	if (candidate === "grok-code" || candidate.startsWith("grok-")) {
		return candidate;
	}
	return undefined;
}

export function resolveModelFamily(model: Pick<HFModelItem, "family" | "id">): string {
	const configured = model.family?.trim();
	return configured || inferHostModelFamily(model.id) || DEFAULT_MODEL_FAMILY;
}

function createCopilotUtilityAliasId(modelId: string): string {
	return `${modelId}${COPILOT_UTILITY_SMALL_ALIAS_SUFFIX}`;
}

export function sourceModelIdForCopilotUtilityAlias(modelId: string): string {
	return modelId.endsWith(COPILOT_UTILITY_SMALL_ALIAS_SUFFIX)
		? modelId.slice(0, -COPILOT_UTILITY_SMALL_ALIAS_SUFFIX.length)
		: modelId;
}

function addCopilotUtilitySmallAlias(
	infos: ModelPickerChatInformation[],
	fallbackModelId: string
): ModelPickerChatInformation[] {
	const normalizedFallbackModelId = fallbackModelId.trim();
	if (!normalizedFallbackModelId) {
		return infos;
	}
	if (infos.some((info) => info.family?.trim().toLowerCase() === COPILOT_UTILITY_SMALL_FAMILY)) {
		return infos;
	}

	const target = infos.find(
		(info) =>
			info.id === normalizedFallbackModelId ||
			info.id.startsWith(`${normalizedFallbackModelId}::`) ||
			info.id.startsWith(`${normalizedFallbackModelId}:`)
	);
	if (!target) {
		logger.warn("models.utilityFallback.notFound", { fallbackModelId: normalizedFallbackModelId });
		return infos;
	}

	const aliasId = createCopilotUtilityAliasId(target.id);
	if (infos.some((info) => info.id === aliasId)) {
		return infos;
	}

	const alias: SelectableModelPickerChatInformation = {
		...target,
		id: aliasId,
		family: COPILOT_UTILITY_SMALL_FAMILY,
		detail: `${target.detail} (${COPILOT_UTILITY_SMALL_FAMILY} compatibility)`,
		tooltip: `${target.tooltip ?? target.detail} (${COPILOT_UTILITY_SMALL_FAMILY} compatibility)`,
		isUserSelectable: false,
	};

	return [...infos, alias];
}

/**
 * Get the list of available language models contributed by this provider
 * @param options Options which specify the calling context of this function
 * @param token A cancellation token which signals if the user cancelled the request or not
 * @returns A promise that resolves to the list of available language models
 */
export async function prepareLanguageModelChatInformation(
	options: { silent: boolean },
	_token: CancellationToken,
	secrets: vscode.SecretStorage
): Promise<LanguageModelChatInformation[]> {
	// Check for user-configured models first
	const config = vscode.workspace.getConfiguration();
	const userModels = normalizeUserModels(config.get<unknown>("kong-chat-bridge.models", []));

	let infos: ModelPickerChatInformation[];
	if (userModels && userModels.length > 0) {
		// Return user-provided models directly
		infos = userModels
			.filter((m) => !m.id.startsWith("__provider__"))
			.map((m) => {
				const contextLen = m?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = m?.max_completion_tokens ?? m?.max_tokens ?? DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);

				// Use configId when present so each model configuration stays distinct.
				const modelId = m.configId ? `${m.id}::${m.configId}` : m.id;
				const modelName = m.displayName || (m.configId ? `${m.id}::${m.configId}` : `${m.id}`);
				const detail = m.owned_by ? `${m.owned_by} (${EXTENSION_LABEL})` : EXTENSION_LABEL;
				const reasoningEffort = isReasoningEffortValue(m.reasoning_effort) ? m.reasoning_effort : undefined;
				const family = resolveModelFamily(m);

				return {
					id: modelId,
					name: modelName,
					detail: detail,
					tooltip: detail,
					family,
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					...(reasoningEffort
						? { configurationSchema: createReasoningEffortConfigurationSchema(reasoningEffort) }
						: {}),
					capabilities: {
						toolCalling: true,
						imageInput: m?.vision ?? false,
					},
				} satisfies ModelPickerChatInformation;
			});
	} else {
		// Fallback: Fetch models from API
		const apiKey = await ensureApiKey(options.silent, secrets);
		if (!apiKey) {
			if (options.silent) {
				return [];
			} else {
				throw new Error("Kong Bridge API key not found");
			}
		}

		const config = vscode.workspace.getConfiguration();
		const BASE_URL = config.get<string>("kong-chat-bridge.baseUrl", "");
		if (!BASE_URL || !BASE_URL.startsWith("http")) {
			throw new Error(`Invalid base URL configuration.`);
		}
		const { models } = await fetchModels(BASE_URL, apiKey);

		infos = models.flatMap((m) => {
			const providers = m?.providers ?? [];
			const modalities = m.architecture?.input_modalities ?? [];
			const vision = Array.isArray(modalities) && modalities.includes("image");

			// Build entries for all providers that support tool calling
			const toolProviders = providers.filter((p) => p.supports_tools === true);
			const entries: ModelPickerChatInformation[] = [];

			for (const p of toolProviders) {
				const contextLen = p?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				const detail = p.provider ? `${p.provider} (${EXTENSION_LABEL})` : EXTENSION_LABEL;
				entries.push({
					id: `${m.id}:${p.provider}`,
					name: `${m.id}`,
					detail: detail,
					tooltip: detail,
					family: resolveModelFamily(m),
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation);
			}

			if (entries.length === 0) {
				const base = providers.length > 0 ? providers[0] : null;
				const contextLen = base?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				entries.push({
					id: `${m.id}`,
					name: `${m.id}`,
					detail: EXTENSION_LABEL,
					tooltip: EXTENSION_LABEL,
					family: resolveModelFamily(m),
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: true,
					},
				} satisfies LanguageModelChatInformation);
			}

			return entries;
		});
	}

	const utilityFallbackModel = config.get<string>("kong-chat-bridge.copilotUtilitySmallFallbackModel", "");
	infos = addCopilotUtilitySmallAlias(infos, utilityFallbackModel);
	logger.info("models.loaded", { count: infos.length, source: userModels && userModels.length > 0 ? "config" : "api" });
	return infos;
}

/**
 * Fetch the list of models and supplementary metadata from Provider.
 */
export async function fetchModels(
	baseUrl: string,
	apiKey: string,
	apiMode?: HFApiMode | string,
	customHeaders?: Record<string, string>
): Promise<{ models: HFModelItem[] }> {
	const normalizedApiMode = apiMode ?? "openai";
	if (normalizedApiMode === "gemini") {
		const models = await fetchGeminiModels(baseUrl, apiKey, customHeaders);
		return { models };
	} else if (normalizedApiMode === "ollama") {
		const models = await fetchOllamaModels(baseUrl, apiKey, customHeaders);
		return { models };
	}

	const modelsList = (async () => {
		const baseHeaders: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": VersionManager.getUserAgent(),
		};
		const headers = customHeaders ? { ...baseHeaders, ...customHeaders } : baseHeaders;
		const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			method: "GET",
			headers,
		});
		if (!resp.ok) {
			let text = "";
			try {
				text = await resp.text();
			} catch (error) {
				console.error("[Kong Bridge Model Provider] Failed to read response text", error);
			}
			const err = new Error(
				`Failed to fetch Kong Bridge models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
			);
			console.error("[Kong Bridge Model Provider] Failed to fetch Kong Bridge models", err);
			throw err;
		}
		const parsed = (await resp.json()) as HFModelsResponse;
		return parsed.data ?? [];
	})();

	try {
		const models = await modelsList;
		return { models };
	} catch (err) {
		const errorObj = err instanceof Error ? err : new Error(String(err));
		console.error("[Kong Bridge Model Provider] Failed to fetch Kong Bridge models", err);
		logger.error("models.fetch.error", { baseUrl, error: errorObj.message });
		throw err;
	}
}

/**
 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
 * @param silent If true, do not prompt the user.
 * @param secrets vscode.SecretStorage
 */
async function ensureApiKey(silent: boolean, secrets: vscode.SecretStorage): Promise<string | undefined> {
	// Fall back to generic API key
	let apiKey = await secrets.get("kong-chat-bridge.apiKey");

	if (!apiKey && !silent) {
		const entered = await vscode.window.showInputBox({
			title: "Kong Bridge API Key",
			prompt: "Enter your Kong Bridge API key",
			ignoreFocusOut: true,
			password: true,
		});
		if (entered && entered.trim()) {
			apiKey = entered.trim();
			await secrets.store("kong-chat-bridge.apiKey", apiKey);
		}
	}
	return apiKey;
}
