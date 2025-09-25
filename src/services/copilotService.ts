import * as vscode from "vscode";

const COPILOT_ID = "GitHub.copilot";
const OFFERED_KEY = "locust.copilot.offeredOnce";

export class CopilotService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext) {}

  hasCopilot(): boolean {
    try { return !!vscode.extensions.getExtension(COPILOT_ID); }
    catch { return false; }
  }

  async setContext(has: boolean) {
    await vscode.commands.executeCommand("setContext", "locust.hasCopilot", has);
  }

  async installCopilot(): Promise<void> {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", COPILOT_ID);
  }

  /** Non-blocking bootstrap: set context now, optionally offer install once, and watch for changes. */
  async bootstrap(): Promise<void> {
    await this.setContext(this.hasCopilot());

    // Command is safe to register even if hidden by 'when'
    this.disposables.push(
      vscode.commands.registerCommand("locust.installCopilot", () => this.installCopilot())
    );

    // One-time, silent offer (no modal), but only in trusted workspaces
    const autoOffer = vscode.workspace.getConfiguration("locust").get<boolean>("copilot.autoOfferInstallOnce", true);
    const alreadyOffered = this.ctx.workspaceState.get<boolean>(OFFERED_KEY, false);

    if (autoOffer && !alreadyOffered && !this.hasCopilot() && vscode.workspace.isTrusted) {
      vscode.window.showInformationMessage(
        "Locust: GitHub Copilot not detected. Install to get AI code suggestions?",
        "Install Copilot",
        "Dismiss"
      ).then(async choice => {
        await this.ctx.workspaceState.update(OFFERED_KEY, true);
        if (choice === "Install Copilot") {
          await this.installCopilot();
        }
      });
    }

    // If Copilot gets installed later, flip the UI automatically
    this.disposables.push(
      vscode.extensions.onDidChange(async () => {
        await this.setContext(this.hasCopilot());
      })
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
