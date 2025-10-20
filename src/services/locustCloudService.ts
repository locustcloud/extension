import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { LocustTreeProvider } from "../tree/locustTree";
import { EnvService } from "./envService";
import { extractLocustUrl } from "../core/utils/locustUrl";

// Keep this key consistent with your extension.ts usage
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

  /** Fallback URL if CLI never prints UI URL. */
  private get cloudFallbackUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>(
      "cloud.rootUrl",
      "https://auth.locust.cloud/load-test?dashboard=false"
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

  /**
   * Run Locust in the cloud and mirror output to the "Locust Cloud" output channel:
   * - Launch via venv-stable runner (python -m locust or absolute binary)
   * - Parse and open the printed web UI URL (split on web / default browser on desktop)
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
        "Locust Cloud: no locustfile found. Create one or open an existing locustfile.py."
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
    out.appendLine(
      `[cloud-ui] launching: ${launch.cmd} ${launch.args.join(" ")} (cwd=${launch.cwd})`
    );

    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "pipe",
      shell: process.platform === "win32", // helps on Windows if "locust" is a shim
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
        out.appendLine(`[cloud-ui] web UI: ${url}`);
        if (this.isWeb) {
          await this.openUrlSplit(url, 0.45);
          vscode.window.setStatusBarMessage(
            "Locust Cloud: web UI opened in split view.",
            60000
          );
        } else {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          vscode.window.setStatusBarMessage(
            "Locust Cloud: web UI opened in your browser.",
            60000
          );
        }
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

      if (/Your Locust instance is currently running/i.test(s)) {
        vscode.window.setStatusBarMessage(
          "Locust Cloud: existing instance detected, opening UI.",
          60000
        );
      }
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
      out.appendLine(`\n[cloud-ui] exited with code ${code ?? "null"}`);
      this._cloudChild = undefined;
      await this.setCloudStarted(false);
    });

    // Fallback: 60 sec timeout to open landing if URL never appeared
    setTimeout(async () => {
      if (!opened) {
        opened = true;
        const fallback = this.cloudFallbackUrl;
        out.appendLine(`[cloud-ui] no UI URL detected — opening fallback: ${fallback}`);
        if (this.isWeb) {
          await this.openUrlSplit(fallback, 0.45);
        } else {
          await vscode.env.openExternal(vscode.Uri.parse(fallback));
        }
      }
    }, 60000);
  }

  /**
   * Prefer stopping the attached cloud CLI process.
   * Fallback to `locust --cloud --delete`
   */
  async deleteLocustCloud(): Promise<void> {
    // Live child process, try graceful kill first.
    if (this._cloudChild && !this._cloudChild.killed) {
      const child = this._cloudChild;
      const out = this.out();
      out.show(true);

      out.appendLine(`[cloud-ui] stopping attached cloud process (PID ${child.pid})`);

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
    out.appendLine(
      `[cloud-ui] deleting: ${launch.cmd} ${launch.args.join(" ")} (cwd=${ws})`
    );

    const del = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    del.stdout.on("data", (b) => out.append(b.toString()));
    del.stderr.on("data", (b) => out.append(`[stderr] ${b.toString()}`));
    del.on("error", (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${launch.cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });
    del.on("close", async (code) => {
      out.appendLine(`[cloud-ui] delete exited with code ${code}`);
      await this.setCloudStarted(false);
    });
  }
}
