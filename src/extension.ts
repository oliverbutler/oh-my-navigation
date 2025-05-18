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
import { RecencyTracker, SymbolScore } from "./recencyTracker";

// Define a custom type for symbol items
interface SymbolQuickPickItem extends vscode.QuickPickItem {
  iconPath?: vscode.ThemeIcon;
  file?: string;
  line?: number;
  score?: number;
}

// Stale-while-revalidate cache for symbol search results
const symbolCache: Record<string, SymbolQuickPickItem[]> = {};

// Helper to get cache key
function getCacheKey(type: string, rootPath: string) {
  return `${type}::${rootPath}`;
}

// Global recency tracker instance
let recencyTracker: RecencyTracker;

// Output channel for extension logging
let outputChannel: vscode.OutputChannel;

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

    // --- Stale-while-revalidate: show cached results immediately if available ---
    const cacheKey = getCacheKey(picked.value, rootPath);
    let itemsForSearch: SymbolQuickPickItem[] = [];
    if (symbolCache[cacheKey]) {
      // Use cached results and enrich with recency scores
      itemsForSearch = [...symbolCache[cacheKey]];

      // Get recency scores for all items
      const scoreItems = itemsForSearch.map((item) => ({
        filePath: item.file!,
        symbolName: item.label,
      }));

      const scores = await recencyTracker.getScores(scoreItems);

      // Apply scores to items
      for (const item of itemsForSearch) {
        const key = `${item.file}#${item.label}`;
        const score = scores.get(key);
        if (score) {
          item.score = score.score;
        }
      }

      // Sort by score (highest first), then alphabetically
      itemsForSearch.sort((a, b) => {
        // Score sorting (descending)
        const scoreA = a.score || 0;
        const scoreB = b.score || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;

        // Fallback to alphabetical sorting
        if (a.label !== b.label) return a.label.localeCompare(b.label);
        if ((a.description || "") !== (b.description || ""))
          return (a.description || "").localeCompare(b.description || "");
        return (a.line || 0) - (b.line || 0);
      });
    }

    // Create the quick pick UI immediately (show cached or loading message)
    const quickPick = vscode.window.createQuickPick<SymbolQuickPickItem>();
    if (itemsForSearch.length > 0) {
      quickPick.items = itemsForSearch.slice(0, 50);
      quickPick.busy = true;
    } else {
      quickPick.items = [
        {
          label: "$(sync~spin) Loading symbols...",
          description: "",
          alwaysShow: true,
        },
      ];
      quickPick.busy = true;
    }
    quickPick.matchOnDescription = false;
    quickPick.matchOnDetail = false;
    quickPick.placeholder = "Search symbols";
    quickPick.show();

    // --- FZF instance (use cached or empty, will be updated on revalidate) ---
    const { Fzf } = await import("fzf");
    let fzf = new Fzf(itemsForSearch, {
      selector: (item) => item.label,
      casing: "smart-case",
      limit: 20,
    });

    const backgroundSearch = async () => {
      const symbols = await findSymbols(picked.value, rootPath);
      if (symbols.length === 0) {
        quickPick.items = [
          {
            label: "No symbols found.",
            description: "",
            alwaysShow: true,
          },
        ];
        quickPick.busy = false;
        symbolCache[cacheKey] = [];
        return;
      }

      // Create fresh items and enrich with recency scores
      const freshItems: SymbolQuickPickItem[] = symbols.map((item) => {
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

      // Get recency scores for all items
      const scoreItems = freshItems.map((item) => ({
        filePath: item.file!,
        symbolName: item.label,
      }));

      const scores = await recencyTracker.getScores(scoreItems);

      // Apply scores to items
      for (const item of freshItems) {
        const key = `${item.file}#${item.label}`;
        const score = scores.get(key);
        if (score) {
          item.score = score.score;
        }
      }

      // Sort by score (highest first), then alphabetically
      freshItems.sort((a, b) => {
        // Score sorting (descending)
        const scoreA = a.score || 0;
        const scoreB = b.score || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;

        // Fallback to alphabetical sorting
        if (a.label !== b.label) return a.label.localeCompare(b.label);
        if ((a.description || "") !== (b.description || ""))
          return (a.description || "").localeCompare(b.description || "");
        return (a.line || 0) - (b.line || 0);
      });

      symbolCache[cacheKey] = freshItems;
      itemsForSearch = freshItems;

      // Update FZF instance and quickPick items if quickPick is still open
      if (!quickPick.busy) return; // If user already accepted/canceled, skip

      fzf = new Fzf(itemsForSearch, {
        selector: (item) => item.label,
        casing: "smart-case",
        limit: 20,
      });
      quickPick.items = freshItems.slice(0, 20);
      quickPick.busy = false;
    };

    void backgroundSearch();

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
        quickPick.items = itemsForSearch;
        return;
      }

      const results = fzf.find(value);

      if (results.length === 0) {
        quickPick.items = [];
        return;
      }

      // Find max FZF score to normalize properly
      const maxFzfScore = Math.max(...results.map((r) => r.score));

      const enrichedResults: SymbolQuickPickItem[] = results.map((result) => {
        const recencyScore = result.item.score || 0;

        const normalizedFzfScore = (result.score / maxFzfScore) * 100;

        // Combined score: 60% FZF match quality, 40% recency/frequency
        const combinedScore = normalizedFzfScore * 0.6 + recencyScore * 0.4;

        return {
          ...result.item,
          label: `${result.item.label}`,
          alwaysShow: true,
          score: combinedScore,
        };
      });

      const sortedResults = enrichedResults.sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0)
      );

      outputChannel.appendLine(
        `Olly: '${picked.label}' first 4 items: ${JSON.stringify(
          sortedResults
            .map((r) => `${r.label} score: ${r.score?.toFixed(1)}`)
            .slice(0, 4)
        )}`
      );

      /**
       * BUG: Theres a bug here we can't avoid, vscode doesn't let us change the sort order of the results.
       *
       * This means even though all the data for recency is there, the resulting list isnt sorted with it.
       */
      quickPick.items = sortedResults;
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

        // Record this access in recency tracker
        if (selected.file && selected.label) {
          await recencyTracker.recordAccess(selected.file, selected.label);
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
  }
);

export function activate(context: vscode.ExtensionContext) {
  // Initialize output channel
  outputChannel = vscode.window.createOutputChannel("Olly");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Olly extension activated");

  // Initialize recency tracker
  recencyTracker = new RecencyTracker(context);

  // Command to show logs
  const showLogs = vscode.commands.registerCommand("olly.showLogs", () => {
    outputChannel.show();
  });

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

  // Add command to clear recency data
  const clearRecencyData = vscode.commands.registerCommand(
    "olly.clearRecencyData",
    async () => {
      await recencyTracker.clear();
      vscode.window.showInformationMessage("Recency data cleared");
    }
  );

  context.subscriptions.push(swapToSibling);
  context.subscriptions.push(searchSymbols);
  context.subscriptions.push(clearRecencyData);
  context.subscriptions.push(showLogs);
}

export function deactivate() {}
