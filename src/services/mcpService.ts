import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';
import { EnvService } from './envService';

export class McpService {
  constructor(private env: EnvService) {}

  async writeMcpConfig(envFolder: string) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    // Prefer the workspace venv, fall back to plain "python"
    const pyInterpAbs = this.env.getEnvInterpreterPath(envFolder);
    const pythonCommand = pyInterpAbs || 'python';

    // Use a literal ${workspaceFolder} in the file for portability
    const serverRel = MCP_SERVER_REL.replace(/\\/g, '/'); // normalize for Windows
    const freshConfig = {
      servers: {
        har2locust: {
          command: pythonCommand.includes(ws.uri.fsPath) ? '${workspaceFolder}/' + path.relative(ws.uri.fsPath, pythonCommand).replace(/\\/g, '/') : pythonCommand,
          args: ['${workspaceFolder}/' + serverRel],
          env: {
            PYTHONPATH: '${workspaceFolder}'
          }
        }
      }
    };

    const dir = vscode.Uri.joinPath(ws.uri, '.vscode');
    const target = vscode.Uri.joinPath(dir, 'mcp.json');

    try { await vscode.workspace.fs.stat(dir); } catch { await vscode.workspace.fs.createDirectory(dir); }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(freshConfig, null, 2), 'utf8'));

    vscode.window.setStatusBarMessage('MCP configured for Copilot (stdio).', 4000);

    // Best-effort: ask user to reload so Copilot picks it up
    const choice = await vscode.window.showInformationMessage(
      'MCP config updated. Reload VS Code so Copilot discovers the server?',
      'Reload',
      'Later'
    );
    if (choice === 'Reload') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}
