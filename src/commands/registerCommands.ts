import * as vscode from 'vscode';
import { SetupService } from '../services/setupService';
import { LocustRunner } from '../runners/locustRunner';
import { LocustTreeProvider } from '../tree/locustTree';

/**
 * Register commands for the Locust extension.
 */

export function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: { setup: SetupService; runner: LocustRunner; tree: LocustTreeProvider }
) {
  const { setup, runner, tree } = deps;

  ctx.subscriptions.push(
    // Tree refresh – call provider directly (no recursive command invocation)
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),

    // Tree/context commands
    vscode.commands.registerCommand('locust.runFileUI', (node?: { filePath?: string; resourceUri?: vscode.Uri }) =>
      runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'ui')
    ),
    vscode.commands.registerCommand('locust.runFileHeadless', (node?: { filePath?: string; resourceUri?: vscode.Uri }) =>
      runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'headless')
    ),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runner.runTaskHeadless(node)),

    // Setup
    vscode.commands.registerCommand('locust.init', () => setup.checkAndOfferSetup({ forcePrompt: true })),

    // Walkthrough
    vscode.commands.registerCommand('locust.openWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.gettingStarted'
      )
    ),

    // Palette commands
    vscode.commands.registerCommand('locust.runUI', () => runner.runSelected('ui')),
    vscode.commands.registerCommand('locust.runHeadless', () => runner.runSelected('headless')),
    vscode.commands.registerCommand('locust.runByTag', () => runner.runByTag()),
  );
}
