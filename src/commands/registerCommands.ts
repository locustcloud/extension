import * as vscode from 'vscode';
import { SetupService } from '../services/setupService';
import { LocustRunner } from '../runners/locustRunner';
import { LocustTreeProvider } from '../tree/locustTree';
import { Har2LocustRunner } from '../runners/har2locustRunner';

/**
 * Register commands for the Locust extension.
 */
export function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: {
    setup: SetupService;
    runner: LocustRunner;
    harRunner: Har2LocustRunner;
    tree: LocustTreeProvider;
  }
) {
  const { setup, runner, harRunner, tree } = deps;

  ctx.subscriptions.push(
    // Tree refresh – call provider directly (no recursive command invocation)
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),

    // Tree/context commands
    vscode.commands.registerCommand(
      'locust.runFileUI',
      async (node?: { filePath?: string; resourceUri?: vscode.Uri }) => {
        // Start Locust with UI
        await runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'ui');

        // Open in VS Code’s built-in simple browser
        vscode.commands.executeCommand(
          'simpleBrowser.show',
          vscode.Uri.parse('http://localhost:8089')
        );
      }
    ),
    
    vscode.commands.registerCommand('locust.runFileHeadless', (node?: { filePath?: string; resourceUri?: vscode.Uri }) =>
      runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'headless')
    ),
    
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runner.runTaskHeadless(node)),

    // Setup (user-driven)
    vscode.commands.registerCommand('locust.init', () => setup.checkAndOfferSetup({ forcePrompt: true })),

    // Walkthrough
    vscode.commands.registerCommand('locust.openWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.gettingStarted'
      )
    ),

    // HAR → Locustfile (delegate to runner -> service)
    vscode.commands.registerCommand('locust.convertHar', () => harRunner.convertHar()),

    // Palette convenience
    vscode.commands.registerCommand('locust.runUI', () => runner.runSelected('ui')),
    vscode.commands.registerCommand('locust.runHeadless', () => runner.runSelected('headless')),
    vscode.commands.registerCommand('locust.runByTag', () => runner.runByTag()),
  );
}
