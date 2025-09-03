import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { LocustTreeProvider } from './locustTree';

const execFileAsync = promisify(execFile);
const LOCUST_TERMINAL_NAME = 'Locust';
const WS_SETUP_KEY = 'locust.setupCompleted'; // workspaceState flag

export function activate(context: vscode.ExtensionContext) {
  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  context.subscriptions.push(treeView, tree); // tree is Disposable

  // Prompt set up env/locust on first activation (trusted workspaces only)
  checkAndOfferSetup(context).catch(err => console.error(err));

  context.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('locust.runFileUI', (node) => runFile(node, 'ui')),
    vscode.commands.registerCommand('locust.runFileHeadless', (node) => runFile(node, 'headless')),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runTaskHeadless(node)),
    vscode.commands.registerCommand('locust.init', async () => {
      // Expose setup via a command
      await checkAndOfferSetup(context, { forcePrompt: true });
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

      // Locust accepts comma-separated tags in a single --tags argument
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

      const templatesDir = vscode.Uri.joinPath(context.extensionUri, 'templates');
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
        label: path.basename(u.fsPath),
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
    
    vscode.commands.registerCommand('locust.stop', async () => {
      const term = findLocustTerminal();
      if (!term) {
        vscode.window.showInformationMessage('No Locust session running.');
        return;
      }
      term.dispose();
      vscode.window.showInformationMessage('Locust: stopped.');
    }),
  );
}

export function deactivate() {}

// Setup Detection
function getConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    locustPath: cfg.get<string>('locust.path', 'locust'),
    envFolder: cfg.get<string>('locust.envFolder', 'locust_env'),
    defaultHost: cfg.get<string>('locust.defaultHost', '')
  };
}

async function checkAndOfferSetup(
  context: vscode.ExtensionContext,
  opts: { forcePrompt?: boolean } = {}
) {
  if (!vscode.workspace.isTrusted) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const already = context.workspaceState.get<boolean>(WS_SETUP_KEY);
  const { locustPath, envFolder } = getConfig();

  // 1) Only prompt if Locust isn't available (unless forcePrompt)
  const hasLocust = await isLocustAvailable(locustPath);
  if (hasLocust && !opts.forcePrompt) {
    await context.workspaceState.update(WS_SETUP_KEY, true);
    return;
  }

  // 2) Detect pyproject + [loadtest] extra
  const pyInfo = await detectPyprojectInfo(folder.uri);

  // 3) Build choices
  const uvAvailable = await isOnPath('uv', ['--version']);
  const picks: vscode.QuickPickItem[] = [];
  if (uvAvailable) {
    if (pyInfo.hasPyproject) {
      picks.push(
        { label: 'Use uv (recommended): Install project (+[loadtest] if present)', detail: `Create ${envFolder}, uv install -e .[loadtest]` },
        { label: 'Use uv: Locust only', detail: `Create ${envFolder}, uv install locust` },
      );
    } else {
      picks.push(
        { label: 'Use uv (recommended): Locust only', detail: `Create ${envFolder}, uv install locust` },
      );
    }
  }
  // venv/pip options
  if (pyInfo.hasPyproject) {
    picks.push(
      { label: 'Use Python venv: Install project (+[loadtest] if present)', detail: `Create ${envFolder}, pip install -e .[loadtest]` },
      { label: 'Use Python venv: Locust only', detail: `Create ${envFolder}, pip install locust` },
    );
  } else {
    picks.push(
      { label: 'Use Python venv: Locust only', detail: `Create ${envFolder}, pip install locust` },
    );
  }
  picks.push({ label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' });

  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Set up a local Locust environment?' });
  if (!choice || choice.label.startsWith('Skip')) return;

  // 4) Resolve selection → installer + payload
  const useUv = choice.label.startsWith('Use uv');
  const installProject = choice.label.includes('Install project');
  const hasLoadtest = pyInfo.hasLoadtestExtra;

  // Decide what to "pip install"
  const installArg = installProject
    ? (hasLoadtest ? '-e ".[loadtest]"' : '-e .')
    : 'locust';

  // 5) Execute in terminal
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Setting up Locust environment', cancellable: false },
    async () => {
      const term = getOrCreateLocustTerminal();
      term.show();
      const workspacePath = folder.uri.fsPath;

      const isWin = process.platform === 'win32';
      const pyPath = isWin ? `${envFolder}\\Scripts\\python` : `${envFolder}/bin/python`;
      const pipPath = isWin ? `${envFolder}\\Scripts\\pip` : `${envFolder}/bin/pip`;

      term.sendText(`cd "${workspacePath}"`);

      if (useUv) {
        term.sendText(`uv venv "${envFolder}"`);
        // tie uv pip to the env's python explicitly
        term.sendText(`uv pip install --python "${pyPath}" --upgrade pip`);
        term.sendText(`uv pip install --python "${pyPath}" ${installArg}`);
      } else {
        if (isWin) {
          term.sendText(`python -m venv "${envFolder}"`);
          term.sendText(`if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`);
        } else {
          term.sendText(`python3 -m venv "${envFolder}"`);
          term.sendText(`if [ -f "${envFolder}/bin/activate" ]; then source "${envFolder}/bin/activate"; fi`);
        }
        // Always use env executables to avoid PEP 668 issues
        term.sendText(`"${pyPath}" -m pip install --upgrade pip`);
        term.sendText(`"${pipPath}" install ${installArg}`);
      }

      vscode.window.showInformationMessage(
        installProject
          ? `Installing project${hasLoadtest ? ' (+[loadtest])' : ''} into ${envFolder}...`
          : `Installing Locust into ${envFolder}...`
      );
      await context.workspaceState.update(WS_SETUP_KEY, true);
    }
  );
}

async function detectPyprojectInfo(root: vscode.Uri): Promise<{ hasPyproject: boolean; hasLoadtestExtra: boolean; }> {
  const pyUri = vscode.Uri.joinPath(root, 'pyproject.toml');
  try {
    const stat = await vscode.workspace.fs.stat(pyUri);
    if (!stat) return { hasPyproject: false, hasLoadtestExtra: false };
    const bytes = await vscode.workspace.fs.readFile(pyUri);
    const text = Buffer.from(bytes).toString('utf8');
    // naive detection of the extra
    const hasExtras = /\[project\.optional-dependencies\]/.test(text);
    const hasLoadtest = hasExtras && /^\s*loadtest\s*=\s*\[/m.test(text);
    return { hasPyproject: true, hasLoadtestExtra: hasLoadtest };
  } catch {
    return { hasPyproject: false, hasLoadtestExtra: false };
  }
}

async function isLocustAvailable(locustPath: string): Promise<boolean> {
  try {
    await execFileAsync(locustPath, ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function isOnPath(binary: string, args: string[] = []): Promise<boolean> {
  try {
    await execFileAsync(binary, args);
    return true;
  } catch {
    return false;
  }
}

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

// Commands called from the tree/context menu
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
  // Also ignore locust_env now
  const files = await vscode.workspace.findFiles('**/locustfile*.py', '**/{locust_env,.venv,.git,__pycache__}/**', 50);
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
