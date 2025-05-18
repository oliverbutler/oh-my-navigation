import * as path from "path";
import * as child_process from "child_process";

export interface RipgrepMatch {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  matchText: string;
}

/**
 * Execute ripgrep search and return structured matches
 */
export async function searchWithRipgrep(
  searchTerm: string,
  rootPath: string
): Promise<RipgrepMatch[]> {
  const matches: RipgrepMatch[] = [];

  try {
    // Get matches from ripgrep
    const lines = runRipgrep(searchTerm, rootPath);

    // Process matches into structured objects
    for (const line of lines) {
      try {
        // Format: file:line:column:match
        const match = line.match(/^([^:]+):(\d+):(\d+):(.*)/);
        if (match) {
          const [_, filePath, lineStr, colStr, matchText] = match;
          const lineNumber = parseInt(lineStr, 10) - 1; // 0-based line numbers
          let columnNumber = parseInt(colStr, 10) - 1; // 0-based column numbers

          // Find the actual match within the line text
          // This ensures we highlight the correct portion even if the search term has different cases
          const lowerMatchText = matchText.toLowerCase();
          const lowerSearchTerm = searchTerm.toLowerCase();
          const matchIndex = lowerMatchText.indexOf(lowerSearchTerm);

          if (matchIndex >= 0) {
            // Adjust the column number to point to the actual match
            columnNumber = columnNumber + matchIndex;
          }

          // Add to matches
          matches.push({
            filePath: path.join(rootPath, filePath),
            lineNumber,
            columnNumber,
            matchText,
          });
        }
      } catch (err) {
        console.error(`Error parsing ripgrep output line: ${line}`, err);
      }
    }

    return matches;
  } catch (err) {
    console.error("Error executing ripgrep search:", err);
    return [];
  }
}

/**
 * Run ripgrep with the given pattern and return matching lines
 * Uses a synchronous execution model that's more reliable than async event handling
 */
export function runRipgrep(searchTerm: string, cwd: string): string[] {
  const args = [
    "--line-number", // Show line numbers
    "--column", // Show column numbers
    "--smart-case", // Smart case search
    "--no-heading", // Don't group matches by file
    "--color",
    "never", // Disable color output
    "--max-filesize=1M", // Skip files larger than 1MB to prevent hangs
    "-e",
    searchTerm, // Pattern to search for
    ".", // Search in current directory
  ];

  try {
    // Execute ripgrep synchronously - this is more reliable than async events
    const output = child_process.execFileSync("rg", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer to handle large outputs
      timeout: 10000, // 10 second timeout
    });

    return output.split("\n").filter(Boolean);
  } catch (err: any) {
    // If ripgrep exits with code 1, it means "no matches found" which is valid
    if (err.status === 1 && err.stdout) {
      return err.stdout.split("\n").filter(Boolean);
    }

    // For real errors, log and return empty
    if (err.stderr) {
      console.error(`Ripgrep error: ${err.stderr}`);
    }

    return [];
  }
}
