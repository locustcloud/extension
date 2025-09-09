import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';
import { EnvService } from './envService';

/**
 * Write MCP Config to workplace.
 * Uses EnvService to get python path inside venv.
 */

export class McpService {
  constructor(private env: EnvService) {}

  async writeMcpConfig(envFolder: string) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    const pyInterpAbs = this.env.getEnvInterpreterPath(envFolder);
    const serverAbs = path.join(ws.uri.fsPath, MCP_SERVER_REL);

    const freshConfig = {
      runtimes: {
        python: {
          command: pyInterpAbs,
          args: ["-u", serverAbs]
        }
      },
      servers: [
        {
          id: "mcp-har2locust",
          name: "HAR → Locustfile (Python)",
          runtime: "python",
          autoStart: true,
          tools: ["har.to_locust"]
        }
      ],
      toolsets: [
        {
          name: "locust-tools",
          description: "Locust authoring helpers",
          servers: ["mcp-har2locust"]
        }
      ]
    };

    const dir = vscode.Uri.joinPath(ws.uri, ".vscode");
    const target = vscode.Uri.joinPath(dir, "mcp.json");

    try { await vscode.workspace.fs.stat(dir); } catch { await vscode.workspace.fs.createDirectory(dir); }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(freshConfig, null, 2), "utf8"));

    vscode.window.setStatusBarMessage("MCP configured (fresh) to use workspace venv.", 4000);

    // Try reload Copilot’s MCP servers so the new config is picked up
    // These command IDs aren’t documented as stable; call defensively and ignore failures.
    const restartCandidates = [
      'github.copilot.mcp.reloadServers',
      'github.copilot.mcp.restartAll',
    ];
    let restarted = false;
    for (const cmd of restartCandidates) {
      try {
        const ok = await vscode.commands.executeCommand(cmd as any);
        // Some commands return undefined; consider it a best-effort.
        restarted = true;
        break;
      } catch {
        // ignore and try next
      }
    }

    if (!restarted) {
      const choice = await vscode.window.showInformationMessage(
        'MCP config updated. Reload VS Code to ensure Copilot picks up the new server?',
        'Reload',
        'Later'
      );
      if (choice === 'Reload') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  }
}
