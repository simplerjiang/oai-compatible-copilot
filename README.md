# Kong-chat-bridge

Kong-chat-bridge lets VS Code route chat-model requests to model endpoints you control. It is designed for Kong API gateway deployments and other OpenAI-compatible, Anthropic, Gemini, or Ollama-style backends.

This extension is independent software. It is not affiliated with, endorsed by, or sponsored by Microsoft, GitHub, OpenAI, Anthropic, Google, or any upstream extension project.

## Features

- Configure multiple model providers with separate API keys.
- Use OpenAI Chat Completions, OpenAI Responses, OpenAI Responses over WebSocket, Anthropic Messages, Gemini, and Ollama-style APIs.
- Store model-specific settings such as base URL, context length, output tokens, temperature, reasoning effort, and custom headers.
- Generate Git commit messages from the Source Control view.
- Show token usage and open configuration from the status bar.
- Import and export provider configuration.

## Quick Start

1. Open the command palette.
2. Run `Kong-chat-bridge: Open Configuration UI`.
3. Add a provider with a base URL and API key.
4. Add one or more model entries.
5. Select a configured model from VS Code's chat model picker.

Example settings:

```json
"kong-chat-bridge.baseUrl": "https://api.example.com/v1",
"kong-chat-bridge.models": [
	{
		"id": "gpt-5.5",
		"owned_by": "kong",
		"family": "gpt-5.5",
		"apiMode": "openai-responses-ws",
		"context_length": 256000,
		"max_completion_tokens": 8192
	}
]
```

## Important Settings

- `kong-chat-bridge.baseUrl`: Global provider base URL.
- `kong-chat-bridge.models`: Model list shown through the VS Code model picker.
- `kong-chat-bridge.retry`: Retry policy for transient HTTP failures.
- `kong-chat-bridge.delay`: Delay between requests.
- `kong-chat-bridge.commitLanguage`: Output language for generated commit messages.
- `kong-chat-bridge.readFileLines`: Default line budget for file-reading tool results.
- `kong-chat-bridge.copilotUtilitySmallFallbackModel`: Optional explicit fallback model for Copilot's internal `gpt-4o-mini` utility-small family selection. Empty by default.

## Model Family

Set `family` when the host should treat a custom endpoint like a known model family. For example:

```json
{
	"id": "gpt-5.5",
	"family": "gpt-5.5"
}
```

If `family` is omitted, the extension tries to infer common model families from the model id and otherwise uses `oai-compatible`.

## Copilot Utility-small Fallback

By default, Kong-chat-bridge does not advertise any compatibility alias for Copilot's internal `gpt-4o-mini` utility-small family selection. If a specific VS Code/Copilot build fails during tool-selection optimization and you explicitly accept routing that internal utility request to one of your configured models, choose a model in the Configuration UI or set:

```json
"kong-chat-bridge.copilotUtilitySmallFallbackModel": "gpt-5.5"
```

Leave this setting empty to avoid exposing the compatibility alias. Enable it only as a network workaround, because the host may treat the fallback as a `gpt-4o-mini` family model and this can affect reasoning/thinking UI behavior.

## Image Generation

For Responses-compatible gateways that expose OpenAI image-generation tools, add the image tool through the model's `extra` request parameters:

```json
{
	"id": "gpt-5.5",
	"apiMode": "openai-responses-ws",
	"extra": {
		"tools": [
			{
				"type": "image_generation",
				"model": "gpt-image-2"
			}
		],
		"tool_choice": "auto"
	}
}
```

When the upstream returns generated image data, Kong-chat-bridge emits a VS Code image response part and also writes the image to `~/.kong/kong-chat-bridge/generated-images` with a Markdown image link in the chat response.

## Notes

- API keys are stored with VS Code SecretStorage.
- Provider-specific keys use `kong-chat-bridge.apiKey.<provider>`.
- The WebSocket Responses mode is intended for Kong API gateway-style upstreams that support per-run session reuse.
