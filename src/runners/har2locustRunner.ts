import * as vscode from 'vscode';
import { EnvService } from '../services/envService';
import { getConfig } from '../core/config';

/**
 * HAR → Locustfile runner
 * - Reuses the same "Locust" terminal as LocustRunner
 * - Ensures venv is activated so har2locust can find ruff (if present)
 * - Writes to <workspace>/templates/<outName>
 */

export class Har2LocustRunner {
  constructor(private env: EnvService) {}

  private findLocustTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find(t => t.name === 'Locust');
  }

  private getOrCreateLocustTerminal(): vscode.Terminal {
    return this.findLocustTerminal() ?? vscode.window.createTerminal({ name: 'Locust' });
  }

  async convertHar() {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    // Pick HAR
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select HAR file',
      filters: { HAR: ['har'], All: ['*'] }
    });
    if (!chosen || chosen.length === 0) return;
    const harPath = chosen[0].fsPath;

    // Output name
    const outName = await vscode.window.showInputBox({
      prompt: 'Enter output locustfile name',
      value: 'locustfile_from_har.py'
    });
    if (!outName) return;

    // Write into <workspace>/templates/
    const templatesDir = vscode.Uri.joinPath(ws.uri, 'templates');
    const outUri = vscode.Uri.joinPath(templatesDir, outName);
    try {
      await vscode.workspace.fs.createDirectory(templatesDir);
    } catch { /* ignore */ }

    // Reuse the Locust terminal and ensure venv is active
    const term = this.getOrCreateLocustTerminal();
    term.show();

    const { envFolder } = getConfig();
    const py = this.env.getEnvInterpreterPath(envFolder);
    this.env.ensureTerminalEnv(term, envFolder);

    term.sendText(`cd "${ws.uri.fsPath}"`);

    // Prefer working with venv’s python -m entrypoint; disable ruff plugin to avoid missing-binary errors.
    const cmd = `"${py}" -m har2locust --disable-plugins=ruff.py "${harPath}" > "${outUri.fsPath}"`;
    term.sendText(cmd);

    // Try to open result (allow short delay due to shell redirection)
    const tryOpen = async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(outUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        setTimeout(tryOpen, 400);
      }
    };
    tryOpen();

    // Refresh scenarios so new file shows up (if it matches locustfile*.py pattern)
    vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
  }
}
