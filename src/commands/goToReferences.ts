import * as vscode from "vscode";
import { PREVIEW_SCHEME, getSymbolPreviewUri } from "../utils/symbolPreview";
import { getLanguageIdFromFilePath } from "../utils/symbolSearch";
import { RecencyTracker } from "../utils/recencyTracker";

// Define a custom type for location items
interface LocationQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  range: vscode.Range;
  score?: number;
}

// Define location provider types
type LocationProviderType =
  | "references"
  | "definition"
  | "implementation"
  | "typeDefinition";

// Mapping of provider types to commands
const providerCommands = {
  references: "vscode.executeReferenceProvider",
  definition: "vscode.executeDefinitionProvider",
  implementation: "vscode.executeImplementationProvider",
  typeDefinition: "vscode.executeTypeDefinitionProvider",
};

// Function to handle symbol navigation
async function navigateToSymbolLocations(
  providerType: LocationProviderType,
  outputChannel: vscode.OutputChannel
) {
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

  // Get display name based on provider type
  const displayNameMap = {
    references: "References",
    definition: "Definition",
    implementation: "Implementations",
    typeDefinition: "Type Definition",
  };
  const displayName = displayNameMap[providerType];

  // Find all locations using the appropriate provider
  const command = providerCommands[providerType];
  const locationsResult = await vscode.commands.executeCommand<
    vscode.Location[] | vscode.LocationLink[]
  >(command, document.uri, position);

  // Convert location links to locations if needed and ensure proper structure
  const locations: vscode.Location[] = [];

  if (locationsResult) {
    for (const loc of locationsResult) {
      if ("uri" in loc && "range" in loc) {
        // This is a Location
        locations.push(loc as vscode.Location);
      } else if ("targetUri" in loc && "targetRange" in loc) {
        // This is a LocationLink
        locations.push({
          uri: (loc as vscode.LocationLink).targetUri,
          range: (loc as vscode.LocationLink).targetRange,
        });
      }
    }
  }

  if (locations.length === 0) {
    vscode.window.showInformationMessage(
      `No ${displayName.toLowerCase()} found`
    );
    return;
  }

  // If only one location found, navigate directly to it
  if (locations.length === 1) {
    await navigateToLocation(locations[0], outputChannel);
    return;
  }

  // Get the symbol name at the current position
  const wordRange = document.getWordRangeAtPosition(position);
  let symbolName = wordRange ? document.getText(wordRange) : "symbol";

  // Create location items for quickpick
  const items: LocationQuickPickItem[] = await Promise.all(
    locations.map(async (location) => {
      try {
        const uri = location.uri;
        const range = location.range;

        // Safely guard against undefined range values
        if (!range) {
          outputChannel.appendLine(
            `Warning: Invalid range for location in ${uri.fsPath}`
          );
          return {
            label: "Unknown location",
            description: uri.fsPath,
            uri: uri,
            range: new vscode.Range(0, 0, 0, 0),
            iconPath: new vscode.ThemeIcon(
              providerType === "references" ? "references" : "symbol-class"
            ),
          };
        }

        // Load the document to get the text at the location
        const doc = await vscode.workspace.openTextDocument(uri);
        // Ensure we have valid line numbers
        const lineNum = Math.min(range.start.line, doc.lineCount - 1);
        const lineText = doc.lineAt(lineNum).text.trim();

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const rootPath = workspaceFolder?.uri.fsPath || "";
        const relativePath = uri.fsPath.startsWith(rootPath)
          ? uri.fsPath.substring(rootPath.length + 1)
          : uri.fsPath;

        return {
          label: lineText,
          description: `${relativePath}:${lineNum + 1}`,
          uri: uri,
          range: range,
          iconPath: new vscode.ThemeIcon(
            providerType === "references" ? "references" : "symbol-class"
          ),
        };
      } catch (err) {
        // Handle any errors that occurred during processing
        outputChannel.appendLine(`Error processing location: ${err}`);
        return {
          label: "Error processing location",
          description: location.uri.fsPath,
          uri: location.uri,
          range: location.range || new vscode.Range(0, 0, 0, 0),
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
      `No valid ${displayName.toLowerCase()} found`
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
  quickPick.placeholder = `${displayName} for '${symbolName}' (${
    validItems.length
  } ${
    providerType === "definition" ? "definitions" : providerType
  }) - Search by filename, code, or path`;
  quickPick.show();

  // Set up fuzzy search
  const { Fzf } = await import("fzf");
  let fzf = new Fzf(validItems, {
    selector: (item) => `${item.label} ${item.detail} ${item.description}`,
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
      `Olly: ${displayName} first 4 items: ${JSON.stringify(
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

export function registerGoToReferencesCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
) {
  // Register go to references command
  const goToReferences = vscode.commands.registerCommand(
    "olly.goToReferences",
    async () => {
      await navigateToSymbolLocations("references", outputChannel);
    }
  );

  // Register go to definition command
  const goToDefinition = vscode.commands.registerCommand(
    "olly.goToDefinition",
    async () => {
      await navigateToSymbolLocations("definition", outputChannel);
    }
  );

  // Register go to implementation command
  const goToImplementation = vscode.commands.registerCommand(
    "olly.goToImplementation",
    async () => {
      await navigateToSymbolLocations("implementation", outputChannel);
    }
  );

  // Register go to type definition command
  const goToTypeDefinition = vscode.commands.registerCommand(
    "olly.goToTypeDefinition",
    async () => {
      await navigateToSymbolLocations("typeDefinition", outputChannel);
    }
  );

  // Add all commands to subscriptions
  context.subscriptions.push(
    goToReferences,
    goToDefinition,
    goToImplementation,
    goToTypeDefinition
  );
}
