import * as vscode from "vscode";
import * as path from "path";
import {
  findSymbols,
  getLanguageIdFromFilePath,
  symbolTypeToIcon,
} from "../utils/symbolSearch";
import { PREVIEW_SCHEME, getSymbolPreviewUri } from "../utils/symbolPreview";
import { RecencyTracker } from "../utils/recencyTracker";
import { LastCommandTracker } from "../utils/lastCommandTracker";

// Define a custom type for symbol items
interface SymbolQuickPickItem extends vscode.QuickPickItem {
  iconPath: vscode.ThemeIcon;
  file: string;
  line: number;
  score: number;
  startColumn: number; // start of the symbol
  endColumn: number; // end of the symbol
}

// Stale-while-revalidate cache for symbol search results
const symbolCache: Record<string, SymbolQuickPickItem[]> = {};

// Helper to get cache key
function getCacheKey(type: string, rootPath: string) {
  return `${type}::${rootPath}`;
}

export function registerSearchSymbolsCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel,
  lastCommandTracker?: LastCommandTracker
) {
  const searchSymbols = vscode.commands.registerCommand(
    "omn.searchSymbols",
    async (typeArg?: string, searchValue?: string) => {
      // Store this command as the last executed command
      if (lastCommandTracker) {
        const args = [];
        if (typeArg) args.push(typeArg);
        if (searchValue) args.push(searchValue);
        await lastCommandTracker.setLastCommand("omn.searchSymbols", args);
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showInformationMessage("No workspace open");
        return;
      }

      const rootPath = workspaceFolders[0].uri.fsPath;

      const originalEditor = vscode.window.activeTextEditor;

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
      if (typeArg) {
        picked = symbolTypes.find((t) => t.value === typeArg);
      } else {
        picked = await vscode.window.showQuickPick(symbolTypes, {
          placeHolder: "Select symbol type to search",
        });
      }
      if (!picked) return;

      const cacheKey = getCacheKey(picked.value, rootPath);

      let itemsForSearch: SymbolQuickPickItem[] = [];

      const fromCache = symbolCache[cacheKey];

      await recencyTracker.load();

      if (fromCache) {
        const cachedItemsWithLatestScores: SymbolQuickPickItem[] =
          fromCache.map((item) => {
            const score = recencyTracker.getScore(item.file, item.label);

            return {
              ...item,
              score: score?.score ?? 0,
            };
          });

        cachedItemsWithLatestScores.sort(compareSymbolQuickPickItems);

        itemsForSearch = cachedItemsWithLatestScores;
      }

      const quickPick = vscode.window.createQuickPick<SymbolQuickPickItem>();

      if (itemsForSearch.length > 0) {
        quickPick.items = itemsForSearch.slice(0, 20);
        quickPick.busy = true;
      } else {
        quickPick.items = [
          {
            label: "$(sync~spin) Loading symbols...",
            description: "",
            alwaysShow: true,
          } as SymbolQuickPickItem,
        ];
        quickPick.busy = true;
      }
      quickPick.matchOnDescription = false;
      quickPick.matchOnDetail = false;
      quickPick.placeholder = "Search symbols";

      if (searchValue) {
        quickPick.value = searchValue;
      }

      quickPick.show();
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
            } as SymbolQuickPickItem,
          ];
          quickPick.busy = false;
          symbolCache[cacheKey] = [];
          return;
        }

        await recencyTracker.load();

        const freshItems: SymbolQuickPickItem[] = symbols.map((item) => {
          const relativePath = item.file.startsWith(rootPath)
            ? item.file.substring(rootPath.length + 1)
            : item.file;

          const score = recencyTracker.getScore(item.file, item.symbol);

          return {
            label: item.symbol,
            description: relativePath,
            iconPath: new vscode.ThemeIcon(symbolTypeToIcon[item.type]),
            file: item.file,
            line: item.line,
            score: score.score,
            startColumn: item.startColumn,
            endColumn: item.endColumn,
          };
        });

        freshItems.sort(compareSymbolQuickPickItems);

        symbolCache[cacheKey] = freshItems;
        itemsForSearch = freshItems;

        fzf = new Fzf(itemsForSearch, {
          selector: (item) => item.label,
          casing: "smart-case",
          limit: 20,
        });

        quickPick.items = freshItems.slice(0, 20);
        quickPick.busy = false;
      };
      void backgroundSearch();

      let lastSelectedItem: SymbolQuickPickItem | undefined;
      let isPreviewingFile = false;
      let quickPickActive = true;

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

        // Update last command with current type and search value
        if (lastCommandTracker && picked) {
          lastCommandTracker.setLastCommand("omn.searchSymbols", [
            picked.value,
            value,
          ]);
        }

        const results = fzf.find(value);
        if (results.length === 0) {
          quickPick.items = [];
          return;
        }
        const maxFzfScore = Math.max(...results.map((r) => r.score));

        const enrichedResults: SymbolQuickPickItem[] = results.map((result) => {
          const recencyScore = result.item.score || 0;
          const normalizedFzfScore = (result.score / maxFzfScore) * 100;
          const combinedScore = normalizedFzfScore * 0.6 + recencyScore * 0.4;

          return {
            ...result.item,
            score: combinedScore,
          };
        });

        const sortedResults = enrichedResults.sort(compareSymbolQuickPickItems);

        outputChannel.appendLine(
          `OMN: '${picked.label}' first 4 items: ${JSON.stringify(
            sortedResults
              .map((r) => `${r.label} score: ${r.score?.toFixed(1)}`)
              .slice(0, 4)
          )}`
        );
        quickPick.items = sortedResults;
      });

      quickPick.onDidChangeActive(async (items) => {
        const selected = items[0];
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
            const previewUri = getSymbolPreviewUri(filePath, line, langId);
            const doc = await vscode.workspace.openTextDocument(previewUri);
            await vscode.languages.setTextDocumentLanguage(doc, langId);
            const previewEditor = await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Active,
              preview: true,
              preserveFocus: true,
            });
            const linePosition = line - 1;

            const range = new vscode.Range(
              linePosition,
              selected.startColumn,
              linePosition,
              selected.endColumn
            );

            previewEditor.selection = new vscode.Selection(
              linePosition,
              selected.startColumn,
              linePosition,
              selected.endColumn
            );
            previewEditor.revealRange(
              range,
              vscode.TextEditorRevealType.InCenter
            );
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
            setTimeout(() => {
              isPreviewingFile = false;
            }, 200);
          }
        }
      });

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
          if (
            vscode.window.activeTextEditor &&
            vscode.window.activeTextEditor.document.uri.scheme ===
              PREVIEW_SCHEME
          ) {
            await vscode.commands.executeCommand(
              "workbench.action.closeActiveEditor"
            );
          }
          if (selected.file && selected.label) {
            await recencyTracker.recordAccess(selected.file, selected.label);
          }
          const fileUri = vscode.Uri.file(
            path.join(rootPath, selected.description ?? "")
          );
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const editor = await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
          const line = (selected.line ?? 1) - 1;
          const pos = new vscode.Position(line, selected.startColumn);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(
            new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenter
          );
        }
        editorChangeDisposable.dispose();
        quickPick.hide();
      });

      quickPick.onDidHide(async () => {
        quickPickActive = false;
        editorChangeDisposable.dispose();
        const openEditors = vscode.window.visibleTextEditors;
        for (const editor of openEditors) {
          if (editor.document.uri.scheme === PREVIEW_SCHEME) {
            await vscode.commands.executeCommand(
              "workbench.action.closeActiveEditor"
            );
            break;
          }
        }
        vscode.workspace
          .getConfiguration("workbench.editor")
          .update(
            "enablePreviewFromQuickOpen",
            originalPreviewSetting,
            vscode.ConfigurationTarget.Global
          );

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
  context.subscriptions.push(searchSymbols);
}

const compareSymbolQuickPickItems = (
  a: SymbolQuickPickItem,
  b: SymbolQuickPickItem
) => {
  // First compare by score (higher scores first)
  const scoreA = a.score || 0;
  const scoreB = b.score || 0;
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
  }

  // Then alphabetically by label
  if (a.label !== b.label) {
    return a.label.localeCompare(b.label);
  }

  // Then by description if present
  const descriptionA = a.description || "";
  const descriptionB = b.description || "";
  if (descriptionA !== descriptionB) {
    return descriptionA.localeCompare(descriptionB);
  }

  // Finally by line number
  return (a.line || 0) - (b.line || 0);
};
