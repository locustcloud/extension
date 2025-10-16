import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { LocustTreeProvider } from "../tree/locustTree";
import { EnvService } from "./envService";
import { extractLocustUrl } from "../core/utils/locustUrl";

export class LocustCloudService {
  private readonly envSvc = new EnvService();

  // Track attached cloud CLI process
  private _cloudChild?: ChildProcessWithoutNullStreams;
  
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Fallback URL if CLI never prints UI URL. */
  private get cloudFallbackUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("cloud.rootUrl", "https://auth.locust.cloud/load-test?dashboard=false");
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
      const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
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
  private async resolveLocustLaunch(args: string[], cwd: string): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> {
    const cfgPath = this.locustCmd; // "locust" (default) or user setting
    if (path.isAbsolute(cfgPath)) {
      // Respect explicit absolute binary
      return { cmd: cfgPath, args, env: this.buildEnv(), cwd };
    }
    // Run via venv's interpreter to guarantee correct site-packages
    const py = await this.envSvc.resolvePythonStrict(this.envFolder);
    return { cmd: py, args: ["-m", "locust", ...args], env: process.env, cwd };
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
      const files = roots.filter(n => (n as any).kind === "file") as Array<{ label: string; fileUri: vscode.Uri; filePath?: string }>;
      if (files.length === 0) return undefined;

      const active = vscode.window.activeTextEditor?.document;
      if (active?.languageId === "python") {
        const hit = files.find(f => f.fileUri.fsPath === active.uri.fsPath);
        if (hit) return hit.fileUri.fsPath;
      }

      if (files.length === 1) return files[0].fileUri.fsPath;

      const pick = await vscode.window.showQuickPick(
        files.map(f => ({ label: f.label, description: f.fileUri.fsPath })),
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
      vscode.commands.executeCommand(id, url, ratio).then(() => true, () => false);

    const ok = await tryCmd("locust.openUrlInSplit") || await tryCmd("locust.openUrlSplit");
    if (!ok) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  /**
   * Run Locust in the cloud:
   * - Launch via venv-stable runner (python -m locust or absolute binary)
   * - Parse the printed web UI URL
   * - Open Simple Browser split (web) or default browser (desktop)
   */
  async openLocustCloudLanding(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    const locustfile = await this.pickLocustfile();
    if (!locustfile) {
      vscode.window.showErrorMessage("Locust Cloud: no locustfile found. Create one or open an existing locustfile.py.");
      return;
    }

    const out = vscode.window.createOutputChannel("Locust Cloud");
    out.show(true);

    const fileDir = path.dirname(locustfile);
    const relFile = path.basename(locustfile);

    // Resolve command using the venv-stable strategy
    const launch = await this.resolveLocustLaunch(["-f", relFile, "--cloud"], fileDir);
    out.appendLine(`[cloud] launching: ${launch.cmd} ${launch.args.join(" ")} (cwd=${launch.cwd})`);

    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "pipe",
    });
    this._cloudChild = child;

    let opened = false;
    let bufOut = "";
    let bufErr = "";

    const isWeb = vscode.env.uiKind === vscode.UIKind.Web;

    const tryExtractAndOpen = async (text: string) => {
      const url = extractLocustUrl(text, { addDashboardFalse: true });
      if (url && !opened) {
        opened = true;
        out.appendLine(`[cloud] web UI: ${url}`);
        if (isWeb) {
          await this.openUrlSplit(url, 0.45);
          vscode.window.setStatusBarMessage("Locust Cloud: web UI opened in split view.", 60000);
        } else {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          vscode.window.setStatusBarMessage("Locust Cloud: web UI opened in your browser.", 60000);
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
        vscode.window.setStatusBarMessage("Locust Cloud: existing instance detected, opening UI.", 60000);
      }
    });

    child.on("error", (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${launch.cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });

    child.on("close", (code) => {
      out.appendLine(`[cloud] exited with code ${code}`);
      this._cloudChild = undefined;
    });

    // Fallback: 60 sec timeout
    setTimeout(() => {
      if (!opened) {
        opened = true;
        const fallback = this.cloudFallbackUrl;
        out.appendLine(`[cloud] no UI URL detected — opening fallback: ${fallback}`);
        if (isWeb) {
          this.openUrlSplit(fallback, 0.45).catch(() => {});
        } else {
          vscode.env.openExternal(vscode.Uri.parse(fallback)).then(undefined, () => {});
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
      const out = vscode.window.createOutputChannel("Locust Cloud");
      out.show(true);
      out.appendLine(`[cloud] stopping attached cloud process (PID ${child.pid})`);

      const trySignal = (sig: NodeJS.Signals) =>
        new Promise<void>((resolve) => {
          try { child.kill(sig); } catch { /* ignore */ }
          setTimeout(() => resolve(), 1200);
        });

      await trySignal("SIGINT");   // Graceful
      if (!child.killed) await trySignal("SIGTERM"); // Terminate
      if (!child.killed) {
        try { child.kill(); } catch { /* ignore */ } // Force
      }

      this._cloudChild = undefined;
      vscode.window.setStatusBarMessage("Locust Cloud: stopped attached run.", 3000);
      return;
    }

    // No child: run "--cloud --delete" in same resolver
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    const out = vscode.window.createOutputChannel("Locust Cloud");
    out.show(true);

    const cwd = ws.uri.fsPath;
    const launch = await this.resolveLocustLaunch(["--cloud", "--delete"], cwd);

    out.appendLine(`[cloud] deleting: ${launch.cmd} ${launch.args.join(" ")} (cwd=${cwd})`);

    const del = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    del.stdout.on("data", (b) => out.append(b.toString()));
    del.stderr.on("data", (b) => out.append(`[stderr] ${b.toString()}`));
    del.on("error", (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${launch.cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });
    del.on("close", (code) => out.appendLine(`[cloud] delete exited with code ${code}`));
  }
}
