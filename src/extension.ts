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

// Cloud toggle
const CLOUD_FLAG_KEY = 'locust.cloudWasStarted';
function getCloudStarted(ctx: vscode.ExtensionContext): boolean {
  return !!ctx.globalState.get<boolean>(CLOUD_FLAG_KEY, false);
}
async function setCloudStarted(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.globalState.update(CLOUD_FLAG_KEY, v);
}

// Local toggle 
function getLocalStarted(ctx: vscode.ExtensionContext): boolean {
  return !!ctx.workspaceState.get<boolean>('locust.localStarted', false);
}
async function setLocalStarted(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.workspaceState.update('locust.localStarted', v);
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
        <button id="btnRunLocal" title="locust -f locustfile.py">Run Test</button>
        <button id="btnLocustCloud" title="locust -f locustfile.py --cloud">Run Cloud</button>
        <button id="btnConvertHar" title="Convert a HAR file to a Locust test">HAR to Locust</button>
      </div>`;

    // Cloud controls
    const cloudControls = `
      <div class="row">
        <button id="btnRunUI" title="locust -f locustfile.py --cloud">Run Test</button>
        <button id="btnDeleteCloud" class="danger" title="Shut down current Test">Stop Test</button>
      </div>`;

    const supportBlock = this.isCloud ? '' : `<a href="mailto:support@locust.cloud">support@locust.cloud</a><br>`;

    const cloudStartedFlag = getCloudStarted(this.ctx) ? '1' : '0';
    const localStartedFlag = !this.isCloud && getLocalStarted(this.ctx) ? '1' : '0';

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
    /* Locust theme */
    :root{
      --bg:            #111315;   /* page */
      --panel:         #1a1d1f;   /* card/panel */
      --panel-border:  #2a2f34;
      --text:          #e6e6e6;   /* main text */
      --muted:         #9aa0a6;   /* secondary text */
      --accent:        #28a745;   /* Locust green */
      --accent-hover:  #23913d;
    }

    body{
      font-family: var(--vscode-font-family);
      background: var(--bg);
      color: var(--text);
      padding: 0;           
    }

    /* View like Locust "card" */
    body{
      margin: 0;
      padding: 14px 16px;
      background:
        linear-gradient(0deg, rgba(0,0,0,.0), rgba(0,0,0,.0)),
        var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,.35);
    }

    h1{
      margin: 0 0 8px;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: .2px;
    }
    h2{
      margin: 16px 0 6px;
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
    }

    p{
      margin: 6px 0 12px;
      color: var(--muted);
    }

    .row{ display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 12px; }
    .row.stack{ flex-direction:column; gap:10px; }
    .row.actions{ gap:8px; }

    /* Buttons Locust green */
    button{
      padding: 8px 14px;
      border: 1px solid #1f7a36;
      border-radius: 6px;
      background: var(--accent);
      color: #ffffff;
      cursor: pointer;
      font-weight: 600;
      letter-spacing: .1px;
      transition: background 120ms ease, box-shadow 120ms ease, transform 60ms ease;
    }
    button:hover,
    button:focus-visible{
      background: var(--accent-hover);
      outline: none;
      box-shadow: 0 0 0 2px rgba(40,167,69,.25);
    }
    button:active{ transform: translateY(1px); }

    /* Danger button (for cloud stop) uses VS Code error palette */
    button.danger{
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-editor-foreground);
      border-color: transparent;
      font-weight: 600;
    }
    button.danger:hover,
    button.danger:focus-visible{
      filter: brightness(1.05);
      box-shadow: none;
    }

    label{ cursor: pointer; user-select: none; color: var(--text); }

    /* HAR to Locust below run buttons */
    .row.actions::before{
      content:'';
      flex-basis:100%;
      order:1;
    }
    #btnConvertHar{
      order:2;
      flex: 0 0 auto;
      width: max-content;
      align-self: flex-start;
      margin-top: 4px;
    }

    /* Links Locust green */
    a{
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    a:hover,
    a:focus-visible{
      color: var(--accent-hover);
      text-decoration: underline;
      outline: none;
    }
  </style>
</head>
<body
  data-cloud="${this.isCloud ? '1' : '0'}"
  data-cloud-started="${cloudStartedFlag}"
  data-local-started="${localStartedFlag}">
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
        // Cloud buttons: Run / Stop separate
        document.getElementById('btnRunUI')?.addEventListener('click', () => run('locust.openLocustCloud'));
        document.getElementById('btnDeleteCloud')?.addEventListener('click', () => run('locust.stopLocustCloud'));
      } else {
        // Desktop: Cloud and Local toggles
        const btnCloud = document.getElementById('btnLocustCloud');
        const btnLocal = document.getElementById('btnRunLocal');
        document.getElementById('btnConvertHar')?.addEventListener('click', () => run('locust.convertHar'));

        // Cloud toggle
        const cloudStarted = document.body.getAttribute('data-cloud-started') === '1';
        const setCloudBtnLabel = (running) => { if (btnCloud) btnCloud.textContent = running ? 'Stop Cloud' : 'Run Cloud'; };
        setCloudBtnLabel(cloudStarted);

        btnCloud?.addEventListener('click', () => {
          run('locust.toggleCloudSimple');
          const willRun = (btnCloud.textContent?.trim() !== 'Stop Cloud');
          setCloudBtnLabel(willRun);
        });

        // Local toggle
        const localStarted = document.body.getAttribute('data-local-started') === '1';
        const setLocalBtnLabel = (running) => { if (btnLocal) btnLocal.textContent = running ? 'Stop Test' : 'Run Test'; };
        setLocalBtnLabel(localStarted);

        btnLocal?.addEventListener('click', () => {
          run('locust.toggleLocalSimple');
          const willRun = (btnLocal.textContent?.trim() !== 'Stop Test');
          setLocalBtnLabel(willRun);
        });
      }

      // Beginner guide
      document.getElementById('linkGuide')?.addEventListener('click', (e) => {
        e.preventDefault();
        run('locust.startBeginnerTour');
      });

      // Extension state sync
      window.addEventListener('message', (ev) => {
        const msg = ev.data || {};
        if (msg.type === 'state') {
          const btnCloud = document.getElementById('btnLocustCloud');
          const btnLocal = document.getElementById('btnRunLocal');
          if (typeof msg.cloudStarted === 'boolean' && btnCloud) {
            btnCloud.textContent = msg.cloudStarted ? 'Stop Cloud' : 'Run Cloud';
          }
          if (typeof msg.localStarted === 'boolean' && btnLocal) {
            btnLocal.textContent = msg.localStarted ? 'Stop Test' : 'Run Test';
          }
        }
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
  const locustRunner = new LocustRunner(); // headless interface removed
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

  // Centralized command registration
  registerCommands(ctx, { setup, runner: locustRunner, harRunner, tree });

  // Cloud toggle behavior
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

    // Local toggle behavior
    vscode.commands.registerCommand('locust.toggleLocalSimple', async () => {
      try {
        const started = getLocalStarted(ctx);
        if (!started) {
          await vscode.commands.executeCommand('locust.runFileUI');
          await setLocalStarted(ctx, true);
          vscode.window.setStatusBarMessage('Locust: local test starting…', 3000);
        } else {
          await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
          await setLocalStarted(ctx, false);
          vscode.window.setStatusBarMessage('Locust: local test stopped.', 3000);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle local run.');
      }
    }),

    vscode.commands.registerCommand('locust.stopLocalThenCloudIfAny', async () => {
      try {
        await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
        await setLocalStarted(ctx, false);
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

  if (!isCloud) {
    await setup.checkAndOfferSetup(); //  Prompt/always/never + trust
    // Re-run after trust is granted (desktop)
    ctx.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        setup.checkAndOfferSetup().catch(() => {});
      })
    );

    // Re-run setup on workspace changes (DESKTOP ONLY)
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => setup.checkAndOfferSetup())
    );
  }

  // Scaffold if needed
  await ensureLocustfileOrScaffold();
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
