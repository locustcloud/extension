import * as vscode from 'vscode';
import * as path from 'path';
import { EnvService } from './envService';
import { getConfig } from '../core/config';

/**
 * HAR → Locustfile helper service (no Copilot required).
 * Runs:  "<env python> -m har2locust [options] <input.har> > <output.py>"
 */
export class Har2LocustService {
  constructor(private env: EnvService) {}

  /**
   * Interactive flow:
   * - Pick HAR file
   * - Choose/confirm output filename (defaults inside workspace/templates/)
   * - Optional: quick flags (template, plugins, disablePlugins, resourceTypes, log level)
   * - Writes file, opens it, refreshes tree
   */
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

    // Select HAR
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select HAR file',
      filters: { HAR: ['har'], All: ['*'] }
    });
    if (!picked || picked.length === 0) return;
    const harPath = picked[0].fsPath;

    // Build default output path under workspace/templates/
    const templatesDir = vscode.Uri.joinPath(ws.uri, 'templates');
    try { await vscode.workspace.fs.stat(templatesDir); } catch { await vscode.workspace.fs.createDirectory(templatesDir); }

    const outName = await vscode.window.showInputBox({
      prompt: 'Enter output locustfile name',
      value: 'locustfile_from_har.py',
      validateInput: (v) => v.trim() ? undefined : 'File name is required'
    });
    if (!outName) return;

    const outUri = vscode.Uri.joinPath(templatesDir, outName);

    // Quick optional flags (kept very lightweight)
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

    // Gather values for chosen options
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

  /**
   * Core runner. Writes to outUri, opens the file, refreshes tree.
   */
  async convertHar(harPath: string, outUri: vscode.Uri, opts: Har2LocustOptions = {}) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    const term = vscode.window.createTerminal({ name: 'Locust (HAR→Locust)' });
    term.show();

    const { envFolder } = getConfig();
    const py = this.env.getEnvInterpreterPath(envFolder);

    const args: string[] = [];
    if (opts.template) args.push(`--template "${opts.template}"`);
    if (opts.plugins) args.push(`--plugins "${opts.plugins}"`);
    if (opts.disablePlugins) args.push(`--disable-plugins "${opts.disablePlugins}"`);
    if (opts.resourceTypes) args.push(`--resource-types "${opts.resourceTypes}"`);
    if (opts.logLevel) args.push(`--loglevel "${opts.logLevel}"`);

    // Run in workspace root so relative template paths (if any) behave intuitively
    term.sendText(`cd "${ws.uri.fsPath}"`);
    term.sendText(`"${py}" -m har2locust ${args.join(' ')} "${harPath}" > "${outUri.fsPath}"`);

    // Try to open when the shell has flushed output
    const openLater = async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(outUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
      } catch {
        setTimeout(openLater, 400);
      }
    };
    setTimeout(openLater, 300);
  }
}

export interface Har2LocustOptions {
  template?: string;
  plugins?: string;          // comma-separated
  disablePlugins?: string;   // comma-separated
  resourceTypes?: string;    // comma-separated
  logLevel?: string;         // e.g. INFO / DEBUG
}
