import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';
import { extractLocustUrl } from '../core/utils/locustUrl';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { LocustTreeProvider } from '../tree/locustTree';

/**
 * Locust run functions.
 * - UI: spawn locust, parse the UI URL from stdout, open Simple Browser split
 * - Headless: run in a dedicated "Locust" terminal
 */

type RunMode = 'ui' | 'headless';

// Fallback older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class LocustRunner {
  private readonly envSvc = new EnvService();

  /** Fallback URL if the CLI never prints a UI URL. */
  private get localFallbackUrl(): string {
    // NOTE: your package.json defines "locust.local.url"
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("local.url", "http://localhost:8089");
  }

  /** Workspace env folder name (default: ".locust_env"). */
  private get envFolder(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("envFolder", ".locust_env");
  }

  /** Locust CLI command (default: "locust"). */
  private get locustCmd(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("path", "locust");
  }

  // Terminal tracking (for headless)
  private _lastTerminal?: vscode.Terminal;
  private _lastPid?: number;
  private _lastCmd?: string;
  private _lastCwd?: string;

  // Spawned child tracking (for UI)
  private _uiChild?: ChildProcessWithoutNullStreams;

  // 🔹 Track last opened UI URL so we can close the Simple Browser tab on stop
  private _lastUiUrl?: string;

  // 🔹 NEW: Track the Simple Browser tab we opened
  private _uiTab?: vscode.Tab;

  private findLocustTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find(t => t.name === 'Locust');
  }

  private getOrCreateLocustTerminal(): vscode.Terminal {
    const t = this.findLocustTerminal() ?? vscode.window.createTerminal({ name: 'Locust' });
    this._lastTerminal = t; // keep reference for stop
    return t;
  }

  /** Build env with venv bin/Scripts prepended so "locust" is found if installed in the venv. */
  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    try {
      const venvPy = this.envSvc.getEnvInterpreterPath(this.envFolder);
      const venvDir = path.dirname(path.dirname(venvPy)); // .../.locust_env/{bin|Scripts}/python -> .../.locust_env
      const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
      env.VIRTUAL_ENV = venvDir;
      env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
    } catch { /* ignore */ }
    return env;
  }

  // 🔹 NEW: Collect all Simple Browser tabs
  private collectSimpleBrowserTabs(): vscode.Tab[] {
    const out: vscode.Tab[] = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        const input = (t as any).input;
        if (input && typeof input.viewType === 'string' && input.viewType.toLowerCase().includes('simplebrowser')) {
          out.push(t);
        }
      }
    }
    return out;
  }

  /** Wrapper: "open in bottom split" */
  private async openUrlSplit(url: string, ratio = 0.45) {
    // 🔹 NEW: snapshot before opening
    const before = this.collectSimpleBrowserTabs();

    const tryCmd = async (id: string) =>
      vscode.commands.executeCommand(id, url, ratio).then(() => true, () => false);

    const ok = await tryCmd("locust.openUrlInSplit") || await tryCmd("locust.openUrlSplit");
    if (!ok) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    // 🔹 NEW: detect the newly opened Simple Browser tab and remember it
    const after = this.collectSimpleBrowserTabs();
    const newlyOpened = after.find(t => !before.includes(t));
    if (newlyOpened) this._uiTab = newlyOpened;
  }

  // 🔹 Find and close the Simple Browser tab showing a given URL
  private async closeSimpleBrowserForUrl(url: string | undefined): Promise<void> {
    if (!url) return;
    try {
      const groups = vscode.window.tabGroups.all;
      for (const g of groups) {
        for (const t of g.tabs) {
          // Simple Browser tab label is usually the full URL or page title including URL.
          // Be permissive: close if label equals or contains the URL.
          const label = (t.label || '').toString();
          if (!label) continue;
          if (label === url || label.includes(url)) {
            await vscode.window.tabGroups.close(t, true);
            return;
          }
        }
      }
    } catch {
      // best-effort; ignore
    }
  }

  private async runLocustUI(locustfileAbs: string) {
    const out = vscode.window.createOutputChannel("Locust");
    out.show(true);

    const env = this.buildEnv();
    const cmd = this.locustCmd;

    // Run from file directory and pass a relative -f 
    const fileDir = path.dirname(locustfileAbs);
    const relFile = path.basename(locustfileAbs);

    out.appendLine(`Launching: ${cmd} -f "${relFile}"`);
    const child = spawn(cmd, ["-f", relFile], {
      cwd: fileDir,
      env,
    });
    this._uiChild = child;

    let opened = false;
    let bufOut = "";
    let bufErr = "";

    const tryExtractAndOpen = async (text: string) => {
      // extractLocustUrl "Starting web interfac
      const url = extractLocustUrl(text, { addDashboardFalse: false });
      if (url && !opened) {
        opened = true;
        this._lastUiUrl = url; // 🔹 remember last UI URL
        out.appendLine(`UI Activated`);
        await this.openUrlSplit(url, 0.45);
        vscode.window.setStatusBarMessage("Locust (local): web UI opened in split view.", 60000);
      }
    };

    const flushLines = async (buf: string) => {
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        await tryExtractAndOpen(lines[i]);
      }
    };

    child.stdout.on("data", async (b) => {
      const s = b.toString();
      out.append(s);
      bufOut += s;
      await flushLines(bufOut);
      bufOut = bufOut.slice(bufOut.lastIndexOf("\n") + 1);
    });

    child.stderr.on("data", async (b) => {
      const s = b.toString();
      out.append(` ${s}`);
      bufErr += s;
      await flushLines(bufErr);
      bufErr = bufErr.slice(bufErr.lastIndexOf("\n") + 1);
    });

    child.on("error", (e: any) => {
      out.appendLine(`${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });

    child.on("close", async (code) => {
      out.appendLine(`exited with code ${code}`);
      this._uiChild = undefined;

      // 🔹 NEW: Close the tracked Simple Browser tab if we opened one
      if (this._uiTab) {
        try {
          await vscode.window.tabGroups.close([this._uiTab], true);
        } catch { /* ignore */ }
        this._uiTab = undefined;
      }
    });

    // Fallback: open configured localhost URL if no URL detected
    setTimeout(() => {
      if (!opened) {
        opened = true;
        const fallback = this.localFallbackUrl;
        this._lastUiUrl = fallback; // 🔹 remember fallback URL too
        out.appendLine(`No UI URL detected opening fallback...`);
        this.openUrlSplit(fallback, 0.45).catch(() => {});
      }
    }, 60000);
  }

  private async runLocustHeadless(locustfileAbs: string, extraArgs: string[] = []) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const term = this.getOrCreateLocustTerminal();
    term.show();

    const cwd = path.dirname(locustfileAbs);
    let cmd = `${this.locustCmd} -f "${locustfileAbs}" --headless`;
    if (extraArgs && extraArgs.length > 0) cmd += ' ' + extraArgs.join(' ');

    this._lastCmd = cmd;
    this._lastCwd = cwd;

    term.sendText(`cd "${cwd}"`);
    term.sendText(cmd);

    try {
      this._lastPid = await term.processId ?? undefined;
    } catch {
      this._lastPid = undefined;
    }
  }


  async runFile(filePath: string | undefined, mode: RunMode) {
    let targetPath = filePath;

    // Active editor if locustfile
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

    if (mode === 'ui') {
      await this.runLocustUI(targetPath);
    } else {
      await this.runLocustHeadless(targetPath);
    }
  }

  // Task helpers (headless with --tags)
  private async runTask(node: any, mode: RunMode) {
    const { filePath, taskName } = node ?? {};
    if (!filePath || !taskName) {
      vscode.window.showWarningMessage('No task selected.');
      return;
    }
    const extra = [`--tags "${taskName}"`];
    if (mode === 'ui') {
      // UI mode generally runs full test set; tags
      // ability to run headless with tags:
      await this.runLocustHeadless(filePath, extra);
    } else {
      await this.runLocustHeadless(filePath, extra);
    }
  }

  async runTaskHeadless(node: any) {
    await this.runTask(node, 'headless');
  }
  async runTaskUI(node: any) {
    // Prefer using UI for the whole file; for tagged runs we keep headless.
    await this.runTask(node, 'headless');
  }

  // Palette helpers.
  async runSelected(mode: RunMode) {
    const file = await this.pickLocustfile();
    if (!file) return;
    if (mode === 'ui') {
      await this.runLocustUI(file.fsPath);
    } else {
      await this.runLocustHeadless(file.fsPath);
    }
  }

  async runByTag() {
    const file = await this.pickLocustfile();
    if (!file) return;

    const tag = await vscode.window.showInputBox({
      prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
      placeHolder: 'e.g. checkout,auth'
    });
    if (!tag) return;

    await this.runLocustHeadless(file.fsPath, [`--tags "${tag}"`]);
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
          const idx = m[1] ? parseInt(m[1], 10) : 0; // plain locustfile.py = index 0
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

  // Create a starter, uniquely-numbered locustfile and return URI.
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

    // Ensure directory exists
    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
    }

    const dest = await this.nextLocustfileUri(dir);

    // Minimal boilerplate
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

  private async pickLocustfile(): Promise<vscode.Uri | undefined> {
    // Try centralized picker from the TreeProvider if available.
    try {
      const tree = new LocustTreeProvider();
      const maybePick = (tree as any).pickLocustfileOrActive;
      if (typeof maybePick === 'function') {
        const uri: vscode.Uri | undefined = await maybePick.call(tree, 'locust.createLocustfile');
        tree.dispose();
        if (uri) return uri;
      } else {
        tree.dispose();
      }
    } catch {
      // ignore and fall back
    }

    // Fallback to previous self-contained behavior 
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    const { envFolder } = getConfig();
    const ignoreDirs = new Set([envFolder, '.venv', '.git', '__pycache__', '.tour', 'node_modules']);
    const ignoreList = Array.from(ignoreDirs).filter(Boolean);
    const ignoreGlob = ignoreList.length ? `**/{${ignoreList.join(',')}}/**` : '';

    // Fast path: conventional names first
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

    // Offer to create one.
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to create files.');
      return;
    }
    const created = await this.createLocustfile({ open: true });
    return created;
  }

  // Stop last run
  public async stopLastRun(): Promise<void> {
    // First try to stop a spawned UI process
    if (this._uiChild && !this._uiChild.killed) {
      try {
        this._uiChild.kill();
        this._uiChild = undefined;

        // 🔹 NEW: Close the tracked Simple Browser tab if present
        if (this._uiTab) {
          try {
            await vscode.window.tabGroups.close([this._uiTab], true);
          } catch { /* ignore */ }
          this._uiTab = undefined;
        }

        // Close by URL fallback as well
        await this.closeSimpleBrowserForUrl(this._lastUiUrl);
        vscode.window.setStatusBarMessage('Locust: stopped local UI run.', 3000);
        return;
      } catch {
        // fall through to terminal stop
      }
    }

    // Stop terminal run
    const term = this._lastTerminal ?? this.findLocustTerminal();
    if (!term) {
      // 🔹 NEW: Close tracked tab (if any) and try URL-based close
      if (this._uiTab) {
        try {
          await vscode.window.tabGroups.close([this._uiTab], true);
        } catch { /* ignore */ }
        this._uiTab = undefined;
      }
      await this.closeSimpleBrowserForUrl(this._lastUiUrl);
      vscode.window.showInformationMessage('No running Locust session to stop.');
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\x03' });

      // 🔹 NEW: Close tracked tab (if any) and URL-based tab
      if (this._uiTab) {
        try {
          await vscode.window.tabGroups.close([this._uiTab], true);
        } catch { /* ignore */ }
        this._uiTab = undefined;
      }
      await this.closeSimpleBrowserForUrl(this._lastUiUrl);

      vscode.window.setStatusBarMessage('Locust: sent Ctrl+C to stop the run.', 3000);
    } catch {
      term.dispose();

      if (this._uiTab) {
        try {
          await vscode.window.tabGroups.close([this._uiTab], true);
        } catch { /* ignore */ }
        this._uiTab = undefined;
      }
      await this.closeSimpleBrowserForUrl(this._lastUiUrl);

      vscode.window.setStatusBarMessage('Locust: terminal disposed to stop the run.', 3000);
    }
  }
}
