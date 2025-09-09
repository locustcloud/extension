import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import { EnvService } from './envService';
import { getConfig } from '../core/config';
import * as fs from 'fs/promises';

const execFile = promisify(cp.execFile);

export class Har2LocustService {
  constructor(private env: EnvService) {}

  async convertHarInteractive() {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select HAR file',
      filters: { HAR: ['har'], All: ['*'] }
    });
    if (!picked || picked.length === 0) return;
    const harPath = picked[0].fsPath;

    // Use a dedicated output dir to avoid tooling races (e.g., Ruff)
    const outDir = vscode.Uri.joinPath(ws.uri, 'mcp-generated');
    try { await vscode.workspace.fs.stat(outDir); } catch { await vscode.workspace.fs.createDirectory(outDir); }

    const outName = await vscode.window.showInputBox({
      prompt: 'Enter output locustfile name',
      value: 'locustfile_from_har.py',
      validateInput: (v) => v.trim() ? undefined : 'File name is required'
    });
    if (!outName) return;

    const outUri = vscode.Uri.joinPath(outDir, outName);

    const applyOptions = await vscode.window.showQuickPick(
      [
        { label: 'No options (recommended)', description: 'Just convert', picked: true, id: 'none' },
        { label: 'Set template path…', description: 'har2locust --template <path>', id: 'template' },
        { label: 'Plugins…', description: 'har2locust --plugins <pkg1,script2.py>', id: 'plugins' },
        { label: 'Disable default plugins…', description: 'har2locust --disable-plugins <comma,list>', id: 'disable' },
        { label: 'Resource types…', description: 'har2locust --resource-types <xhr,document,...>', id: 'res' },
        { label: 'Log level…', description: 'har2locust --loglevel <level>', id: 'log' },
      ],
      { placeHolder: 'Optional: add har2locust flags?', canPickMany: true }
    );

    const opts: Har2LocustOptions = {};
    if (applyOptions?.some(o => o.id === 'template')) {
      const v = await vscode.window.showInputBox({ prompt: 'Template path (e.g. locust.jinja2)' });
      if (v) opts.template = v;
    }
    if (applyOptions?.some(o => o.id === 'plugins')) {
      const v = await vscode.window.showInputBox({ prompt: 'Plugins (comma-separated)', placeHolder: 'har2locust.extra_plugins.plugin_example,myplugin.py' });
      if (v) opts.plugins = v;
    }
    if (applyOptions?.some(o => o.id === 'disable')) {
      const v = await vscode.window.showInputBox({ prompt: 'Disable default plugins (comma-separated)', placeHolder: 'rest.py' });
      if (v) opts.disablePlugins = v;
    }
    if (applyOptions?.some(o => o.id === 'res')) {
      const v = await vscode.window.showInputBox({ prompt: 'Resource types (comma-separated)', placeHolder: 'xhr,document,other' });
      if (v) opts.resourceTypes = v;
    }
    if (applyOptions?.some(o => o.id === 'log')) {
      const v = await vscode.window.showQuickPick(['CRITICAL','ERROR','WARNING','INFO','DEBUG'], { placeHolder: 'Log level' });
      if (v) opts.logLevel = v;
    }

    await this.convertHar(harPath, outUri, opts);
  }

  async convertHar(harPath: string, outUri: vscode.Uri, opts: Har2LocustOptions = {}) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    const { envFolder } = getConfig();
    const py = this.env.getEnvInterpreterPath(envFolder) || 'python';

    // Build args safely (no shell needed)
    const args: string[] = ['-m', 'har2locust'];
    if (opts.template) { args.push('--template', opts.template); }
    if (opts.plugins) { args.push('--plugins', opts.plugins); }
    if (opts.disablePlugins) { args.push('--disable-plugins', opts.disablePlugins); }
    if (opts.resourceTypes) { args.push('--resource-types', opts.resourceTypes); }
    if (opts.logLevel) { args.push('--loglevel', opts.logLevel); }
    args.push(harPath);

    const cwd = ws.uri.fsPath;

    try {
      const { stdout } = await execFile(py, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
      await fs.writeFile(outUri.fsPath, stdout, 'utf8');

      const doc = await vscode.workspace.openTextDocument(outUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
    } catch (err: any) {
      const msg = err?.stderr || err?.message || String(err);
      vscode.window.showErrorMessage(`har2locust failed: ${msg}`);
    }
  }
}

export interface Har2LocustOptions {
  template?: string;
  plugins?: string;          // comma-separated
  disablePlugins?: string;   // comma-separated
  resourceTypes?: string;    // comma-separated
  logLevel?: string;         // e.g. INFO / DEBUG
}
