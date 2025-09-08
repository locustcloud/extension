import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import { EnvService } from '../services/envService';

/**
 * Locust run functions.
 * Runs in a dedicated terminal named "Locust"
 * Uses config settings for locust path, env folder, default host
 */

type RunMode = 'ui' | 'headless';


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
  }

  async convertHar() {
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
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select HAR file',
      filters: { HAR: ['har'], All: ['*'] }
    });
    if (!chosen || chosen.length === 0) return;
    const harPath = chosen[0].fsPath;

    // Output name
    const outName = await vscode.window.showInputBox({
      prompt: 'Enter output locustfile name',
      value: 'locustfile_from_har.py'
    });
    if (!outName) return;

    const outUri = vscode.Uri.joinPath(ws.uri, outName);

    // Run inside locust_env
    const term = vscode.window.createTerminal({ name: 'Locust (HAR→Locust)' });
    term.show();

    const { envFolder } = getConfig();
    const py = this.env.getEnvInterpreterPath(envFolder);

    term.sendText(`cd "${ws.uri.fsPath}"`);
    // Use module entrypoint to avoid CLI name confusion (har-to-locust vs har2locust)
    term.sendText(`"${py}" -m har2locust "${harPath}" > "${outUri.fsPath}"`);

    // Open result
    try {
      const doc = await vscode.workspace.openTextDocument(outUri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      // If the file isn't ready yet (shell redirection), try again after a tick
      setTimeout(async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(outUri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch { /* no-op */ }
      }, 500);
    }
  }

  async runFile(filePath: string | undefined, mode: RunMode) {
    if (!filePath) {
      vscode.window.showWarningMessage('No file node provided.');
      return;
    }
    this.runLocustFile(filePath, mode);
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

  //  Palette helpers.
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
      const templatesDir = vscode.Uri.joinPath(this.extensionUri, 'templates');
      try {
        const entries = await vscode.workspace.fs.readDirectory(templatesDir);
        const locustfileEntry = entries.find(
          ([name, type]) => type === vscode.FileType.File && name.toLowerCase() === 'locustfile.py'
        );
        const templateUri = locustfileEntry
          ? vscode.Uri.joinPath(templatesDir, locustfileEntry[0])
          : vscode.Uri.joinPath(templatesDir, entries.find(([, t]) => t === vscode.FileType.File)![0]);

        const bytes = await vscode.workspace.fs.readFile(templateUri);
        const dest = vscode.Uri.joinPath(ws.uri, 'locustfile.py');
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
