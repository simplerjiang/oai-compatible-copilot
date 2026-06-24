import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	Progress,
} from "vscode";

import type { HFModelItem } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { parseModelId, createRetryConfig, executeWithRetry, normalizeUserModels } from "./utils";

import { prepareLanguageModelChatInformation, sourceModelIdForCopilotUtilityAlias } from "./provideModel";
import { countMessageTokens } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi, type OpenAIResponsesTransport } from "./openai/openaiResponsesApi";
import {
	hasOpenAIResponsesWebsocketSession,
	OpenaiResponsesWebsocketApi,
	WsUnsupportedError,
} from "./openai/openaiResponsesWebsocketApi";
import {
	buildOpenAIResponsesStatefulPlan,
	createOpenAIResponsesStatefulCacheBucketKey,
	createOpenAIResponsesStatefulCacheEntry,
	findBestMatchingOpenAIResponsesStatefulCacheEntry,
	hasExplicitPreviousResponseIdValue,
	upsertOpenAIResponsesStatefulCacheEntry,
} from "./openai/openaiResponsesStateful";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi } from "./commonApi";
import { logger } from "./logger";
import type { LanguageModelProgressPart } from "./vscodeLanguageModelCompat";

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();
	private readonly _openaiResponsesPreviousResponseIdUnsupportedTargets = new Set<string>();
	private readonly _openaiResponsesStatefulCacheByTarget = new Map<
		string,
		ReturnType<typeof createOpenAIResponsesStatefulCacheEntry>[]
	>();
	private readonly _openaiResponsesWsSessionKeyByResponseId = new Map<string, string>();
	private _openaiResponsesWsSessionSeq = 0;

	static readonly OPENAI_RESPONSES_STATEFUL_MARKER_MIME = "application/vnd.kong-chat-bridge.stateful-marker";

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly statusBarItem: vscode.StatusBarItem
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token, this.secrets);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return countMessageTokens(text, { includeReasoningInRequest: true });
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelProgressPart>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelProgressPart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[Kong Bridge Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		const requestStartTime = Date.now();
		try {
			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("kong-chat-bridge.models", []));

			// Parse model ID to handle config ID
			const requestModelId = sourceModelIdForCopilotUtilityAlias(model.id);
			const parsedModelId = parseModelId(requestModelId);

			// Find matching user model configuration
			// Prioritize matching models with same base ID and config ID
			// If no config ID, match models with same base ID
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// If still no model found, try to find any model matching the base ID (most lenient match, for backward compatibility)
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			// Check if using Ollama native API mode
			const apiMode = um?.apiMode ?? "openai";
			const baseUrl = um?.baseUrl || config.get<string>("kong-chat-bridge.baseUrl", "");

			logger.info("request.start", {
				modelId: model.id,
				messageCount: messages.length,
				apiMode,
				baseUrl,
			});

			// Prepare model configuration
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
			};

			// Update Token Usage
			updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig);

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("kong-chat-bridge.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					logger.debug("request.delay", {
						delayMs,
						elapsed,
						remainingDelay,
					});
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key for the model's provider
			const provider = um?.owned_by;
			const useGenericKey = !um?.baseUrl;
			const modelApiKey = await this.ensureApiKey(useGenericKey, provider);
			if (!modelApiKey) {
				logger.warn("apiKey.missing", {
					provider: provider ?? "",
					useGenericKey,
				});
				throw new Error("Kong Bridge API key not found");
			}

			// send chat request
			const BASE_URL = baseUrl;
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			// get retry config
			const retryConfig = createRetryConfig();

			// prepare headers with custom headers if specified
			const requestHeaders = CommonApi.prepareHeaders(modelApiKey, apiMode, um?.headers);
			logger.debug("request.headers", {
				headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
			});
			logger.debug("request.messages.origin", {
				messages,
			});
			if (apiMode === "ollama") {
				// Ollama native API mode
				const ollamaApi = new OllamaApi(requestModelId);
				const ollamaMessages = ollamaApi.convertMessages(messages, modelConfig);

				let ollamaRequestBody: OllamaRequestBody = {
					model: parsedModelId.baseId,
					messages: ollamaMessages,
					stream: true,
				};
				ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, um, options);

				// send Ollama chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/api/chat`;
				logger.debug("request.body", {
					url: url,
					requestBody: ollamaRequestBody,
				});
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(ollamaRequestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Ollama Provider] Ollama API error response", errorText);
						throw new Error(
							`Ollama API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Ollama API");
				}
				await ollamaApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "anthropic") {
				// Anthropic API mode
				const anthropicApi = new AnthropicApi(requestModelId, um?.cache_control !== false);
				const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: AnthropicRequestBody = {
					model: parsedModelId.baseId,
					messages: anthropicMessages,
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

				// send Anthropic chat request with retry
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				// Some providers require configuring the baseUrl with a version suffix (e.g. .../v1).
				// Avoid double-appending (e.g. .../v1/v1/messages).
				const url = normalizedBaseUrl.endsWith("/v1")
					? `${normalizedBaseUrl}/messages`
					: `${normalizedBaseUrl}/v1/messages`;
				logger.debug("request.body", { url, requestBody });
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Anthropic Provider] Anthropic API error response", errorText);
						throw new Error(
							`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "openai-responses" || apiMode === "openai-responses-ws") {
				// OpenAI Responses API mode (HTTP or per-run WebSocket transport).
				const useWs = apiMode === "openai-responses-ws";
				const openaiResponsesApi: OpenaiResponsesApi = useWs
					? new OpenaiResponsesWebsocketApi(requestModelId)
					: new OpenaiResponsesApi(requestModelId);
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				const statefulModelId = parsedModelId.baseId;

				// Convert full history once (also extracts system `instructions`).
				const fullInput = openaiResponsesApi.convertMessages(messages, modelConfig);
				const statefulCacheBucketKey = createOpenAIResponsesStatefulCacheBucketKey(
					normalizedBaseUrl,
					statefulModelId
				);
				const statefulCacheEntries = this._openaiResponsesStatefulCacheByTarget.get(statefulCacheBucketKey) ?? [];
				const cacheMatch = findBestMatchingOpenAIResponsesStatefulCacheEntry(statefulCacheEntries, fullInput);

				const marker = findLastOpenAIResponsesStatefulMarker(statefulModelId, messages);
				let deltaInput: ReturnType<OpenaiResponsesApi["convertMessages"]> | null = null;
				const cacheDeltaAnchorIndex = !marker && cacheMatch ? findLastAssistantMessageIndex(messages) : -1;
				const deltaAnchorIndex = marker?.index ?? cacheDeltaAnchorIndex;
				const hasDeltaMessages = deltaAnchorIndex >= 0 && deltaAnchorIndex < messages.length - 1;
				if (hasDeltaMessages) {
					const deltaMessages = messages.slice(deltaAnchorIndex + 1);
					const converted = openaiResponsesApi.convertMessages(deltaMessages, modelConfig);
					if (converted.length > 0) {
						deltaInput = converted;
					}
				}

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					input: fullInput,
					stream: true,
				};

				requestBody = openaiResponsesApi.prepareRequestBody(requestBody, um, options);

				// Add prompt_cache_key to enable OpenAI prompt caching.
				// Without this parameter, cached_tokens is always 0 even with identical requests.
				if (!requestBody.prompt_cache_key) {
					requestBody.prompt_cache_key = `kong-chat-bridge-${parsedModelId.baseId}`;
				}
				// send Responses API request with retry
				const url = `${normalizedBaseUrl}/responses`;
				logger.debug("request.body", { url, requestBody });

				// If the user explicitly set `previous_response_id` via `extra`, don't apply stateful slicing.
				const statefulPlan = buildOpenAIResponsesStatefulPlan({
					requestModel: parsedModelId.baseId,
					normalizedBaseUrl,
					fullInput,
					deltaInput,
					marker,
					cacheCandidate:
						!marker && cacheMatch
							? {
								previousResponseId: cacheMatch.entry.previousResponseId,
								source: "cache",
							}
							: null,
					hasDeltaMessages,
					explicitPreviousResponseId: hasExplicitPreviousResponseIdValue(requestBody.previous_response_id),
					unsupportedPreviousResponseIdKeys: this._openaiResponsesPreviousResponseIdUnsupportedTargets,
					modelFamily: um?.family,
					displayName: um?.displayName,
					modelId: model.id,
				});
				const explicitPreviousResponseId = hasExplicitPreviousResponseIdValue(requestBody.previous_response_id);
				const wsPreviousResponseId = marker?.marker || cacheMatch?.entry.previousResponseId || "";
				const mappedWsSessionKey = wsPreviousResponseId
					? this._openaiResponsesWsSessionKeyByResponseId.get(wsPreviousResponseId)
					: undefined;
				const wsHasMappedLiveSession =
					useWs &&
					!!mappedWsSessionKey &&
					hasOpenAIResponsesWebsocketSession(mappedWsSessionKey);
				const wsSessionKey = useWs && wsHasMappedLiveSession
					? mappedWsSessionKey!
					: useWs
						? this.createOpenAIResponsesWsSessionKey(statefulCacheBucketKey)
						: statefulCacheBucketKey;
				const wsHasLiveSession = useWs && wsHasMappedLiveSession;
				const wsCanUseDeltaInput =
					wsHasLiveSession &&
					statefulPlan.isGptModel &&
					!explicitPreviousResponseId &&
					!!wsPreviousResponseId &&
					(!!marker?.marker || !!cacheMatch) &&
					hasDeltaMessages &&
					Array.isArray(deltaInput) &&
					deltaInput.length > 0;

				if (useWs) {
					requestBody.input = wsCanUseDeltaInput ? deltaInput : fullInput;
					if (wsCanUseDeltaInput) {
						requestBody.previous_response_id = wsPreviousResponseId;
					} else {
						delete requestBody.previous_response_id;
					}
				} else {
					requestBody.input = statefulPlan.input;
					if (statefulPlan.addedPreviousResponseId) {
						requestBody.previous_response_id = statefulPlan.previousResponseId;
					}
				}

				logger.debug("responses.stateful.plan", {
					modelId: model.id,
					requestModel: parsedModelId.baseId,
					isGptModel: statefulPlan.isGptModel,
					hasMarker: !!marker?.marker,
					hasCacheMatch: !!cacheMatch,
					hasDeltaMessages,
					deltaInputLength: Array.isArray(deltaInput) ? deltaInput.length : 0,
					usedPreviousResponseId: !useWs && statefulPlan.addedPreviousResponseId,
					previousResponseIdSource: !useWs ? statefulPlan.previousResponseIdSource ?? "" : "",
					wsHasLiveSession,
					wsCanUseDeltaInput,
					wsMappedSession: !!mappedWsSessionKey,
					wsMappedSessionLive: wsHasMappedLiveSession,
					usedDeltaInput: requestBody.input !== fullInput,
				});

				const buildResponsesTransportBody = (transport: OpenAIResponsesTransport): Record<string, unknown> =>
					openaiResponsesApi.sanitizeRequestBody(requestBody, transport);

				const sendRequest = async (body: Record<string, unknown>) =>
					await executeWithRetry(async () => {
						const res = await fetch(url, {
							method: "POST",
							headers: requestHeaders,
							body: JSON.stringify(body),
						});

						if (!res.ok) {
							const errorText = await res.text();
							const error = new Error(
								`Responses API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							);
							(error as { status?: number; errorText?: string }).status = res.status;
							(error as { status?: number; errorText?: string }).errorText = errorText;
							throw error;
						}

						return res;
					}, retryConfig);

				const wsUsedDeltaInput = useWs && requestBody.input !== fullInput;
				let wsHandled = false;
				if (useWs) {
					try {
						const wsRequestBody = buildResponsesTransportBody("websocket");
						const wsRequestHeaders = {
							...requestHeaders,
							"X-Client-Request-Id": createOpenAIResponsesWebsocketClientRequestId(wsSessionKey),
						};
						logger.debug("responses.ws.body", {
							modelId: model.id,
							requestModel: parsedModelId.baseId,
							sessionKey: wsSessionKey,
							keys: Object.keys(wsRequestBody).sort(),
							store: wsRequestBody.store,
							hasPreviousResponseId: Object.prototype.hasOwnProperty.call(wsRequestBody, "previous_response_id"),
							inputLength: Array.isArray(wsRequestBody.input) ? wsRequestBody.input.length : 0,
							toolCount: Array.isArray(wsRequestBody.tools) ? wsRequestBody.tools.length : 0,
						});
						await (openaiResponsesApi as OpenaiResponsesWebsocketApi).sendOverWebsocket({
							sessionKey: wsSessionKey,
							baseUrl: normalizedBaseUrl,
							headers: wsRequestHeaders,
							requestBody: wsRequestBody,
							progress: trackingProgress,
							token,
						});
						wsHandled = true;
					} catch (wsErr) {
						if (wsErr instanceof WsUnsupportedError) {
							this.forgetOpenAIResponsesWsSession(wsSessionKey);
							if (wsUsedDeltaInput) {
								requestBody.input = fullInput;
								delete requestBody.previous_response_id;
							}
							logger.warn("responses.ws.fallback_to_http", {
								modelId: model.id,
								requestModel: parsedModelId.baseId,
								error: wsErr.message,
								usedDeltaInput: wsUsedDeltaInput,
								httpFallbackInput: wsUsedDeltaInput ? "full" : "current",
							});
							// HTTP fallback cannot rely on WS session state.
						} else {
							throw wsErr;
						}
					}
				}

				if (!wsHandled) {
					let response: Response;
					const httpRequestBody = buildResponsesTransportBody("http");
					try {
						response = await sendRequest(httpRequestBody);
					} catch (err) {
						// Some Responses-compatible gateways don't support `previous_response_id`.
						// Fall back to sending full history when the previous-response attempt fails.
						const status = (err as { status?: unknown })?.status;
						const shouldFallback =
							statefulPlan.addedPreviousResponseId &&
							typeof status === "number" &&
							status >= 400 &&
							status < 500 &&
							status !== 429;
						if (!shouldFallback) {
							throw err;
						}

						this._openaiResponsesPreviousResponseIdUnsupportedTargets.add(statefulPlan.unsupportedKey);

						let fallbackBody: Record<string, unknown> = {
							model: parsedModelId.baseId,
							input: fullInput,
							stream: true,
						};
						fallbackBody = openaiResponsesApi.prepareRequestBody(fallbackBody, um, options);
						delete fallbackBody.previous_response_id;
						fallbackBody = openaiResponsesApi.sanitizeRequestBody(fallbackBody, "http");
						response = await sendRequest(fallbackBody);
					}

					if (!response.body) {
						throw new Error("No response body from Responses API");
					}
					await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);
				}

				// Append a stateful marker so future requests can reuse `previous_response_id` (chat host style).
				const responseId = openaiResponsesApi.responseId;
				if (responseId) {
					const cacheEntry = createOpenAIResponsesStatefulCacheEntry(fullInput, responseId);
					this._openaiResponsesStatefulCacheByTarget.set(
						statefulCacheBucketKey,
						upsertOpenAIResponsesStatefulCacheEntry(statefulCacheEntries, cacheEntry)
					);
					if (useWs && wsHandled) {
						this.rememberOpenAIResponsesWsSession(responseId, wsSessionKey);
					}
					trackingProgress.report(createOpenAIResponsesStatefulMarkerPart(statefulModelId, responseId));
				}
			} else if (apiMode === "gemini") {
				// Gemini native API mode
				const geminiApi = new GeminiApi(requestModelId, this._geminiToolCallMetaByCallId);
				const geminiMessages = geminiApi.convertMessages(messages, modelConfig);

				const systemParts: string[] = [];
				const contents: GeminiGenerateContentRequest["contents"] = [];
				for (const msg of geminiMessages) {
					if (msg.role === "system") {
						const text = msg.parts
							.map((p) =>
								p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
									? String((p as { text: string }).text)
									: ""
							)
							.join("")
							.trim();
						if (text) {
							systemParts.push(text);
						}
						continue;
					}
					contents.push({ role: msg.role, parts: msg.parts });
				}

				let requestBody: GeminiGenerateContentRequest = {
					contents,
				};
				if (systemParts.length > 0) {
					requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
				}
				requestBody = geminiApi.prepareRequestBody(requestBody, um, options);

				const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
				logger.debug("request.body", { url, requestBody });
				if (!url) {
					throw new Error("Invalid Gemini base URL configuration.");
				}

				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Gemini Provider] Gemini API error response", errorText);
						throw new Error(
							`Gemini API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Gemini API");
				}
				await geminiApi.processStreamingResponse(response.body, trackingProgress, token);
			} else {
				// OpenAI compatible API mode (default)
				const openaiApi = new OpenaiApi(requestModelId);
				const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					messages: openaiMessages,
					stream: true,
					stream_options: { include_usage: true },
				};
				requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

				// send chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
				logger.debug("request.body", { url, requestBody });
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Kong Bridge Model Provider] Kong Bridge API error response", errorText);
						throw new Error(
							`Kong Bridge API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Kong Bridge API");
				}
				await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
			}
		} catch (err) {
			console.error("[Kong Bridge Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			logger.error("request.error", {
				modelId: model.id,
				messageCount: messages.length,
				errorName: err instanceof Error ? err.name : String(err),
				errorMessage: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			const durationMs = Date.now() - requestStartTime;
			logger.info("request.end", { modelId: model.id, durationMs });
			// Update last request time after successful completion
			this._lastRequestTime = Date.now();
		}
	}

	private createOpenAIResponsesWsSessionKey(bucketKey: string): string {
		this._openaiResponsesWsSessionSeq++;
		return `${bucketKey}::ws-${Date.now().toString(36)}-${this._openaiResponsesWsSessionSeq.toString(36)}`;
	}

	private rememberOpenAIResponsesWsSession(responseId: string, sessionKey: string): void {
		this._openaiResponsesWsSessionKeyByResponseId.set(responseId, sessionKey);
		while (this._openaiResponsesWsSessionKeyByResponseId.size > 128) {
			const oldest = this._openaiResponsesWsSessionKeyByResponseId.keys().next().value;
			if (!oldest) {
				break;
			}
			this._openaiResponsesWsSessionKeyByResponseId.delete(oldest);
		}
	}

	private forgetOpenAIResponsesWsSession(sessionKey: string): void {
		for (const [responseId, mappedSessionKey] of this._openaiResponsesWsSessionKeyByResponseId) {
			if (mappedSessionKey === sessionKey) {
				this._openaiResponsesWsSessionKeyByResponseId.delete(responseId);
			}
		}
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param useGenericKey If true, use generic API key.
	 * @param provider Optional provider name to get provider-specific API key.
	 */
	private async ensureApiKey(useGenericKey: boolean, provider?: string): Promise<string | undefined> {
		// Try to get provider-specific API key first
		let apiKey: string | undefined;
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.trim().toLowerCase();
			const providerKey = `kong-chat-bridge.apiKey.${normalizedProvider}`;
			apiKey = await this.secrets.get(providerKey);

			if (!apiKey && !useGenericKey) {
				const entered = await vscode.window.showInputBox({
					title: `Kong Bridge API Key for ${normalizedProvider}`,
					prompt: `Enter your Kong Bridge API key for ${normalizedProvider}`,
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store(providerKey, apiKey);
				}
			}
		}

		// Fall back to generic API key
		if (!apiKey) {
			apiKey = await this.secrets.get("kong-chat-bridge.apiKey");
		}

		if (!apiKey && useGenericKey) {
			const entered = await vscode.window.showInputBox({
				title: "Kong Bridge API Key",
				prompt: "Enter your Kong Bridge API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("kong-chat-bridge.apiKey", apiKey);
			}
		}
		return apiKey;
	}
}

interface OpenAIResponsesStatefulMarkerLocation {
	marker: string;
	index: number;
}

function createOpenAIResponsesWebsocketClientRequestId(sessionKey: string): string {
	let hash = 2166136261;
	for (let i = 0; i < sessionKey.length; i++) {
		hash ^= sessionKey.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `kong-chat-bridge-${(hash >>> 0).toString(16)}`;
}

function createOpenAIResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME);
}

function parseOpenAIResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== "object") {
		return null;
	}
	if (typeof maybe.mimeType !== "string") {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const sep = decoded.indexOf("\\");
		if (sep <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, sep).trim();
		const marker = decoded.slice(sep + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastOpenAIResponsesStatefulMarker(
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[]
): OpenAIResponsesStatefulMarkerLocation | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[i].content ?? []) {
			const parsed = parseOpenAIResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index: i };
			}
		}
	}
	return null;
}

function findLastAssistantMessageIndex(messages: readonly LanguageModelChatRequestMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === vscode.LanguageModelChatMessageRole.Assistant) {
			return i;
		}
	}

	return -1;
}
