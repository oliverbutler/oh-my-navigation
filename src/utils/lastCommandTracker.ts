import * as vscode from "vscode";

export interface CommandData {
  commandId: string;
  args?: any[];
}

/**
 * Tracks the last command executed for resume functionality
 */
export class LastCommandTracker {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Store information about the last executed command
   * @param commandId The VS Code command ID
   * @param args The arguments passed to the command
   */
  async setLastCommand(commandId: string, args?: any[]): Promise<void> {
    const commandData: CommandData = {
      commandId,
      args,
    };

    await this.context.globalState.update("olly.lastCommand", commandData);
  }

  /**
   * Get the last executed command information
   * @returns The last command or undefined if none exists
   */
  async getLastCommand(): Promise<CommandData | undefined> {
    return this.context.globalState.get<CommandData>("olly.lastCommand");
  }

  /**
   * Clear the stored last command
   */
  async clear(): Promise<void> {
    await this.context.globalState.update("olly.lastCommand", undefined);
  }
}
