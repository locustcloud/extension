import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EnvService } from './services/envService';
import { McpService } from './services/mcpService';
import { SetupService } from './services/setupService';
import { LocustRunner } from './runners/locustRunner';
import { Har2LocustService } from './services/har2locustService';
import { Har2LocustRunner } from './runners/har2locustRunner';
import { LocustTreeProvider } from './tree/locustTree';

export async function activate(ctx: vscode.ExtensionContext) {
  // Core services
  const env = new EnvService();
  const mcp = new McpService();
  const setup = new SetupService(env, mcp, ctx);

  // Runners / Services
  const locustRunner = new LocustRunner(env, ctx.extensionUri);
  const harService = new Har2LocustService(env);
  const harRunner = new Har2LocustRunner(env, harService);

  // Tree
  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  ctx.subscriptions.push(treeView, tree);

  // Commands
  registerCommands(ctx, {
    setup,
    runner: locustRunner,
    harRunner,
    tree,
  });

  // Optional: lightweight health check or auto-repair on activation
  // await setup.repairWorkspaceInterpreterIfBroken(); // uncomment if you want auto-repair
}

export function deactivate() {
  // noop
}
