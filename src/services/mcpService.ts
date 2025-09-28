import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';
import { EnvService } from './envService';

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class McpService {
  constructor(private env: EnvService) {}

  /**
   * Write .vscode/mcp.json using a concrete, runnable Python interpreter,
   * pointing DIRECTLY to the extension's bundled MCP server (Option B).
   *
   * No workspace copies; we resolve the extension's absolute path and
   * generate absolute paths in the config (command args + PYTHONPATH).
   */
  async writeMcpConfig(pythonCmd?: string) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    // Resolve Python command
    let cmd = pythonCmd;
    if (!cmd) {
      try {
        cmd = await this.env.resolvePythonStrict('locust_env');
      } catch {
        cmd = 'python';
      }
    }

    // Resolve extension root (uses publisher.name from package.json)
    const ext = vscode.extensions.getExtension('locust.locust-vscode-extension');
    const extRoot = ext?.extensionUri.fsPath;

    // Build absolute server path if we can; otherwise fall back to workspace-relative
    const serverAbs = extRoot ? path.join(extRoot, MCP_SERVER_REL) : undefined;
    const pyPath = extRoot ?? '${workspaceFolder}';
    const serverArg = serverAbs ?? '${workspaceFolder}/' + MCP_SERVER_REL.replace(/\\/g, '/');

    const freshConfig = {
      servers: {
        har2locust: {
          command: cmd!,
          args: ['-u', serverArg],
          env: { PYTHONPATH: pyPath }
        }
      }
    };

    const dir = uriJoinPath(ws.uri, '.vscode');
    const target = uriJoinPath(ws.uri, '.vscode', 'mcp.json');
    try { await vscode.workspace.fs.stat(dir); } catch { await vscode.workspace.fs.createDirectory(dir); }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(freshConfig, null, 2), 'utf8'));

    // Best-effort: ask Copilot to reload MCP servers
    const candidates = ['github.copilot.mcp.reloadServers', 'github.copilot.mcp.restartAll'];
    for (const id of candidates) {
      try { await vscode.commands.executeCommand(id as any); break; } catch {}
    }
  }
}
