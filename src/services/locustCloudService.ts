import * as vscode from "vscode";

const RUNNING_COMMAND_FLAG_KEY = 'locust.commandWasStarted';

const findLocustTerminal = (): vscode.Terminal | undefined =>
  vscode.window.terminals.find((t) => t.name === "Locust");

function createTerminal(): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({ name: "Locust" })

  return new Promise<vscode.Terminal>((resolve) => {
      const disposable = vscode.window.onDidChangeTerminalShellIntegration(() => {
      resolve(terminal)
      disposable.dispose()
    });
  });
}

const getOrCreateLocustTerminal = async () =>
  findLocustTerminal() || await createTerminal();

/**
 * Locust run functions.
 * - UI: spawn locust, parse the UI URL from stdout, open Simple Browser split
 * - Headless: run in a dedicated "Locust" terminal
 */
type RunMode = 'ui' | 'headless';

export class LocustCloudService {
  private async closeSimpleBrowser(): Promise<void> {
    try {
      const groups = vscode.window.tabGroups.all;

      for (const g of groups) {
        for (const t of g.tabs) {
          const label = (t.label || '').toString();
          if (!label) continue;

          if (label == 'Simple Browser') {
            await vscode.window.tabGroups.close(t, true);
            return
          }
        }
      }
    } catch {
      // best-effort; ignore
    }
  }

  private async setCommandStarted(isCommandStarted: boolean) {
    await this.ctx.globalState.update(RUNNING_COMMAND_FLAG_KEY, isCommandStarted);
    await vscode.commands.executeCommand("locust.welcome.refresh");
  }

  constructor(private readonly ctx: vscode.ExtensionContext) {
    vscode.window.onDidChangeTerminalState(async (terminal) => {
      const currentShell = (terminal.state as unknown as {shell: string}).shell
      await this.setCommandStarted(currentShell === 'python');

      if (currentShell !== 'python') {
        this.closeSimpleBrowser()
      }
    });

    vscode.window.onDidEndTerminalShellExecution(event => {
      const { terminal, execution, exitCode } = event;

      if (terminal.name === "Locust" && execution.commandLine.value.includes("locust") && exitCode !== 0) {
        vscode.window.showErrorMessage("Failed to start locust command. Check the terminal for more details");
      }
    });
  }

  async pickLocustfile(): Promise<string | undefined> {
    try {
      const uri = await vscode.commands.executeCommand('locust.pickLocustfile') as vscode.Uri | undefined;
      return uri?.fsPath;
    } catch {
      return undefined
    }
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private get isWeb(): boolean {
    return vscode.env.uiKind === vscode.UIKind.Web;
  }

  private async openUrlSplit(url: string, ratio = 0.45) {
    const tryCmd = async (id: string) =>
      vscode.commands.executeCommand(id, url, ratio).then(() => true, () => false);
    const ok = (await tryCmd("locust.openUrlInSplit")) || (await tryCmd("locust.openUrlSplit"));

    if (!ok) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  public async runLocustUI(): Promise<boolean> {
    const ws = this.getWorkspaceRoot();
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      await this.setCommandStarted(false);
      return false;
    }

    const locustfile = await this.pickLocustfile();
    if (!locustfile) {
      // cancelled
      await this.setCommandStarted(false);
      await vscode.commands.executeCommand('locust.refreshTree');
      return false;
    }

    const terminal = await getOrCreateLocustTerminal();
    terminal.show();
    const exec = terminal.shellIntegration?.executeCommand(`locust -f ${locustfile}`);

    (async () => {
      for await (const chunk of (exec as any).read()) {
        const urlMatch = chunk.match(/Starting web interface at ([^,]+)/)

        if (urlMatch) {
           await this.openUrlSplit(urlMatch[1], 0.45)
        }
      }
    })();

    return true;
  }
  
  private async runLocustHeadless(locustfileAbs?: string, extraArgs: string[] = []): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      await this.setCommandStarted(false);
      return false;
    }

    let locustfile = locustfileAbs
    // TODO: Investigate always getting the locustfile here
    if (!locustfile) {
      const ws = this.getWorkspaceRoot();
      if (!ws) {
        vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
        await this.setCommandStarted(false);
        return false;
      }

      locustfile = await this.pickLocustfile();
      if (!locustfile) {
        // cancelled
        await this.setCommandStarted(false);
        await vscode.commands.executeCommand('locust.refreshTree');
        return false;
      }
    }


    const terminal = await getOrCreateLocustTerminal();
    terminal.show();
    terminal.sendText(`locust -f ${locustfile} --headless` + extraArgs.join(' ')); 

    return true
  }

  async runFile(mode: RunMode): Promise<boolean> {
    if (mode === 'ui') {
      return await this.runLocustUI();
    }

    return await this.runLocustHeadless();
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
    // Prefer using UI for the whole file
    await this.runTask(node, 'headless');
  }

  // Palette helpers.
  async runSelected(mode: RunMode) {
    return this.runFile(mode);
  }

  async runByTag() {
    const file = await vscode.commands.executeCommand('locust.pickLocustfile') as vscode.Uri | undefined;
    if (!file) return;

    const tag = await vscode.window.showInputBox({
      prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
      placeHolder: 'e.g. checkout,auth'
    });
    if (!tag) return;

    await this.runLocustHeadless(file.fsPath, [`--tags "${tag}"`]);
  }

  /**
   * Start a Locust Cloud run.
   * Returns true if run started, false if cancelled or invalid.
   */
  async openLocustCloudLanding(): Promise<boolean> {
    const ws = this.getWorkspaceRoot();
    if (!ws) {
      vscode.window.showErrorMessage("Locust Cloud: open a workspace folder first.");
      await this.setCommandStarted(false);
      return false;
    }

    const locustfile = await this.pickLocustfile();
    if (!locustfile) {
      // cancelled
      await this.setCommandStarted(false);
      await vscode.commands.executeCommand('locust.refreshTree');
      return false;
    }

    const terminal = await getOrCreateLocustTerminal();
    terminal.show();

    const exec = terminal.shellIntegration?.executeCommand(`locust -f ${locustfile} --cloud`);

    (async () => {
      for await (const chunk of (exec as any).read()) {
        const urlMatch = chunk.match(/Starting web interface at ([^,]+)/)

        if (urlMatch) {
          if (this.isWeb) {
            await this.openUrlSplit('https://auth.locust.cloud/load-test?dashboard=false', 0.45)
          } else {
            await vscode.env.openExternal(vscode.Uri.parse(urlMatch[1]));
          }
        }
      }
    })();
    
    return true;
  }

  async deleteLocustCloud(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.terminal.sendSequence',
      { text: '\x03' }
    );
    await this.closeSimpleBrowser()
  }
}
