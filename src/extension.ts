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
import * as path from 'path';
import { LocustWelcomeViewProvider } from './welcome/welcomeView';

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

export async function activate(ctx: vscode.ExtensionContext) {
  // Detect environment and set context keys
  const isCloud = detectCloudEnv();
  await vscode.commands.executeCommand('setContext', 'locust.isCloud', isCloud);
  await vscode.commands.executeCommand('setContext', 'locust.isDesktop', !isCloud);

  // Core services
  const env = new EnvService();
  const mcp = new McpService(env);
  const setup = new SetupService(env, mcp, ctx);

  // Copilot service
  const copilot = new CopilotService(ctx);
  await copilot.bootstrap();           
  ctx.subscriptions.push(copilot);


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

  // Welcome view
  const welcomeProvider = new LocustWelcomeViewProvider(ctx, isCloud);
  const welcomeReg = vscode.window.registerWebviewViewProvider('locust.welcome', welcomeProvider);
  ctx.subscriptions.push(welcomeReg);


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

  // Expose refresh
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.welcome.refresh', () => welcomeProvider.refresh())
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
        await vscode.commands.executeCommand('locust.welcome.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle Locust Cloud.');
      }
    }),

    // Local toggle behavior
    vscode.commands.registerCommand('locust.toggleLocalSimple', async () => {
      try {
        const started = getLocalStarted(ctx);
        if (!started) {
          await vscode.commands.executeCommand('locust.runUI');
          await setLocalStarted(ctx, true);
          vscode.window.setStatusBarMessage('Locust: local test starting…', 3000);
        } else {
          await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
          await setLocalStarted(ctx, false);
          vscode.window.setStatusBarMessage('Locust: local test stopped.', 3000);
        }
        await vscode.commands.executeCommand('locust.welcome.refresh');
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
        await vscode.commands.executeCommand('locust.welcome.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to stop runs.');
      }
    }),
  );

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

async function ensureLocustfileOrScaffold() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return;

  const root = folders[0].uri.fsPath;

  try { await fs.access(path.join(root, 'locustfile.py')); return; } catch {}

  const matches = await vscode.workspace.findFiles('**/locustfile_*.py', '**/node_modules/**', 1);
  if (matches.length > 0) return;

  void vscode.commands.executeCommand('locust.createSimulation');
}
