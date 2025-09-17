import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import { EnvService } from './envService';
import { getConfig } from '../core/config';
import * as fs from 'fs/promises';

const execFile = promisify(cp.execFile);

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

// ✅ Build a venv-like env for child processes given an absolute python path
function envForVenvFromPython(absPython: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const venvDir = path.dirname(path.dirname(absPython)); // .../.locust_env/{bin|Scripts}/python -> .../.locust_env
  const binDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  env.VIRTUAL_ENV = venvDir;
  env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ''}`;
  return env;
}

export class Har2LocustService {
  constructor(private env: EnvService) {}

  // ... convertHarInteractive unchanged ...

  /**
   * Core runner. Spawns `python -m har2locust`, captures stdout, writes file, opens it.
   */
  async convertHar(harPath: string, outUri: vscode.Uri, opts: Har2LocustOptions = {}) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { return; }

    const { envFolder } = getConfig();

    let py: string;
    try {
      py = await this.env.resolvePythonStrict(envFolder);
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Python not found. Run “Locust: Initialize (Install/Detect)” to create ${envFolder}, or set “python.defaultInterpreterPath”. ${e?.message ?? ''}`.trim()
      );
      return;
    }

    const baseArgs: string[] = ['-m', 'har2locust'];
    if (opts.template)        { baseArgs.push('--template', opts.template); }
    if (opts.plugins)         { baseArgs.push('--plugins', opts.plugins); }
    if (opts.disablePlugins)  { baseArgs.push('--disable-plugins', opts.disablePlugins); }
    if (opts.resourceTypes)   { baseArgs.push('--resource-types', opts.resourceTypes); }
    if (opts.logLevel)        { baseArgs.push('--loglevel', opts.logLevel); }
    baseArgs.push(harPath);

    const cwd = ws.uri.fsPath;
    const childEnv = envForVenvFromPython(py); // ⭐ ensure venv bin (ruff) is on PATH

    const runOnce = async (extraArgs: string[] = []) => {
      const args = [...baseArgs, ...extraArgs];
      return execFile(py, args, { cwd, env: childEnv, maxBuffer: 20 * 1024 * 1024 });
    };

    try {
      const { stdout } = await runOnce();
      await fs.writeFile(outUri.fsPath, stdout, 'utf8');
      const doc = await vscode.workspace.openTextDocument(outUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
    } catch (err: any) {
      const stderr = err?.stderr || '';
      const message = stderr || err?.message || String(err);

      // If the default ruff plugin failed because the 'ruff' binary wasn't found, try again without it.
      const missingRuff =
        message.includes(`No such file or directory: 'ruff'`) ||
        message.includes('ENOENT') && message.toLowerCase().includes('ruff');

      if (missingRuff) {
        try {
          // har2locust ships plugin as default_plugins/ruff.py, disabling by basename works
          const { stdout } = await runOnce(['--disable-plugins', 'ruff.py']);
          await fs.writeFile(outUri.fsPath, stdout, 'utf8');
          const doc = await vscode.workspace.openTextDocument(outUri);
          await vscode.window.showTextDocument(doc, { preview: false });
          vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
          vscode.window.showInformationMessage(
            'har2locust: ruff not found on PATH, ran conversion with ruff plugin disabled.'
          );
          return;
        } catch (err2: any) {
          const msg2 = (err2?.stderr || err2?.message || String(err2));
          vscode.window.showErrorMessage(`har2locust failed (even after disabling ruff): ${msg2}`);
          return;
        }
      }

      const extra =
        /No module named ['"]?har2locust['"]?/.test(message) || /ModuleNotFoundError:.*har2locust/.test(message)
          ? ' Tip: run “Locust: Initialize (Install/Detect)” to install har2locust into the selected interpreter.'
          : '';
      vscode.window.showErrorMessage(`har2locust failed: ${message}${extra}`);
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