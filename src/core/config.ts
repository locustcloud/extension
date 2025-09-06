import * as vscode from 'vscode';
import * as path from 'path';

export const LOCUST_TERMINAL_NAME = 'Locust';
export const WS_SETUP_KEY = 'locust.setupCompleted';

// Tree layout
export const MCP_REQ_REL = path.join('mcp', 'requirements.txt');
export const MCP_SERVER_REL = path.join('mcp', 'server.py');
export const WORKSPACE_REQ_REL = 'requirements.txt';

export function getConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    locustPath: cfg.get<string>('locust.path', 'locust'),
    envFolder: cfg.get<string>('locust.envFolder', 'locust_env'),
    defaultHost: cfg.get<string>('locust.defaultHost', '')
  };
}
