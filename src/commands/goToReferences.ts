import * as vscode from "vscode";
import * as path from "path";
import { PREVIEW_SCHEME, getSymbolPreviewUri } from "../utils/symbolPreview";
import { getLanguageIdFromFilePath } from "../utils/symbolSearch";
import { RecencyTracker } from "../utils/recencyTracker";

// Define a custom type for reference items
interface ReferenceQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  range: vscode.Range;
  score?: number;
}

export function registerGoToReferencesCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
) {
  const goToReferences = vscode.commands.registerCommand(
    "olly.goToReferences",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor");
        return;
      }

      const position = editor.selection.active;
      const document = editor.document;
      const originalEditor = editor;
      const originalPreviewSetting = vscode.workspace
        .getConfiguration("workbench.editor")
        .get("enablePreviewFromQuickOpen");

      // Set preview from quick open
      await vscode.workspace
        .getConfiguration("workbench.editor")
        .update(
          "enablePreviewFromQuickOpen",
          true,
          vscode.ConfigurationTarget.Global
        );

      // Find all references
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        document.uri,
        position
      );

      if (!locations || locations.length === 0) {
        vscode.window.showInformationMessage("No references found");
        return;
      }

      // Get the symbol name at the current position
      let symbolName = document.getText(
        document.getWordRangeAtPosition(position)
      );

      // Create reference items for quickpick
      const items: ReferenceQuickPickItem[] = await Promise.all(
        locations.map(async (location) => {
          const uri = location.uri;
          const range = location.range;
          const lineText = (await vscode.workspace.openTextDocument(uri))
            .lineAt(range.start.line)
            .text.trim();
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const rootPath = workspaceFolder?.uri.fsPath || "";
          const relativePath = uri.fsPath.startsWith(rootPath)
            ? uri.fsPath.substring(rootPath.length + 1)
            : uri.fsPath;

          return {
            label: lineText,
            description: `${relativePath}:${range.start.line + 1}`,
            uri: uri,
            range: range,
            iconPath: new vscode.ThemeIcon("references"),
          };
        })
      );

      // Sort items by file path and line number
      items.sort((a, b) => {
        // First compare file paths
        if (a.uri.fsPath !== b.uri.fsPath) {
          return a.uri.fsPath.localeCompare(b.uri.fsPath);
        }
        // If same file, sort by line number
        return a.range.start.line - b.range.start.line;
      });

      // Set up quickpick
      const quickPick = vscode.window.createQuickPick<ReferenceQuickPickItem>();
      quickPick.items = items;
      quickPick.matchOnDescription = true;
      quickPick.placeholder = `References for '${symbolName}' (${items.length} references) - Search by filename, code, or path`;
      quickPick.show();

      // Set up fuzzy search
      const { Fzf } = await import("fzf");
      let fzf = new Fzf(items, {
        selector: (item) => `${item.label} ${item.detail} ${item.description}`,
        casing: "smart-case",
        limit: 50,
      });

      let lastSelectedItem: ReferenceQuickPickItem | undefined;
      let isPreviewingFile = false;
      let quickPickActive = true;

      // Set up editor change listener
      const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
        () => {
          if (quickPickActive) {
            quickPick.show();
          }
        }
      );

      // Handle filter input changes
      quickPick.onDidChangeValue((value) => {
        if (!value) {
          quickPick.items = items;
          return;
        }

        const results = fzf.find(value);
        if (results.length === 0) {
          quickPick.items = [];
          return;
        }

        const sortedResults = results.map((result) => ({
          ...result.item,
          alwaysShow: true,
        }));

        outputChannel.appendLine(
          `Olly: References first 4 items: ${JSON.stringify(
            sortedResults.map((r) => r.description).slice(0, 4)
          )}`
        );

        quickPick.items = sortedResults;
      });

      // Handle preview of items
      quickPick.onDidChangeActive(async (activeItems) => {
        const selected = activeItems[0] as ReferenceQuickPickItem;
        if (
          selected &&
          selected !== lastSelectedItem &&
          selected.description &&
          !isPreviewingFile
        ) {
          lastSelectedItem = selected;
          isPreviewingFile = true;
          try {
            const filePath = selected.uri.fsPath;
            const line = selected.range.start.line + 1;
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
              selected.range.start.character,
              linePosition,
              selected.range.end.character
            );

            previewEditor.selection = new vscode.Selection(
              linePosition,
              selected.range.start.character,
              linePosition,
              selected.range.end.character
            );

            previewEditor.revealRange(
              range,
              vscode.TextEditorRevealType.InCenter
            );

            const decoration = vscode.window.createTextEditorDecorationType({
              backgroundColor: new vscode.ThemeColor(
                "editor.findMatchHighlightBackground"
              ),
              fontWeight: "bold",
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

      // Handle item selection
      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0] as ReferenceQuickPickItem;
        if (selected) {
          // First hide the quickPick to ensure focus will move to the editor
          quickPickActive = false;
          quickPick.hide();

          // Close preview editor if open
          if (
            vscode.window.activeTextEditor &&
            vscode.window.activeTextEditor.document.uri.scheme ===
              PREVIEW_SCHEME
          ) {
            await vscode.commands.executeCommand(
              "workbench.action.closeActiveEditor"
            );
          }

          // Log debugging information
          outputChannel.appendLine(
            `Navigating to reference at ${selected.uri.fsPath}:${
              selected.range.start.line + 1
            }:${selected.range.start.character}`
          );

          try {
            // Open the document at the exact location using the revealRange command
            await vscode.commands.executeCommand("vscode.open", selected.uri, {
              selection: selected.range,
              viewColumn: vscode.ViewColumn.Active,
              preserveFocus: false,
            });

            // Ensure the editor is focused and the range is visible
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              // Create a more precise selection at the reference
              const position = new vscode.Position(
                selected.range.start.line,
                selected.range.start.character
              );

              // Set selection and ensure it's visible in the center
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(
                selected.range,
                vscode.TextEditorRevealType.InCenter
              );

              // Apply temporary highlighting
              const highlightDecoration =
                vscode.window.createTextEditorDecorationType({
                  backgroundColor: new vscode.ThemeColor(
                    "editor.findMatchHighlightBackground"
                  ),
                  isWholeLine: false,
                });

              editor.setDecorations(highlightDecoration, [selected.range]);

              // Remove decoration after a delay
              setTimeout(() => {
                highlightDecoration.dispose();
              }, 2000);
            }
          } catch (err) {
            console.error("Failed to navigate to reference:", err);
            outputChannel.appendLine(`Error navigating to reference: ${err}`);
          }
        }

        editorChangeDisposable.dispose();
        quickPick.hide();
      });

      // Clean up when quickpick is hidden
      quickPick.onDidHide(async () => {
        if (quickPickActive) {
          // Only do this if not already handled in onDidAccept
          quickPickActive = false;

          // Close preview editor if open
          const openEditors = vscode.window.visibleTextEditors;
          for (const editor of openEditors) {
            if (editor.document.uri.scheme === PREVIEW_SCHEME) {
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor"
              );
              break;
            }
          }

          // Restore original editor if we didn't select anything
          if (originalEditor && originalEditor.document) {
            vscode.window.showTextDocument(originalEditor.document, {
              viewColumn: originalEditor.viewColumn,
              selection: originalEditor.selection,
              preview: false,
            });
          }
        }

        // Always clean up resources
        editorChangeDisposable.dispose();

        // Restore original preview setting
        vscode.workspace
          .getConfiguration("workbench.editor")
          .update(
            "enablePreviewFromQuickOpen",
            originalPreviewSetting,
            vscode.ConfigurationTarget.Global
          );
      });
    }
  );

  context.subscriptions.push(goToReferences);
}
