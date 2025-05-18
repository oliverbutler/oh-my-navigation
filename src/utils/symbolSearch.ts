import * as path from "path";

export type SymbolType =
  | "class"
  | "function"
  | "method"
  | "variable"
  | "type"
  | "interface"
  | "zod"
  | "react"
  | "unknown";

// Precedence map for symbol types
export const symbolTypePrecedence: Record<
  keyof typeof symbolTypeToIcon,
  number
> = {
  zod: 100,
  class: 90,
  interface: 80,
  type: 70,
  react: 60,
  function: 50,
  method: 40,
  variable: 10,
  unknown: 0,
};

// Utility: Run ripgrep with a pattern, return lines
export async function runRipgrep(
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

// Map symbol type to VSCode icon
export const symbolTypeToIcon: Record<SymbolType, string> = {
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

type SymbolPattern = {
  patterns: string[];
  exts: string[];
  type: SymbolType;
  ignore?: string[];
};

// Symbol patterns for JS/TS/Go
export const symbolPatterns: Record<string, SymbolPattern> = {
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
    ignore: [
      "expect",
      "describe",
      "it",
      "beforeAll",
      "beforeEach",
      "afterEach",
      "afterAll",
      "constructor",
    ],
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
    patterns: [String.raw`\binterface\s+([A-Za-z0-9_]+)\s*\{`],
    exts: ["*.ts", "*.tsx"],
    type: "interface",
  },
  zod: {
    patterns: [
      String.raw`(?:^|\b)(?:export\s+)?(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*z\.`,
    ],
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

// Extract symbol name from a line using regex
export function extractSymbol(line: string, regex: RegExp): string | null {
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

// Helper to get language ID from file extension
export function getLanguageIdFromFilePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  // Map common extensions to language IDs
  const extensionMap: Record<string, string> = {
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".go": "go",
    ".py": "python",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sh": "shellscript",
    ".bash": "shellscript",
    ".php": "php",
    ".rb": "ruby",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "cpp",
    ".cs": "csharp",
    ".fs": "fsharp",
    ".rs": "rust",
    ".swift": "swift",
    ".sql": "sql",
  };

  return extensionMap[ext] || "plaintext";
}

// Function to find symbols in codebase - easier to test
export async function findSymbols(
  symbolType: string,
  rootPath: string
): Promise<{ symbol: string; file: string; line: number; type: SymbolType }[]> {
  let searchSet: SymbolPattern[] = [];

  if (symbolType === "all") {
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
  } else if (Object.keys(symbolPatterns).includes(symbolType)) {
    searchSet = [symbolPatterns[symbolType]];
  } else {
    return [];
  }

  let results: {
    symbol: string;
    file: string;
    line: number;
    type: SymbolType;
  }[] = [];

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

        if (search.ignore?.includes(symbol)) continue;

        results.push({
          symbol,
          file,
          line: Number(lineNum),
          type: search.type,
        });
      }
    }
  }

  // Remove duplicates (by file:line:symbol), keeping the highest precedence type
  const deduped = new Map<
    string,
    { symbol: string; file: string; line: number; type: SymbolType }
  >();
  for (const item of results) {
    const key = `${item.file}:${item.line}:${item.symbol}`;
    const existing = deduped.get(key);
    if (
      !existing ||
      symbolTypePrecedence[item.type] > symbolTypePrecedence[existing.type]
    ) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}
