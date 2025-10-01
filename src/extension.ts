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
import * as fs from 'fs/promises';
import * as path from 'path'; // ✅ fix

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
<title>Locust Menu</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; }
  h1 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 6px 0 12px; color: var(--vscode-descriptionForeground); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
  button { padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px; background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); cursor: pointer; }
  .danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-editor-foreground); }
</style>
</head>
<body>
  <h1>Locust Cloud</h1>
  <p>Load generator management.</p>

  <div class="row">
    <button id="btnLocustCloud" title="Run: locust --cloud">Launch</button>
    <button id="btnDeleteCloud" class="danger" title="Run: locust --cloud --delete">Shut Down</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const run = (cmd) => vscode.postMessage({ type: 'run', command: cmd });
  document.getElementById('btnLocustCloud')?.addEventListener('click', () => run('locust.openLocustCloud'));
  document.getElementById('btnDeleteCloud')?.addEventListener('click', () => run('locust.deleteLocustCloud'));
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

  // Tree — register provider lazily; keep the disposable
  const tree = new LocustTreeProvider();
  const treeReg = vscode.window.registerTreeDataProvider('locust.scenarios', tree); // ✅ keep disposable
  ctx.subscriptions.push(treeReg, tree);

  // Optional gating via context key (matches your package.json "when" if used)
  await vscode.commands.executeCommand('setContext', 'locust.showScenarios', false);

  // Welcome view provider
  const welcomeReg = vscode.window.registerWebviewViewProvider('locust.welcome', new LocustWelcomeViewProvider(ctx));
  ctx.subscriptions.push(welcomeReg);

  // Focus the Welcome view on startup
  await vscode.commands.executeCommand('locust.welcome.focus');

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.showScenariosView', async () => { // ✅ push disposable
      await vscode.commands.executeCommand('setContext', 'locust.showScenarios', true);
      await vscode.commands.executeCommand('locust.scenarios.focus');
    })
  );

  // Centralized command registration (includes Locust Cloud commands)
  registerCommands(ctx, { setup, runner: locustRunner, harRunner, tree });

  // Run setup automatically on activation (env, ruff, MCP, tour, etc.)
  setup.autoSetupSilently();

  // Scaffold if needed
  await ensureLocustfileOrScaffold();

  // Re-run setup on folder changes
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setup.autoSetupSilently())
  );
}

export function deactivate() {
  // noop
}

async function ensureLocustfileOrScaffold() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return; // no folder open

  const root = folders[0].uri.fsPath;

  // First, check a plain 'locustfile.py' at root quickly.
  try {
    await fs.access(path.join(root, 'locustfile.py'));
    return; // exists → done
  } catch {}

  // Then, use VS Code glob for variants like 'locustfile_*.py'
  const matches = await vscode.workspace.findFiles('**/locustfile_*.py', '**/node_modules/**', 1);
  if (matches.length > 0) return;

  // None found → scaffold
  void vscode.commands.executeCommand('locust.createSimulation');
}
