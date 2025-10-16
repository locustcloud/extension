import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { Har2LocustService } from './services/har2locustService';
import { Har2LocustRunner } from './runners/har2locustRunner';
import { LocustTreeProvider } from './tree/locustTree';
// import { CopilotService } from './services/copilotService';
import * as fs from 'fs/promises';
import * as path from 'path';

// Minimal cloud toggle state (persisted; does NOT touch code-server logic)
const CLOUD_FLAG_KEY = 'locust.cloudWasStarted';
function getCloudStarted(ctx: vscode.ExtensionContext): boolean {
  return !!ctx.globalState.get<boolean>(CLOUD_FLAG_KEY, false);
}
async function setCloudStarted(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.globalState.update(CLOUD_FLAG_KEY, v);
}

// Persistent Welcome panel: quick actions.
class LocustWelcomeViewProvider implements vscode.WebviewViewProvider {
  constructor(private ctx: vscode.ExtensionContext, private readonly isCloud: boolean) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };

    const nonce = String(Math.random()).slice(2);

    // Desktop controls
    const desktopControls = `
      <div class="row actions">
        <button id="btnRunLocal"    title="locust -f locustfile.py">Run Test</button>
        <button id="btnLocustCloud" title="locust -f locustfile.py --cloud">Run Cloud</button>
      </div>
      <div class="row">
        <button id="btnShutdownLocal" class="danger" title="Stop last local run">Stop Test</button>
      </div>`;

    // Cloud controls
    const cloudControls = `
      <div class="row">
        <button id="btnRunUI"       title="locust -f locustfile.py --cloud">Run Test</button>
        <button id="btnDeleteCloud" class="danger" title="Shut down current Test">Stop Test</button>
      </div>`;

    const supportBlock = this.isCloud ? '' : `<a href="mailto:support@locust.cloud">support@locust.cloud</a><br>`;

    webview.html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} https:;
                 script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Locust Menu</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; }
    h1 { margin: 0 0 8px; font-size: 16px; }
    p { margin: 6px 0 12px; color: var(--vscode-descriptionForeground); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
    .row.stack { flex-direction: column; gap: 10px; }
    .row.actions { gap: 8px; }
    button {
      padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px; background: var(--vscode-button-background);
      color: var(--vscode-button-foreground); cursor: pointer;
    }
    button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-editor-foreground); }
    label { cursor: pointer; user-select: none; }
  </style>
</head>
<body data-cloud="${this.isCloud ? '1' : '0'}" data-cloud-started="${getCloudStarted(this.ctx) ? '1' : '0'}">
  <h1>Locust ${this.isCloud ? 'Cloud' : 'Local'}</h1>
  <p>${this.isCloud ? 'Manage runs in Locust Cloud.' : 'Run Locust locally or open Locust Cloud.'}</p>

  ${this.isCloud ? cloudControls : desktopControls}
  <br>

  <h2>Get Help</h2>
  <p>
    <a href="#" id="linkGuide">Beginner Guide</a><br>
    <a href="https://docs.locust.io/en/stable/" target="_blank">Locust Docs</a><br>
    ${supportBlock}
  </p>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const run = (cmd) => vscode.postMessage({ type: 'run', command: cmd });
      const isCloud = document.body.getAttribute('data-cloud') === '1';

      if (isCloud) {
        document.getElementById('btnRunUI')?.addEventListener('click', () => run('locust.openLocustCloud'));
        document.getElementById('btnDeleteCloud')?.addEventListener('click', () => run('locust.stopLocustCloud'));
      } else {
        const btnCloud = document.getElementById('btnLocustCloud');
        const btnStop  = document.getElementById('btnShutdownLocal');

        // --- Dynamic label setup (reads persisted flag injected into HTML) ---
        const startedFlag = document.body.getAttribute('data-cloud-started') === '1';
        const setCloudBtnLabel = (running) => {
          if (!btnCloud) return;
          btnCloud.textContent = running ? 'Stop Cloud' : 'Run Cloud';
        };
        setCloudBtnLabel(startedFlag);

        // Start/Stop Cloud toggle (keeps existing command logic)
        btnCloud?.addEventListener('click', async () => {
          run('locust.toggleCloudSimple');
          // optimistically flip the label; logic remains in commands
          setCloudBtnLabel(btnCloud.textContent?.trim() !== 'Stop Cloud');
        });

        // Stop Test also clears cloud label (since it stops both)
        btnStop?.addEventListener('click', () => {
          run('locust.stopLocalThenCloudIfAny');
          setCloudBtnLabel(false);
        });

        // Local run button unchanged
        document.getElementById('btnRunLocal')?.addEventListener('click', () => run('locust.runFileUI'));
      }

      document.getElementById('linkGuide')?.addEventListener('click', (e) => {
        e.preventDefault();
        run('locust.startBeginnerTour');
      });
    })();
  </script>
</body>
</html>
`;

    webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.type === 'run' && typeof msg.command === 'string') {
          if (msg.command === 'locust.hideWelcome') {
            await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
            await vscode.commands.executeCommand('locust.scenarios.focus');
            return;
          }
          await vscode.commands.executeCommand(msg.command);
          return;
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to execute action.');
      }
    });
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Detect environment and set context keys
  const isCloud = detectCloudEnv();
  await vscode.commands.executeCommand('setContext', 'locust.isCloud', isCloud);
  await vscode.commands.executeCommand('setContext', 'locust.isDesktop', !isCloud);

  // Core services
  const env = new EnvService();
  const mcp = new McpService(env);
  const setup = new SetupService(env, mcp, ctx);

  // Runners / Services
  const locustRunner = new LocustRunner(); // headless interface removed; runner still supports UI
  const harService = new Har2LocustService(env);
  const harRunner = new Har2LocustRunner(env, harService);

  // Tree provider
  const tree = new LocustTreeProvider();
  const treeReg = vscode.window.registerTreeDataProvider('locust.scenarios', tree);
  ctx.subscriptions.push(treeReg, tree);

  // Gating context key
  await vscode.commands.executeCommand('setContext', 'locust.showScenarios', false);

  // Welcome view
  const welcomeReg = vscode.window.registerWebviewViewProvider(
    'locust.welcome',
    new LocustWelcomeViewProvider(ctx, isCloud)
  );
  ctx.subscriptions.push(welcomeReg);

  // Focus Welcome view on startup
  await vscode.commands.executeCommand('locust.welcome.focus');

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.showScenariosView', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.showScenarios', true);
      await vscode.commands.executeCommand('locust.scenarios.focus');
    })
  );

  // Centralized command registration (includes locust.openUrlInSplit)
  registerCommands(ctx, { setup, runner: locustRunner, harRunner, tree });

  // Minimal helper commands for the cloud toggle behavior
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.toggleCloudSimple', async () => {
      try {
        const started = getCloudStarted(ctx);
        if (!started) {
          await vscode.commands.executeCommand('locust.openLocustCloud');
          await setCloudStarted(ctx, true);
          vscode.window.setStatusBarMessage('Locust Cloud: starting…', 3000);
        } else {
          await vscode.commands.executeCommand('locust.deleteLocustCloud').then(undefined, () => {});
          await setCloudStarted(ctx, false);
          vscode.window.setStatusBarMessage('Locust Cloud: stopped.', 3000);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle Locust Cloud.');
      }
    }),

    vscode.commands.registerCommand('locust.stopLocalThenCloudIfAny', async () => {
      try {
        await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
        if (getCloudStarted(ctx)) {
          await vscode.commands.executeCommand('locust.deleteLocustCloud').then(undefined, () => {});
          await setCloudStarted(ctx, false);
        }
        vscode.window.setStatusBarMessage('Locust: stopped local (and cloud if active).', 3000);
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to stop runs.');
      }
    }),
  );

  // Auto-setup
  setup.autoSetupSilently();

  // Scaffold if needed
  await ensureLocustfileOrScaffold();

  // Re-run setup on dir changes
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setup.autoSetupSilently())
  );
}

export function deactivate() { /* noop */ }

function detectCloudEnv(): boolean {
  const byEnv = (process.env.CODE_SERVER ?? '').toLowerCase();
  const envFlag = byEnv === 'true' || byEnv === '1' || byEnv === 'yes';
  const uiIsWeb = vscode.env.uiKind === vscode.UIKind.Web;
  return envFlag || uiIsWeb;
}

async function ensureLocustfileOrScaffold() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return;

  const root = folders[0].uri.fsPath;

  try { await fs.access(path.join(root, 'locustfile.py')); return; } catch {}

  const matches = await vscode.workspace.findFiles('**/locustfile_*.py', '**/node_modules/**', 1);
  if (matches.length > 0) return;

  void vscode.commands.executeCommand('locust.createSimulation');
}
