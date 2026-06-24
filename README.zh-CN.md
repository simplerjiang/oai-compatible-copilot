# Kong-chat-bridge

Kong-chat-bridge 用于把 VS Code 的聊天模型请求转发到你自己控制的模型端点。它面向 Kong API gateway 部署，也可以连接 OpenAI-compatible、Anthropic、Gemini 或 Ollama 风格的后端。

这是独立软件。它不隶属于 Microsoft、GitHub、OpenAI、Anthropic、Google，也不由这些组织或任何上游扩展项目背书。

## 功能

- 配置多个模型供应商，并为每个供应商保存独立 API key。
- 支持 OpenAI Chat Completions、OpenAI Responses、OpenAI Responses WebSocket、Anthropic Messages、Gemini 和 Ollama 风格 API。
- 支持模型级 base URL、上下文长度、输出 token、temperature、reasoning effort、自定义 headers。
- 可在 Source Control 视图生成 Git commit message。
- 通过状态栏查看 token 使用量并打开配置界面。
- 支持导入和导出配置。

## 快速开始

1. 打开命令面板。
2. 执行 `Kong-chat-bridge: Open Configuration UI`。
3. 添加供应商 base URL 和 API key。
4. 添加模型配置。
5. 从 VS Code 的聊天模型选择器里选择配置好的模型。

配置示例：

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

## 关键配置

- `kong-chat-bridge.baseUrl`：全局供应商 base URL。
- `kong-chat-bridge.models`：暴露给 VS Code 模型选择器的模型列表。
- `kong-chat-bridge.retry`：临时 HTTP 失败的重试策略。
- `kong-chat-bridge.delay`：请求之间的延迟。
- `kong-chat-bridge.commitLanguage`：生成 commit message 的语言。
- `kong-chat-bridge.readFileLines`：文件读取工具结果的默认行数预算。

## Model Family

当自定义端点需要被宿主识别为某个已知模型族时，请显式设置 `family`：

```json
{
	"id": "gpt-5.5",
	"family": "gpt-5.5"
}
```

如果省略 `family`，扩展会尝试从模型 id 推断常见模型族；无法识别时使用 `oai-compatible`。

## 说明

- API key 使用 VS Code SecretStorage 保存。
- 供应商级 API key 使用 `kong-chat-bridge.apiKey.<provider>`。
- WebSocket Responses 模式面向支持 per-run session reuse 的 Kong API gateway 风格上游。
