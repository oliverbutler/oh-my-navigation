import * as vscode from "vscode";
import { PREVIEW_SCHEME, previewProvider } from "./utils/symbol-preview";
import { RecencyTracker } from "./utils/recency-tracker";
import { LastCommandTracker } from "./utils/last-command-tracker";
import { registerSearchSymbolsCommand } from "./commands/search-symbols";
import { registerSwapToSiblingCommand } from "./commands/swap-to-sibling";
import { registerGoToReferencesCommand } from "./commands/go-to-references";
import { registerGoToDefinitionCommand } from "./commands/go-to-definition";
import { registerGoToImplementationCommand } from "./commands/go-to-implementation";
import { registerGoToTypeDefinitionCommand } from "./commands/go-to-type-definition";
import { registerRipgrepSearchCommand } from "./commands/ripgrep-search";
import { registerResumeCommand } from "./commands/resume-command";

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
