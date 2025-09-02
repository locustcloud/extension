import * as vscode from 'vscode';
import * as path from 'path';
import { LocustTreeProvider } from './locustTree';

const LOCUST_TERMINAL_NAME = 'Locust';

export function activate(context: vscode.ExtensionContext) {
  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  context.subscriptions.push(treeView, tree); // tree is Disposable

  context.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('locust.runFileUI', (node) => runFile(node, 'ui')),
    vscode.commands.registerCommand('locust.runFileHeadless', (node) => runFile(node, 'headless')),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runTaskHeadless(node)),
    vscode.commands.registerCommand('locust.init', async () => {
      vscode.window.showInformationMessage('Locust: Initialize (stub). Add detection/uv env logic here.');
    }),

    // createSimulation: copies a template from the extension's templates/ into the workspace
    vscode.commands.registerCommand('locust.createSimulation', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace to create files.');
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('Open a folder first.');
        return;
      }

      // list templates/
      const templatesDir = vscode.Uri.joinPath(context.extensionUri, 'templates');

      // entries: [name, type]
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(templatesDir);
      } catch {
        vscode.window.showErrorMessage('No templates directory found in the extension.');
        return;
      }

      // List files with their full URIs
      const files = entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => vscode.Uri.joinPath(templatesDir, name));

      if (files.length === 0) {
        vscode.window.showErrorMessage('No template files found in templates/.');
        return;
      }

      // QuickPick items with uri attached
      type TemplatePick = vscode.QuickPickItem & { uri: vscode.Uri };
      const items: TemplatePick[] = files.map((u) => ({
        label: path.basename(u.fsPath),
        description: u.fsPath, // optional
        uri: u
      }));

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose a Locust template'
      });
      if (!choice) return;

      // choose destination filename
      const defaultName = choice.label.toLowerCase().includes('locustfile')
        ? choice.label
        : 'locustfile.py';
      const dest = vscode.Uri.joinPath(folder.uri, defaultName);

      // confirm overwrite if exists
      let shouldWrite = true;
      try {
        await vscode.workspace.fs.stat(dest);
        const overwrite = await vscode.window.showWarningMessage(
          `${defaultName} already exists. Overwrite?`,
          'Yes',
          'No'
        );
        shouldWrite = overwrite === 'Yes';
      } catch {
        /* not found; ok */
      }
      if (!shouldWrite) return;

      // copy + open
      const bytes = await vscode.workspace.fs.readFile(choice.uri);
      await vscode.workspace.fs.writeFile(dest, bytes);
      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Created ${defaultName} from template.`);
    }),

    vscode.commands.registerCommand('locust.runUI', async () => {
      // Optional global runner: run the default locustfile in workspace
      const file = await pickLocustfile();
      if (!file) return;
      runLocustFile(file.fsPath, 'ui');
    }),

    vscode.commands.registerCommand('locust.runHeadless', async () => {
      const file = await pickLocustfile();
      if (!file) return;
      runLocustFile(file.fsPath, 'headless');
    }),

    vscode.commands.registerCommand('locust.stop', async () => {
      const term = findLocustTerminal();
      if (!term) {
        vscode.window.showInformationMessage('No Locust session running.');
        return;
      }
      // Disposing terminal kills process group
      term.dispose();
      vscode.window.showInformationMessage('Locust: stopped.');
    }),
  );
}

export function deactivate() {}

// Run helpers CLI
type RunMode = 'ui' | 'headless';

function getConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    locustPath: cfg.get<string>('locust.path', 'locust'),
    envFolder: cfg.get<string>('locust.envFolder', '.venv'),
    defaultHost: cfg.get<string>('locust.defaultHost', '')
  };
}

function findLocustTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find(t => t.name === LOCUST_TERMINAL_NAME);
}

function getOrCreateLocustTerminal(): vscode.Terminal {
  return findLocustTerminal() ?? vscode.window.createTerminal({ name: LOCUST_TERMINAL_NAME });
}

async function ensureTerminalEnv(term: vscode.Terminal, envFolder: string) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  // Check if the venv folder exists
  const venvUri = vscode.Uri.joinPath(folder.uri, envFolder);
  try {
    const stat = await vscode.workspace.fs.stat(venvUri);
    if (!stat) return;
  } catch {
    // No venv — that's fine.
    return;
  }

  // Activate venv: POSIX vs Windows PowerShell
  const isWin = process.platform === 'win32';
  if (isWin) {
    // PowerShell: Activate.ps1
    term.sendText(`if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`);
  } else {
    // bash/zsh
    term.sendText(`if [ -f "${envFolder}/bin/activate" ]; then source "${envFolder}/bin/activate"; fi`);
  }
}

function buildLocustCommand(filePath: string, mode: RunMode): string {
  const { locustPath, defaultHost } = getConfig();
  const uiArgs = mode === 'headless' ? '--headless' : '';
  const hostArg = defaultHost ? `-H "${defaultHost}"` : '';
  // Trim to avoid trailing spaces when args are empty
  return `${locustPath} -f "${filePath}" ${uiArgs} ${hostArg}`.trim();
}

function runLocustFile(filePath: string, mode: RunMode) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust this workspace to run commands.');
    return;
  }
  const term = getOrCreateLocustTerminal();
  term.show();
  const { envFolder } = getConfig();
  // Activate venv if present, then run
  ensureTerminalEnv(term, envFolder);
  term.sendText(buildLocustCommand(filePath, mode));
}

//Commands called from the tree/context menu
function runFile(node: any, mode: RunMode) {
  const filePath = node?.filePath ?? node?.resourceUri?.fsPath;
  if (!filePath) {
    vscode.window.showWarningMessage('No file node provided.');
    return;
  }
  runLocustFile(filePath, mode);
}

function runTaskHeadless(node: any) {
  const { filePath, taskName } = node ?? {};
  if (!filePath || !taskName) {
    vscode.window.showWarningMessage('No task node provided.');
    return;
  }
  // NOTE: Locust CLI does not natively run a single @task function.
  // In practice, you’d structure tasks by User classes or flags.
  // For now, we run the whole file headless. Later you could add
  // environment variables or custom filtering inside your locustfile.
  runLocustFile(filePath, 'headless');
}


// Utility
async function pickLocustfile(): Promise<vscode.Uri | undefined> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showWarningMessage('Open a folder first.');
    return;
  }
  const files = await vscode.workspace.findFiles('**/locustfile*.py', '**/{.venv,.git,__pycache__}/**', 50);
  if (files.length === 0) {
    vscode.window.showWarningMessage('No locustfile found in this workspace.');
    return;
  }
  if (files.length === 1) return files[0];

  const picks = files.map(u => ({
    label: vscode.workspace.asRelativePath(u),
    uri: u
  }));
  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
  return choice?.uri;
}
