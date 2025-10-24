import * as vscode from 'vscode';
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

  const withProgress = (title: string, fn: () => Thenable<void>) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      fn
    );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("locust.openLocustCloud", async () => {
      try {
        // On web/code-server: Simple Browser; on desktop: system browser
        const preferSimple = vscode.env.uiKind === vscode.UIKind.Web;
        await cloud.openLocustCloudLanding();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "unexpected error"}`);
      }
    }),

    vscode.commands.registerCommand("locust.deleteLocustCloud", async () => {
      try {
        await withProgress("Locust Cloud: stopping…", () => cloud.deleteLocustCloud());
        vscode.window.setStatusBarMessage("Locust Cloud: stopped.", 3000);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "unexpected error"}`);
      }
    }),

    vscode.commands.registerCommand("locust.stopLocustCloud", async () => {
      try {
        await withProgress("Locust Cloud: stopping…", () => cloud.deleteLocustCloud());
        vscode.window.setStatusBarMessage("Locust Cloud: stopped.", 3000);
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
  // Make Locust Cloud commands available
  registerLocustCloudCommands(ctx);

  const { setup, runner, harRunner, tree } = deps;

  ctx.workspaceState.update('locust.offerSetup', setup.checkAndOfferSetup());

  // Simple browser split-view opener
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.openUrlInSplit', async (url: string, ratio = 0.45) => {
      if (typeof url !== 'string' || !url) return;

      const r = Math.min(0.8, Math.max(0.2, ratio));

      if (vscode.window.tabGroups.all.length < 2) {
        // Avoid duplicating editor
        await vscode.commands.executeCommand('workbench.action.newGroupBelow').then(undefined, () => {});
      }

      const ok = await vscode.commands
        .executeCommand('simpleBrowser.show', url, {
          viewColumn: vscode.ViewColumn.Two, // second (bottom) group
          preserveFocus: true,
          preview: true,
        })
        .then(() => true, () => false);

      if (!ok) {
        // No external fallback 
        vscode.window.showErrorMessage('Could not open Simple Browser.');
        return;
      }

      if (vscode.window.tabGroups.all.length === 2) {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
          orientation: 0, // horizontal rows (top/bottom)
          groups: [{ size: 1 - r }, { size: r }], // top then bottom
        }).then(undefined, () => {});
      }

      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup').then(undefined, () => {});
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.pickLocustfile', async () => {
      const uri = await tree.pickLocustfileOrActive();
      return uri; // callers can await executeCommand to get this Uri (or undefined)
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),

    // Expose the scaffold command id used by the picker
    vscode.commands.registerCommand('locust.createLocustfile', async () => {
      return tree.createLocustfileFromTemplate({ open: true });
    }),

    // (kept for existing UX label/entry point)
    vscode.commands.registerCommand('locust.createSimulation', async () => {
      await tree.createLocustfileFromTemplate({ open: true });
    }),

    vscode.commands.registerCommand(
      'locust.runFileUI',
      async (node?: { filePath?: string; resourceUri?: vscode.Uri }) => {
        try {
          await runner.runLocustUI(node?.filePath ?? node?.resourceUri?.fsPath);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Locust (UI): ${e?.message ?? 'failed to start UI run'}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      'locust.runFileHeadless',
      async (node?: { filePath?: string; resourceUri?: vscode.Uri }) => {
        try {
          await runner.runFile(node?.filePath ?? node?.resourceUri?.fsPath, 'headless');
        } catch (e: any) {
          vscode.window.showErrorMessage(`Locust (headless): ${e?.message ?? 'failed to start headless run'}`);
        }
      }
    ),

    // Stop Locust run
    vscode.commands.registerCommand('locust.stopLastRun', async () => {
      try {
        await runner.stopLastRun();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust: ${e?.message ?? 'Failed to stop the last run.'}`);
      }
    }),

    // Future inline task actions
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

    // Copilot walkthrough
    vscode.commands.registerCommand('locust.openCopilotWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.copilotWalkthrough'
      )
    ),

    // Start beginner tour
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

    // Always go through unified picker flow
    vscode.commands.registerCommand('locust.runUI', async () => {
      try {
        return runner.runFile(undefined, 'ui');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust (UI): ${e?.message ?? 'failed to start'}`);
      }
    }),

    vscode.commands.registerCommand('locust.runHeadless', async () => {
      try {
        return runner.runFile(undefined, 'headless');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust (headless): ${e?.message ?? 'failed to start'}`);
      }
    })
  );
  vscode.commands.executeCommand('locust.welcome.refresh');
}
