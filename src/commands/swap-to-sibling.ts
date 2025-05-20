import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function registerSwapToSiblingCommand(context: vscode.ExtensionContext) {
  const swapToSibling = vscode.commands.registerCommand(
    "omn.swapToSibling",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor");
        return;
      }
      const currentUri = editor.document.uri;
      const currentPath = currentUri.fsPath;
      const dir = path.dirname(currentPath);
      const file = path.basename(currentPath);
      const ext = path.extname(file);
      const base = file.slice(0, -ext.length);
      const patterns = [/([\.-_])(test|spec)$/];
      let siblingCandidates = [];
      let match = base.match(patterns[0]);
      if (match) {
        const baseName = base.replace(patterns[0], "");
        siblingCandidates.push(path.join(dir, baseName + ext));
      } else {
        const suffixes = ["test", "spec"];
        const seps = ["-", ".", "_"];
        for (const sep of seps) {
          for (const suf of suffixes) {
            siblingCandidates.push(path.join(dir, base + sep + suf + ext));
          }
        }
      }
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
}
