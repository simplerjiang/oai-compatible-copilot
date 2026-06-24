import * as vscode from "vscode";

export type LanguageModelProgressPart = vscode.LanguageModelResponsePart;

export interface LanguageModelThinkingPartLike {
	value: string | string[];
	id?: string;
	metadata?: Readonly<Record<string, unknown>>;
}

export function isLanguageModelThinkingPart(part: unknown): part is LanguageModelThinkingPartLike {
	if (!part || typeof part !== "object") {
		return false;
	}
	const ctor = (vscode as unknown as { LanguageModelThinkingPart?: new (...args: unknown[]) => unknown })
		.LanguageModelThinkingPart;
	if (typeof ctor === "function" && part instanceof ctor) {
		return true;
	}
	return (part as { constructor?: { name?: string } }).constructor?.name === "LanguageModelThinkingPart";
}

export function getLanguageModelThinkingText(part: LanguageModelThinkingPartLike): string {
	return Array.isArray(part.value) ? part.value.join("") : part.value;
}

export function createLanguageModelThinkingPart(
	value: string | string[],
	id?: string
): LanguageModelProgressPart | undefined {
	const ctor = (vscode as unknown as {
		LanguageModelThinkingPart?: new (value: string | string[], id?: string) => LanguageModelProgressPart;
	}).LanguageModelThinkingPart;
	if (typeof ctor !== "function") {
		return undefined;
	}
	return new ctor(value, id);
}
