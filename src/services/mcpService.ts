import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class McpService {
  constructor() {}

  async writeMcpConfig(_envFolder: string) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    const freshConfig = {
      servers: {
        har2locust: {
          command: "python",
          args: ["-u", "${workspaceFolder}/" + MCP_SERVER_REL.replace(/\\/g, "/")],
          env: { PYTHONPATH: "${workspaceFolder}" }
        }
      }
    };

    const dir = uriJoinPath(ws.uri, ".vscode");
    const target = uriJoinPath(ws.uri, ".vscode", "mcp.json");

    try { await vscode.workspace.fs.stat(dir); } catch { await vscode.workspace.fs.createDirectory(dir); }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(freshConfig, null, 2), "utf8"));

    const choice = await vscode.window.showInformationMessage(
      "MCP config updated. Reload VS Code so Copilot discovers the server?",
      "Reload",
      "Later"
    );
    if (choice === "Reload") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}
