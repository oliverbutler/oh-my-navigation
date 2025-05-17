import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";

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
          iconPath: new vscode.ThemeIcon(getFileIcon(file)),
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
}

export function deactivate() {}

// Helper function to get appropriate file icon
function getFileIcon(filePath: string): string {
  if (filePath.endsWith(".tsx")) return "symbol-typescript";
  if (filePath.endsWith(".jsx")) return "symbol-javascript";
  if (filePath.endsWith(".ts")) return "symbol-typescript";
  if (filePath.endsWith(".js")) return "symbol-javascript";
  return "symbol-file";
}
