import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * EnvService
 * - Single source of truth for which Python to use.
 * - Handy helpers for venv paths and (optional) terminal activation.
 */
export class EnvService {
  constructor() {}

  /** Returns the first workspace folder path, or undefined if none is open. */
  getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Build the absolute path to the workspace venv's python (even if it doesn't exist). */
  getEnvInterpreterPath(envFolder: string): string {
    const root = this.getWorkspaceRoot() ?? '';
    const isWin = process.platform === 'win32';
    return path.join(root, envFolder, isWin ? 'Scripts' : 'bin', 'python');
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the best Python to use, in order:
   *  1) workspace venv python (if it exists),
   *  2) python.defaultInterpreterPath (if set and exists),
   *  3) 'python' (fall back to PATH).
   */
  async resolvePython(envFolder: string): Promise<string> {
    const venvPy = this.getEnvInterpreterPath(envFolder);
    if (await this.exists(venvPy)) return venvPy;

    const cfgPy = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
    if (cfgPy && (await this.exists(cfgPy))) return cfgPy;

    return 'python';
  }

  /* ─────────────────────────────────────────────────────────────
     Optional helpers (kept for compatibility with other runners)
     ───────────────────────────────────────────────────────────── */

  /** Create a fresh terminal for setup/runner usage. */
  createFreshLocustTerminal(name = 'Locust'): vscode.Terminal {
    return vscode.window.createTerminal({ name });
  }

  /**
   * Best-effort venv activation in a Terminal (useful for interactive sessions).
   * Not required for programmatic execFile calls (which should use resolvePython()).
   */
  ensureTerminalEnv(term: vscode.Terminal, envFolder: string) {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    const isWin = process.platform === 'win32';

    const activateCmd = isWin
      ? `if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`
      : `if [ -f "${envFolder}/bin/activate" ]; then . "${envFolder}/bin/activate"; fi`;

    term.sendText(`cd "${root}"`);
    term.sendText(activateCmd);
  }
}
