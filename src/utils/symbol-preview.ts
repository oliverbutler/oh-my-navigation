import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLanguageIdFromFilePath } from "./symbol-search";

// Custom scheme for file previews
export const PREVIEW_SCHEME = "symbol-preview";

// ContentProvider for efficient file previews without triggering LSP
export class SymbolPreviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private fileContents = new Map<string, string>();
  private outputChannel?: vscode.OutputChannel;

  setOutputChannel(channel: vscode.OutputChannel) {
    this.outputChannel = channel;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Parse URI parameters and decode base64 path
    const params = new URLSearchParams(uri.query);
    const encodedPath = params.get("path64") || "";
    const filePath = Buffer.from(encodedPath, "base64").toString("utf8");

    this.outputChannel?.appendLine(`OMN: Loading preview for: ${filePath}`);

    // Check cache first
    if (this.fileContents.has(filePath)) {
      return this.fileContents.get(filePath) || "";
    }

    // Create a file URI and read the content
    const fileUri = vscode.Uri.file(filePath);

    try {
      const fileData = await vscode.workspace.fs.readFile(fileUri);
      const content = new TextDecoder().decode(fileData);
      this.fileContents.set(filePath, content);
      return content;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.outputChannel?.appendLine(
        `OMN: Error loading file: ${filePath} - ${errorMessage}`
      );
      return `Error loading preview: ${errorMessage}`;
    }
  }

  // Clear cache when no longer needed
  clearCache(filePath?: string) {
    if (filePath) {
      this.fileContents.delete(filePath);
    } else {
      this.fileContents.clear();
    }
  }
}

// Singleton instance
export const previewProvider = new SymbolPreviewContentProvider();

// Utility to construct preview URIs
export function getSymbolPreviewUri(
  filePath: string,
  line: number,
  langId: string
): vscode.Uri {
  // Use base64 encoding to avoid URL encoding issues completely
  const base64Path = Buffer.from(filePath, "utf8").toString("base64");

  return vscode.Uri.parse(
    `${PREVIEW_SCHEME}:Symbol Preview?path64=${base64Path}&line=${line}&language=${langId}`
  );
}

export class PreviewManager {
  private originalPreviewSetting: unknown;
  private originalEditor: vscode.TextEditor | undefined;
  private currentPreviewEditor: vscode.TextEditor | undefined;
  private currentDecoration: vscode.TextEditorDecorationType | undefined;
  private initialized = false;

  constructor(private outputChannel?: vscode.OutputChannel) {
    if (outputChannel) {
      previewProvider.setOutputChannel(outputChannel);
    }
  }

  /**
   * Initialize the preview environment by saving original settings
   * and configuring the preview mode
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Store original editor
    this.originalEditor = vscode.window.activeTextEditor;

    // Save original preview setting
    this.originalPreviewSetting = vscode.workspace
      .getConfiguration("workbench.editor")
      .get("enablePreviewFromQuickOpen");

    // Enable preview mode to prevent cluttering the editor tabs
    await vscode.workspace
      .getConfiguration("workbench.editor")
      .update(
        "enablePreviewFromQuickOpen",
        true,
        vscode.ConfigurationTarget.Global
      );

    this.initialized = true;
  }

  /**
   * Shows a preview of a file with highlighted symbol
   * Call init() first if this is the first preview
   */
  async showFile(
    filePath: string,
    line: number,
    startColumn: number,
    endColumn?: number
  ): Promise<vscode.TextEditor> {
    if (!this.initialized) {
      await this.init();
    }

    this.outputChannel?.appendLine(
      `OMN: Showing preview for: ${filePath} at line: ${line}`
    );

    const langId = getLanguageIdFromFilePath(filePath);
    const previewUri = getSymbolPreviewUri(filePath, line, langId);

    try {
      const doc = await vscode.workspace.openTextDocument(previewUri);
      await vscode.languages.setTextDocumentLanguage(doc, langId);

      this.currentPreviewEditor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
        preview: true,
        preserveFocus: true,
      });

      const range = new vscode.Range(
        line - 1,
        startColumn - 1,
        line - 1,
        endColumn ? endColumn - 1 : startColumn
      );

      this.currentPreviewEditor.selection = new vscode.Selection(
        line - 1,
        startColumn - 1,
        line - 1,
        endColumn ? endColumn - 1 : startColumn - 1
      );

      this.currentPreviewEditor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenter
      );

      // Highlight the line
      if (this.currentDecoration) {
        this.currentDecoration.dispose();
      }

      this.currentDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor(
          "editor.findMatchHighlightBackground"
        ),
        isWholeLine: true,
      });

      this.currentPreviewEditor.setDecorations(this.currentDecoration, [range]);

      return this.currentPreviewEditor;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.outputChannel?.appendLine(
        `OMN: Error previewing file: ${errorMessage}`
      );
      vscode.window.showErrorMessage(`Failed to preview file: ${errorMessage}`);
      throw err;
    }
  }

  /**
   * Completely dispose the preview manager, restoring original settings
   * and closing any open preview
   */
  async dispose(): Promise<void> {
    this.outputChannel?.appendLine("OMN: Disposing preview manager");

    if (!this.initialized) return;

    // Clean up decoration
    if (this.currentDecoration) {
      this.currentDecoration.dispose();
      this.currentDecoration = undefined;
    }

    // Close preview editor
    const openEditors = vscode.window.visibleTextEditors;
    for (const editor of openEditors) {
      if (editor.document.uri.scheme === PREVIEW_SCHEME) {
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor"
        );
        break;
      }
    }

    this.currentPreviewEditor = undefined;

    // Restore original settings
    await vscode.workspace
      .getConfiguration("workbench.editor")
      .update(
        "enablePreviewFromQuickOpen",
        this.originalPreviewSetting,
        vscode.ConfigurationTarget.Global
      );

    // Restore original editor
    if (this.originalEditor && this.originalEditor.document) {
      await vscode.window.showTextDocument(this.originalEditor.document, {
        viewColumn: this.originalEditor.viewColumn,
        selection: this.originalEditor.selection,
        preview: false,
      });
    }

    this.initialized = false;
  }
}
