# Changelog

## 1.0.5

- Added generated-image output support for OpenAI Chat Completions `delta.images` and OpenAI Responses `image_generation_call` events.
- Saved generated images to a local `~/.kong/kong-chat-bridge/generated-images` file and emitted a Markdown image link so Copilot Chat can render or open the result even when binary image response parts are ignored by the host UI.
- Added an opt-in Copilot utility-small fallback setting for environments where Copilot cannot resolve its internal `gpt-4o-mini` tool-selection model.
- Kept the compatibility alias disabled by default; when enabled, it is hidden from the user picker and routes requests to the selected configured model.
- Documented the reasoning UI caveat for hosts that treat the fallback as a `gpt-4o-mini` family model.

## 1.0.4

- Rebranded the extension as Kong-chat-bridge with a new package id, vendor id, command namespace, configuration namespace, SecretStorage keys, and log path.
- Removed old public branding and upstream marketplace references from packaged documentation.
- Added model-family inference so `gpt-5.5` and similar model ids are exposed with a matching family when no explicit `family` is configured.

## 1.0.3

- Added OpenAI Responses WebSocket transport support for Kong API gateway-style upstreams.
- Added stateful response id reuse for supported Responses backends.
