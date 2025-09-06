import * as vscode from 'vscode';
import * as path from 'path';
import { LOCUST_TERMINAL_NAME } from '../core/config';

export class EnvService {
  createFreshLocustTerminal(): vscode.Terminal {
    vscode.window.terminals.find(t => t.name === LOCUST_TERMINAL_NAME)?.dispose();

    const term = vscode.window.createTerminal({ name: LOCUST_TERMINAL_NAME });
    term.show();

    // Best-effort 'deactivate' if venv currently active in shell.
    if (process.platform === 'win32') {
      term.sendText('if (Get-Command deactivate -ErrorAction SilentlyContinue) { deactivate }');
    } else {
      term.sendText('type deactivate >/dev/null 2>&1 && deactivate || true');
    }
    return term;
  }

  getEnvInterpreterPath(envFolder: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return '';
    const isWin = process.platform === 'win32';
    return isWin
      ? path.join(ws.uri.fsPath, envFolder, 'Scripts', 'python.exe')
      : path.join(ws.uri.fsPath, envFolder, 'bin', 'python');
  }

  async ensureTerminalEnv(term: vscode.Terminal, envFolder: string) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const venvUri = vscode.Uri.joinPath(folder.uri, envFolder);
    try { await vscode.workspace.fs.stat(venvUri); } catch { return; }

    const isWin = process.platform === 'win32';
    if (isWin) {
      term.sendText(`if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`);
    } else {
      term.sendText(`if [ -f "${envFolder}/bin/activate" ]; then source "${envFolder}/bin/activate"; fi`);
    }
  }
}
