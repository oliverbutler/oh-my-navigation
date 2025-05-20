import * as vscode from "vscode";
import { RecencyTracker } from "../utils/recencyTracker";
import { navigateToSymbolLocations } from "../utils/symbolNavigation";

export function registerGoToTypeDefinitionCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
): void {
  const goToTypeDefinition = vscode.commands.registerCommand(
    "omn.goToTypeDefinition",
    async () => {
      await navigateToSymbolLocations(
        "typeDefinition",
        outputChannel,
        recencyTracker
      );
    }
  );

  context.subscriptions.push(goToTypeDefinition);
}
