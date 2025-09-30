import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { LocustTreeProvider } from "../tree/locustTree";
import { EnvService } from "./envService";

/** Extract the Locust web UI URL from a log line and sanitize trailing punctuation. */
function extractLocustUrl(line: string): string | undefined {
  // 1) Normal path
  let m = line.match(/Starting web interface at (\S+)/i);
  let url = m?.[1];

  // 2) "already running" path
  if (!url) {
    m = line.match(/available at (\S+)/i);
    url = m?.[1];
  }

  // 3) Fallback: first http(s) URL in the line
  if (!url) {
    m = line.match(/https?:\/\/[^\s)>\]]+/);
    url = m?.[0];
  }

  // Strip trailing punctuation that often rides along in logs
  if (url) url = url.replace(/[)\].,;'"!?]+$/, "");
  return url;
}

export class LocustCloudService {
  private readonly envSvc = new EnvService();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Fallback URL if the CLI never prints a UI URL. */
  private get cloudFallbackUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("cloud.rootUrl", "https://auth.locust.cloud/load-test");
  }

  /** Workspace env folder name (default: ".locust_env"). */
  private get envFolder(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("envFolder", ".locust_env");
  }

  /** Make env behave like the venv is activated, when absPy is a venv python. */
  private envForInterpreter(absPy?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (!absPy) return env;
    try {
      const venvDir = path.dirname(path.dirname(absPy)); // .../.locust_env/{bin|Scripts}/python -> .../.locust_env
      const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
      env.VIRTUAL_ENV = venvDir;
      env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
    } catch { /* ignore */ }
    return env;
  }

  /** Resolve a runnable interpreter using EnvService (venv → config → python → python3). */
  private async resolveRunner(): Promise<{ exe: string; baseArgs: string[]; env: NodeJS.ProcessEnv; note: string }> {
    const exe = await this.envSvc.resolvePythonStrict(this.envFolder);
    const env = this.envForInterpreter(exe);
    const note =
      exe.includes(`${path.sep}${this.envFolder}${path.sep}`) ? this.envFolder :
      path.isAbsolute(exe) ? "configured" : exe; // "python"/"python3"
    return { exe, baseArgs: ["-u", "-m", "locust"], env, note };
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
      const roots = await tree.getChildren(); // file nodes at root
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

  /**
   * Open a URL in Simple Browser in a **bottom** editor group sized to ~45% height.
   * Uses `newGroupBelow` so we DON'T duplicate the current editor in the new group.
   */
  private async openInSimpleBrowserSplit(url: string, browserRatio = 0.45) {
    const r = Math.min(0.8, Math.max(0.2, browserRatio));

    if (vscode.window.tabGroups.all.length < 2) {
      await vscode.commands.executeCommand("workbench.action.newGroupBelow").then(undefined, () => {});
    }

    const ok = await vscode.commands
      .executeCommand("simpleBrowser.show", url, {
        viewColumn: vscode.ViewColumn.Two, // open in the second (bottom) group
        preserveFocus: true,
        preview: true,
      })
      .then(() => true, () => false);

    if (!ok) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    if (vscode.window.tabGroups.all.length === 2) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 0, // horizontal rows (top/bottom)
        groups: [{ size: 1 - r }, { size: r }], // top then bottom
      }).then(undefined, () => {});
    }

    await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup").then(undefined, () => {});
  }

  /**
   * Run `python -m locust -f <locustfile> --cloud` (no TTY),
   * parse the "Starting web interface at <URL>" / "available at <URL>" line,
   * and open that URL in the Simple Browser split. We never send <Enter>,
   * so the OS browser isn't triggered.
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

    // Resolve interpreter using EnvService
    let runner;
    try {
      runner = await this.resolveRunner();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "No Python interpreter found."}`);
      return;
    }

    const out = vscode.window.createOutputChannel("Locust Cloud");
    out.show(true);

    // Run from the file's directory and pass a relative -f to satisfy cloud path handling
    const fileDir = path.dirname(locustfile);
    const relFile = path.basename(locustfile);

    out.appendLine(`[cloud] launching: ${runner.exe} ${runner.baseArgs.join(" ")} -f "${relFile}" --cloud (via ${runner.note})`);

    const child = spawn(runner.exe, [...runner.baseArgs, "-f", relFile, "--cloud"], {
      cwd: fileDir,
      env: runner.env,
      stdio: ["ignore", "pipe", "pipe"], // no stdin → we won't press <Enter>
    });

    let opened = false;
    let bufOut = "";
    let bufErr = "";

    const tryExtractAndOpen = async (text: string) => {
      const url = extractLocustUrl(text);
      if (url && !opened) {
        opened = true;
        out.appendLine(`[cloud] web UI: ${url}`);
        await this.openInSimpleBrowserSplit(url, 0.45);
        vscode.window.setStatusBarMessage("Locust Cloud: web UI opened in split view.", 3000);
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
        vscode.window.setStatusBarMessage("Locust Cloud: existing instance detected – opening its UI.", 3000);
      }
    });

    child.on("error", (e) => out.appendLine(`[error] ${e?.message ?? e}`));
    child.on("close", (code) => out.appendLine(`[cloud] exited with code ${code}`));

    // Safety net: open fallback if we didn't see a URL soon.
    setTimeout(() => {
      if (!opened) {
        opened = true;
        const fallback = this.cloudFallbackUrl;
        out.appendLine(`[cloud] no UI URL detected — opening fallback: ${fallback}`);
        this.openInSimpleBrowserSplit(fallback, 0.45).catch(() => {});
      }
    }, 10000);
  }

  /** Run `python -m locust --cloud --delete` using the same interpreter resolution. */
  async deleteLocustCloud(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    let runner;
    try {
      runner = await this.resolveRunner();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "No Python interpreter found."}`);
      return;
    }

    const cwd = ws.uri.fsPath;
    const out = vscode.window.createOutputChannel("Locust Cloud");
    out.show(true);
    out.appendLine(`[cloud] deleting: ${runner.exe} ${runner.baseArgs.join(" ")} --cloud --delete (cwd=${cwd}, via ${runner.note})`);

    const child = spawn(runner.exe, [...runner.baseArgs, "--cloud", "--delete"], {
      cwd,
      env: runner.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (b) => out.append(b.toString()));
    child.stderr.on("data", (b) => out.append(`[stderr] ${b.toString()}`));
    child.on("error", (e) => out.appendLine(`[error] ${e?.message ?? e}`));
    child.on("close", (code) => out.appendLine(`[cloud] delete exited with code ${code}`));
  }
}
