import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { Har2LocustService } from './services/har2locustService';
import { Har2LocustRunner } from './runners/har2locustRunner';
import { LocustTreeProvider } from './tree/locustTree';
// import { CopilotService } from './services/copilotService'; Commented out for future implementation
import * as fs from 'fs/promises';
import * as path from 'path'; 

// Persistent Welcome panel with quick actions.
class LocustWelcomeViewProvider implements vscode.WebviewViewProvider {
  constructor(private ctx: vscode.ExtensionContext, private readonly isCloud: boolean) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };

    const nonce = String(Math.random()).slice(2);

    // Desktop controls: Headless checkbox, Run decides UI/headless, Shut Down = stopLastRun
    const desktopControls = `
      <div class="row stack">
        <label style="display:flex; align-items:center; gap:6px;" title="Toggle headless mode for local runs">
          <input type="checkbox" id="chkHeadless" />
          Headless
        </label>

        <div class="row actions">
          <button id="btnRunLocal" title="Run locally: locust -f locustfile.py [--headless]">Run Test</button>
          <button id="btnLocustCloud" title="Open Locust Cloud login">Launch Cloud</button>
        </div>

        <div class="row">
          <button id="btnShutdownLocal" class="danger" title="Stop last local run">Shut Down</button>
        </div>
      </div>`;

    // Cloud controls: no headless, Run Test = locust -f locustfile.py --cloud, Shut Down = deleteLocustCloud
    const cloudControls = `
      <div class="row">
        <button id="btnRunUI"  title="Run in Locust Cloud: locust -f locustfile.py --cloud">Run UI</button>
        <button id="btnDeleteCloud" class="danger" title="Shut down current Test">Shut Down</button>
      </div>`;


    // Desktop Support block: email  
    const supportBlock = this.isCloud
      ? ''
      : `
        <a href="mailto:support@locust.cloud">support@locust.cloud</a><br>
      `;

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
  .row.stack { flex-direction: column; gap: 10px; }
  .row.actions { gap: 8px; }

  button {
    padding: 6px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
  }

  button.danger {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-editor-foreground);
  }

  label { cursor: pointer; user-select: none; }
</style>

</head>
<body data-cloud="${this.isCloud ? '1' : '0'}">
  <h1>Locust ${this.isCloud ? 'Server' : 'Cloud'}</h1>
  <p>${this.isCloud ? 'Run Locust in this server workspace.' : 'Load generator management.'}</p>

  ${this.isCloud ? cloudControls : desktopControls}
  <br>

  <h2>Get Help</h2>
  <p>
    <a href="#" id="linkGuide">Beginner Guide</a><br>
    <a href="https://docs.locust.io/en/stable/" target="_blank">Locust Docs</a><br>
    ${supportBlock}
  </p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const run = (cmd) => vscode.postMessage({ type: 'run', command: cmd });
  const isCloud = document.body.getAttribute('data-cloud') === '1';

  if (isCloud) {
    // Cloud: no headless toggle; shutdown deletes cloud deployment
    document.getElementById('btnRunUI')?.addEventListener('click', () => run('locust.openLocustCloud'));
    document.getElementById('btnDeleteCloud')?.addEventListener('click', () => run('locust.deleteLocustCloud'));
  } else {
    // Desktop: Run Test obeys headless checkbox
    document.getElementById('btnRunLocal')?.addEventListener('click', () => {
      const headless = !!document.getElementById('chkHeadless')?.checked;
      run(headless ? 'locust.runHeadless' : 'locust.runUI');
    });

    // Desktop: Launch Cloud → open login in split simple browser
    document.getElementById('btnLocustCloud')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openUrl', url: 'https://auth.locust.cloud/login' });
    });

    // Desktop: Shut Down → stop last local run
    document.getElementById('btnShutdownLocal')?.addEventListener('click', () => run('locust.stopLastRun'));
  }
    
  // Open the CodeTour-based Beginner Guide
  document.getElementById('linkGuide')?.addEventListener('click', (e) => {
    e.preventDefault();
    run('locust.startBeginnerTour'); 
  });
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
        return;
      }

      // NEW: open arbitrary URL in a bottom split Simple Browser (≈45%)
      if (msg?.type === 'openUrl' && typeof msg.url === 'string' && msg.url) {
        await openUrlInSimpleBrowserSplit(msg.url, 0.45);
      }
    });
  }
}

/** Open a URL in Simple Browser in a bottom group sized to ~45% height. */
async function openUrlInSimpleBrowserSplit(url: string, browserRatio = 0.45) {
  const r = Math.min(0.8, Math.max(0.2, browserRatio));

  if (vscode.window.tabGroups.all.length < 2) {
    // Create an EMPTY group below (no file duplication).
    await vscode.commands.executeCommand('workbench.action.newGroupBelow').then(undefined, () => {});
  }

  const ok = await vscode.commands
    .executeCommand('simpleBrowser.show', url, {
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
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0, // horizontal rows (top/bottom)
      groups: [{ size: 1 - r }, { size: r }], // top then bottom
    }).then(undefined, () => {});
  }

  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup').then(undefined, () => {});
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
  const locustRunner = new LocustRunner(env, ctx.extensionUri);
  const harService = new Har2LocustService(env);
  const harRunner = new Har2LocustRunner(env, harService);

  // Tree register provider keep disposable
  const tree = new LocustTreeProvider();
  const treeReg = vscode.window.registerTreeDataProvider('locust.scenarios', tree); 
  ctx.subscriptions.push(treeReg, tree);

  // Gating context key 
  await vscode.commands.executeCommand('setContext', 'locust.showScenarios', false);

  // Welcome view provider
  const welcomeReg = vscode.window.registerWebviewViewProvider('locust.welcome', new LocustWelcomeViewProvider(ctx, isCloud));
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

  // Run setup automatically on activation.
  setup.autoSetupSilently();

  // Scaffold if needed
  await ensureLocustfileOrScaffold();

  // Re-run setup on dir changes
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setup.autoSetupSilently())
  );
}

export function deactivate() {
  // noop
}

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

  try {
    await fs.access(path.join(root, 'locustfile.py'));
    return;
  } catch {}

  const matches = await vscode.workspace.findFiles('**/locustfile_*.py', '**/node_modules/**', 1);
  if (matches.length > 0) return;

  void vscode.commands.executeCommand('locust.createSimulation');
}
