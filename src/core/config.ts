import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Central configuration and path helpers for the extension.
 * - Use POSIX-style strings for relative paths that will be embedded into JSON (e.g., .vscode/mcp.json).
 * - Use absolute path helpers (getAbsPath) when you need a local filesystem path.
 */

export const LOCUST_TERMINAL_NAME = 'Locust';
export const WS_SETUP_KEY = 'locust.setupCompleted';

/** Relative paths (POSIX style) used by Copilot MCP and repo layout */
export const MCP_REQ_REL_POSIX = 'mcp/requirements.txt';
export const MCP_SERVER_REL_POSIX = 'mcp/server.py';
export const WORKSPACE_REQ_REL_POSIX = 'requirements.txt';

/** Legacy aliases (kept for compatibility) */
export const MCP_REQ_REL = MCP_REQ_REL_POSIX;
export const MCP_SERVER_REL = MCP_SERVER_REL_POSIX;
export const WORKSPACE_REQ_REL = WORKSPACE_REQ_REL_POSIX;

/** Returns the first workspace folder path, or undefined if none is open. */
export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Join a path under the current workspace root (absolute FS path). */
export function getAbsPath(relPosixPath: string): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  // Convert the POSIX-style rel path to the host OS separator when joining.
  const relOs = relPosixPath.split('/').join(path.sep);
  return path.join(root, relOs);
}

/** Read extension settings (workspace scope by default). */
export function getConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    /** Executable name or path for `locust` (only used when spawning locust directly). */
    locustPath: cfg.get<string>('locust.path', 'locust'),

    /** Folder name (under workspace) for the venv we create if user chooses that path. */
    envFolder: cfg.get<string>('locust.envFolder', 'locust_env'),

    /** Optional default host passed to locust runs. */
    defaultHost: cfg.get<string>('locust.defaultHost', '')
  };
}

/**
 * Convenience helpers for absolute paths to common files in this repo.
 * Use these when you need filesystem access (read/write).
 */
export function getAbsMcpServerPath(): string | undefined {
  return getAbsPath(MCP_SERVER_REL_POSIX);
}

export function getAbsWorkspaceReqPath(): string | undefined {
  return getAbsPath(WORKSPACE_REQ_REL_POSIX);
}

export function getAbsMcpReqPath(): string | undefined {
  return getAbsPath(MCP_REQ_REL_POSIX);
}
