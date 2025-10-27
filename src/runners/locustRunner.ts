import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';
import { extractLocustUrl } from '../core/utils/locustUrl';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

type RunMode = 'ui' | 'headless';

function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class LocustRunner {
  private readonly envSvc = new EnvService();

  private get localFallbackUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("local.url", "http://localhost:8089");
  }

  private get envFolder(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("envFolder", ".locust_env");
  }

  private get locustCmd(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("path", "locust");
  }

  private _lastTerminal?: vscode.Terminal;
  private _lastPid?: number;
  private _lastCmd?: string;
  private _lastCwd?: string;

  private _uiChild?: ChildProcessWithoutNullStreams;

  private findLocustTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find(t => t.name === 'Locust');
  }

  private getOrCreateLocustTerminal(): vscode.Terminal {
    const t = this.findLocustTerminal() ?? vscode.window.createTerminal({ name: 'Locust' });
    this._lastTerminal = t;
    return t;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    try {
      const venvPy = this.envSvc.getEnvInterpreterPath(this.envFolder);
      const venvDir = path.dirname(path.dirname(venvPy));
      const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
      env.VIRTUAL_ENV = venvDir;
      env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
    } catch { /* ignore */ }
    return env;
  }

  private async openUrlSplit(url: string, ratio = 0.45) {
    const tryCmd = async (id: string) =>
      vscode.commands.executeCommand(id, url, ratio).then(() => true, () => false);

    const ok = await tryCmd("locust.openUrlInSplit") || await tryCmd("locust.openUrlSplit");
    if (!ok) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  public async runLocustUI(locustfileAbs?: string) {
    const out = vscode.window.createOutputChannel("Locust");
    out.show(true);

    let targetPath = locustfileAbs;
    if (!targetPath) {
      const uri = await vscode.commands.executeCommand('locust.pickLocustfile') as vscode.Uri | undefined;
      targetPath = uri?.fsPath;
    }
    if (!targetPath) {
      vscode.window.showWarningMessage('No locustfile selected.');
      // ensure not stuck
      await vscode.commands.executeCommand('locust.setLocalStarted', false);
      return;
    }

    const env = this.buildEnv();
    const cmd = this.locustCmd;
    const cwd = path.dirname(targetPath);
    const rel = path.basename(targetPath);

    out.appendLine(`[local-ui] launching: ${cmd} -f "${rel}"`);
    const child = spawn(cmd, ['-f', rel], { cwd, env, stdio: 'pipe', shell: process.platform === 'win32' });
    this._uiChild = child;

    let opened = false;
    let bufOut = "";
    let bufErr = "";

    const tryExtractAndOpen = async (text: string) => {
      const url = extractLocustUrl(text, { addDashboardFalse: false });
      if (url && !opened) {
        opened = true;
        out.appendLine(`[local-ui] Activating Interface...`);
        await this.openUrlSplit(url, 0.45);
        vscode.window.setStatusBarMessage("Interface activated.", 60000);
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
      out.append(`[stderr] ${s}`);
      bufErr += s;
      await flushLines(bufErr);
      bufErr = bufErr.slice(bufErr.lastIndexOf("\n") + 1);
    });

    child.on("error", async (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
      this._uiChild = undefined;
      // ✅ clear running flag on error
      await vscode.commands.executeCommand('locust.setLocalStarted', false);
    });

    child.on("close", async (code) => {
      out.appendLine(`[local-ui] exited with code ${code}`);
      this._uiChild = undefined;
      // ✅ clear running flag on clean exit
      await vscode.commands.executeCommand('locust.setLocalStarted', false);
    });

    setTimeout(() => {
      if (!opened) {
        opened = true;
        this.openUrlSplit(this.localFallbackUrl, 0.45).catch(() => {});
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

    if (!targetPath) {
      const uri = await vscode.commands.executeCommand('locust.pickLocustfile') as vscode.Uri | undefined;
      targetPath = uri?.fsPath;
    }
    if (!targetPath) {
      vscode.window.showWarningMessage('No locustfile selected.');
      await vscode.commands.executeCommand('locust.setLocalStarted', false);
      return;
    }

    if (mode === 'ui') {
      await this.runLocustUI(targetPath);
    } else {
      await this.runLocustHeadless(targetPath);
    }
  }

  private async runTask(node: any, mode: RunMode) {
    const { filePath, taskName } = node ?? {};
    if (!filePath || !taskName) {
      vscode.window.showWarningMessage('No task selected.');
      return;
    }
    const extra = [`--tags "${taskName}"`];
    await this.runLocustHeadless(filePath, extra);
  }

  async runTaskHeadless(node: any) {
    await this.runTask(node, 'headless');
  }
  async runTaskUI(node: any) {
    await this.runTask(node, 'headless');
  }

  public async stopLastRun(): Promise<void> {
    // First try to stop a spawned UI process
    if (this._uiChild && !this._uiChild.killed) {
      try {
        this._uiChild.kill();
        this._uiChild = undefined;
        vscode.window.setStatusBarMessage('Locust: stopped local UI run.', 3000);
        // ✅ clear running flag when user stops
        await vscode.commands.executeCommand('locust.setLocalStarted', false);
        return;
      } catch {
        // fall through to terminal stop
      }
    }

    const term = this._lastTerminal ?? this.findLocustTerminal();
    if (!term) {
      vscode.window.showInformationMessage('No running Locust session to stop.');
      // still clear any stale flag
      await vscode.commands.executeCommand('locust.setLocalStarted', false);
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\x03' });
      vscode.window.setStatusBarMessage('Locust: sent Ctrl+C to stop the run.', 3000);
    } catch {
      term.dispose();
      vscode.window.setStatusBarMessage('Locust: terminal disposed to stop the run.', 3000);
    } finally {
      // ✅ clear flag after stopping terminal run
      await vscode.commands.executeCommand('locust.setLocalStarted', false);
    }
  }
}
