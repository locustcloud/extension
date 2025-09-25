import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

type LoginStatus = { loggedIn: boolean; username?: string; raw?: string };

export class LocustCloudService {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private get locustPath(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("path", "locust");
  }

  private get cloudRootUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("cloud.rootUrl", "https://www.locust.cloud/");
  }

  private get cloudLoginUrl(): string {
    const cfg = vscode.workspace.getConfiguration("locust");
    return cfg.get<string>("cloud.loginUrl", "https://auth.www.locust.cloud/login");
  }

  private async openInSimpleBrowser(url: string) {
    // Prefer VS Code Simple Browser (keeps onboarding inside VS Code)
    const ok = await vscode.commands.executeCommand(
      "simpleBrowser.show",
      url,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: true }
    ).then(() => true, () => false);

    if (!ok) {
      // Fallback to external browser if Simple Browser isn’t available
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async getLoginStatus(): Promise<LoginStatus> {
    try {
      // Non-interactive; exits non-zero if not logged in.
      const { stdout, stderr } = await execFileAsync(this.locustPath, ["--cloud", "whoami"], { timeout: 5000 });
      const raw = (stdout || "") + (stderr || "");
      const line = raw.trim().split(/\r?\n/).find(Boolean) || "";
      const m = line.match(/([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/);
      if (m) return { loggedIn: true, username: m[1], raw };
      if (/logged in/i.test(raw)) return { loggedIn: true, raw };
      // Some builds may print nothing but still exit 0 – treat as logged in.
      return { loggedIn: true, raw };
    } catch {
      return { loggedIn: false };
    }
  }

  async openLocustCloudLanding(): Promise<void> {
    const status = await this.getLoginStatus();
    if (status.loggedIn) {
      await this.openInSimpleBrowser(this.cloudRootUrl);
      if (status.username) {
        vscode.window.setStatusBarMessage(`Locust Cloud: signed in as ${status.username}`, 3000);
      }
    } else {
      await this.openInSimpleBrowser(this.cloudLoginUrl);
      vscode.window.setStatusBarMessage("Locust Cloud: please sign in.", 3000);
    }
  }
}
