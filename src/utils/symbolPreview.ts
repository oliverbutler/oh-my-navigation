import * as vscode from "vscode";
import * as path from "path";
import { getLanguageIdFromFilePath } from "./symbolSearch";

// Custom scheme for file previews
export const PREVIEW_SCHEME = "symbol-preview";

// ContentProvider for efficient file previews without triggering LSP
export class SymbolPreviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private fileContents = new Map<string, string>();

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Parse URI parameters
    const params = new URLSearchParams(uri.query);
    const filePath = params.get("path") || "";

    // Check cache first
    if (this.fileContents.has(filePath)) {
      return this.fileContents.get(filePath) || "";
    }

    try {
      const fs = require("fs");
      const content = fs.readFileSync(filePath, "utf8");
      this.fileContents.set(filePath, content);
      return content;
    } catch (err) {
      return `Error loading preview: ${err}`;
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
  return vscode.Uri.parse(
    `${PREVIEW_SCHEME}:Symbol Preview?path=${encodeURIComponent(
      filePath
    )}&line=${line}&language=${langId}`
  );
}

export class PreviewManager {
  private originalPreviewSetting: unknown;
  private originalEditor: vscode.TextEditor | undefined;
  private currentPreviewEditor: vscode.TextEditor | undefined;
  private currentDecoration: vscode.TextEditorDecorationType | undefined;
  private initialized = false;

  constructor(private outputChannel?: vscode.OutputChannel) {}

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

    const langId = getLanguageIdFromFilePath(filePath);
    const previewUri = getSymbolPreviewUri(filePath, line, langId);

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
      startColumn - 1
    );

    this.currentPreviewEditor.selection = new vscode.Selection(
      line - 1,
      startColumn - 1,
      line - 1,
      startColumn - 1
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

    if (this.outputChannel) {
      this.outputChannel.appendLine(
        `OMN: Shown preview for: ${filePath} at line: ${line} at column: ${startColumn}`
      );
    }

    return this.currentPreviewEditor;
  }

  /**
   * Completely dispose the preview manager, restoring original settings
   * and closing any open preview
   */
  async dispose(): Promise<void> {
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
