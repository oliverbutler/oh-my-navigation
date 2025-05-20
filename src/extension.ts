import * as vscode from "vscode";
import { PREVIEW_SCHEME, previewProvider } from "./utils/symbolPreview";
import { RecencyTracker } from "./utils/recencyTracker";
import { LastCommandTracker } from "./utils/lastCommandTracker";
import { registerSearchSymbolsCommand } from "./commands/searchSymbols";
import { registerSwapToSiblingCommand } from "./commands/swapToSibling";
import { registerGoToReferencesCommand } from "./commands/goToReferences";
import { registerGoToDefinitionCommand } from "./commands/goToDefinition";
import { registerGoToImplementationCommand } from "./commands/goToImplementation";
import { registerGoToTypeDefinitionCommand } from "./commands/goToTypeDefinition";
import { registerRipgrepSearchCommand } from "./commands/ripgrepSearch";
import { registerResumeCommand } from "./commands/resumeCommand";

let recencyTracker: RecencyTracker;
let lastCommandTracker: LastCommandTracker;

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Olly");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Olly extension activated");

  recencyTracker = new RecencyTracker(context);
  lastCommandTracker = new LastCommandTracker(context);

  registerSearchSymbolsCommand(
    context,
    recencyTracker,
    outputChannel,
    lastCommandTracker
  );
  registerSwapToSiblingCommand(context);
  registerGoToReferencesCommand(context, recencyTracker, outputChannel);
  registerGoToDefinitionCommand(context, recencyTracker, outputChannel);
  registerGoToImplementationCommand(context, recencyTracker, outputChannel);
  registerGoToTypeDefinitionCommand(context, recencyTracker, outputChannel);
  registerRipgrepSearchCommand(context, recencyTracker, outputChannel);
  registerResumeCommand(context, lastCommandTracker, outputChannel);

  const showLogs = vscode.commands.registerCommand("omn.showLogs", () => {
    outputChannel.show();
  });

  const providerRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider
    );
  context.subscriptions.push(providerRegistration);

  const clearRecencyData = vscode.commands.registerCommand(
    "omn.clearRecencyData",
    async () => {
      await recencyTracker.clear();
      vscode.window.showInformationMessage("Recency data cleared");
    }
  );

  context.subscriptions.push(clearRecencyData);
  context.subscriptions.push(showLogs);
}

export function deactivate() {}
