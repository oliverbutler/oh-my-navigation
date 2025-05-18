import * as vscode from "vscode";
import * as path from "path";
import { PREVIEW_SCHEME, getSymbolPreviewUri } from "../utils/symbolPreview";
import { getLanguageIdFromFilePath } from "../utils/symbolSearch";
import { RecencyTracker } from "../utils/recencyTracker";
import { searchWithRipgrep, RipgrepMatch } from "../utils/ripgrepSearch";

// Define a custom type for location items
interface LocationQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  range: vscode.Range;
  score?: number;
}

// Function to search with ripgrep and display results with fuzzy find
async function searchWithRipgrepCommand(outputChannel: vscode.OutputChannel) {
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

  // Get the word under cursor
  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    vscode.window.showInformationMessage("No word found under cursor");
    return;
  }

  const searchTerm = document.getText(wordRange);
  if (!searchTerm) {
    vscode.window.showInformationMessage("No word found under cursor");
    return;
  }

  // Show progress while searching
  const matches: RipgrepMatch[] = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching for "${searchTerm}"`,
      cancellable: true,
    },
    async (progress, token) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showInformationMessage("No workspace folder open");
        return [];
      }
      const rootPath = workspaceFolders[0].uri.fsPath;

      // Use our ripgrepSearch utility
      try {
        if (token.isCancellationRequested) {
          return [];
        }

        progress.report({ message: "Running ripgrep..." });
        const results = await searchWithRipgrep(searchTerm, rootPath);

        if (token.isCancellationRequested) {
          return [];
        }

        progress.report({ message: `Found ${results.length} matches` });
        return results;
      } catch (err) {
        outputChannel.appendLine(`Error in ripgrep search: ${err}`);
        return [];
      }
    }
  );

  if (matches.length === 0) {
    vscode.window.showInformationMessage(
      `No results found for "${searchTerm}"`
    );
    return;
  }

  // If only one match found, navigate directly to it
  if (matches.length === 1) {
    const match = matches[0];
    // Create a VS Code location
    const location = createLocationFromMatch(match, searchTerm);
    await navigateToLocation(location, outputChannel);
    return;
  }

  // Create location items for quickpick
  const items: LocationQuickPickItem[] = await Promise.all(
    matches.map(async (match) => {
      try {
        // Convert match to VS Code structures
        const location = createLocationFromMatch(match, searchTerm);

        // Load the document to get the text at the location
        const doc = await vscode.workspace.openTextDocument(location.uri);
        // Ensure we have valid line numbers
        const lineNum = Math.min(location.range.start.line, doc.lineCount - 1);
        const lineText = doc.lineAt(lineNum).text.trim();

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          location.uri
        );
        const rootPath = workspaceFolder?.uri.fsPath || "";
        const relativePath = location.uri.fsPath.startsWith(rootPath)
          ? location.uri.fsPath.substring(rootPath.length + 1)
          : location.uri.fsPath;

        return {
          label: lineText,
          description: `${relativePath}:${lineNum + 1}`,
          uri: location.uri,
          range: location.range,
          iconPath: new vscode.ThemeIcon("search"),
        };
      } catch (err) {
        // Handle any errors that occurred during processing
        outputChannel.appendLine(`Error processing match: ${err}`);
        return {
          label: "Error processing location",
          description: match.filePath,
          uri: vscode.Uri.file(match.filePath),
          range: new vscode.Range(0, 0, 0, 0),
          iconPath: new vscode.ThemeIcon("error"),
        };
      }
    })
  );

  // Filter out any undefined or invalid items
  const validItems = items.filter((item) => item && item.label);

  // If no valid items, show message and return
  if (validItems.length === 0) {
    vscode.window.showInformationMessage(
      `No valid results found for "${searchTerm}"`
    );
    return;
  }

  // Sort items by file path and line number
  validItems.sort((a, b) => {
    // First compare file paths
    if (a.uri.fsPath !== b.uri.fsPath) {
      return a.uri.fsPath.localeCompare(b.uri.fsPath);
    }
    // If same file, sort by line number
    return a.range.start.line - b.range.start.line;
  });

  // Set up quickpick
  const quickPick = vscode.window.createQuickPick<LocationQuickPickItem>();
  quickPick.items = validItems;
  quickPick.matchOnDescription = true;
  quickPick.placeholder = `Search results for '${searchTerm}' (${validItems.length} matches) - Search by filename, code, or path`;
  quickPick.show();

  // Set up fuzzy search
  const { Fzf } = await import("fzf");
  let fzf = new Fzf(validItems, {
    selector: (item) =>
      `${item.label} ${item.detail || ""} ${item.description || ""}`,
    casing: "smart-case",
    limit: 50,
  });

  let lastSelectedItem: LocationQuickPickItem | undefined;
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
      quickPick.items = validItems;
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
      `Olly: Search results first 4 items: ${JSON.stringify(
        sortedResults.map((r) => r.description).slice(0, 4)
      )}`
    );

    quickPick.items = sortedResults;
  });

  // Handle preview of items
  quickPick.onDidChangeActive(async (activeItems) => {
    const selected = activeItems[0] as LocationQuickPickItem;
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

        previewEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        const decoration = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor(
            "editor.findMatchHighlightBackground"
          ),
          fontWeight: "bold",
        });

        previewEditor.setDecorations(decoration, [range]);
      } catch (err) {
        console.error("Failed to preview file:", err);
        outputChannel.appendLine(`Error previewing file: ${err}`);
      } finally {
        setTimeout(() => {
          isPreviewingFile = false;
        }, 200);
      }
    }
  });

  // Handle item selection
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0] as LocationQuickPickItem;
    if (selected) {
      // First hide the quickPick to ensure focus will move to the editor
      quickPickActive = false;
      quickPick.hide();

      // Close preview editor if open
      if (
        vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.uri.scheme === PREVIEW_SCHEME
      ) {
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor"
        );
      }

      await navigateToLocation(
        { uri: selected.uri, range: selected.range },
        outputChannel
      );
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

/**
 * Helper function to create a VS Code Location from a RipgrepMatch
 */
function createLocationFromMatch(
  match: RipgrepMatch,
  searchTerm: string
): vscode.Location {
  const uri = vscode.Uri.file(match.filePath);

  // Find actual match length in the text (could be different due to case insensitivity)
  let matchLength = searchTerm.length;
  if (match.matchText) {
    const lowerText = match.matchText.toLowerCase();
    const lowerSearchTerm = searchTerm.toLowerCase();
    const startPos = lowerText.indexOf(lowerSearchTerm);

    if (
      startPos >= 0 &&
      startPos + match.columnNumber < match.matchText.length
    ) {
      // Use the original casing version from the matched text
      matchLength = Math.min(
        searchTerm.length,
        match.matchText.length - startPos
      );
    }
  }

  // Create the range
  const range = new vscode.Range(
    match.lineNumber,
    match.columnNumber,
    match.lineNumber,
    Math.min(match.columnNumber + matchLength, match.columnNumber + 100) // Limit max length to avoid issues
  );

  return { uri, range };
}

// Function to navigate to a specific location
async function navigateToLocation(
  location: vscode.Location,
  outputChannel: vscode.OutputChannel
) {
  // Verify location has valid properties
  if (!location || !location.uri || !location.range) {
    outputChannel.appendLine(`Error: Invalid location provided`);
    return;
  }

  // Log debugging information
  outputChannel.appendLine(
    `Navigating to location at ${location.uri.fsPath}:${
      location.range.start.line + 1
    }:${location.range.start.character}`
  );

  try {
    // Open the document at the exact location using the revealRange command
    await vscode.commands.executeCommand("vscode.open", location.uri, {
      selection: location.range,
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
    });

    // Ensure the editor is focused and the range is visible
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      // Create a more precise selection at the location
      const position = new vscode.Position(
        location.range.start.line,
        location.range.start.character
      );

      // Set selection and ensure it's visible in the center
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
    }
  } catch (err) {
    console.error("Failed to navigate to location:", err);
    outputChannel.appendLine(`Error navigating to location: ${err}`);
  }
}

export function registerRipgrepSearchCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
) {
  // Register ripgrep search command
  const ripgrepSearch = vscode.commands.registerCommand(
    "olly.ripgrepSearch",
    async () => {
      await searchWithRipgrepCommand(outputChannel);
    }
  );

  // Add command to subscriptions
  context.subscriptions.push(ripgrepSearch);
}
