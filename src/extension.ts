import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { Har2LocustService } from './services/har2locustService';
import { Har2LocustRunner } from './runners/har2locustRunner';
import { LocustTreeProvider } from './tree/locustTree';
import { registerWelcomePanel } from './welcome/welcomePanel';
import { CopilotService } from './services/copilotService';
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

class LocustWelcomeViewProvider implements vscode.WebviewViewProvider {
  constructor(private ctx: vscode.ExtensionContext, private readonly isCloud: boolean) {}

  
  private _view?: vscode.WebviewView;

  async resolveWebviewView(webviewView: vscode.WebviewView) { 
    
    this._view = webviewView;

    const { webview } = webviewView;
    webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };

    const nonce = String(Math.random()).slice(2);

        // Desktop controls
    const desktopControls = `
      <div class="row actions">
        <button id="btnRunLocal" title="locust -f locustfile.py">Local Test</button>
        <button id="btnLocustCloud" title="locust -f locustfile.py --cloud">Cloud Test</button>
      </div>
      <div class="row">
        <button id="btnStopAll" class="danger" title="Stop active Test">Stop Test</button>
      </div><br>
      <div class="row">
        <button id="btnCopilotChat" title="Open Copilot Chat">Copilot Chat</button>
      </div>
      <div class="row">
        <button id="btnConvertHar" title="Convert a HAR file to a Locust test">HAR to Locust</button>
      </div>     
    `;

    // Cloud controls
    const cloudControls = `
      <div class="row actions">
        <button id="btnRunUI" title="locust -f locustfile.py --cloud">Cloud Test</button>
      </div>
      <div class="row">
        <button id="btnStopAll" class="danger" title="Stop active Test">Stop Test</button>
      </div>
    `;

    const supportBlock = this.isCloud ? '' : `<a href="mailto:support@locust.cloud">support@locust.cloud</a><br>`;

    const cloudStartedFlag = getCloudStarted(this.ctx) ? '1' : '0';
    const localStartedFlag = !this.isCloud && getLocalStarted(this.ctx) ? '1' : '0';

    // Load HTML template
    const htmlUri = vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', 'webView.html'));
    let html = await fs.readFile(htmlUri.fsPath, 'utf8');

    html = html
      // standard placeholders
      .replace(/\$\{webview\.cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cloudStartedFlag\}/g, cloudStartedFlag)
      .replace(/\$\{localStartedFlag\}/g, localStartedFlag)
      .replace(/\$\{supportBlock\}/g, supportBlock)
      .replace(/\$\{cloudControls\}/g, cloudControls)
      .replace(/\$\{desktopControls\}/g, desktopControls)
      .replace(/\$\{this\.isCloud \? '1' : '0'\}/g, this.isCloud ? '1' : '0')
      .replace(/\$\{this\.isCloud \? 'Cloud' : 'Local'\}/g, this.isCloud ? 'Cloud' : 'Local')
      .replace(/\$\{this\.isCloud \? cloudControls : desktopControls\}/g, this.isCloud ? cloudControls : desktopControls);

    webview.html = html;

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

        if (msg?.type === 'getCopilotPrompts') {
          try {
            const mdPath = path.join(this.ctx.extensionUri.fsPath, 'media', 'copilot_tutorial', '01-copilot.md');
            const md = await fs.readFile(mdPath, 'utf8');

            // Extract blocks **Prompt:** or ***Prompt:***
            const items: string[] = [];
            const re = /(?:\*\*\*?Prompt:\*\*\*?\s*)([\s\S]*?)(?=\n\s*\*\*|$)/gi;
            let m: RegExpExecArray | null;
            while ((m = re.exec(md)) !== null) {
              const block = (m[1] || '').trim();

              // Prefer numbered lines (1. ..., 2. ...) if present
              const numbered: string[] = [];
              block.replace(/^\s*\d+\.\s*(.+)$/gm, (_a, p1) => { numbered.push(String(p1).trim()); return ''; });

              if (numbered.length) {
                items.push(...numbered);
              } else {
                // First non-empty line
                const first = block.split(/\r?\n/).map(s => s.trim()).find(Boolean);
                if (first) items.push(first);
              }
            }

            await webview.postMessage({ type: 'copilotPrompts', items });
          } catch (e: any) {
            await webview.postMessage({ type: 'copilotPrompts', items: [], error: e?.message ?? 'Failed to read prompts' });
          }
          return;
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to execute action.');
      }
    });
  }

  
  refresh() {
    if (!this._view) return;
    const cloudStarted = !!this.ctx.globalState.get<boolean>('locust.cloudWasStarted', false);
    const localStarted = !this.isCloud && !!this.ctx.workspaceState.get<boolean>('locust.localStarted', false);
    this._view.webview.postMessage({ type: 'state', cloudStarted, localStarted });
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
  const locustRunner = new LocustRunner(); 
  const harService = new Har2LocustService(env);
  const harRunner = new Har2LocustRunner(env, harService);

  // Tree provider
  const tree = new LocustTreeProvider();
  const treeReg = vscode.window.registerTreeDataProvider('locust.scenarios', tree);
  ctx.subscriptions.push(treeReg, tree);

  // Gating context key
  await vscode.commands.executeCommand('setContext', 'locust.showScenarios', false);

  // desktop auto-open
  registerWelcomePanel(ctx); 

  // Welcome view
  const welcomeProvider = new LocustWelcomeViewProvider(ctx, isCloud);
  const welcomeReg = vscode.window.registerWebviewViewProvider('locust.welcome', welcomeProvider);
  ctx.subscriptions.push(welcomeReg);

  
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.welcome.refresh', () => {
      try { welcomeProvider.refresh(); } catch { /* noop */ }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.setLocalStarted', async (value: boolean) => {
      try {
        await ctx.workspaceState.update('locust.localStarted', !!value);
        await vscode.commands.executeCommand('locust.welcome.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to set local started state.');
      }
    })
  );

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


  if (!isCloud) {
    await setup.checkAndOfferSetup(); //  Prompt/always/never + trust
    ctx.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        setup.checkAndOfferSetup().catch(() => {});
      })
    );
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => setup.checkAndOfferSetup())
    );
  }
}

export function deactivate() { /* noop */ }

function detectCloudEnv(): boolean {
  const byEnv = (process.env.CODE_SERVER ?? '').toLowerCase();
  const envFlag = byEnv === 'true' || byEnv === '1' || byEnv === 'yes';
  const uiIsWeb = vscode.env.uiKind === vscode.UIKind.Web;
  return envFlag || uiIsWeb;
}
