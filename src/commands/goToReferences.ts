import * as vscode from "vscode";
import {
  PREVIEW_SCHEME,
  getSymbolPreviewUri,
  PreviewManager,
} from "../utils/symbolPreview";
import {
  getLanguageIdFromFilePath,
  getFirstIdentifier,
} from "../utils/symbolSearch";
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
const providerCommands: Record<LocationProviderType, string> = {
  references: "vscode.executeReferenceProvider",
  definition: "vscode.executeDefinitionProvider",
  implementation: "vscode.executeImplementationProvider",
  typeDefinition: "vscode.executeTypeDefinitionProvider",
};

// Function to handle symbol navigation
async function navigateToSymbolLocations(
  providerType: LocationProviderType,
  outputChannel: vscode.OutputChannel,
  recencyTracker?: RecencyTracker
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
  const displayNameMap: Record<LocationProviderType, string> = {
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

  outputChannel.appendLine(
    `OMN: ${displayName} locations: ${JSON.stringify(locations)}`
  );

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

        // Track if this item was selected previously (if recency tracker is available)
        if (recencyTracker) {
          await recencyTracker.recordAccess(
            selected.uri.fsPath,
            selected.label
          );
        }

        // Open the document
        const doc = await vscode.workspace.openTextDocument(selected.uri);
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Active,
          preview: false,
        });

        // Start with the LSP position
        let position = selected.range.start;

        // Extract just the portion of the line within the range
        const lineText = doc.lineAt(position.line).text;
        const rangeStart = selected.range.start.character;
        const rangeEnd = Math.min(
          selected.range.end.character,
          lineText.length
        );

        // Only look at the text within the range
        if (rangeStart < rangeEnd) {
          const textInRange = lineText.substring(rangeStart, rangeEnd);
          const identifier = getLanguageIdFromFilePath(selected.uri.fsPath)
            ? getFirstIdentifier(textInRange)
            : null;

          if (identifier) {
            // Find the position of the identifier within the range
            const identifierIndex = textInRange.indexOf(identifier);
            if (identifierIndex >= 0) {
              // Add the range start offset to get the correct position in the full line
              position = new vscode.Position(
                position.line,
                rangeStart + identifierIndex
              );
            }
          }
        }

        const selection = new vscode.Selection(position, position);
        editor.selection = selection;
        editor.revealRange(
          selected.range,
          vscode.TextEditorRevealType.InCenter
        );

        outputChannel.appendLine(
          `OMN: Navigated to ${selected.uri.fsPath}:${position.line + 1}:${
            position.character + 1
          }`
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

async function navigateToLocation(
  location: vscode.Location,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Active,
  });

  // Start with the LSP position
  let position = location.range.start;

  // Extract just the portion of the line within the range
  const lineText = doc.lineAt(position.line).text;
  const rangeStart = location.range.start.character;

  const textInRange = lineText.substring(rangeStart);

  const identifier = getLanguageIdFromFilePath(location.uri.fsPath)
    ? getFirstIdentifier(textInRange)
    : null;

  if (identifier) {
    // Find the position of the identifier within the range
    const identifierIndex = textInRange.indexOf(identifier);
    if (identifierIndex >= 0) {
      // Add the range start offset to get the correct position in the full line
      position = new vscode.Position(
        position.line,
        rangeStart + identifierIndex
      );
    }
  }

  const selection = new vscode.Selection(position, position);
  editor.selection = selection;
  editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);

  outputChannel.appendLine(
    `OMN: Navigated to ${location.uri.fsPath}:${position.line + 1}:${
      position.character + 1
    }`
  );
}

export function registerGoToReferencesCommand(
  context: vscode.ExtensionContext,
  recencyTracker: RecencyTracker,
  outputChannel: vscode.OutputChannel
): void {
  const goToReferences = vscode.commands.registerCommand(
    "omn.goToReferences",
    async () => {
      await navigateToSymbolLocations(
        "references",
        outputChannel,
        recencyTracker
      );
    }
  );

  const goToDefinition = vscode.commands.registerCommand(
    "omn.goToDefinition",
    async () => {
      await navigateToSymbolLocations(
        "definition",
        outputChannel,
        recencyTracker
      );
    }
  );

  const goToImplementation = vscode.commands.registerCommand(
    "omn.goToImplementation",
    async () => {
      await navigateToSymbolLocations(
        "implementation",
        outputChannel,
        recencyTracker
      );
    }
  );

  const goToTypeDefinition = vscode.commands.registerCommand(
    "omn.goToTypeDefinition",
    async () => {
      await navigateToSymbolLocations(
        "typeDefinition",
        outputChannel,
        recencyTracker
      );
    }
  );

  context.subscriptions.push(
    goToReferences,
    goToDefinition,
    goToImplementation,
    goToTypeDefinition
  );
}
