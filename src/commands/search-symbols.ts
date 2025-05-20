import * as vscode from "vscode";
import * as path from "path";
import {
  findSymbols,
  getLanguageIdFromFilePath,
  symbolTypeToIcon,
} from "../utils/symbol-search";
import {
  PREVIEW_SCHEME,
  getSymbolPreviewUri,
  PreviewManager,
} from "../utils/symbol-preview";
import { RecencyTracker } from "../utils/recency-tracker";
import { LastCommandTracker } from "../utils/last-command-tracker";

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

      // Create our preview manager and initialize it
      const previewManager = new PreviewManager(outputChannel);
      await previewManager.init();

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

      let picked: (typeof symbolTypes)[number] | undefined;
      if (typeArg) {
        picked = symbolTypes.find((t) => t.value === typeArg);
      } else {
        picked = await vscode.window.showQuickPick(symbolTypes, {
          placeHolder: "Select symbol type to search",
        });
      }
      if (!picked) {
        await previewManager.dispose(); // Clean up if user cancels
        return;
      }

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

      quickPick.onDidChangeValue((value) => {
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
        if (selected && selected.description) {
          try {
            const filePath = path.join(rootPath, selected.description);
            await previewManager.showFile(
              filePath,
              selected.line,
              selected.startColumn,
              selected.endColumn
            );
          } catch (err) {
            console.error("Failed to preview file:", err);
          }
        }
      });

      quickPick.onDidAccept(async () => {
        await previewManager.dispose();

        const selected = quickPick.selectedItems[0];
        if (selected) {
          if (selected.file && selected.label) {
            await recencyTracker.recordAccess(selected.file, selected.label);
          }
          const fileUri = vscode.Uri.file(
            path.join(rootPath, selected.description ?? "")
          );
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const selection = new vscode.Selection(
            selected.line - 1,
            selected.startColumn - 1,
            selected.line - 1,
            selected.startColumn - 1
          );
          const editor = await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
          outputChannel.appendLine(
            `OMN: Opened file: ${selected.description} at line: ${selected.line} at column: ${selected.startColumn}`
          );
          editor.selection = selection;
          editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
        }
      });

      quickPick.onDidHide(async () => {
        outputChannel.appendLine("OMN: onDidHide Quick pick hidden");
        await previewManager.dispose();
        quickPick.dispose();
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
