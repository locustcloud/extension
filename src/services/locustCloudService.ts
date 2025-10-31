import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EnvService } from "./envService";
import { extractLocustUrl } from "../core/utils/locustUrl";

const CLOUD_FLAG_KEY = "locust.cloudWasStarted";

export class LocustCloudService {
  private readonly envSvc = new EnvService();
  private _out?: vscode.OutputChannel;

  private out(): vscode.OutputChannel {
    if (!this._out) this._out = vscode.window.createOutputChannel("Locust Cloud");
    return this._out;
  }

  // Track cloud CLI process
  private _cloudChild?: ChildProcessWithoutNullStreams;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /**
   * Pick a locustfile
   */
  async pickLocustfile(): Promise<string | undefined> {
    try {
      const uri = await vscode.commands.executeCommand('locust.pickLocustfile') as vscode.Uri | undefined;
      if (uri?.fsPath) return uri.fsPath;
    } catch { /* ignore */ }
    return undefined;
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private get isWeb(): boolean {
    return vscode.env.uiKind === vscode.UIKind.Web;
  }

  private getCloudStarted(): boolean {
    return !!this.ctx.globalState.get<boolean>(CLOUD_FLAG_KEY, false);
  }

  private async setCloudStarted(v: boolean) {
    await this.ctx.globalState.update(CLOUD_FLAG_KEY, v);
    await vscode.commands.executeCommand("locust.welcome.refresh").then(() => {}, () => {});
  }

  /** Workspace env folder name (default: ".locust_env"). */
  private get envFolder(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("envFolder", ".locust_env");
  }

  /** Locust CLI command runner (default: "locust"). */
  private get locustCmd(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("path", "locust");
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    try {
      const venvPy = this.envSvc.getEnvInterpreterPath(this.envFolder);
      const venvDir = path.dirname(path.dirname(venvPy));
      const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
      if (fs.existsSync(binDir)) {
        env.VIRTUAL_ENV = venvDir;
        env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
      }
    } catch { /* ignore */ }
    return env;
  }

  private async resolveLocustLaunch(
    args: string[],
    cwd: string
  ): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> {
    const cfgPath = this.locustCmd;
    if (path.isAbsolute(cfgPath)) {
      return { cmd: cfgPath, args, env: this.buildEnv(), cwd };
    }
    const py = await this.envSvc.resolvePythonStrict(this.envFolder);
    return { cmd: py, args: ["-m", "locust", ...args], env: this.buildEnv(), cwd };
  }

  private async openUrlSplit(url: string, ratio = 0.45) {
    const tryCmd = async (id: string) =>
      vscode.commands.executeCommand(id, url, ratio).then(() => true, () => false);
    const ok = (await tryCmd("locust.openUrlInSplit")) || (await tryCmd("locust.openUrlSplit"));
    if (!ok) await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private _ppWorkersReadyLogged = false;

  private prettifyLine(line: string): string | null {
    const mDep = line.match(/Deploying\s*\(([^)]+)\)/i);
    if (mDep) return `Deploying (${mDep[1]})`;
    if (/Waiting for load generators to be ready/i.test(line)) return "Waiting for load generators to be ready...";
    const mWorkers = line.match(/(\d+)\s+workers connected\./i);
    if (mWorkers && !this._ppWorkersReadyLogged) {
      this._ppWorkersReadyLogged = true;
      return "Workers ready.";
    }
    const mSpawn = line.match(/All users spawned:.*\((\d+)\s+total users\)/i);
    if (mSpawn) return `All users spawned: ${mSpawn[1]}`;
    if (/Tearing down Locust cloud/i.test(line)) return "Stopping Locust cloud...";
    const mWeb = line.match(/Starting web interface at\s+(https?:\/\/\S+)/i);
    if (mWeb) return `Starting Browser...`;
    if (/^KeyboardInterrupt$/i.test(line.trim())) return "";
    return null;
    }

  private processChunk(out: vscode.OutputChannel, chunk: string, onLine?: (line: string) => void) {
    const lines = chunk.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw) continue;
      if (onLine) onLine(raw);
      const pretty = this.prettifyLine(raw);
      if (pretty === "") continue;
      if (typeof pretty === "string") out.appendLine(pretty);
      else out.append(raw + "\n");
    }
  }

  /**
   * Start a Locust Cloud run.
   * Returns true if run started, false if cancelled or invalid.
   */
  async openLocustCloudLanding(locustfileAbs?: string): Promise<boolean> {
    const ws = this.getWorkspaceRoot();
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      await this.setCloudStarted(false);
      return false;
    }

    let targetPath = locustfileAbs;
    const picked = await this.pickLocustfile();
    if (!picked) {
      // cancelled
      await this.setCloudStarted(false);
      await vscode.commands.executeCommand('locust.refreshTree').then(() => {}, () => {});
      return false;
    }
    targetPath = picked;

    const out = this.out();
    out.show(true);

    // Fallback URL
    const cfg = vscode.workspace.getConfiguration('locust');
    const fallbackUrl = cfg.get<string>('cloud.rootUrl', 'https://auth.locust.cloud/load-test?dashboard=false');

    const fileDir = path.dirname(targetPath);
    const relFile = path.basename(targetPath);

    const launch = await this.resolveLocustLaunch(["-f", relFile, "--cloud"], fileDir);
    out.appendLine(`Launching: ${launch.cmd} ${launch.args.join(" ")}`);

    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    this._cloudChild = child;
    await this.setCloudStarted(true); 

    let opened = false;
    let bufOut = "";
    let bufErr = "";

    const tryExtractAndOpen = async (text: string) => {
      const url = extractLocustUrl(text, { addDashboardFalse: true });
      if (url && !opened) {
        opened = true;
        out.appendLine(`Opening Browser...`);
        if (this.isWeb) await this.openUrlSplit(url, 0.45);
        else await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    };

    child.stdout.on("data", async (b) => {
      const s = b.toString();
      this.processChunk(out, s, (line) => { void tryExtractAndOpen(line); });
      bufOut += s;
      const lastNL = bufOut.lastIndexOf("\n");
      if (lastNL >= 0) bufOut = bufOut.slice(lastNL + 1);
    });

    child.stderr.on("data", async (b) => {
      const s = b.toString();
      out.append(`${s}`);
      bufErr += s;
      const lastNL = bufErr.lastIndexOf("\n");
      if (lastNL >= 0) bufErr = bufErr.slice(lastNL + 1);
    });

    child.on("error", async (e: any) => {
      out.appendLine(`${e?.message ?? e}`);
      vscode.window.showErrorMessage(`Failed to run "${launch.cmd}". Ensure Locust is installed.`);
      
      if (!opened && fallbackUrl) {
        opened = true;
        out.appendLine(`Opening Browser (fallback)…`);
        if (this.isWeb) await this.openUrlSplit(fallbackUrl, 0.45);
        else await vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
      }
      await this.setCloudStarted(false);
      this._cloudChild = undefined;
    });

    child.on("close", async (code) => {
      out.appendLine(`\nExit code: \n ${code ?? "null"}`);
      
      if (!opened && fallbackUrl) {
        opened = true;
        out.appendLine(`Opening Browser (fallback)…`);
        if (this.isWeb) await this.openUrlSplit(fallbackUrl, 0.45);
        else await vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
      }
      this._cloudChild = undefined;
      await this.setCloudStarted(false);
    });

    setTimeout(async () => {
      if (!opened && fallbackUrl) {
        opened = true;
        out.appendLine(`Opening Browser (timeout fallback)…`);
        if (this.isWeb) await this.openUrlSplit(fallbackUrl, 0.45);
        else await vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
      }
    }, 60000);

    return true; // started
  }

  async deleteLocustCloud(): Promise<void> {
    if (this._cloudChild && !this._cloudChild.killed) {
      const child = this._cloudChild;
      const out = this.out();
      out.show(true);

      out.appendLine(`Stopping cloud`);

      const trySignal = (sig: NodeJS.Signals) =>
        new Promise<void>((resolve) => {
          try { child.kill(sig); } catch { /* ignore */ }
          setTimeout(() => resolve(), 1200);
        });

      await trySignal("SIGINT");
      if (!child.killed) await trySignal("SIGTERM");
      if (!child.killed) { try { child.kill(); } catch { /* ignore */ } }

      this._cloudChild = undefined;
      await this.setCloudStarted(false);
      vscode.window.setStatusBarMessage("Locust Cloud: stopped attached run.", 3000);
      return;
    }

    const ws = this.getWorkspaceRoot();
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    const out = this.out();
    out.show(true);

    const launch = await this.resolveLocustLaunch(["--cloud", "--delete"], ws);
    out.appendLine(`Shutting Down...`);

    const del = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    del.stdout.on("data", (b) => out.append(b.toString()));
    del.stderr.on("data", (b) => out.append(`${b.toString()}`));
    del.on("error", (e: any) => {
      out.appendLine(`${e?.message ?? e}`);
      vscode.window.showErrorMessage(`Failed to run "${launch.cmd}".`);
    });
    del.on("close", async (code) => {
      out.appendLine(`Shut down:\n ${code}`);
      await this.setCloudStarted(false);
    });
  }
}
