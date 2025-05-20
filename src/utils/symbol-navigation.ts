import * as vscode from "vscode";
import {
  PREVIEW_SCHEME,
  getSymbolPreviewUri,
  PreviewManager,
} from "./symbol-preview";
import { getLanguageIdFromFilePath, getFirstIdentifier } from "./symbol-search";
import { RecencyTracker } from "./recency-tracker";

// Define a custom type for location items
export interface LocationQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  range: vscode.Range;
  score?: number;
}

// Define location provider types
export type LocationProviderType =
  | "references"
  | "definition"
  | "implementation"
  | "typeDefinition";

// Mapping of provider types to commands
export const providerCommands: Record<LocationProviderType, string> = {
  references: "vscode.executeReferenceProvider",
  definition: "vscode.executeDefinitionProvider",
  implementation: "vscode.executeImplementationProvider",
  typeDefinition: "vscode.executeTypeDefinitionProvider",
};

// Mapping of provider types to display names
export const displayNameMap: Record<LocationProviderType, string> = {
  references: "References",
  definition: "Definition",
  implementation: "Implementations",
  typeDefinition: "Type Definition",
};

// Navigate to a specific location
export async function navigateToLocation(
  location: vscode.Location,
  outputChannel: vscode.OutputChannel,
  recencyTracker: RecencyTracker,
  symbolName: string
): Promise<void> {
  await recencyTracker.recordAccess(location.uri.fsPath, symbolName);

  const doc = await vscode.workspace.openTextDocument(location.uri);

  const lineZeroIndex = location.range.start.line;
  let columnZeroIndex = location.range.start.character;

  const lineText = doc.lineAt(lineZeroIndex).text;
  const lineTextFromColumnZeroIndex = lineText.slice(
    columnZeroIndex,
    lineText.length
  );

  const identifier = getFirstIdentifier(lineTextFromColumnZeroIndex);

  if (identifier) {
    columnZeroIndex = lineText.indexOf(identifier);
  }

  outputChannel.appendLine(
    `OMN: navigateToLocation > looking for identifier in text: "${lineTextFromColumnZeroIndex}", found: "${identifier}"`
  );

  const range = new vscode.Range(
    lineZeroIndex,
    columnZeroIndex,
    lineZeroIndex,
    columnZeroIndex
  );

  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Active,
    preview: false,
    preserveFocus: false,
    selection: range,
  });

  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

  outputChannel.appendLine(
    `OMN: Navigated to ${location.uri.fsPath} range: ${range.start.line} ${range.start.character} ${range.end.line} ${range.end.character}`
  );
}

// Function to handle symbol navigation
export async function navigateToSymbolLocations(
  providerType: LocationProviderType,
  outputChannel: vscode.OutputChannel,
  recencyTracker: RecencyTracker
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("No active editor");
    return;
  }

  const position = editor.selection.active;
  const document = editor.document;

  // Create our preview manager
  const previewManager = new PreviewManager(outputChannel);

  // Get display name based on provider type
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

  // Filter out the current position for references
  const filteredLocations =
    providerType === "references"
      ? locations.filter((loc) => {
          // Skip if it's the same position where the command was triggered
          if (
            loc.uri.fsPath === document.uri.fsPath &&
            loc.range.start.line === position.line
          ) {
            return false;
          }
          return true;
        })
      : locations;

  outputChannel.appendLine(
    `OMN: ${displayName} locations: ${JSON.stringify(filteredLocations)}`
  );

  if (filteredLocations.length === 0) {
    vscode.window.showInformationMessage(
      `No ${displayName.toLowerCase()} found`
    );
    return;
  }

  // Get the symbol name at the current position
  const wordRange = document.getWordRangeAtPosition(position);
  let symbolName = wordRange ? document.getText(wordRange) : "symbol";

  // If only one location found, navigate directly to it
  if (filteredLocations.length === 1) {
    // Use the symbol name we've already extracted for consistency
    await navigateToLocation(
      filteredLocations[0],
      outputChannel,
      recencyTracker,
      symbolName
    );
    return;
  }

  // Create location items for quickpick
  const items: LocationQuickPickItem[] = await Promise.all(
    filteredLocations.map(async (location) => {
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

  // Set up quickpick
  const quickPick = vscode.window.createQuickPick<LocationQuickPickItem>();
  quickPick.items = validItems;
  quickPick.matchOnDescription = true;
  quickPick.placeholder = `${displayName} for '${symbolName}' (${
    validItems.length
  } ${
    providerType === "definition" ? "definitions" : providerType
  }) - Search by filename, code, or path`;

  // Initialize preview manager with quickpick
  await previewManager.init();

  quickPick.show();

  // Set up fuzzy search
  const { Fzf } = await import("fzf");
  let fzf = new Fzf(validItems, {
    selector: (item) => `${item.label} ${item.detail} ${item.description}`,
    casing: "smart-case",
  });

  let lastSelectedItem: LocationQuickPickItem | undefined;

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
      `OMN: ${displayName} first 4 items: ${JSON.stringify(
        sortedResults.map((r) => r.description).slice(0, 4)
      )}`
    );

    quickPick.items = sortedResults;
  });

  // Handle preview of items
  quickPick.onDidChangeActive(async (activeItems) => {
    const selected = activeItems[0] as LocationQuickPickItem;
    if (selected && selected !== lastSelectedItem) {
      try {
        lastSelectedItem = selected;

        // Show preview of the file
        await previewManager.showFile(
          selected.uri.fsPath,
          selected.range.start.line + 1, // 1-based line number
          selected.range.start.character + 1, // 1-based character
          selected.range.end.character + 1
        );
      } catch (err) {
        console.error("Error previewing file:", err);
      }
    }
  });

  // Handle selection
  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0];
    if (selected) {
      void (async () => {
        await previewManager.dispose();

        // Create a location object from the selected item
        const location: vscode.Location = {
          uri: selected.uri,
          range: selected.range,
        };

        // Navigate to the selected location with recency tracking
        await navigateToLocation(
          location,
          outputChannel,
          recencyTracker,
          selected.label
        );
      })();
    }
    quickPick.hide();
  });

  // Cleanup
  quickPick.onDidHide(async () => {
    await previewManager.dispose();
    quickPick.dispose();
  });
}
