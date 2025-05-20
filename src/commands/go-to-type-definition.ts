import * as vscode from "vscode";
import { RecencyTracker } from "../utils/recency-tracker";
import { navigateToSymbolLocations } from "../utils/symbol-navigation";

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
