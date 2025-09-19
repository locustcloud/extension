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
  <h1>Locust Action Menu</h1>
  <p>Quick Action Buttons for common Locust operations.</p>

  <div class="row">
    <button class="primary" id="btnGetting">Locust Tour</button>
    <button id="btnCopilot">Copilot Walkthrough</button>
    <button id="btnRunUI">Run Test (Web UI)</button>
    <button id="btnRunHeadless">Run Test (Headless)</button>
    <button id="btnCreate">Create Simulation</button>
    <button id="btnConvert">Convert HAR → Locustfile</button>
  </div>

  <p id="msg" class="muted" style="min-height:1.2em;"></p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const msgEl = document.getElementById('msg');

  function setMsg(text, isError=false) {
    msgEl.textContent = text || '';
    msgEl.style.color = isError ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)';
  }

  const run = cmd => vscode.postMessage({ type: 'run', command: cmd });

  document.getElementById('btnGetting').onclick = () => {
    setMsg('Starting tour…');
    vscode.postMessage({ type: 'startTour' });
  };
  document.getElementById('btnCopilot').onclick = () => run('locust.openCopilotWalkthrough');
  document.getElementById('btnRunUI').onclick = () => run('locust.runUI');
  document.getElementById('btnRunHeadless').onclick = () => run('locust.runHeadless');
  document.getElementById('btnCreate').onclick = () => run('locust.createSimulation');
  document.getElementById('btnConvert').onclick = () => run('locust.convertHar');

  window.addEventListener('message', (event) => {
    const { type, ok, error } = event.data || {};
    if (type === 'tourStatus') {
      if (ok) setMsg('Tour started.');
      else setMsg(error || 'Could not start tour.', true);
    }
  });
</script>
</body>
</html>
    `;

    webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') return;

      // Handle starting the tour
      if (msg.type === 'startTour') {
        try {
          const ext = vscode.extensions.getExtension('locust.locust-vscode-extension');
          if (!ext) throw new Error('Extension context not found.');

          // Use joinPath if available, otherwise fallback to path.join
          // (Assuming VS Code API >= 1.56, joinPath is available)
          const joinPath = (vscode.workspace.fs as any).joinPath || ((base: vscode.Uri, ...paths: string[]) => {
            const path = require('path');
            return vscode.Uri.file(path.join(base.fsPath, ...paths));
          });
          const tourUri = joinPath(
            ext.extensionUri,
            'media',
            '.tours',
            'locust_beginner.tour'
          );

          await vscode.commands.executeCommand('codetour.openTourFile', tourUri);
          await vscode.commands.executeCommand('codetour.startTour');

          webview.postMessage({ type: 'tourStatus', ok: true });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Could not open Locust Beginner Tour: ${err?.message || err}`);
          webview.postMessage({ type: 'tourStatus', ok: false, error: 'Could not open Locust Beginner Tour.' });
        }
        return;
      }

      // Existing command passthrough
      if (msg.type === 'run' && typeof msg.command === 'string') {
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

  // Welcome view provider
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('locust.welcome', new LocustWelcomeViewProvider(ctx))
  );

  // Centralized command registration
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
