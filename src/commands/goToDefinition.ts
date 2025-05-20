import * as vscode from "vscode";
import { RecencyTracker } from "../utils/recencyTracker";
import { navigateToSymbolLocations } from "../utils/symbolNavigation";

export function registerGoToDefinitionCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
): void {
  const goToDefinition = vscode.commands.registerCommand(
    "omn.goToDefinition",
    async () => {
      await navigateToSymbolLocations(
        "definition",
        outputChannel,
        recencyTracker
      );
    }
  );

  context.subscriptions.push(goToDefinition);
}
