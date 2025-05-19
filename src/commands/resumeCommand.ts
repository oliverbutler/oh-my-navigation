import * as vscode from "vscode";
import { LastCommandTracker } from "../utils/lastCommandTracker";

export function registerResumeCommand(
  context: vscode.ExtensionContext,
  lastCommandTracker: LastCommandTracker,
  outputChannel: vscode.OutputChannel
) {
  const resumeCommand = vscode.commands.registerCommand(
    "omn.resumeLastCommand",
    async () => {
      const lastCommand = await lastCommandTracker.getLastCommand();

      if (!lastCommand) {
        vscode.window.showInformationMessage("No previous command to resume");
        return;
      }

      outputChannel.appendLine(
        `Resuming command: ${lastCommand.commandId} with args: ${JSON.stringify(
          lastCommand.args
        )}`
      );

      try {
        await vscode.commands.executeCommand(
          lastCommand.commandId,
          ...(lastCommand.args || [])
        );
      } catch (error) {
        outputChannel.appendLine(`Error resuming command: ${error}`);
        vscode.window.showErrorMessage(
          `Failed to resume last command: ${error}`
        );
      }
    }
  );

  context.subscriptions.push(resumeCommand);
}
