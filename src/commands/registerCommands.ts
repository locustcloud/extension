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

    // Create a new (numbered) locustfile
    vscode.commands.registerCommand('locust.createSimulation', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Workspace root', description: 'Create locustfile_###.py at the repo root', id: 'root' },
          { label: 'templates/', description: 'Create locustfile_###.py under templates/', id: 'templates' }
        ],
        { placeHolder: 'Where should I create the new locustfile?' }
      );
      const where = (pick?.id === 'templates' ? 'templates' : 'root') as 'root' | 'templates';
      await runner.createLocustfile({ where, open: true });
    }),

    // Tree/context commands
    vscode.commands.registerCommand(
      'locust.runFileUI',
      async (node?: { filePath?: string; resourceUri?: vscode.Uri }) => {
        await runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'ui');
      }
    ),

    vscode.commands.registerCommand(
      'locust.runFileHeadless',
      (node?: { filePath?: string; resourceUri?: vscode.Uri }) =>
        runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'headless')
    ),

    vscode.commands.registerCommand('locust.runTaskUI', (node) => runner.runTaskUI(node)),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runner.runTaskHeadless(node)),

    // Setup (user-driven)
    vscode.commands.registerCommand('locust.init', () => setup.checkAndOfferSetup({ forcePrompt: true })),

    // --- Tutorials ---
    vscode.commands.registerCommand('locust.startBeginnerTour', async () => {
      // Resolve to the tour bundled with the extension
      const ext = vscode.extensions.getExtension('locust.locust-vscode-extension');
      if (!ext) {
        vscode.window.showErrorMessage('Locust extension not found to resolve tour file.');
        return;
      }

      const tourUri = vscode.Uri.file(
        require('path').join(
          ext.extensionUri.fsPath,
          'media',
          '.tours',
          'locust_beginner.tour'
        )
      );

      try {
        await vscode.commands.executeCommand('codetour.openTourFile', tourUri);
        await vscode.commands.executeCommand('codetour.startTour');
      } catch (err) {
        vscode.window.showErrorMessage(`Could not open Locust Beginner Tour: ${err}`);
      }
    }),

    // Copilot walkthrough
    vscode.commands.registerCommand('locust.openCopilotWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.copilotWalkthrough'
      )
    ),

    // Welcome view show/hide
    vscode.commands.registerCommand('locust.showWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', false);
      await vscode.commands.executeCommand('locust.welcome.focus');
    }),
    vscode.commands.registerCommand('locust.hideWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
      await vscode.commands.executeCommand('locust.scenarios.focus');
    }),

    // HAR → Locustfile
    vscode.commands.registerCommand('locust.convertHar', () => harRunner.convertHar()),

    // Palette convenience
    vscode.commands.registerCommand('locust.runUI', () => runner.runSelected('ui')),
    vscode.commands.registerCommand('locust.runHeadless', () => runner.runSelected('headless')),
    vscode.commands.registerCommand('locust.runByTag', () => runner.runByTag())
  );
}
