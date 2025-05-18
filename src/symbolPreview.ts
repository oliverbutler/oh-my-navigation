import * as vscode from "vscode";
import * as path from "path";

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
    const line = parseInt(params.get("line") || "1", 10);

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
