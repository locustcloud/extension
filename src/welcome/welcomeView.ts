import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TourRunner } from '../runners/tourRunner';


// Persisted flags
const CLOUD_FLAG_KEY = 'locust.cloudWasStarted';
const getCloudStarted = (ctx: vscode.ExtensionContext) =>
  !!ctx.globalState.get<boolean>(CLOUD_FLAG_KEY, false);
const setCloudStarted = (ctx: vscode.ExtensionContext, v: boolean) =>
  ctx.globalState.update(CLOUD_FLAG_KEY, v);

const getLocalStarted = (ctx: vscode.ExtensionContext) =>
  !!ctx.workspaceState.get<boolean>('locust.localStarted', false);
const setLocalStarted = (ctx: vscode.ExtensionContext, v: boolean) =>
  ctx.workspaceState.update('locust.localStarted', v);

// Small template helper
function render(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/{{\s*([\w.-]+)\s*}}/g, (_, k) => values[k] ?? '');
}

export class LocustWelcomeViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly isCloud: boolean
  ) {}

  // State pusher
  refresh() {
    if (!this._view) return;
    const cloudStarted = getCloudStarted(this.ctx);
    const localStarted = !this.isCloud && getLocalStarted(this.ctx);
    this._view.webview.postMessage({ type: 'state', cloudStarted, localStarted });
  }

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    const mediaRoot = vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media'));

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri, mediaRoot],
    };

    const nonce = Math.random().toString().slice(2);
    const cspSource = webviewView.webview.cspSource;

    // External assets
    const htmlUri   = vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', 'webView.html'));
   
    // Controls
    const desktopControls = `
      <div class="row actions">
        <button id="btnRunLocal"    title="locust -f locustfile.py">Local Test</button>
        <button id="btnLocustCloud" title="locust -f locustfile.py --cloud">Cloud Test</button>
      </div>
      <div class="row">
        <button id="btnStopAll" class="danger" title="Stop active Test">Stop Test</button>
      </div><br>
      <div class="row"><br>
        <button id="btnConvertHar"  title="Convert a HAR file to a Locust test">HAR to Locust</button>
      </div>`;

    const cloudControls = `
      <div class="row actions">
        <button id="btnRunUI"       title="locust -f locustfile.py --cloud">Cloud Test</button>
      </div>
      <div class="row">
        <button id="btnStopAll" class="danger" title="Stop active Test">Stop Test</button>
      </div>`;

    const supportBlock = this.isCloud ? '' : `<a href="mailto:support@locust.cloud">support@locust.cloud</a><br>`;
    const cloudStartedFlag = getCloudStarted(this.ctx) ? '1' : '0';
    const localStartedFlag = !this.isCloud && getLocalStarted(this.ctx) ? '1' : '0';

    // Read + hydrate HTML template
    const raw = await fs.readFile(htmlUri.fsPath, 'utf8');
    const html = render(raw, {
      cspSource,
      nonce,
      isCloud: this.isCloud ? '1' : '0',
      cloudStarted: cloudStartedFlag,
      localStarted: localStartedFlag,
      titleSuffix: this.isCloud ? 'Cloud' : 'Local',
      subtitle: this.isCloud ? 'Manage runs in Locust Cloud.' : 'Run Locust locally or open Locust Cloud.',
      controls: this.isCloud ? cloudControls : desktopControls,
      supportBlock,
    });

    webviewView.webview.html = html;

    // Initial state
    this.refresh();

    // Command bridge 
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.type === 'run' && typeof msg.command === 'string') {
          switch (msg.command) {
            case 'runLocal': {
              // runner will clear on exit/error
              await vscode.commands.executeCommand('locust.setLocalStarted', true);
              await vscode.commands.executeCommand('locust.runUI');
              this.refresh();
              return;
            }
            case 'runCloud': {
              await vscode.commands.executeCommand('locust.openLocustCloud');
              await setCloudStarted(this.ctx, true);
              this.refresh();
              return;
            }
            case 'stopAll': {
              if (this.isCloud) {
                await vscode.commands.executeCommand('locust.deleteLocustCloud').then(undefined, () => {});
                await setCloudStarted(this.ctx, false);
              } else {
                await vscode.commands.executeCommand('locust.stopLastRun').then(undefined, () => {});
                await vscode.commands.executeCommand('locust.setLocalStarted', false);
              }
              this.refresh();
              return;
            }
            case 'convertHar': {
              await vscode.commands.executeCommand('locust.convertHar');
              return;
            }
            case 'hideWelcome': {
              await vscode.commands.executeCommand('setContext', 'locust.hideWelcome', true);
              await vscode.commands.executeCommand('locust.scenarios.focus');
              return;
            }
            case 'beginnerTour': {
              const tr = new TourRunner(this.ctx);
              await tr.runBeginnerTour();
              return;
            }
            default: {
              // fallback for direct command ids
              await vscode.commands.executeCommand(msg.command);
              return;
            }
          }
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? 'Failed to execute action.');
        
        await vscode.commands.executeCommand('locust.setLocalStarted', false);
        await setCloudStarted(this.ctx, false);
        this.refresh();
      }
    });
  }
}
