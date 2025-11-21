import * as vscode from 'vscode';
import { SetupService } from '../services/setupService';
import { EnvService } from '../services/envService';
import { McpService } from '../services/mcpService';
import { LocustRunner } from '../runners/locustRunner';
import { Har2LocustRunner } from '../runners/har2locustRunner';
import { TourRunner } from '../runners/tourRunner';
import { LocustTreeProvider } from '../tree/locustTree';
import { LocustCloudService } from '../services/locustCloudService';

// Main command registrar
export function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: {
    setup: SetupService;
    harRunner: Har2LocustRunner;
    tree: LocustTreeProvider;
  },
) {
  const cloud = new LocustCloudService(ctx);

  const { setup, harRunner, tree } = deps;

  const withProgress = (title: string, fn: () => Thenable<void>) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      fn,
    );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.openLocustCloud', async () => {
      try {
        return await cloud.openLocustCloudLanding();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? 'unexpected error'}`);
        return false;
      }
    }),

    vscode.commands.registerCommand('locust.stopLocust', async () => {
      try {
        await withProgress('Locust Cloud: stopping…', () => cloud.deleteLocustCloud());
        vscode.window.setStatusBarMessage('Locust Cloud: stopped.', 3000);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? 'unexpected error'}`);
      }
    }),

    vscode.commands.registerCommand('locust.openUrlInSplit', async (url: string, ratio = 0.45) => {
      if (typeof url !== 'string' || !url) return;

      const r = Math.min(0.8, Math.max(0.2, ratio));

      if (vscode.window.tabGroups.all.length < 2) {
        await vscode.commands
          .executeCommand('workbench.action.newGroupBelow')
          .then(undefined, () => {});
      }

      const ok = await vscode.commands
        .executeCommand('simpleBrowser.show', url, {
          viewColumn: vscode.ViewColumn.Two,
          preserveFocus: true,
          preview: true,
        })
        .then(
          () => true,
          () => false,
        );

      if (!ok) {
        vscode.window.showErrorMessage('Could not open Simple Browser.');
        return;
      }

      if (vscode.window.tabGroups.all.length === 2) {
        await vscode.commands
          .executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 1 - r }, { size: r }],
          })
          .then(undefined, () => {});
      }

      await vscode.commands
        .executeCommand('workbench.action.focusFirstEditorGroup')
        .then(undefined, () => {});
    }),

    vscode.commands.registerCommand('locust.pickLocustfile', async () => {
      const uri = await tree.pickLocustfileOrActive();
      return uri;
    }),

    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),

    vscode.commands.registerCommand('locust.runUI', async () => {
      try {
        return await cloud.runFile('ui');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust (UI): ${e?.message ?? 'failed to start'}`);
        return false;
      }
    }),

    vscode.commands.registerCommand('locust.runHeadless', async () => {
      try {
        return await cloud.runFile('headless');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust (headless): ${e?.message ?? 'failed to start'}`);
        return false;
      }
    }),

    vscode.commands.registerCommand('locust.runTaskUI', node => cloud.runTaskUI(node)),
    vscode.commands.registerCommand('locust.runTaskHeadless', node => cloud.runTaskHeadless(node)),

    vscode.commands.registerCommand('locust.init', () =>
      setup.checkAndOfferSetup({ forcePrompt: true }),
    ),

    vscode.commands.registerCommand('locust.showWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', false);
      await vscode.commands.executeCommand('locust.welcome.focus');
    }),

    vscode.commands.registerCommand('locust.hideWelcome', async () => {
      await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
      await vscode.commands.executeCommand('locust.scenarios.focus');
    }),

    vscode.commands.registerCommand('locust.openCopilotWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.copilotWalkthrough',
      ),
    ),

    vscode.commands.registerCommand('locust.startBeginnerTour', async () => {
      const tr = new TourRunner(ctx);
      await tr.runBeginnerTour();
    }),

    vscode.commands.registerCommand('locust.mcp.rewriteAndReload', async () => {
      const envService = new EnvService();
      const mcp = new McpService(envService);
      await mcp.writeMcpConfig('python');
    }),

    vscode.commands.registerCommand('locust.convertHar', () => harRunner.convertHar()),
    vscode.commands.registerCommand('locust.toggleCloudSimple', async () => {
      try {
        const ok = (await vscode.commands.executeCommand('locust.openLocustCloud')) as
          | boolean
          | undefined;
        if (ok === true) {
          vscode.window.setStatusBarMessage('Locust Cloud: starting…', 3000);
        } else {
          vscode.window.setStatusBarMessage('Locust Cloud: cancelled.', 3000);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle Locust Cloud.');
      }
    }),

    vscode.commands.registerCommand('locust.toggleLocalSimple', async () => {
      try {
        const ok = (await vscode.commands.executeCommand('locust.runUI')) as boolean | undefined;
        if (ok === true) {
          vscode.window.setStatusBarMessage('Locust: local test starting…', 3000);
        } else {
          vscode.window.setStatusBarMessage('Locust Cloud: cancelled.', 3000);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle local run.');
      }
    }),
  );
}
