import * as vscode from 'vscode';
import { SetupService } from '../services/setupService';
import { EnvService } from '../services/envService';
import { McpService } from '../services/mcpService';
import { LocustRunner } from '../runners/locustRunner';
import { Har2LocustRunner } from '../runners/har2locustRunner';
import { TourRunner } from '../runners/tourRunner';
import { LocustTreeProvider } from '../tree/locustTree';
import { LocustCloudService } from '../services/locustCloudService';

// ---- added: tiny helpers for state flags ----
const CLOUD_FLAG_KEY = 'locust.cloudWasStarted';
const LOCAL_FLAG_KEY = 'locust.localStarted';

function getCloudStarted(ctx: vscode.ExtensionContext): boolean {
  return !!ctx.globalState.get<boolean>(CLOUD_FLAG_KEY, false);
}
async function setCloudStarted(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.globalState.update(CLOUD_FLAG_KEY, v);
}

function getLocalStarted(ctx: vscode.ExtensionContext): boolean {
  return !!ctx.workspaceState.get<boolean>(LOCAL_FLAG_KEY, false);
}
async function setLocalStarted(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.workspaceState.update(LOCAL_FLAG_KEY, v);
}

// Locust Cloud command registrar
export function registerLocustCloudCommands(ctx: vscode.ExtensionContext) {
  const cloud = new LocustCloudService(ctx);

  const withProgress = (title: string, fn: () => Thenable<void>) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      fn
    );

  // Ensure these are disposed correctly
  ctx.subscriptions.push(
    vscode.commands.registerCommand("locust.openLocustCloud", async () => {
      try {
        const ok = await cloud.openLocustCloudLanding();
        return ok === true; // propagate boolean for toggles
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust Cloud: ${e?.message ?? "unexpected error"}`);
        return false;
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

  // Simple browser split-view opener
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.openUrlInSplit', async (url: string, ratio = 0.45) => {
      if (typeof url !== 'string' || !url) return;

      const r = Math.min(0.8, Math.max(0.2, ratio));

      if (vscode.window.tabGroups.all.length < 2) {
        await vscode.commands.executeCommand('workbench.action.newGroupBelow').then(undefined, () => {});
      }

      const ok = await vscode.commands
        .executeCommand('simpleBrowser.show', url, {
          viewColumn: vscode.ViewColumn.Two,
          preserveFocus: true,
          preview: true,
        })
        .then(() => true, () => false);

      if (!ok) {
        vscode.window.showErrorMessage('Could not open Simple Browser.');
        return;
      }

      if (vscode.window.tabGroups.all.length === 2) {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
          orientation: 0,
          groups: [{ size: 1 - r }, { size: r }],
        }).then(undefined, () => {});
      }

      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup').then(undefined, () => {});
    })
  );

  // Pick locustfile 
  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.pickLocustfile', async () => {
      const uri = await tree.pickLocustfileOrActive();
      return uri;
    }),

    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh())
  );


  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.runUI', async () => {
      try {
        await runner.runFile(undefined, 'ui');
        return true;
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust (UI): ${e?.message ?? 'failed to start'}`);
        return false;
      }
    }),

    vscode.commands.registerCommand('locust.runHeadless', async () => {
      try {
        await runner.runFile(undefined, 'headless');
        return true;
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust (headless): ${e?.message ?? 'failed to start'}`);
        return false;
      }
    }),

    vscode.commands.registerCommand('locust.stopLastRun', async () => {
      try {
        await runner.stopLastRun();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Locust: ${e?.message ?? 'Failed to stop the last run.'}`);
      }
    }),

    vscode.commands.registerCommand('locust.runTaskUI', (node) => runner.runTaskUI(node)),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runner.runTaskHeadless(node)),

    vscode.commands.registerCommand('locust.init', () =>
      setup.checkAndOfferSetup({ forcePrompt: true })
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
        'locust.locust-vscode-extension#locust.copilotWalkthrough'
      )
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

    vscode.commands.registerCommand('locust.convertHar', () => harRunner.convertHar())
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.toggleCloudSimple', async () => {
      try {
        const started = getCloudStarted(ctx);
        if (!started) {
          const ok = await vscode.commands.executeCommand('locust.openLocustCloud') as boolean | undefined;
          if (ok === true) {
            await setCloudStarted(ctx, true);
            vscode.window.setStatusBarMessage('Locust Cloud: starting…', 3000);
          } else {
            await setCloudStarted(ctx, false);
            vscode.window.setStatusBarMessage('Locust Cloud: cancelled.', 3000);
          }
        } else {
          await vscode.commands.executeCommand('locust.deleteLocustCloud').then(undefined, () => {});
          await setCloudStarted(ctx, false);
          vscode.window.setStatusBarMessage('Locust Cloud: stopped.', 3000);
        }
        await vscode.commands.executeCommand('locust.welcome.refresh').then(() => {}, () => {});
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle Locust Cloud.');
      }
    }),

    vscode.commands.registerCommand('locust.toggleLocalSimple', async () => {
      try {
        const started = getLocalStarted(ctx);
        if (!started) {
          const ok = await vscode.commands.executeCommand('locust.runUI') as boolean | undefined;
          if (ok === true) {
            await setLocalStarted(ctx, true);
            vscode.window.setStatusBarMessage('Locust: local test starting…', 3000);
          } else {
            await setLocalStarted(ctx, false);
          }
        } else {
          await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
          await setLocalStarted(ctx, false);
          vscode.window.setStatusBarMessage('Locust: local test stopped.', 3000);
        }
        await vscode.commands.executeCommand('locust.welcome.refresh').then(() => {}, () => {});
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to toggle local run.');
      }
    }),

    vscode.commands.registerCommand('locust.stopLocalThenCloudIfAny', async () => {
      try {
        // Stop local first
        await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
        await setLocalStarted(ctx, false);

        // Then cloud if flagged
        if (getCloudStarted(ctx)) {
          await vscode.commands.executeCommand('locust.deleteLocustCloud').then(undefined, () => {});
          await setCloudStarted(ctx, false);
        }

        vscode.window.setStatusBarMessage('Locust: stopped local (and cloud if active).', 3000);
        await vscode.commands.executeCommand('locust.welcome.refresh').then(() => {}, () => {});
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to stop runs.');
      }
    })
  );
}
