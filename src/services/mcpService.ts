import * as vscode from 'vscode';
import * as path from 'path';
import { MCP_SERVER_REL } from '../core/config';
import { EnvService } from './envService';

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
  }
}
