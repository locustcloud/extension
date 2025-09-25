import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { Har2LocustService } from './services/har2locustService';
import { Har2LocustRunner } from './runners/har2locustRunner';
import { LocustTreeProvider } from './tree/locustTree';
import { CopilotService } from './services/copilotService';

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
<title>Locust - Action Menu</title>
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
  <h1>Action Menu</h1>
  <p>Quick Action Buttons for common Locust operations.</p>

  <div class="row">
    <button id="btnCreate">Create Simulation</button>
    <button id="btnConvert">Convert HAR → Locustfile</button>
    <button id="btnRunUI">Run Test (Web UI)</button>
    <button id="btnRunHeadless">Run Test (Headless)</button>
    <button id="btnLocustCloud" class="primary" title="Open Locust Cloud (login-aware)">Locust Cloud</button>
    <button id="btnCopilot">Copilot Walkthrough</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const run = cmd => vscode.postMessage({ type: 'run', command: cmd });

  document.getElementById('btnCopilot').onclick      = () => run('locust.openCopilotWalkthrough');
  document.getElementById('btnRunUI').onclick        = () => run('locust.runUI');
  document.getElementById('btnRunHeadless').onclick  = () => run('locust.runHeadless');
  document.getElementById('btnCreate').onclick       = () => run('locust.createSimulation');
  document.getElementById('btnConvert').onclick      = () => run('locust.convertHar');
  document.getElementById('btnLocustCloud').onclick  = () => run('locust.openLocustCloud');
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

  // Copilot light-up (non-blocking)
  const copilot = new CopilotService(ctx);
  ctx.subscriptions.push(copilot); // dispose listeners on deactivate
  await copilot.bootstrap();

  // Runners / Services
  const locustRunner = new LocustRunner(env, ctx.extensionUri);
  const harService = new Har2LocustService(env);
  const harRunner = new Har2LocustRunner(env, harService);

  // Tree
  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  ctx.subscriptions.push(treeView, tree);

  // Welcome view provider
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('locust.welcome', new LocustWelcomeViewProvider(ctx))
  );

  // Centralized command registration (includes Locust Cloud command)
  registerCommands(ctx, { setup, runner: locustRunner, harRunner, tree });

  // Run setup automatically on activation (env, ruff, MCP, tour, etc.)
  setup.autoSetupSilently();

  // Re-run setup on folder changes
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setup.autoSetupSilently())
  );
}

export function deactivate() {
  // noop
}
