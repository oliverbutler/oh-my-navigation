import * as vscode from "vscode";
import { PREVIEW_SCHEME, previewProvider } from "./utils/symbolPreview";
import { RecencyTracker } from "./utils/recencyTracker";
import { registerSearchSymbolsCommand } from "./commands/searchSymbols";
import { registerSwapToSiblingCommand } from "./commands/swapToSibling";
import { registerGoToReferencesCommand } from "./commands/goToReferences";

let recencyTracker: RecencyTracker;

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Olly");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Olly extension activated");

  recencyTracker = new RecencyTracker(context);

  registerSearchSymbolsCommand(context, recencyTracker, outputChannel);
  registerSwapToSiblingCommand(context);
  registerGoToReferencesCommand(context, recencyTracker, outputChannel);

  const showLogs = vscode.commands.registerCommand("olly.showLogs", () => {
    outputChannel.show();
  });

  const providerRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider
    );
  context.subscriptions.push(providerRegistration);

  const clearRecencyData = vscode.commands.registerCommand(
    "olly.clearRecencyData",
    async () => {
      await recencyTracker.clear();
      vscode.window.showInformationMessage("Recency data cleared");
    }
  );

  context.subscriptions.push(clearRecencyData);
  context.subscriptions.push(showLogs);
}

export function deactivate() {}
