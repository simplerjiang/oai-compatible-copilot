import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import type { LanguageModelProgressPart } from "../vscodeLanguageModelCompat";

const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function streamFromText(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function collectImageParts(parts: LanguageModelProgressPart[]): vscode.LanguageModelDataPart[] {
	return parts.filter(
		(part): part is vscode.LanguageModelDataPart =>
			part instanceof vscode.LanguageModelDataPart && part.mimeType === "image/png"
	);
}

function collectText(parts: LanguageModelProgressPart[]): string {
	return parts
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map((part) => part.value)
		.join("");
}

suite("openai image responses", () => {
	test("reports chat completion delta images as image data parts", async () => {
		const api = new OpenaiApi("gpt-5.5");
		const parts: LanguageModelProgressPart[] = [];
		const stream = streamFromText(
			[
				`data: {"choices":[{"delta":{"images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,${PNG_BASE64}"}}]}}]}`,
				"data: [DONE]",
			].join("\n\n")
		);

		const cts = new vscode.CancellationTokenSource();
		await api.processStreamingResponse(stream, { report: (part) => parts.push(part) }, cts.token);

		const imageParts = collectImageParts(parts);
		assert.strictEqual(imageParts.length, 1);
		assert.deepStrictEqual(Buffer.from(imageParts[0].data), Buffer.from(PNG_BASE64, "base64"));
		assert.match(collectText(parts), /!\[Generated image\]\(file:\/\/\/.+generated-image-.+\.png\)/);
	});

	test("reports responses image generation calls as image data parts", async () => {
		const api = new OpenaiResponsesApi("gpt-5.5");
		const parts: LanguageModelProgressPart[] = [];
		const stream = streamFromText(
			[
				`data: {"type":"response.output_item.done","item":{"id":"ig_1","type":"image_generation_call","output_format":"png","result":"${PNG_BASE64}"}}`,
				`data: {"type":"response.completed","response":{"id":"resp_1","output":[{"id":"ig_1","type":"image_generation_call","output_format":"png","result":"${PNG_BASE64}"}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`,
				"data: [DONE]",
			].join("\n\n")
		);

		const cts = new vscode.CancellationTokenSource();
		await api.processStreamingResponse(stream, { report: (part) => parts.push(part) }, cts.token);

		const imageParts = collectImageParts(parts);
		assert.strictEqual(imageParts.length, 1);
		assert.deepStrictEqual(Buffer.from(imageParts[0].data), Buffer.from(PNG_BASE64, "base64"));
		assert.match(collectText(parts), /!\[Generated image\]\(file:\/\/\/.+generated-image-.+\.png\)/);
	});
});
