import * as vscode from 'vscode';
import * as path from 'path';
import { LocustTreeProvider } from './locustTree';
import { checkAndOfferSetup, getConfig, repairWorkspaceInterpreterIfBroken } from './setup';

const LOCUST_TERMINAL_NAME = 'Locust';

export function activate(ctx: vscode.ExtensionContext) {
  // Try to repair a broken Python interpreter setting on startup (cross-platform).
  // If locust_env exists, it will re-point python.defaultInterpreterPath to it.
  repairWorkspaceInterpreterIfBroken().catch(err => console.error(err));

  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  ctx.subscriptions.push(treeView, tree); // tree is Disposable

  // Prompt set up env/locust on first activation (trusted workspaces only)
  checkAndOfferSetup(ctx).catch(err => console.error(err));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('locust.runFileUI', (node) => runFile(node, 'ui')),
    vscode.commands.registerCommand('locust.runFileHeadless', (node) => runFile(node, 'headless')),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runTaskHeadless(node)),
    vscode.commands.registerCommand('locust.init', async () => {
      // Expose setup via a command
      await checkAndOfferSetup(ctx, { forcePrompt: true });
    }),

    // Generic run commands (palette) <<<
    vscode.commands.registerCommand('locust.runUI', async () => {
      const file = await pickLocustfile();
      if (!file) return;
      runLocustFile(file.fsPath, 'ui');
    }),
    vscode.commands.registerCommand('locust.runHeadless', async () => {
      const file = await pickLocustfile();
      if (!file) return;
      runLocustFile(file.fsPath, 'headless');
    }),
  

    // NEW: Run by Tag… (prompts for tag(s) and runs headless with --tags)
    vscode.commands.registerCommand('locust.runByTag', async () => {
      const file = await pickLocustfile();
      if (!file) return;

      const tag = await vscode.window.showInputBox({
        prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
        placeHolder: 'e.g. checkout,auth'
      });
      if (!tag) return;

      // Locust accepts comma-separated tags in single --tags argument
      runLocustFile(file.fsPath, 'headless', [`--tags ${tag}`]);
    }),

    // createSimulation: copies a template from extension's templates/ into workspace
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

      const templatesDir = vscode.Uri.joinPath(ctx.extensionUri, 'templates');
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(templatesDir);
      } catch {
        vscode.window.showErrorMessage('No templates directory found in the extension.');
        return;
      }

      const files = entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => vscode.Uri.joinPath(templatesDir, name));

      if (files.length === 0) {
        vscode.window.showErrorMessage('No template files found in templates/.');
        return;
      }

      type TemplatePick = vscode.QuickPickItem & { uri: vscode.Uri };
      const items: TemplatePick[] = files.map((u) => ({
        label: require('path').basename(u.fsPath),
        description: u.fsPath,
        uri: u
      }));

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose a Locust template'
      });
      if (!choice) return;

      const folderUri = folder.uri;
      const defaultName = choice.label.toLowerCase().includes('locustfile') ? choice.label : 'locustfile.py';
      const dest = vscode.Uri.joinPath(folderUri, defaultName);

      let shouldWrite = true;
      try {
        await vscode.workspace.fs.stat(dest);
        const overwrite = await vscode.window.showWarningMessage(
          `${defaultName} already exists. Overwrite?`,
          'Yes',
          'No'
        );
        shouldWrite = overwrite === 'Yes';
      } catch { /* not found */ }
      if (!shouldWrite) return;

      const bytes = await vscode.workspace.fs.readFile(choice.uri);
      await vscode.workspace.fs.writeFile(dest, bytes);
      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Created ${defaultName} from template.`);
    }),
  );
}

export function deactivate() {}

// Run Helpers
type RunMode = 'ui' | 'headless';

function findLocustTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find(t => t.name === LOCUST_TERMINAL_NAME);
}

function getOrCreateLocustTerminal(): vscode.Terminal {
  return findLocustTerminal() ?? vscode.window.createTerminal({ name: LOCUST_TERMINAL_NAME });
}

async function ensureTerminalEnv(term: vscode.Terminal, envFolder: string) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const venvUri = vscode.Uri.joinPath(folder.uri, envFolder);
  try { await vscode.workspace.fs.stat(venvUri); } catch { return; }

  const isWin = process.platform === 'win32';
  if (isWin) {
    term.sendText(`if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`);
  } else {
    term.sendText(`if [ -f "${envFolder}/bin/activate" ]; then source "${envFolder}/bin/activate"; fi`);
  }
}

function buildLocustCommand(filePath: string, mode: RunMode, extraArgs: string[] = []): string {
  const { locustPath, defaultHost } = getConfig();
  const headless = mode === 'headless' ? '--headless' : '';
  const host = defaultHost ? `-H "${defaultHost}"` : '';
  const extras = extraArgs.join(' ');
  return `${locustPath} -f "${filePath}" ${headless} ${host} ${extras}`.trim();
}

function runLocustFile(filePath: string, mode: RunMode, extraArgs: string[] = []) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust this workspace to run commands.');
    return;
  }
  const term = getOrCreateLocustTerminal();
  term.show();
  const { envFolder } = getConfig();
  ensureTerminalEnv(term, envFolder);
  term.sendText(buildLocustCommand(filePath, mode, extraArgs));
}

// Commands called from tree/context menu
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
  // Runs whole file; TODO: custom filters per-task later
  runLocustFile(filePath, 'headless');
}

// Utility
async function pickLocustfile(): Promise<vscode.Uri | undefined> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showWarningMessage('Open a folder first.');
    return;
  }

  // Build ignore globs dynamically from config
  const { envFolder } = getConfig();
  const ignoreDirs = new Set([envFolder, '.venv', '.git', '__pycache__', 'node_modules']);
  // Normalize empty/edge cases
  const ignoreList = Array.from(ignoreDirs).filter(Boolean);
  const ignoreGlob = ignoreList.length
    ? `**/{${ignoreList.join(',')}}/**`
    : ''; // no ignores if list empty

  const files = await vscode.workspace.findFiles('**/locustfile*.py', ignoreGlob, 50);

  if (files.length === 0) {
    vscode.window.showWarningMessage('No locustfile found in this workspace.');
    return;
  }
  if (files.length === 1) return files[0];

  // Sort: prefer files closer to workspace root
  const picks = files
    .sort((a, b) => a.fsPath.length - b.fsPath.length)
    .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));

  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
  return choice?.uri;
}
