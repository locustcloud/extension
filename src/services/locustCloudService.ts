import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { LocustTreeProvider } from "../tree/locustTree";
import { EnvService } from "./envService";

/** Extract the Locust web UI URL from a log line and ensure ?dashboard=false is set. */
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

  if (!url) return undefined;

  // Strip trailing punctuation that often rides along in logs
  url = url.replace(/[)\].,;'"!?]+$/, "");

  // Keep fragment aside (if any) so we can add/modify query cleanly
  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : "";

  // Force dashboard=false (append if missing, overwrite if present)
  let newBase: string;
  if (/[?&]dashboard=/.test(base)) {
    newBase = base.replace(/([?&]dashboard=)[^&#]*/i, "$1false");
  } else {
    const joiner = base.includes("?") ? "&" : "?";
    newBase = `${base}${joiner}dashboard=false`;
  }

  return newBase + fragment;
}

export class LocustCloudService {
  private readonly envSvc = new EnvService();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Fallback URL if the CLI never prints a UI URL. */
  private get cloudFallbackUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("cloud.rootUrl", "https://auth.locust.cloud/load-test?dashboard=false");
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
   * Run `locust -f <locustfile> --cloud` (no TTY),
   * parse the "Starting web interface at <URL>" / "available at <URL>" line,
   * and open that URL in the Simple Browser split.
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

    const env = this.buildEnv();
    const cmd = this.locustCmd;

    // Run from the file's directory and pass a relative -f (helps with cloud path handling)
    const fileDir = path.dirname(locustfile);
    const relFile = path.basename(locustfile);

    out.appendLine(`[cloud] launching: ${cmd} -f "${relFile}" --cloud`);

    const child = spawn(cmd, ["-f", relFile, "--cloud"], {
      cwd: fileDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
        vscode.window.setStatusBarMessage("Locust Cloud: web UI opened in split view.", 60000);
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
        `Failed to run "${cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });
    child.on("close", (code) => out.appendLine(`[cloud] exited with code ${code}`));

    // Safety net: open fallback if we didn't see a URL soon.
    setTimeout(() => {
      if (!opened) {
        opened = true;
        const fallback = this.cloudFallbackUrl;
        out.appendLine(`[cloud] no UI URL detected — opening fallback: ${fallback}`);
        this.openInSimpleBrowserSplit(fallback, 0.45).catch(() => {});
      }
    }, 60000);
  }

  /** Run `locust --cloud --delete` using the same environment. */
  async deleteLocustCloud(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      return;
    }

    const cwd = ws.uri.fsPath;
    const env = this.buildEnv();
    const cmd = this.locustCmd;

    const out = vscode.window.createOutputChannel("Locust Cloud");
    out.show(true);
    out.appendLine(`[cloud] deleting: ${cmd} --cloud --delete (cwd=${cwd})`);

    const child = spawn(cmd, ["--cloud", "--delete"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (b) => out.append(b.toString()));
    child.stderr.on("data", (b) => out.append(`[stderr] ${b.toString()}`));
    child.on("error", (e: any) => {
      out.appendLine(`[error] ${e?.message ?? e}`);
      vscode.window.showErrorMessage(
        `Failed to run "${cmd}". Ensure Locust is installed (in your venv or PATH) or set "locust.path" in settings.`
      );
    });
    child.on("close", (code) => out.appendLine(`[cloud] delete exited with code ${code}`));
  }
}
