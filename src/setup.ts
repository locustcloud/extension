import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path'; // <-- added

const execFileAsync = promisify(execFile);
const LOCUST_TERMINAL_NAME = 'Locust';
const WS_SETUP_KEY = 'locust.setupCompleted'; // workspaceState flag

export function getConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    locustPath: cfg.get<string>('locust.path', 'locust'),
    envFolder: cfg.get<string>('locust.envFolder', 'locust_env'),
    defaultHost: cfg.get<string>('locust.defaultHost', '')
  };
}

/**
 * Creates a fresh terminal named "Locust", disposes the old one,
 * best-effort deactivates active venv to avoid cross-contamination.
 */
function createFreshLocustTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find(t => t.name === LOCUST_TERMINAL_NAME);
  existing?.dispose();

  const term = vscode.window.createTerminal({ name: LOCUST_TERMINAL_NAME });
  term.show();

  // Best-effort 'deactivate' if venv is currently active in shell.
  if (process.platform === 'win32') {
    term.sendText('if (Get-Command deactivate -ErrorAction SilentlyContinue) { deactivate }');
  } else {
    term.sendText('type deactivate >/dev/null 2>&1 && deactivate || true');
  }
  return term;
}

/**
 * Returns true if a given binary is on PATH and runs without error.
 */
async function isOnPath(binary: string, args: string[] = []): Promise<boolean> {
  try {
    await execFileAsync(binary, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if `locust` appears available.
 */
async function isLocustAvailable(locustPath: string): Promise<boolean> {
  try {
    await execFileAsync(locustPath, ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if pyproject exists and declares optional dependency group named [loadtest].
 */
async function detectPyprojectInfo(root: vscode.Uri): Promise<{ hasPyproject: boolean; hasLoadtestExtra: boolean; }> {
  const pyUri = vscode.Uri.joinPath(root, 'pyproject.toml');
  try {
    await vscode.workspace.fs.stat(pyUri);
    const bytes = await vscode.workspace.fs.readFile(pyUri);
    const text = Buffer.from(bytes).toString('utf8');
    const hasExtras = /\[project\.optional-dependencies\]/.test(text);
    const hasLoadtest = hasExtras && /^\s*loadtest\s*=\s*\[/m.test(text);
    return { hasPyproject: true, hasLoadtestExtra: hasLoadtest };
  } catch {
    return { hasPyproject: false, hasLoadtestExtra: false };
  }
}

/* -------------------- interpreter helpers (new/safe) -------------------- */

function getEnvInterpreterPath(envFolder: string): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return '';
  const isWin = process.platform === 'win32';
  return isWin
    ? path.join(ws.uri.fsPath, envFolder, 'Scripts', 'python.exe')
    : path.join(ws.uri.fsPath, envFolder, 'bin', 'python');
}

async function fileExists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

async function isInterpreterPathValid(interpreterPath: string): Promise<boolean> {
  if (!interpreterPath) return false;
  return fileExists(interpreterPath);
}

/**
 * Set workspace's Python interpreter to created env, enable terminal
 * auto-activation for UX. Only writes if the path exists.
 */
export async function setWorkspacePythonInterpreter(envFolder: string) {
  const interpreter = getEnvInterpreterPath(envFolder);
  if (!await isInterpreterPathValid(interpreter)) {
    vscode.window.showWarningMessage(
      `Locust env interpreter not found at: ${interpreter}. Run “Locust: Initialize (Install/Detect)” to create it.`
    );
    return;
  }

  await vscode.workspace
    .getConfiguration('python')
    .update('defaultInterpreterPath', interpreter, vscode.ConfigurationTarget.Workspace);

  await vscode.workspace
    .getConfiguration('python')
    .update('terminal.activateEnvironment', true, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage(`Workspace Python interpreter set to: ${interpreter}`);
}

/**
 * Optional: call on activation to repair an invalid interpreter path.
 * If locust_env exists, re-point to it. Otherwise clear the setting.
 */
export async function repairWorkspaceInterpreterIfBroken() {
  const cfg = vscode.workspace.getConfiguration('python');
  const current = cfg.get<string>('defaultInterpreterPath');
  const { envFolder } = getConfig();

  const currentValid = current ? await isInterpreterPathValid(current) : false;
  if (currentValid) return;

  const envInterp = getEnvInterpreterPath(envFolder);
  const envValid = await isInterpreterPathValid(envInterp);

  if (envValid) {
    await cfg.update('defaultInterpreterPath', envInterp, vscode.ConfigurationTarget.Workspace);
    await cfg.update('terminal.activateEnvironment', true, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`Repaired Python interpreter → ${envInterp}`);
  } else {
    await cfg.update('defaultInterpreterPath', undefined, vscode.ConfigurationTarget.Workspace);
    vscode.window.showWarningMessage(
      'No valid Python interpreter found for this workspace. Run “Locust: Initialize (Install/Detect)” to create locust_env.'
    );
  }
}

/* ------------------------------- main setup ------------------------------ */

/**
 * Main setup entry:
 * - prompts only if locust isn't available (unless forced),
 * - pip-only,
 * - deactivates any existing venv in a fresh terminal,
 * - creates envFolder (default: locust_env),
 * - installs either project (-e .[loadtest]) or locust,
 * - activates the new env,
 * - sets the workspace interpreter to the new env (if valid).
 */
export async function checkAndOfferSetup(
  context: vscode.ExtensionContext,
  opts: { forcePrompt?: boolean } = {}
) {
  if (!vscode.workspace.isTrusted) return;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const { locustPath, envFolder } = getConfig();

  const already = context.workspaceState.get<boolean>(WS_SETUP_KEY);
  const hasLocust = await isLocustAvailable(locustPath);

  if (hasLocust && !opts.forcePrompt) {
    await context.workspaceState.update(WS_SETUP_KEY, true);
    return;
  }

  // Optional UX: if repo has pyproject, offer "install project" vs "locust only"
  const pyInfo = await detectPyprojectInfo(folder.uri);
  const picks: vscode.QuickPickItem[] = pyInfo.hasPyproject
    ? [
        { label: 'Set up with venv + pip: Install project (+[loadtest] if present)', detail: `Create ${envFolder} and pip install -e .[loadtest]` },
        { label: 'Set up with venv + pip: Locust only', detail: `Create ${envFolder} and pip install locust` },
        { label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' }
      ]
    : [
        { label: 'Set up with venv + pip: Locust only', detail: `Create ${envFolder} and pip install locust` },
        { label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' }
      ];

  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Set up a local Locust environment?' });
  if (!choice || choice.label.startsWith('Skip')) return;

  const installProject = choice.label.includes('Install project');
  const installArg = installProject
    ? (pyInfo.hasLoadtestExtra ? '-e ".[loadtest]"' : '-e .')
    : 'locust';

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Setting up Locust environment', cancellable: false },
    async () => {
      const workspacePath = folder.uri.fsPath;
      const term = createFreshLocustTerminal();

      const isWin = process.platform === 'win32';
      const pyPath = isWin ? `${envFolder}\\Scripts\\python` : `${envFolder}/bin/python`;
      const pipPath = isWin ? `${envFolder}\\Scripts\\pip`   : `${envFolder}/bin/pip`;
      const activateCmd = isWin
        ? `if (Test-Path "${envFolder}\\Scripts\\Activate.ps1") { . "${envFolder}\\Scripts\\Activate.ps1" }`
        : `if [ -f "${envFolder}/bin/activate" ]; then . "${envFolder}/bin/activate"; fi`;

      term.sendText(`cd "${workspacePath}"`);

      // Create dedicated venv
      term.sendText(isWin ? `python -m venv "${envFolder}"` : `python3 -m venv "${envFolder}"`);

      // Upgrade pip using env-local python, avoiding system pip/PEP 668 issues
      term.sendText(`"${pyPath}" -m pip install --upgrade pip`);

      // Install target payload with env-local pip
      term.sendText(`"${pipPath}" install ${installArg}`);

      // Activate env, follow-up user commands run inside it
      term.sendText(activateCmd);

      vscode.window.showInformationMessage(
        installProject
          ? `Installing project${pyInfo.hasLoadtestExtra ? ' (+[loadtest])' : ''} into ${envFolder}...`
          : `Installing Locust into ${envFolder}...`
      );

      // Set workspace interpreter to new env (only if valid)
      await setWorkspacePythonInterpreter(envFolder);

      await context.workspaceState.update(WS_SETUP_KEY, true);
    }
  );
}
