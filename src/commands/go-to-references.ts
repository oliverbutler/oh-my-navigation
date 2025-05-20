import * as vscode from "vscode";
import { RecencyTracker } from "../utils/recency-tracker";
import { navigateToSymbolLocations } from "../utils/symbol-navigation";

export function registerGoToReferencesCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
): void {
  const goToReferences = vscode.commands.registerCommand(
    "omn.goToReferences",
    async () => {
      await navigateToSymbolLocations(
        "references",
        outputChannel,
        recencyTracker
      );
    }
  );

  context.subscriptions.push(goToReferences);
}
