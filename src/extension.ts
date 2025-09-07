import * as vscode from 'vscode';
import { LocustTreeProvider } from './tree/locustTree';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { registerCommands } from './commands/registerCommands';

/**
* This method is called when your extension is activated
* the extension is activated the very first time the command is executed
*/

export function activate(ctx: vscode.ExtensionContext) {
  const env = new EnvService();
  const mcp = new McpService(env);
  const setup = new SetupService(env, mcp, ctx);
  const runner = new LocustRunner(env, ctx.extensionUri);

  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  ctx.subscriptions.push(treeView, tree);

  // Pass tree here ⬇️
  registerCommands(ctx, { setup, runner, tree });

  setup.repairWorkspaceInterpreterIfBroken().catch(err => console.error(err));
  setup.checkAndOfferSetup().catch(err => console.error(err));
}

export function deactivate() {}
