import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class EnvService {
  getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  getEnvInterpreterPath(envFolder: string): string {
    const root = this.getWorkspaceRoot() ?? '';
    const isWin = process.platform === 'win32';
    return path.join(root, envFolder, isWin ? 'Scripts' : 'bin', 'python');
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.stat(p); return true; } catch { return false; }
  }

  private async cmdExists(cmd: string): Promise<boolean> {
    try {
      await execFileAsync(cmd, ['-V'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a Python interpreter path/command that actually works, in order:
   *  1) workspace venv python (if file exists)
   *  2) python.defaultInterpreterPath (if file exists)
   *  3) 'python' on PATH (if runnable)
   *  4) 'python3' on PATH (if runnable)
   * Throws if none found.
   */
  async resolvePythonStrict(envFolder: string): Promise<string> {
    const venvPy = this.getEnvInterpreterPath(envFolder);
    if (await this.exists(venvPy)) {return venvPy;}

    const cfgPy = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
    if (cfgPy && (await this.exists(cfgPy))) {return cfgPy;}

    if (await this.cmdExists('python')) {return 'python';}
    if (await this.cmdExists('python3')) {return 'python3';}

    throw new Error(
      'No usable Python found. Create a venv (Locust: Initialize) or set python.defaultInterpreterPath.'
    );
  }

  /** Backwards-compatible alias (use Strict one wherever possible). */
  async resolvePython(envFolder: string): Promise<string> {
    try { return await this.resolvePythonStrict(envFolder); }
    catch { return 'python'; } // last-ditch fallback if callers don't handle throws
  }

  // Optional: terminal helpers (unchanged)
  createFreshLocustTerminal(name = 'Locust'): vscode.Terminal {
    return vscode.window.createTerminal({ name });
  }
  ensureTerminalEnv(term: vscode.Terminal, envFolder: string) {
    const root = this.getWorkspaceRoot();
    if (!root) {return;}
    const isWin = process.platform === 'win32';
    const activateCmd = isWin
      ? `if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`
      : `if [ -f "${envFolder}/bin/activate" ]; then . "${envFolder}/bin/activate"; fi`;
    term.sendText(`cd "${root}"`);
    term.sendText(activateCmd);
  }
}
