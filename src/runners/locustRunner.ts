import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';
import path from 'path';

/**
 * Locust run functions.
 * Runs in a dedicated terminal named "Locust"
 * Uses config settings for locust path, env folder, default host
 */

type RunMode = 'ui' | 'headless';

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class LocustRunner {
  constructor(private env: EnvService, private extensionUri: vscode.Uri) {}

  private findLocustTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find(t => t.name === 'Locust');
  }

  private getOrCreateLocustTerminal(): vscode.Terminal {
    return this.findLocustTerminal() ?? vscode.window.createTerminal({ name: 'Locust' });
  }

  private buildLocustCommand(filePath: string, mode: RunMode, extraArgs: string[] = []): string {
    const { locustPath, defaultHost } = getConfig();
    const headless = mode === 'headless' ? '--headless' : '';
    const host = defaultHost ? `-H "${defaultHost}"` : '';
    const extras = extraArgs.join(' ');
    return `${locustPath} -f "${filePath}" ${headless} ${host} ${extras}`.trim();
  }

  /**
   * Opens the Locust UI in VS Code's Simple Browser with a short delay.
   * Falls back to external browser if the Simple Browser command is unavailable.
   */
  private openLocustUIBrowser(url: vscode.Uri = vscode.Uri.parse('http://127.0.0.1:8089')) {
    // Small delay gives Locust a moment to start its web UI
    const open = () => {
      // Try Simple Browser first
      vscode.commands.executeCommand('simpleBrowser.show', url).then(
        undefined,
        // Fallback: open in external browser
        () => vscode.env.openExternal(url)
      );
    };

    // Try quickly, then once more as a gentle fallback
    setTimeout(open, 600);
    setTimeout(open, 1800);
  }

  private runLocustFile(filePath: string, mode: RunMode, extraArgs: string[] = []) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    const term = this.getOrCreateLocustTerminal();
    term.show();
    const { envFolder } = getConfig();
    this.env.ensureTerminalEnv(term, envFolder);
    term.sendText(this.buildLocustCommand(filePath, mode, extraArgs));

    // Always open Simple Browser when starting in UI mode
    if (mode === 'ui') {
      this.openLocustUIBrowser();
    }
  }

    async runFile(filePath: string | undefined, mode: RunMode) {
    let targetPath = filePath;

    // Fallback 1: active editor if it's a locustfile
    if (!targetPath) {
      const active = vscode.window.activeTextEditor?.document;
      if (active && /(?:^|\/)locustfile.*\.py$/i.test(active.fileName)) {
        targetPath = active.fileName;
      }
    }

    // Fallback 2: quick pick a locustfile
    if (!targetPath) {
      const picked = await this.pickLocustfile();
      if (picked) targetPath = picked.fsPath;
    }

    if (!targetPath) {
      vscode.window.showWarningMessage('No locustfile selected.');
      return;
    }

    this.runLocustFile(targetPath, mode);
  }


  async runTaskHeadless(node: any) {
    const { filePath, taskName } = node ?? {};
    if (!filePath || !taskName) {
      vscode.window.showWarningMessage('No task node provided.');
      return;
    }
    // Runs whole file; TODO: custom filters per-task later
    this.runLocustFile(filePath, 'headless');
  }

  // Palette helpers.
  async runSelected(mode: RunMode) {
    const file = await this.pickLocustfile();
    if (!file) return;
    this.runLocustFile(file.fsPath, mode);
  }

  async runByTag() {
    const file = await this.pickLocustfile();
    if (!file) return;

    const tag = await vscode.window.showInputBox({
      prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
      placeHolder: 'e.g. checkout,auth'
    });
    if (!tag) return;

    this.runLocustFile(file.fsPath, 'headless', [`--tags ${tag}`]);
  }

  private async pickLocustfile(): Promise<vscode.Uri | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    const { envFolder } = getConfig();
    const ignoreDirs = new Set([envFolder, '.venv', '.git', '__pycache__', 'node_modules']);
    const ignoreList = Array.from(ignoreDirs).filter(Boolean);
    const ignoreGlob = ignoreList.length ? `**/{${ignoreList.join(',')}}/**` : '';

    const files = await vscode.workspace.findFiles('**/locustfile*.py', ignoreGlob, 50);

    if (files.length === 0) {
      // AUTO-CREATE from extension template on first run
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace to create files.');
        return;
      }
      const templatesDir = uriJoinPath(this.extensionUri, 'templates');
      try {
        const entries = await vscode.workspace.fs.readDirectory(templatesDir);
        const locustfileEntry = entries.find(
          ([name, type]) => type === vscode.FileType.File && name.toLowerCase() === 'locustfile.py'
        );
        const templateUri = locustfileEntry
          ? uriJoinPath(templatesDir, locustfileEntry[0])
          : uriJoinPath(templatesDir, entries.find(([, t]) => t === vscode.FileType.File)![0]);

        const bytes = await vscode.workspace.fs.readFile(templateUri);
        const dest = uriJoinPath(ws.uri, 'locustfile.py');
        await vscode.workspace.fs.writeFile(dest, bytes);

        const doc = await vscode.workspace.openTextDocument(dest);
        await vscode.window.showTextDocument(doc, { preview: false });

        // Refresh the Locust tree immediately
        vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});

        vscode.window.showInformationMessage('Created locustfile.py from template.');
        return dest;
      } catch {
        vscode.window.showErrorMessage('No templates directory or template file found in the extension.');
        return;
      }
    }

    if (files.length === 1) return files[0];

    const picks = files
      .sort((a, b) => a.fsPath.length - b.fsPath.length)
      .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));

    const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
    return choice?.uri;
  }
}
