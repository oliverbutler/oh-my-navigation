import * as vscode from "vscode";
import * as path from "path";
import {
  findSymbols,
  getLanguageIdFromFilePath,
  symbolTypeToIcon,
} from "./symbolSearch";
import {
  PREVIEW_SCHEME,
  SymbolPreviewContentProvider,
  previewProvider,
  getSymbolPreviewUri,
} from "./symbolPreview";

// Define a custom type for symbol items
interface SymbolQuickPickItem extends vscode.QuickPickItem {
  iconPath?: vscode.ThemeIcon;
  file?: string;
  line?: number;
}

// Main searchSymbols command
const searchSymbols = vscode.commands.registerCommand(
  "olly.searchSymbols",
  async (typeArg?: string) => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showInformationMessage("No workspace open");
      return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;

    // Save original editor state
    const originalEditor = vscode.window.activeTextEditor;

    // Enable proper preview mode to prevent navigation history pollution
    // Save original setting value
    const originalPreviewSetting = vscode.workspace
      .getConfiguration("workbench.editor")
      .get("enablePreviewFromQuickOpen");
    await vscode.workspace
      .getConfiguration("workbench.editor")
      .update(
        "enablePreviewFromQuickOpen",
        true,
        vscode.ConfigurationTarget.Global
      );

    // Ask user for symbol type
    const symbolTypes = [
      { label: "All", value: "all" },
      { label: "Classes", value: "class" },
      { label: "Functions", value: "function" },
      { label: "Methods", value: "method" },
      { label: "Variables", value: "variable" },
      { label: "Types", value: "type" },
      { label: "Interfaces", value: "interface" },
      { label: "Zod Schemas", value: "zod" },
      { label: "React Components", value: "react" },
    ];
    let picked;
    if (typeArg && symbolTypes.some((t) => t.value === typeArg)) {
      picked = symbolTypes.find((t) => t.value === typeArg);
    } else {
      picked = await vscode.window.showQuickPick(symbolTypes, {
        placeHolder: "Select symbol type to search",
      });
    }
    if (!picked) return;

    // Find all symbols using the extracted function
    const symbols = await findSymbols(picked.value, rootPath);

    if (symbols.length === 0) {
      vscode.window.showInformationMessage("No symbols found.");
      return;
    }

    // Prepare items for FZF
    const itemsForSearch: SymbolQuickPickItem[] = symbols.map((item) => {
      const relativePath = item.file.startsWith(rootPath)
        ? item.file.substring(rootPath.length + 1)
        : item.file;

      return {
        label: item.symbol,
        description: relativePath,
        iconPath: new vscode.ThemeIcon(symbolTypeToIcon[item.type]),
        file: item.file,
        line: item.line,
      };
    });

    const { Fzf } = await import("fzf");

    // Create FZF instance correctly
    const fzf = new Fzf(itemsForSearch, {
      selector: (item) => item.label,
      casing: "smart-case",
      limit: 50,
    });

    const quickPick = vscode.window.createQuickPick();
    quickPick.items = itemsForSearch.slice(0, 50);
    quickPick.matchOnDescription = false;
    quickPick.matchOnDetail = false;
    quickPick.placeholder = "Search symbols (FZF)";

    // Store original editor state to return to if canceled
    let lastSelectedItem: SymbolQuickPickItem | undefined;
    let previewEditor: vscode.TextEditor | undefined;
    let isPreviewingFile = false;

    // Track if quickPick is active
    let quickPickActive = true;

    // Set focus back to quick pick when editor changes
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
      () => {
        if (quickPickActive) {
          quickPick.show();
        }
      }
    );

    quickPick.onDidChangeValue((value) => {
      if (!value) {
        quickPick.items = itemsForSearch.slice(0, 50);
        return;
      }

      // Use FZF to find matches
      const results = fzf.find(value);

      quickPick.items = results.map((result) => result.item);
    });

    // Preview the selected file when navigating
    quickPick.onDidChangeActive(async (items) => {
      const selected = items[0] as SymbolQuickPickItem;
      if (
        selected &&
        selected !== lastSelectedItem &&
        selected.description &&
        !isPreviewingFile
      ) {
        lastSelectedItem = selected;
        isPreviewingFile = true;

        try {
          const filePath = path.join(rootPath, selected.description);
          const line = selected.line || 1;
          const langId = getLanguageIdFromFilePath(filePath);

          // Create a URI with our custom scheme
          const previewUri = getSymbolPreviewUri(filePath, line, langId);

          // Open with our lightweight preview provider
          const doc = await vscode.workspace.openTextDocument(previewUri);

          // Set the language ID for syntax highlighting
          await vscode.languages.setTextDocumentLanguage(doc, langId);

          const previewEditor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Active,
            preview: true,
            preserveFocus: true, // Keep focus on the quickPick
          });

          // Highlight the line
          const linePosition = line - 1;
          const range = new vscode.Range(linePosition, 0, linePosition, 0);
          previewEditor.selection = new vscode.Selection(
            linePosition,
            0,
            linePosition,
            0
          );
          previewEditor.revealRange(
            range,
            vscode.TextEditorRevealType.InCenter
          );

          // Add decoration to highlight the line
          const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor(
              "editor.findMatchHighlightBackground"
            ),
            isWholeLine: true,
          });
          previewEditor.setDecorations(decoration, [range]);
        } catch (err) {
          console.error("Failed to preview file:", err);
        } finally {
          // Reset preview flag after a short delay
          setTimeout(() => {
            isPreviewingFile = false;
          }, 200);
        }
      }
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0] as SymbolQuickPickItem;
      if (selected) {
        // Close the preview first
        if (
          vscode.window.activeTextEditor &&
          vscode.window.activeTextEditor.document.uri.scheme === PREVIEW_SCHEME
        ) {
          // Close any open preview editors
          await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor"
          );
        }

        // Open the actual file (not in preview mode)
        const fileUri = vscode.Uri.file(
          path.join(rootPath, selected.description ?? "")
        );
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
          viewColumn: vscode.ViewColumn.Active, // Open in the active column
        });

        // Reveal the line
        const line = (selected.line ?? 1) - 1;
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
      }

      // Clean up the disposable
      editorChangeDisposable.dispose();
      quickPick.hide();
    });

    quickPick.onDidHide(async () => {
      quickPickActive = false;

      // Clean up the disposable
      editorChangeDisposable.dispose();

      // Close any open symbol preview editors
      const openEditors = vscode.window.visibleTextEditors;
      for (const editor of openEditors) {
        if (editor.document.uri.scheme === PREVIEW_SCHEME) {
          // Close this preview editor
          await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor"
          );
          break; // Only close one editor, which should be the active one
        }
      }

      // Restore original setting
      vscode.workspace
        .getConfiguration("workbench.editor")
        .update(
          "enablePreviewFromQuickOpen",
          originalPreviewSetting,
          vscode.ConfigurationTarget.Global
        );

      // If we didn't accept a selection and have an original editor, go back to it
      if (originalEditor && originalEditor.document) {
        vscode.window.showTextDocument(originalEditor.document, {
          viewColumn: originalEditor.viewColumn,
          selection: originalEditor.selection,
          preview: false,
        });
      }
    });

    quickPick.show();
  }
);

export function activate(context: vscode.ExtensionContext) {
  const swapToSibling = vscode.commands.registerCommand(
    "olly.swapToSibling",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor");
        return;
      }
      const currentUri = editor.document.uri;
      const currentPath = currentUri.fsPath;
      const path = require("path");
      const fs = require("fs");

      const dir = path.dirname(currentPath);
      const file = path.basename(currentPath);
      const ext = path.extname(file);
      const base = file.slice(0, -ext.length);

      // Patterns to match and generate sibling names
      const patterns = [
        // If current is a test/spec file, try to find the non-test/spec sibling
        /([\.-_])(test|spec)$/,
      ];
      let siblingCandidates = [];
      let match = base.match(patterns[0]);
      if (match) {
        // e.g. foo.test -> foo
        const baseName = base.replace(patterns[0], "");
        siblingCandidates.push(path.join(dir, baseName + ext));
      } else {
        // e.g. foo -> foo.test, foo.spec, foo_test, foo-spec, foo.spec
        const suffixes = ["test", "spec"];
        const seps = ["-", ".", "_"];
        for (const sep of seps) {
          for (const suf of suffixes) {
            siblingCandidates.push(path.join(dir, base + sep + suf + ext));
          }
        }
      }

      // Find the first sibling that exists
      const sibling = siblingCandidates.find((candidate) =>
        fs.existsSync(candidate)
      );
      if (sibling) {
        const doc = await vscode.workspace.openTextDocument(sibling);
        vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showInformationMessage("No sibling file found.");
      }
    }
  );

  // Register the content provider for symbol previews (now from symbolPreview)
  const providerRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider
    );
  context.subscriptions.push(providerRegistration);

  context.subscriptions.push(swapToSibling);
  context.subscriptions.push(searchSymbols);
}

export function deactivate() {}
