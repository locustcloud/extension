import * as vscode from 'vscode';
import * as path from 'path';
import { SetupService } from '../services/setupService';
import { EnvService } from '../services/envService';
import { McpService } from '../services/mcpService';
import { LocustRunner } from '../runners/locustRunner';
import { Har2LocustRunner } from '../runners/har2locustRunner';
import { TourRunner } from '../runners/tourRunner';
import { LocustTreeProvider } from '../tree/locustTree';
import { LocustCloudService } from '../services/locustCloudService';

// Locust Cloud command registrar
export function registerLocustCloudCommands(ctx: vscode.ExtensionContext) {
  const cloud = new LocustCloudService(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("locust.openLocustCloud", async () => {
      try {
        await cloud.openLocustCloudLanding(); // ← opens https://auth.locust.cloud/load-test by default
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "unexpected error"}`);
      }
    })
  );

  // Delete/stop current Locust Cloud deployment
  ctx.subscriptions.push(
    vscode.commands.registerCommand("locust.deleteLocustCloud", async () => {
      try {
        const confirm = await vscode.window.showWarningMessage(
          "Shut down Locust Cloud?",
          { modal: true },
          "Shut down"
        );
        if (confirm !== "Shut down") return;
        await cloud.deleteLocustCloud();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "unexpected error"}`);
      }
    })
  );
}

// Main command registrar
export function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: {
    setup: SetupService;
    runner: LocustRunner;
    harRunner: Har2LocustRunner;
    tree: LocustTreeProvider;
  }
) {
  // Make Locust Cloud command available
  registerLocustCloudCommands(ctx);

  const { setup, runner, harRunner, tree } = deps;

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),

    vscode.commands.registerCommand('locust.createSimulation', async () => {
      await runner.createLocustfile({ open: true });
    }),

    vscode.commands.registerCommand('locust.openBeginnerTourPage', async () => {
      try {
        const md = vscode.Uri.file(
          path.join(ctx.extensionUri.fsPath, 'media', 'walkthrough', '00-beginner-tour.md')
        );
        // Open the Markdown in preview (like a welcome page)
        await vscode.commands.executeCommand('markdown.showPreview', md);
      } catch (err) {
        vscode.window.showErrorMessage('Could not open the Locust Beginner page.');
      }
    }),

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

    vscode.commands.registerCommand('locust.init', () =>
      setup.checkAndOfferSetup({ forcePrompt: true })
    ),

    // Show/hide welcome view
    vscode.commands.registerCommand('locust.showWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', false);
      await vscode.commands.executeCommand('locust.welcome.focus');
    }),

    vscode.commands.registerCommand('locust.hideWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
      await vscode.commands.executeCommand('locust.scenarios.focus');
    }),

    // Copilot walkthrough launcher
    vscode.commands.registerCommand('locust.openCopilotWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.copilotWalkthrough'
      )
    ),

    // Beginner walkthrough
    vscode.commands.registerCommand('locust.openBeginnerWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.beginnerWalkthrough'
      )
    ),

    // Uses TourRunner to copy into workspace & open directly
    vscode.commands.registerCommand('locust.startBeginnerTour', async () => {
      const tr = new TourRunner(ctx);
      await tr.runBeginnerTour();
    }),

    // Dev utility
    vscode.commands.registerCommand('locust.mcp.rewriteAndReload', async () => {
      const envService = new EnvService();
      const mcp = new McpService(envService);
      await mcp.writeMcpConfig('python');
    }),

    vscode.commands.registerCommand('locust.convertHar', () => harRunner.convertHar()),

    // Prefer active editor's Python file from menu/welcome
    vscode.commands.registerCommand('locust.runUI', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const activePy =
        doc && doc.languageId === 'python' && doc.uri.scheme === 'file'
          ? doc.uri.fsPath
          : undefined;

      if (activePy) {
        return runner.runFile(activePy, 'ui');
      }
      return runner.runSelected('ui');
    }),

    vscode.commands.registerCommand('locust.runHeadless', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const activePy =
        doc && doc.languageId === 'python' && doc.uri.scheme === 'file'
          ? doc.uri.fsPath
          : undefined;

      if (activePy) {
        return runner.runFile(activePy, 'headless');
      }
      return runner.runSelected('headless');
    }),

    vscode.commands.registerCommand('locust.runByTag', () => runner.runByTag())
  );
}
