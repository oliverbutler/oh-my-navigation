import * as vscode from "vscode";
import * as child_process from "child_process";
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
  react: "symbol-constant",
  unknown: "symbol-misc",
};

// Extract symbol name from a line using regex
function extractSymbol(line: string, regex: RegExp): string | null {
  const match = line.match(regex);
  if (!match) return null;
  // Find the first non-keyword group
  for (let i = 1; i < match.length; ++i) {
    if (
      match[i] &&
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

// Main searchSymbols command
const searchSymbols = vscode.commands.registerCommand(
  "olly.searchSymbols",
  async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showInformationMessage("No workspace open");
      return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;

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
    const picked = await vscode.window.showQuickPick(symbolTypes, {
      placeHolder: "Select symbol type to search",
    });
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
            // Remove detail for single-line result
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

    const quickPick = vscode.window.createQuickPick();
    quickPick.items = items;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.placeholder = "Search symbols...";

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        const fileUri = vscode.Uri.file(
          path.join(rootPath, (selected as any).description)
        );
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc);
        // Reveal the line
        const line = (selected as any).line - 1;
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
      }
      quickPick.hide();
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

  const searchReactComponents = vscode.commands.registerCommand(
    "olly.searchReactComponent",
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showInformationMessage("No workspace open");
        return;
      }
      const rootPath = workspaceFolders[0].uri.fsPath;

      // Patterns for ripgrep
      const patterns = [
        // Pattern 1: Function/const/class components
        String.raw`\b(export\s+)?(const|let|var|function|class)\s+([A-Z][a-zA-Z0-9]*)\s*(=\s*(function\s*\(|(React\.)?memo\(|(React\.)?forwardRef(?:<[^>]+>)?\(|\()|extends\s+React\.Component|\(|:)`,
        // Pattern 2: Generic function components
        String.raw`\b(export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*<[^>]+>`,
        // Pattern 3: Arrow function components with generics
        String.raw`\b(export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*=\s*<[^>]+>`,
      ];

      // Build ripgrep args
      const rgArgs = [
        "--with-filename",
        "--line-number",
        "--column",
        "-g",
        "*.jsx",
        "-g",
        "*.tsx",
        "-g",
        "*.js",
        "-g",
        "*.ts",
        ...patterns.flatMap((p) => ["-e", p]),
        ".", // search in current dir
      ];

      let rgOutput: string;
      try {
        rgOutput = child_process.execFileSync("rg", rgArgs, {
          cwd: rootPath,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 10,
        });
      } catch (err: any) {
        if (err.stdout) {
          rgOutput = err.stdout; // ripgrep returns nonzero if no matches
        } else {
          vscode.window.showErrorMessage("ripgrep failed: " + err.message);
          return;
        }
      }

      // Parse rg output: file:line:col:match
      const items: vscode.QuickPickItem[] = [];
      const lines = rgOutput.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
        if (!match) continue;
        const [, file, lineNum, colNum, code] = match;
        // Try to extract component name
        const nameMatch = code.match(/\b([A-Z][a-zA-Z0-9]*)\b/);
        const componentName = nameMatch ? nameMatch[1] : "(unknown)";

        // Get relative path from workspace root
        const relativePath = file.startsWith(rootPath)
          ? file.substring(rootPath.length + 1)
          : file;

        items.push({
          label: componentName,
          description: relativePath,
          // Skip detail field for more compact display
          // Preserve data for navigation
          alwaysShow: false,
          iconPath: new vscode.ThemeIcon("symbol-function"),
          // @ts-ignore - custom properties
          file,
          // @ts-ignore
          line: Number(lineNum),
        });
      }

      if (items.length === 0) {
        vscode.window.showInformationMessage("No React components found.");
        return;
      }

      const quickPick = vscode.window.createQuickPick();
      quickPick.items = items;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.placeholder = "Search React components...";

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
          const fileUri = vscode.Uri.file(
            path.join(rootPath, (selected as any).description)
          );
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const editor = await vscode.window.showTextDocument(doc);
          // Reveal the line
          const line = (selected as any).line - 1;
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(
            new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenter
          );
        }
        quickPick.hide();
      });

      quickPick.show();
    }
  );

  context.subscriptions.push(swapToSibling);
  context.subscriptions.push(searchReactComponents);
  context.subscriptions.push(searchSymbols);
}

export function deactivate() {}
