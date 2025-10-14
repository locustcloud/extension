import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';
import * as http from 'http';
import path from 'path';

/**
 * Locust run functions.
 * Runs in a dedicated terminal named "Locust"
 * Uses config settings for locust path, env folder, default host
 */

type RunMode = 'ui' | 'headless';

// Fallback older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class LocustRunner {
  constructor(private env: EnvService, private extensionUri: vscode.Uri) {}

  // Track latest run (PID)
  private _lastTerminal?: vscode.Terminal;
  private _lastPid?: number;
  private _lastCmd?: string;
  private _lastCwd?: string;

  private findLocustTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find(t => t.name === 'Locust');
  }

  private getOrCreateLocustTerminal(): vscode.Terminal {
    const t = this.findLocustTerminal() ?? vscode.window.createTerminal({ name: 'Locust' });
    this._lastTerminal = t; // keep reference for stop
    return t;
  }

  private buildLocustCommand(fileName: string, mode: RunMode, extraArgs: string[] = []): string {
    const { locustPath, defaultHost } = getConfig();
    const headless = mode === 'headless' ? '--headless' : '';
    const host = defaultHost ? `-H "${defaultHost}"` : '';
    const extras = extraArgs.join(' ');
    return `${locustPath} -f "${fileName}" ${headless} ${host} ${extras}`.trim();
  }

  /** Open 127.0.0.1:8089 in Simple Browser split (bottom ~45%). */
  private openLocalUiSplit() {
    return vscode.commands.executeCommand('locust.openUrlInSplit', 'http://127.0.0.1:8089', 0.45);
  }

  /** Quick probe: local UI up */
  private async isLocalUiUp(url = 'http://127.0.0.1:8089'): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const req = http.get(url, (res) => {
          res.resume(); // drain body
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
      } catch {
        resolve(false);
      }
    });
  }

  /** Wait local UI responds OK. */
  private async waitForLocalUi(timeoutMs = 20000, intervalMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isLocalUiUp()) return true;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  private async runLocustFile(filePath: string, mode: RunMode, extraArgs: string[] = []) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }

    // If UI is already running, avoid starting a new process
    if (mode === 'ui' && await this.isLocalUiUp()) {
      await this.openLocalUiSplit();
      vscode.window.setStatusBarMessage('Locust: UI already running — opened existing UI.', 3000);
      return;
    }

    const term = this.getOrCreateLocustTerminal();
    term.show();
    const { envFolder } = getConfig();
    this.env.ensureTerminalEnv(term, envFolder);

    // Use relative -f
    const fileDir = path.dirname(filePath);
    const relFile = path.basename(filePath);

    // Record cwd and command
    const cmd = this.buildLocustCommand(relFile, mode, extraArgs);
    this._lastCmd = cmd;
    this._lastCwd = fileDir;

    term.sendText(`cd "${fileDir}"`);

    // Prevent Python/webbrowser from opening the system browser
    if (process.platform === 'win32') {
      term.sendText(`$env:BROWSER='none'`);
    } else {
      term.sendText(`export BROWSER=none`);
    }

    term.sendText(cmd);

    try {
      this._lastPid = await term.processId ?? undefined;
    } catch {
      this._lastPid = undefined;
    }

    if (mode === 'ui') {
      const up = await this.waitForLocalUi(20000, 500);
      if (!up) vscode.window.setStatusBarMessage('Locust: UI did not respond in time; opening anyway…', 4000);
      await this.openLocalUiSplit();
    }
  }

  /** Compute next available locustfile name: locustfile_001.py, 002, ... in given directory. */
  private async nextLocustfileUri(dir: vscode.Uri): Promise<vscode.Uri> {
    let maxIndex = 0;
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        // Match: locustfile.py  OR  locustfile_###.py
        const m = /^locustfile(?:_(\d+))?\.py$/i.exec(name);
        if (m) {
          const idx = m[1] ? parseInt(m[1], 10) : 0; // treat plain locustfile.py as index 0
          if (!Number.isNaN(idx)) maxIndex = Math.max(maxIndex, idx);
        }
      }
    } catch {
      // dir may not exist yet; caller will create it
    }
    const next = Math.max(1, maxIndex + 1);
    const nextName = `locustfile_${String(next).padStart(3, '0')}.py`;
    return uriJoinPath(dir, nextName);
  }

  // Create a starter, uniquely-numbered locustfile return URI.
  async createLocustfile(opts: { open?: boolean } = {}) {
    const { open = true } = opts;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    // Pick workspace folder
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select folder for new locustfile',
      defaultUri: ws.uri,
    });
    if (!picked || picked.length === 0) {
      vscode.window.showInformationMessage('Locustfile creation cancelled.');
      return;
    }
    const dir = picked[0];

    // Ensure chosen directory exists
    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
    }

    const dest = await this.nextLocustfileUri(dir);

    // Minimal, snippet-inspired boilerplate (your current content kept)
    const content = `# Welcome to Locust Cloud's Online Test Editor!
#
# This is a quick way to get started with load tests without having
# to set up your own Python development environment.

from locust import FastHttpUser, task


class MyUser(FastHttpUser):
    # Change this to your actual target site, or leave it as is
    host = "https://mock-test-target.eu-north-1.locust.cloud"

    @task
    def t(self):
        # Simple request
        self.client.get("/")

        # Example rest call with validation
        with self.client.post(
            "/authenticate",
            json={"username": "foo", "password": "bar"},
            catch_response=True,
        ) as resp:
            if "token" not in resp.text:
                resp.failure("missing token in response")


# To deploy this test to the load generators click the Launch button.
#
# When you are done, or want to deploy an updated test, click Shut Down
#
# If you get stuck reach out to us at support@locust.cloud
#
# When you are ready to run Locust from your own machine,
# check out the documentation:
# https://docs.locust.io/en/stable/locust-cloud/locust-cloud.html
#
# Please remember to save your work outside of this editor as the
# storage is not permanent.
`;

    await vscode.workspace.fs.writeFile(dest, Buffer.from(content, 'utf8'));

    if (open) {
      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
    vscode.window.showInformationMessage(`Created ${vscode.workspace.asRelativePath(dest)}.`);
    return dest;
  }

  async runFile(filePath: string | undefined, mode: RunMode) {
    let targetPath = filePath;

    // Active editor if it's a locustfile
    if (!targetPath) {
      const active = vscode.window.activeTextEditor?.document;
      if (active && /(?:^|\/)locustfile.*\.py$/i.test(active.fileName)) {
        targetPath = active.fileName;
      }
    }

    // Fallback: Pick a locustfile
    if (!targetPath) {
      const picked = await this.pickLocustfile();
      if (picked) targetPath = picked.fsPath;
    }

    if (!targetPath) {
      vscode.window.showWarningMessage('No locustfile selected.');
      return;
    }

    await this.runLocustFile(targetPath, mode);
  }

  // Task helper
  private async runTask(node: any, mode: RunMode) {
    const { filePath, taskName } = node ?? {};
    if (!filePath || !taskName) {
      vscode.window.showWarningMessage('No task selected.');
      return;
    }
    // Filter by tag = taskName (recommend @tag("<taskName>") on the task)
    await this.runLocustFile(filePath, mode, [`--tags "${taskName}"`]);
  }

  async runTaskHeadless(node: any) {
    await this.runTask(node, 'headless');
  }

  async runTaskUI(node: any) {
    await this.runTask(node, 'ui');
  }

  // Palette helpers.
  async runSelected(mode: RunMode) {
    const file = await this.pickLocustfile();
    if (!file) return;
    await this.runLocustFile(file.fsPath, mode);
  }

  async runByTag() {
    const file = await this.pickLocustfile();
    if (!file) return;

    const tag = await vscode.window.showInputBox({
      prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
      placeHolder: 'e.g. checkout,auth'
    });
    if (!tag) return;

    await this.runLocustFile(file.fsPath, 'headless', [`--tags "${tag}"`]);
  }

  private async pickLocustfile(): Promise<vscode.Uri | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    const { envFolder } = getConfig();
    const ignoreDirs = new Set([envFolder, '.venv', '.git', '__pycache__', '.tour', 'node_modules']);
    const ignoreList = Array.from(ignoreDirs).filter(Boolean);
    const ignoreGlob = ignoreList.length ? `**/{${ignoreList.join(',')}}/**` : '';

    // Fast path: prefer conventional names first
    const named = await vscode.workspace.findFiles('**/locustfile*.py', ignoreGlob, 200);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      const picks = named
        .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
        .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
      return chosen?.uri;
    }

    // Fallback: scan python files for a Locust import
    const candidates = await vscode.workspace.findFiles('**/*.py', ignoreGlob, 2000);
    const locustRegex = /\bfrom\s+locust\s+import\b|\bimport\s+locust\b/;

    const checks = await Promise.allSettled(
      candidates.map(async (uri) => {
        try {
          // Read only the first few KB for speed
          const bytes = await vscode.workspace.fs.readFile(uri);
          const head = Buffer.from(bytes).toString('utf8', 0, Math.min(bytes.length, 4096));
          return locustRegex.test(head) ? uri : undefined;
        } catch {
          return undefined;
        }
      })
    );

    const locustFiles = checks
      .map(r => (r.status === 'fulfilled' ? r.value : undefined))
      .filter((u): u is vscode.Uri => !!u);

    if (locustFiles.length === 1) return locustFiles[0];
    if (locustFiles.length > 1) {
      const picks = locustFiles
        .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
        .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
      return chosen?.uri;
    }

    // locustfile not found offer to create one.
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to create files.');
      return;
    }
    const created = await this.createLocustfile({ open: true });
    return created;
  }

  // Stop last run
  public async stopLastRun(): Promise<void> {
    const term = this._lastTerminal ?? this.findLocustTerminal();
    if (!term) {
      vscode.window.showInformationMessage('No running Locust terminal to stop.');
      return;
    }

    // Ctrl+C last command
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\x03' });
      vscode.window.setStatusBarMessage('Locust: sent Ctrl+C to stop the last run.', 3000);
    } catch {
      // Fallback, dispose terminal
      term.dispose();
      vscode.window.setStatusBarMessage('Locust: terminal disposed to stop the run.', 3000);
    }
  }
}
