import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	// One-time migration from the upstream `oaicopilot.*` namespace (Kong fork rename).
	// Runs before any provider/config is touched so the rest of activate() sees the migrated values.
	void migrateLegacyOaicopilotNamespace(context);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	const provider = new HuggingFaceChatModelProvider(context.secrets, tokenCountStatusBarItem);
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot-kong", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot-kong.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot-kong.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OAI Compatible Provider API Key",
				prompt: existing ? "Update your OAI Compatible API key" : "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot-kong.apiKey");
				vscode.window.showInformationMessage("OAI Compatible API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot-kong.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("OAI Compatible API key saved.");
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot-kong.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot-kong.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in oaicopilot-kong.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot-kong.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `OAI Compatible API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot-kong.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot-kong.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("oaicopilot-kong.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("oaicopilot-kong.logLevel")) {
				logger.reloadConfig();
			}
		})
	);
}

export function deactivate() {}

/**
 * Migrate user data from the upstream `oaicopilot.*` namespace to the Kong fork's
 * `oaicopilot-kong.*` namespace on first activation. Idempotent and gated on a
 * `globalState` flag so this runs at most once per VS Code profile.
 *
 * Scope:
 *  - global-scoped config keys: logLevel, baseUrl, models, retry, delay,
 *    commitLanguage, commitMessagePrompt, readFileLines
 *  - secrets: `oaicopilot.apiKey` and `oaicopilot.apiKey.<provider>` for every
 *    provider mentioned in the migrated `models` config.
 *
 * Failures are logged and swallowed so a partial migration never blocks activation.
 */
async function migrateLegacyOaicopilotNamespace(context: vscode.ExtensionContext): Promise<void> {
	const FLAG = "oaicopilot-kong.migrationDone";
	if (context.globalState.get<boolean>(FLAG)) {
		return;
	}
	try {
		const oldCfg = vscode.workspace.getConfiguration("oaicopilot");
		const newCfg = vscode.workspace.getConfiguration("oaicopilot-kong");
		const keys = [
			"logLevel",
			"baseUrl",
			"models",
			"retry",
			"delay",
			"commitLanguage",
			"commitMessagePrompt",
			"readFileLines",
		];
		let migratedKeys = 0;
		for (const key of keys) {
			const oldInspect = oldCfg.inspect(key);
			const newInspect = newCfg.inspect(key);
			if (oldInspect?.globalValue !== undefined && newInspect?.globalValue === undefined) {
				try {
					await newCfg.update(key, oldInspect.globalValue, vscode.ConfigurationTarget.Global);
					migratedKeys++;
				} catch (e) {
					logger.warn("migration.config.update_failed", {
						key,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}

		// Top-level api key
		let migratedSecrets = 0;
		try {
			const legacyTop = await context.secrets.get("oaicopilot.apiKey");
			if (legacyTop && !(await context.secrets.get("oaicopilot-kong.apiKey"))) {
				await context.secrets.store("oaicopilot-kong.apiKey", legacyTop);
				migratedSecrets++;
			}
		} catch (e) {
			logger.warn("migration.secret.top_failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		}

		// Per-provider api keys discovered from the migrated `models` value.
		const refreshedNewCfg = vscode.workspace.getConfiguration("oaicopilot-kong");
		const modelsCandidate =
			refreshedNewCfg.get<HFModelItem[]>("models") ?? oldCfg.get<HFModelItem[]>("models") ?? [];
		const providerSet = new Set<string>();
		for (const m of modelsCandidate) {
			const provider = (m?.owned_by ?? "").toString().toLowerCase().trim();
			if (provider) {
				providerSet.add(provider);
			}
		}
		for (const provider of providerSet) {
			const oldKey = `oaicopilot.apiKey.${provider}`;
			const newKey = `oaicopilot-kong.apiKey.${provider}`;
			try {
				const v = await context.secrets.get(oldKey);
				if (v && !(await context.secrets.get(newKey))) {
					await context.secrets.store(newKey, v);
					migratedSecrets++;
				}
			} catch (e) {
				logger.warn("migration.secret.provider_failed", {
					provider,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		await context.globalState.update(FLAG, true);
		logger.info("migration.done", { migratedKeys, migratedSecrets, providers: providerSet.size });
	} catch (err) {
		logger.warn("migration.failed", { error: err instanceof Error ? err.message : String(err) });
	}
}
