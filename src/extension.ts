import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { Har2LocustService } from './services/har2locustService';
import { Har2LocustRunner } from './runners/har2locustRunner';
import { LocustTreeProvider } from './tree/locustTree';

/** Small webview view that shows a persistent Welcome panel with quick actions. */
class LocustWelcomeViewProvider implements vscode.WebviewViewProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };

    const nonce = String(Math.random()).slice(2);

    webview.html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Locust — Welcome</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; }
  h1 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 6px 0 12px; color: var(--vscode-descriptionForeground); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
  button { padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px; background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .muted { opacity: .8; }
</style>
</head>
<body>
  <h1>Welcome to Locust</h1>
  <p>Quick start: create or convert a locustfile, then run headless or with the Web UI.</p>

  <div class="row">
    <button class="primary" id="btnGetting">Getting Started</button>
    <button id="btnCopilot">Copilot Walkthrough</button>
    <button id="btnCreate">Create Simulation</button>
    <button id="btnConvert">Convert HAR → Locustfile</button>
  </div>

  <p class="muted">You can hide this panel anytime.</p>
  <div class="row">
    <button id="btnHide">Don’t show again</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const run = cmd => vscode.postMessage({ type: 'run', command: cmd });
  document.getElementById('btnGetting').onclick = () => run('locust.openWalkthrough');
  document.getElementById('btnCopilot').onclick = () => run('locust.openCopilotWalkthrough');
  document.getElementById('btnCreate').onclick = () => run('locust.createSimulation');
  document.getElementById('btnConvert').onclick = () => run('locust.convertHar');
  document.getElementById('btnHide').onclick = () => run('locust.hideWelcome');
</script>
</body>
</html>
    `;

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'run' && typeof msg.command === 'string') {
        if (msg.command === 'locust.hideWelcome') {
          await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
          await vscode.commands.executeCommand('locust.scenarios.focus');
          return;
        }
        await vscode.commands.executeCommand(msg.command);
      }
    });
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Core services
  const env = new EnvService();
  const mcp = new McpService(env);
  const setup = new SetupService(env, mcp, ctx);

  // Runners / Services
  const locustRunner = new LocustRunner(env, ctx.extensionUri);
  const harService = new Har2LocustService(env);
  const harRunner = new Har2LocustRunner(env, harService);

  // Tree
  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  ctx.subscriptions.push(treeView, tree);

  // Welcome view provider + show/hide controls + copilot walkthrough opener
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('locust.welcome', new LocustWelcomeViewProvider(ctx))
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.showWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', false);
      await vscode.commands.executeCommand('locust.welcome.focus');
    }),
    vscode.commands.registerCommand('locust.hideWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
      await vscode.commands.executeCommand('locust.scenarios.focus');
    }),
    vscode.commands.registerCommand('locust.openCopilotWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.copilotWalkthrough'
      )
    )
  );

  // Commands
  registerCommands(ctx, {
    setup,
    runner: locustRunner,
    harRunner,
    tree,
  });

  setup.autoSetupSilently();

  // If the user opens/closes folders in a multi-root workspace, try setup again.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setup.autoSetupSilently())
  );
}

export function deactivate() {
  // noop
}
