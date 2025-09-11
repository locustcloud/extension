import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';
import { EnvService } from './envService';

// Fallback joinPath helper for older VS Code
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class McpService {
  constructor(private env: EnvService) {}

  /**
   * Write .vscode/mcp.json using a concrete interpreter that we know works.
   * If you *really* want "python", pass pythonCmd="python".
   */
  async writeMcpConfig(pythonCmd?: string) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {return;}

    const { fsPath: root } = ws.uri;

    // Choose interpreter: caller-provided, else robust resolver
    let cmd = pythonCmd;
    if (!cmd) {
      try {
        cmd = await this.env.resolvePythonStrict('locust_env');
      } catch {
        // Fall back to 'python' for users who prefer PATH, but it might fail in Snap
        cmd = 'python';
      }
    }

    const freshConfig = {
      servers: {
        har2locust: {
          command: cmd!,
          args: ['-u', '${workspaceFolder}/' + MCP_SERVER_REL.replace(/\\/g, '/')],
          env: { PYTHONPATH: '${workspaceFolder}' }
        }
      }
    };

    const dir = uriJoinPath(ws.uri, '.vscode');
    const target = uriJoinPath(ws.uri, '.vscode', 'mcp.json');
    try { await vscode.workspace.fs.stat(dir); } catch { await vscode.workspace.fs.createDirectory(dir); }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(freshConfig, null, 2), 'utf8'));

    // Nudge Copilot to reload MCP (best-effort)
    const candidates = ['github.copilot.mcp.reloadServers', 'github.copilot.mcp.restartAll'];
    for (const id of candidates) {
      try { await vscode.commands.executeCommand(id as any); break; } catch {}
    }
  }
}
