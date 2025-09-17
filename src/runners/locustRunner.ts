import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';
import path from 'path';

/**
 * Locust run functions.
 * Runs in a dedicated terminal named "Locust"
 * Uses config settings for locust path, env folder, default host
 */

type RunMode = 'ui' | 'headless';

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class LocustRunner {
  constructor(private env: EnvService, private extensionUri: vscode.Uri) {}

  private findLocustTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find(t => t.name === 'Locust');
  }

  private getOrCreateLocustTerminal(): vscode.Terminal {
    return this.findLocustTerminal() ?? vscode.window.createTerminal({ name: 'Locust' });
  }

  private buildLocustCommand(filePath: string, mode: RunMode, extraArgs: string[] = []): string {
    const { locustPath, defaultHost } = getConfig();
    const headless = mode === 'headless' ? '--headless' : '';
    const host = defaultHost ? `-H "${defaultHost}"` : '';
    const extras = extraArgs.join(' ');
    return `${locustPath} -f "${filePath}" ${headless} ${host} ${extras}`.trim();
  }

  /**
   * Opens the Locust UI in VS Code's Simple Browser with a short delay.
   * Falls back to external browser if the Simple Browser command is unavailable.
   */
  private openLocustUIBrowser(url: vscode.Uri = vscode.Uri.parse('http://127.0.0.1:8089')) {
    const open = () => {
      vscode.commands.executeCommand('simpleBrowser.show', url).then(
        undefined,
        () => vscode.env.openExternal(url)
      );
    };
    setTimeout(open, 600);
    setTimeout(open, 1800);
  }

  private runLocustFile(filePath: string, mode: RunMode, extraArgs: string[] = []) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const term = this.getOrCreateLocustTerminal();
    term.show();
    const { envFolder } = getConfig();
    this.env.ensureTerminalEnv(term, envFolder);
    term.sendText(this.buildLocustCommand(filePath, mode, extraArgs));

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

  /** Create a starter, uniquely-numbered locustfile and return its URI. */
  async createLocustfile(opts: { where?: 'root' | 'templates'; open?: boolean } = {}) {
    const { where = 'root', open = true } = opts;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    const dir = where === 'templates' ? uriJoinPath(ws.uri, 'templates') : ws.uri;

    // ensure target dir exists (especially for templates/)
    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
    }

    const dest = await this.nextLocustfileUri(dir);

    // Minimal, snippet-inspired boilerplate
    const content = `from locust import FastHttpUser, task, tag, constant

class MyUser(FastHttpUser):
    \"\"\"Example user making a simple GET request.\"\"\"
    wait_time = constant(1)

    @task
    def example(self):
        self.client.get("/")

    @tag("checkout")
    @task
    def checkout(self):
        self.client.post("/api/checkout", json={})
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

    // Fallback 1: active editor if it's a locustfile
    if (!targetPath) {
      const active = vscode.window.activeTextEditor?.document;
      if (active && /(?:^|\/)locustfile.*\.py$/i.test(active.fileName)) {
        targetPath = active.fileName;
      }
    }

    // Fallback 2: quick pick a locustfile
    if (!targetPath) {
      const picked = await this.pickLocustfile();
      if (picked) targetPath = picked.fsPath;
    }

    if (!targetPath) {
      vscode.window.showWarningMessage('No locustfile selected.');
      return;
    }

    this.runLocustFile(targetPath, mode);
  }

  // Task helper
  private async runTask(node: any, mode: RunMode) {
    const { filePath, taskName } = node ?? {};
    if (!filePath || !taskName) {
      vscode.window.showWarningMessage('No task selected.');
      return;
    }
    // Filter by tag = taskName (recommend @tag("<taskName>") on the task)
    this.runLocustFile(filePath, mode, [`--tags "${taskName}"`]);
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
    this.runLocustFile(file.fsPath, mode);
  }

  async runByTag() {
    const file = await this.pickLocustfile();
    if (!file) return;

    const tag = await vscode.window.showInputBox({
      prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
      placeHolder: 'e.g. checkout,auth'
    });
    if (!tag) return;

    this.runLocustFile(file.fsPath, 'headless', [`--tags "${tag}"`]);
  }

  private async pickLocustfile(): Promise<vscode.Uri | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    const { envFolder } = getConfig();
    const ignoreDirs = new Set([envFolder, '.venv', '.git', '__pycache__', 'node_modules']);
    const ignoreList = Array.from(ignoreDirs).filter(Boolean);
    const ignoreGlob = ignoreList.length ? `**/{${ignoreList.join(',')}}/**` : '';

    // Look for common patterns
    const files = await vscode.workspace.findFiles('**/locustfile*.py', ignoreGlob, 50);

    if (files.length === 0) {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace to create files.');
        return;
      }
      // Create a uniquely-numbered locustfile at the repo root
      const created = await this.createLocustfile({ where: 'root', open: true });
      return created;
    }

    if (files.length === 1) return files[0];

    const picks = files
      .sort((a, b) => a.fsPath.length - b.fsPath.length)
      .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));

    const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
    return choice?.uri;
  }
}
