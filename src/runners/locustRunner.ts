import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';
import { extractLocustUrl } from "../core/utils/locustUrl";
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

  private buildLocustCommand(filePath: string, mode: RunMode, extraArgs: string[] = []): string {
    const { locustPath, defaultHost } = getConfig();
    const headless = mode === 'headless' ? '--headless' : '';
    const host = defaultHost ? `-H "${defaultHost}"` : '';
    const extras = extraArgs.join(' ');
    return `${locustPath} -f "${filePath}" ${headless} ${host} ${extras}`.trim();
  }

  /**
   * Opens Locust UI in VS Code's Simple Browser, sized to ~45% width (right column). 
   * Fallback: External browser if Simple Browser fails.
   */
  private openLocustUIBrowser(url: vscode.Uri = vscode.Uri.parse('http://127.0.0.1:8089')) {
  // Ensure dashboard=false for embedded Simple Browser
  const target = extractLocustUrl(url.toString()) ?? url.toString();
  const open = () => vscode.commands.executeCommand('locust.openUrlInSplit', target, 0.45);
  setTimeout(open, 600);
  setTimeout(open, 1800);
}

  private async runLocustFile(filePath: string, mode: RunMode, extraArgs: string[] = []) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const term = this.getOrCreateLocustTerminal();
    term.show();
    const { envFolder } = getConfig();
    this.env.ensureTerminalEnv(term, envFolder);

    // Record cwd and command for this run
    const cwd = path.dirname(filePath);
    const cmd = this.buildLocustCommand(filePath, mode, extraArgs);
    this._lastCmd = cmd;
    this._lastCwd = cwd;

    term.sendText(`cd "${cwd}"`);
    term.sendText(cmd);

    // Capture the terminal pid for one-click stop later
    try {
      this._lastPid = await term.processId ?? undefined;
    } catch {
      this._lastPid = undefined;
    }

    if (mode === 'ui') {
      this.openLocustUIBrowser();
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

    // Minimal, snippet-inspired boilerplate
    const content = `import random
from locust import FastHttpUser, constant, run_single_user, task


class SimpleUrl(FastHttpUser):
    wait_time = constant(1)

    @task
    def index(self):
        self.client.get("/")


class MockTarget(FastHttpUser):
    wait_time = constant(1)
    host = "https://mock-test-target.eu-north-1.locust.cloud"
    product_ids = [1, 2, 42, 4711]

    @task
    def t(self):
        self.client.get("/")
        self.client.post("/authenticate", json={"user": "foo", "password": "bar"})
        for product_id in random.sample(self.product_ids, 2):
            self.client.post("/cart/add", json={"productId": product_id})
        with self.client.post("/checkout/confirm", catch_response=True) as resp:
            if not resp.json().get("orderId"):
                resp.failure("orderId missing")


if __name__ == "__main__":
    run_single_user(MockTarget)

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
