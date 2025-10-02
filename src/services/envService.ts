import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Workspace helpers
function wsRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function expandWsVar(p: string | undefined): string | undefined {
  if (!p) {return p;}
  const root = wsRoot();
  return root ? p.replace('${workspaceFolder}', root) : p;
}
async function exists(p?: string): Promise<boolean> {
  if (!p) {return false;}
  try { await fs.stat(p); return true; } catch { return false; }
}
async function cmdExists(cmd: string): Promise<boolean> {
  try { await execFileAsync(cmd, ['-V'], { timeout: 3000 }); return true; } catch { return false; }
}

export class EnvService {
  /** Absolute path to the workspace venv's python. */
  getEnvInterpreterPath(envFolder: string): string {
    const root = wsRoot() ?? '';
    const isWin = process.platform === 'win32';
    return path.join(root, envFolder, isWin ? 'Scripts' : 'bin', 'python');
  }

  /**
   * Strict resolver: returns a runnable python, or throws with guidance.
   * Resolution order:
   *  1) workspace venv python (file exists)
   *  2) python.defaultInterpreterPath (expanded, file exists)
   *  3) 'python' on PATH (runnable)
   *  4) 'python3' on PATH (runnable)
   */
  async resolvePythonStrict(envFolder: string): Promise<string> {
    const venvPy = this.getEnvInterpreterPath(envFolder);
    if (await exists(venvPy)) {return venvPy;}

    const cfgRaw = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
    const cfgPy = expandWsVar(cfgRaw);
    if (await exists(cfgPy)) {return cfgPy!;}

    if (await cmdExists('python')) {return 'python';}
    if (await cmdExists('python3')) {return 'python3';}

    throw new Error('No usable Python found. Create a venv (Locust: Initialize) or set python.defaultInterpreterPath.');
  }

  /** Backwards-compatible alias. Prefer resolvePythonStrict() in new code. */
  async resolvePython(envFolder: string): Promise<string> {
    try { return await this.resolvePythonStrict(envFolder); }
    catch { return 'python'; }
  }

  // Optional terminal helpers
  createFreshLocustTerminal(name = 'Locust'): vscode.Terminal {
    return vscode.window.createTerminal({ name });
  }
  ensureTerminalEnv(term: vscode.Terminal, envFolder: string) {
    const root = wsRoot();
    if (!root) {return;}
    const isWin = process.platform === 'win32';
    const activateCmd = isWin
      ? `if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`
      : `if [ -f "${envFolder}/bin/activate" ]; then . "${envFolder}/bin/activate"; fi`;
    term.sendText(`cd "${root}"`);
    term.sendText(activateCmd);
  }
}