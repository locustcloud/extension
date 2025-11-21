import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';
import { EnvService } from './envService';
import * as fs from 'fs/promises';

// Fallback older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class McpService {
  constructor(private env: EnvService) {}

  /**
   * Write .vscode/mcp.json using a concrete, runnable Python interpreter,
   * pointing DIRECTLY extension bundled MCP server.
   *
   * No workspace copies; resolve extension absolute path and
   * generate absolute paths config (command args + PYTHONPATH).
   */
  async writeMcpConfig(pythonCmd?: string) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    // 1) Resolve Python interpreter (prefer the one your setup created)
    let cmd = pythonCmd;
    if (!cmd) {
      try {
        // keep your env folder name in sync with your setup service
        cmd = await this.env.resolvePythonStrict('.locust_env');
      } catch {
        cmd = 'python';
      }
    }

    // 2) Resolve absolute path to server.py
    const ext = vscode.extensions.getExtension('locust.locust-vscode-extension');
    const extRoot = ext?.extensionUri.fsPath;
    const serverAbs = extRoot ? path.join(extRoot, MCP_SERVER_REL) : undefined;

    // Fallback: workspace-relative if we can’t resolve the extension root
    const serverArg = serverAbs ?? '${workspaceFolder}/' + MCP_SERVER_REL.replace(/\\/g, '/');

    // 3) Read existing .vscode/settings.json (merge, don’t clobber)
    const settingsUri = uriJoinPath(ws.uri, '.vscode', 'settings.json');
    await vscode.workspace.fs.createDirectory(uriJoinPath(ws.uri, '.vscode'));
    let curr: any = {};
    try {
      const buf = await vscode.workspace.fs.readFile(settingsUri);
      curr = JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch {
      /* no existing settings.json */
    }

    // 4) Build the Copilot MCP server block (use venv python; -u for unbuffered logs)
    const serverBlock = {
      command: cmd!,
      args: ['-u', serverArg],
      cwd: '${workspaceFolder}',
    };

    // 5) Write to both the stable and experimental keys (harmless if one is ignored)
    curr['github.copilot.chat.mcpServers'] = {
      ...(curr['github.copilot.chat.mcpServers'] || {}),
      'mcp-locust': serverBlock,
    };
    curr['github.copilot.experimental.mcpServers'] = {
      ...(curr['github.copilot.experimental.mcpServers'] || {}),
      'mcp-locust': serverBlock,
    };

    // 6) Save settings.json
    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(JSON.stringify(curr, null, 2), 'utf8'),
    );

    // 7) Best-effort: ask Copilot to reload MCP servers
    const candidates = ['github.copilot.mcp.reloadServers', 'github.copilot.mcp.restartAll'];
    for (const id of candidates) {
      try {
        await vscode.commands.executeCommand(id as any);
        break;
      } catch {}
    }
  }
}
