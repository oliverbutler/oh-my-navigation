import * as vscode from "vscode";
import * as path from "path";

type SymbolType =
  | "class"
  | "function"
  | "method"
  | "variable"
  | "type"
  | "interface"
  | "zod"
  | "react"
  | "unknown";

// Utility: Run ripgrep with a pattern, return lines
async function runRipgrep(
  patterns: string[],
  exts: string[],
  cwd: string
): Promise<string[]> {
  const child_process = require("child_process");
  const args = [
    "--with-filename",
    "--line-number",
    "--column",
    "--smart-case",
    "--max-filesize=1M",
    ...exts.flatMap((e) => ["-g", e]),
    ...patterns.flatMap((p) => ["-e", p]),
    ".",
  ];
  try {
    const output = child_process.execFileSync("rg", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    });
    return output.split("\n").filter(Boolean);
  } catch (err: any) {
    if (err.stdout) return err.stdout.split("\n").filter(Boolean);
    return [];
  }
}

// Custom scheme for file previews
const PREVIEW_SCHEME = "symbol-preview";

// ContentProvider for efficient file previews without triggering LSP
class SymbolPreviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private fileContents = new Map<string, string>();

  constructor() {}

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

// Create a singleton preview provider that can be accessed from everywhere
const previewProvider = new SymbolPreviewContentProvider();

// Symbol patterns for JS/TS/Go
const symbolPatterns: Record<
  string,
  { patterns: string[]; exts: string[]; type: SymbolType }
> = {
  // JS/TS
  class: {
    patterns: [String.raw`\bclass\s+([A-Z][a-zA-Z0-9_]*)`],
    exts: ["*.ts", "*.tsx", "*.js", "*.jsx"],
    type: "class",
  },
  function: {
    patterns: [
      String.raw`\bfunction\s+([a-zA-Z0-9_]+)\s*\(`,
      String.raw`\b(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(async\s*)?\(?\s*.*=>`,
    ],
    exts: ["*.ts", "*.tsx", "*.js", "*.jsx"],
    type: "function",
  },
  method: {
    patterns: [
      String.raw`^\s*(public|private|protected|static|async|\s)*\s*([a-zA-Z0-9_]+)\(`,
    ],
    exts: ["*.ts", "*.tsx", "*.js", "*.jsx"],
    type: "method",
  },
  variable: {
    patterns: [String.raw`\b(const|let|var)\s+([a-zA-Z0-9_]+)\s*=`],
    exts: ["*.ts", "*.tsx", "*.js", "*.jsx"],
    type: "variable",
  },
  type: {
    patterns: [String.raw`\btype\s+([A-Za-z0-9_]+)\s*=`],
    exts: ["*.ts", "*.tsx"],
    type: "type",
  },
  interface: {
    patterns: [String.raw`\binterface\s+([A-Za-z0-9_]+)\s*{`],
    exts: ["*.ts", "*.tsx"],
    type: "interface",
  },
  zod: {
    patterns: [String.raw`\b(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*z\.`],
    exts: ["*.ts", "*.tsx", "*.js", "*.jsx"],
    type: "zod",
  },
  react: {
    patterns: [
      String.raw`\b(export\s+)?(const|let|var|function|class)\s+([A-Z][a-zA-Z0-9]*)\s*(=\s*(function\s*\(|(React\.)?memo\(|(React\.)?forwardRef(?:<[^>]+>)?\(|\()|extends\s+React\.Component|\(|:)`,
      String.raw`\b(export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*<[^>]+>`,
      String.raw`\b(export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*=\s*<[^>]+>`,
    ],
    exts: ["*.ts", "*.tsx", "*.js", "*.jsx"],
    type: "react",
  },
  // Go
  go_func: {
    patterns: [
      String.raw`\bfunc\s+([A-Za-z0-9_]+)\s*\(`,
      String.raw`\bfunc\s+\([^)]+\)\s+([A-Za-z0-9_]+)\s*\(`,
    ],
    exts: ["*.go"],
    type: "function",
  },
  go_type: {
    patterns: [
      String.raw`\btype\s+([A-Za-z0-9_]+)\s+struct`,
      String.raw`\btype\s+([A-Za-z0-9_]+)\s+interface`,
      String.raw`\btype\s+([A-Za-z0-9_]+)\s+`,
    ],
    exts: ["*.go"],
    type: "type",
  },
};

// Map symbol type to VSCode icon
const symbolTypeToIcon: Record<SymbolType, string> = {
  class: "symbol-class",
  function: "symbol-function",
  method: "symbol-method",
  variable: "symbol-variable",
  type: "symbol-namespace",
  interface: "symbol-interface",
  zod: "symbol-struct",
  react: "symbol-parameter",
  unknown: "symbol-misc",
};

// Extract symbol name from a line using regex
function extractSymbol(line: string, regex: RegExp): string | null {
  const match = line.match(regex);
  if (!match) return null;
  // Scan all groups, return the last one that is a valid identifier and not a keyword
  for (let i = match.length - 1; i > 0; --i) {
    if (
      match[i] &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(match[i]) &&
      ![
        "const",
        "let",
        "var",
        "function",
        "class",
        "type",
        "interface",
        "export",
      ].includes(match[i])
    ) {
      return match[i];
    }
  }
  return null;
}

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

    // Build search set
    let searchSet: { patterns: string[]; exts: string[]; type: SymbolType }[] =
      [];
    if (picked.value === "all") {
      searchSet = [
        symbolPatterns.class,
        symbolPatterns.function,
        symbolPatterns.method,
        symbolPatterns.variable,
        symbolPatterns.type,
        symbolPatterns.interface,
        symbolPatterns.zod,
        symbolPatterns.react,
        symbolPatterns.go_func,
        symbolPatterns.go_type,
      ];
    } else if (
      picked.value === "class" ||
      picked.value === "function" ||
      picked.value === "method" ||
      picked.value === "variable" ||
      picked.value === "type" ||
      picked.value === "interface" ||
      picked.value === "zod" ||
      picked.value === "react"
    ) {
      searchSet = [
        symbolPatterns[picked.value],
        symbolPatterns.go_func,
        symbolPatterns.go_type,
      ].filter(Boolean) as any;
    }

    // Run all searches and collect results
    let items: vscode.QuickPickItem[] = [];
    for (const search of searchSet) {
      for (const pattern of search.patterns) {
        const lines = await runRipgrep([pattern], search.exts, rootPath);
        const regex = new RegExp(pattern);
        for (const line of lines) {
          const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
          if (!match) continue;
          const [, file, lineNum, colNum, code] = match;
          const symbol = extractSymbol(code, regex);
          if (!symbol) continue;
          const relativePath = file.startsWith(rootPath)
            ? file.substring(rootPath.length + 1)
            : file;
          items.push({
            label: symbol,
            description: relativePath,
            alwaysShow: false,
            iconPath: new vscode.ThemeIcon(
              symbolTypeToIcon[search.type] || "symbol-misc"
            ),
            // @ts-ignore
            file,
            // @ts-ignore
            line: Number(lineNum),
          });
        }
      }
    }

    // Remove duplicates (by file:line:symbol)
    const seen = new Set();
    items = items.filter((item: any) => {
      const key = `${item.file}:${item.line}:${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (items.length === 0) {
      vscode.window.showInformationMessage("No symbols found.");
      return;
    }

    // Prepare items for FZF
    const itemsForSearch: SymbolQuickPickItem[] = items.map((item) => ({
      label: item.label,
      description: item.description ?? "",
      iconPath:
        item.iconPath instanceof vscode.ThemeIcon ? item.iconPath : undefined,
      file: (item as any).file as string | undefined,
      line: (item as any).line as number | undefined,
    }));

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

          // Create a URI with our custom scheme
          const previewUri = vscode.Uri.parse(
            `${PREVIEW_SCHEME}:Symbol Preview?path=${encodeURIComponent(
              filePath
            )}&line=${line}`
          );

          // Open with our lightweight preview provider
          const doc = await vscode.workspace.openTextDocument(previewUri);
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

      // Clear the preview cache
      previewProvider.clearCache();

      // Clean up the disposable
      editorChangeDisposable.dispose();
      quickPick.hide();
    });

    quickPick.onDidHide(() => {
      quickPickActive = false;

      // Clean up the disposable
      editorChangeDisposable.dispose();

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
  // Register the content provider for symbol previews
  const providerRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider
    );
  context.subscriptions.push(providerRegistration);

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

  context.subscriptions.push(swapToSibling);
  context.subscriptions.push(searchSymbols);
}

export function deactivate() {}
