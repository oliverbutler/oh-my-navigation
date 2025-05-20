import * as vscode from "vscode";
import { RecencyTracker } from "../utils/recency-tracker";
import { navigateToSymbolLocations } from "../utils/symbol-navigation";

export function registerGoToImplementationCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
): void {
  const goToImplementation = vscode.commands.registerCommand(
    "omn.goToImplementation",
    async () => {
      await navigateToSymbolLocations(
        "implementation",
        outputChannel,
        recencyTracker
      );
    }
  );

  context.subscriptions.push(goToImplementation);
}
