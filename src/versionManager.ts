import * as vscode from "vscode";

export class VersionManager {
	private static _version: string | null = null;

	/**
	 * Get the current extension version
	 */
	static getVersion(): string {
		if (this._version === null) {
			const extension = vscode.extensions.getExtension("kong-fork.oai-compatible-copilot-kong");
			this._version = extension?.packageJSON?.version ?? "unknown";
		}
		return this._version!;
	}

	/**
	 * Build a descriptive User-Agent to help quantify API usage
	 * Keep UA minimal: only extension version and VS Code version
	 */
	static getUserAgent(): string {
		const vscodeVersion = vscode.version;
		return `oaicopilot-kong/${this.getVersion()} VSCode/${vscodeVersion}`;
	}

	/**
	 * Get the current extension information
	 */
	static getClientInfo(): { name: string; version: string; author: string } {
		return {
			name: "oai-compatible-copilot-kong",
			version: this.getVersion(),
			author: "johnny-zhao",
		};
	}
}
