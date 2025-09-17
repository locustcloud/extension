import * as vscode from 'vscode';
import * as path from 'path';
import { EnvService } from '../services/envService';
import { Har2LocustService, Har2LocustOptions } from '../services/har2locustService';

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

/**
 * HAR → Locustfile runner (thin controller)
 * Handles user interaction, delegates execution to Har2LocustService.
 */
export class Har2LocustRunner {
  constructor(
    private env: EnvService,
    private service: Har2LocustService
  ) {}

  /** Interactive flow to pick a HAR and convert it into a locustfile. */
  async convertHar(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    // Pick HAR
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select HAR file',
      filters: { HAR: ['har'], All: ['*'] }
    });
    if (!picked || picked.length === 0) return;

    const harPath = picked[0].fsPath;
    const harBase = path.basename(harPath, '.har');

    // Ensure templates dir
    const outDir = uriJoinPath(ws.uri, 'templates');
    try {
      await vscode.workspace.fs.stat(outDir);
    } catch {
      await vscode.workspace.fs.createDirectory(outDir);
    }

    // Default output file
    const defaultOut = `${harBase}_locustfile.py`;
    const outName = await vscode.window.showInputBox({
      prompt: 'Enter output locustfile name',
      value: defaultOut,
      validateInput: (v) => v.trim() ? undefined : 'File name is required'
    });
    if (!outName) return;

    const outUri = uriJoinPath(ws.uri, 'templates', outName);

    // Optional flags
    const applyOptions = await vscode.window.showQuickPick(
      [
        { label: 'No options (recommended)', description: 'Just convert', picked: true, id: 'none' },
        { label: 'Set template path…', description: 'har2locust --template <path>', id: 'template' },
        { label: 'Plugins…', description: 'har2locust --plugins <pkg1,script2.py>', id: 'plugins' },
        { label: 'Disable default plugins…', description: 'har2locust --disable-plugins <comma,list>', id: 'disable' },
        { label: 'Resource types…', description: 'har2locust --resource-types <xhr,document,...>', id: 'res' },
        { label: 'Log level…', description: 'har2locust --loglevel <level>', id: 'log' }
      ],
      { placeHolder: 'Optional: add har2locust flags?', canPickMany: true }
    );

    const opts: Har2LocustOptions = {};
    if (applyOptions?.some(o => o.id === 'template')) {
      const v = await vscode.window.showInputBox({ prompt: 'Template path (e.g. locust.jinja2)' });
      if (v) opts.template = v;
    }
    if (applyOptions?.some(o => o.id === 'plugins')) {
      const v = await vscode.window.showInputBox({
        prompt: 'Plugins (comma-separated)',
        placeHolder: 'har2locust.extra_plugins.plugin_example,myplugin.py'
      });
      if (v) opts.plugins = v;
    }
    if (applyOptions?.some(o => o.id === 'disable')) {
      const v = await vscode.window.showInputBox({
        prompt: 'Disable default plugins (comma-separated)',
        placeHolder: 'ruff.py,rest.py'
      });
      if (v) opts.disablePlugins = v;
    }
    if (applyOptions?.some(o => o.id === 'res')) {
      const v = await vscode.window.showInputBox({
        prompt: 'Resource types (comma-separated)',
        placeHolder: 'xhr,document,other'
      });
      if (v) opts.resourceTypes = v;
    }
    if (applyOptions?.some(o => o.id === 'log')) {
      const v = await vscode.window.showQuickPick(['CRITICAL','ERROR','WARNING','INFO','DEBUG'], { placeHolder: 'Log level' });
      if (v) opts.logLevel = v;
    }

    // Delegate execution to the service (uses venv PATH so ruff is found)
    await this.service.convertHar(harPath, outUri, opts);
  }
}
