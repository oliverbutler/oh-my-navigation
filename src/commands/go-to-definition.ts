import * as vscode from "vscode";
import { RecencyTracker } from "../utils/recency-tracker";
import { navigateToSymbolLocations } from "../utils/symbol-navigation";

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
