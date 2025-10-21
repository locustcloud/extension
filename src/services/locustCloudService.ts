import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { LocustTreeProvider } from "../tree/locustTree";
import { EnvService } from "./envService";
import { extractLocustUrl } from "../core/utils/locustUrl";


const CLOUD_FLAG_KEY = "locust.cloudWasStarted";


export class LocustCloudService {
  private readonly envSvc = new EnvService();
  private _out?: vscode.OutputChannel;
  private out(): vscode.OutputChannel {
    if (!this._out) {
      this._out = vscode.window.createOutputChannel("Locust Cloud");
    }
    return this._out;
  }

  // Track attached cloud CLI process
  private _cloudChild?: ChildProcessWithoutNullStreams;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

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
    // Optional: tell the webview to refresh button labels
    await vscode.commands
      .executeCommand("locust.postStateToWebview", { cloudStarted: v })
      .then(
        () => {},
        () => {}
      );
  }

  /** Workspace env folder name (default: ".locust_env"). */
  private get envFolder(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("envFolder", ".locust_env");
  }

  /** Locust CLI command or module runner hint (default: "locust"). */
  private get locustCmd(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("path", "locust");
  }

  /**
   * Build env with venv bin/Scripts prepended so "locust" is found if installed in the venv.
   * Only prepends if the bin/Scripts folder actually exists.
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    try {
      const venvPy = this.envSvc.getEnvInterpreterPath(this.envFolder);
      const venvDir = path.dirname(path.dirname(venvPy)); // .../.locust_env/{bin|Scripts}/python -> .../.locust_env
      const binDir = path.join(
        venvDir,
        process.platform === "win32" ? "Scripts" : "bin"
      );
      if (fs.existsSync(binDir)) {
        env.VIRTUAL_ENV = venvDir;
        env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
      }
    } catch {
      /* ignore */
    }
    return env;
  }

  /**
   * Decide how to launch Locust in a venv-stable way.
   * - If user configured an *absolute* binary path (locust.path), honor it directly.
   * - Otherwise, prefer running "python -m locust" using the resolved interpreter from EnvService.
   */
  private async resolveLocustLaunch(
    args: string[],
    cwd: string
  ): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> {
    const cfgPath = this.locustCmd; // "locust" (default) or user setting
    if (path.isAbsolute(cfgPath)) {
      // Respect explicit absolute binary
      return { cmd: cfgPath, args, env: this.buildEnv(), cwd };
    }
    // Run via venv's interpreter to guarantee correct site-packages
    const py = await this.envSvc.resolvePythonStrict(this.envFolder);
    return { cmd: py, args: ["-m", "locust", ...args], env: this.buildEnv(), cwd };
  }

  /**
   * Find the locustfile to run:
   * - If the active editor is a detected locustfile, use it
   * - If exactly one is found, use it
   * - Otherwise prompt the user
   */
  private async pickLocustfile(): Promise<string | undefined> {
    const tree = new LocustTreeProvider();
    try {
      const roots = await tree.getChildren();
      const files = roots.filter(
        (n) => (n as any).kind === "file"
      ) as Array<{ label: string; fileUri: vscode.Uri; filePath?: string }>;
      if (files.length === 0) return undefined;

      const active = vscode.window.activeTextEditor?.document;
      if (active?.languageId === "python") {
        const hit = files.find((f) => f.fileUri.fsPath === active.uri.fsPath);
        if (hit) return hit.fileUri.fsPath;
      }

      if (files.length === 1) return files[0].fileUri.fsPath;

      const pick = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f.label, description: f.fileUri.fsPath })),
        { placeHolder: "Select a locustfile to run in the cloud" }
      );
      return pick?.description;
    } finally {
      tree.dispose();
    }
  }

  /** Wrapper: "open in bottom split" command. */
  private async openUrlSplit(url: string, ratio = 0.45) {
    const tryCmd = async (id: string) =>
      vscode.commands.executeCommand(id, url, ratio).then(
        () => true,
        () => false
      );

    const ok =
      (await tryCmd("locust.openUrlInSplit")) ||
      (await tryCmd("locust.openUrlSplit"));
    if (!ok) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }


  private _ppWorkersReadyLogged = false;

  /**
   * Prettify Locust cloud output lines.
   */
  private prettifyLine(line: string): string | null {
    // Deploying (...)
    const mDep = line.match(/Deploying\s*\(([^)]+)\)/i);
    if (mDep) return `Deploying (${mDep[1]})`;

    // Waiting for load generators...
    if (/Waiting for load generators to be ready/i.test(line)) {
      return "Waiting for load generators to be ready...";
    }

    // Workers connected => once
    const mWorkers = line.match(/(\d+)\s+workers connected\./i);
    if (mWorkers && !this._ppWorkersReadyLogged) {
      this._ppWorkersReadyLogged = true;
      return "Workers ready.";
    }

    // All users spawned: ... (N total users)
    const mSpawn = line.match(/All users spawned:.*\((\d+)\s+total users\)/i);
    if (mSpawn) return `All users spawned: ${mSpawn[1]}`;

    // Tearing down
    if (/Tearing down Locust cloud/i.test(line)) {
      return "Stopping Locust cloud...";
    }

    // Starting web interface <url>
    const mWeb = line.match(/Starting web interface at\s+(https?:\/\/\S+)/i);
    if (mWeb) return `web UI: ${mWeb[1]}`;

    // Suppress "KeyboardInterrupt"
    if (/^KeyboardInterrupt$/i.test(line.trim())) return "";

    // Default: no prettification
    return null;
  }

  private processChunk(
    out: vscode.OutputChannel,
    chunk: string,
    onLine?: (line: string) => void
  ) {
    const lines = chunk.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw) continue;
      if (onLine) onLine(raw);

      const pretty = this.prettifyLine(raw);
      if (pretty === "") {
        // Suppressed KeyboardInterrupt
        continue;
      } else if (typeof pretty === "string") {
        out.appendLine(pretty);
      } else {
        out.append(raw + "\n");
      }
    }
  }


  /**
   * Run Locust in the cloud and mirror output to "Locust Cloud" output channel:
   * - Launch via venv-stable runner (python -m locust or absolute binary)
   * - Parse and open the printed web UI URL (split on web / default browser on desktop)
   * - Pretty-print only a few noisy lines.
   */
  async openLocustCloudLanding(): Promise<void> {
    const ws = this.getWorkspaceRoot();
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    const locustfile = await this.pickLocustfile();
    if (!locustfile) {
      vscode.window.showErrorMessage(
        "No locustfile found. Create one or open an existing locustfile.py."
      );
      return;
    }

    const out = this.out();
    out.show(true);

    const fileDir = path.dirname(locustfile);
    const relFile = path.basename(locustfile);

    // Resolve command using the venv-stable strategy
    const launch = await this.resolveLocustLaunch(
      ["-f", relFile, "--cloud"],
      fileDir
    );
    out.appendLine("Deploying (cloud run)…");

    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "pipe",
      shell: process.platform === "win32", // windows shim help
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
        out.appendLine(`Opening browser}`);
        if (this.isWeb) {
          await this.openUrlSplit(url, 0.45);
        } else {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    };

    child.stdout.on("data", async (b) => {
      const s = b.toString();
      // Pretty print
      this.processChunk(out, s, (line) => {
        // Maintain URL auto-open
        void tryExtractAndOpen(line);
      });

      // Minimal buffer for incomplete line handling
      bufOut += s;
      const lastNL = bufOut.lastIndexOf("\n");
      if (lastNL >= 0) bufOut = bufOut.slice(lastNL + 1);
    });

    child.stderr.on("data", async (b) => {
      const s = b.toString();
      this.processChunk(out, s, (line) => {
        void tryExtractAndOpen(line);
        if (/Your Locust instance is currently running/i.test(line)) {
          vscode.window.setStatusBarMessage("Instance detected, opening UI.", 5000);
        }
      });

      bufErr += s;
      const lastNL = bufErr.lastIndexOf("\n");
      if (lastNL >= 0) bufErr = bufErr.slice(lastNL + 1);
    });

    child.on("error", async (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${launch.cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
      await this.setCloudStarted(false);
      this._cloudChild = undefined;
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        out.appendLine(`Stop/Clean-up exited with code ${code}`);
      }
      this._cloudChild = undefined;
      await this.setCloudStarted(false);
    });
  }

  /**
   * Prefer stopping the attached cloud CLI process.
   * Fallback `locust --cloud --delete`
   */
  async deleteLocustCloud(): Promise<void> {
    // Try graceful kill first.
    if (this._cloudChild && !this._cloudChild.killed) {
      const child = this._cloudChild;
      const out = this.out();
      out.show(true);

      out.appendLine(`Stopping test: ${child.pid}`);
      out.appendLine(`Stopping Locust cloud...`);

      const trySignal = (sig: NodeJS.Signals) =>
        new Promise<void>((resolve) => {
          try { child.kill(sig); } catch { /* ignore */ }
          setTimeout(() => resolve(), 1200);
        });

      await trySignal("SIGINT");    // Graceful
      if (!child.killed) await trySignal("SIGTERM"); // Terminate
      if (!child.killed) {
        try { child.kill(); } catch { /* ignore */ } // Force
      }

      this._cloudChild = undefined;
      await this.setCloudStarted(false);
      vscode.window.setStatusBarMessage("Locust Cloud: stopped attached run.", 3000);
      return;
    }

    // No child: run "--cloud --delete" 
    const ws = this.getWorkspaceRoot();
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    const out = this.out();
    out.show(true);

    const launch = await this.resolveLocustLaunch(["--cloud", "--delete"], ws);
    out.appendLine(`Stopping Locust cloud...`);

    const del = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    del.stdout.on("data", (b) => this.processChunk(out, b.toString()));
    del.stderr.on("data", (b) => this.processChunk(out, b.toString()));
    del.on("error", (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${launch.cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });
    del.on("close", async (code) => {
      if (code !== 0) {
        out.appendLine(`Stop/clean-up exited with code ${code}`);
      }
      await this.setCloudStarted(false);
    });
  }
}
