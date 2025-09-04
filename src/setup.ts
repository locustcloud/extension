import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const LOCUST_TERMINAL_NAME = 'Locust';
const WS_SETUP_KEY = 'locust.setupCompleted';

// Current tree layout
const MCP_REQ_REL = path.join('mcp', 'requirements.txt');
const MCP_SERVER_REL = path.join('mcp', 'server.py');
const WORKSPACE_REQ_REL = 'requirements.txt';

export function getConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    locustPath: cfg.get<string>('locust.path', 'locust'),
    envFolder: cfg.get<string>('locust.envFolder', 'locust_env'),
    defaultHost: cfg.get<string>('locust.defaultHost', '')
  };
}

/**
 * Creates fresh terminal "Locust", disposes the old one,
 * best-effort deactivates active venv to avoid cross-contamination.
 */
function createFreshLocustTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find(t => t.name === LOCUST_TERMINAL_NAME);
  existing?.dispose();

  const term = vscode.window.createTerminal({ name: LOCUST_TERMINAL_NAME });
  term.show();

  // Best-effort 'deactivate' if venv currently active in shell.
  if (process.platform === 'win32') {
    term.sendText('if (Get-Command deactivate -ErrorAction SilentlyContinue) { deactivate }');
  } else {
    term.sendText('type deactivate >/dev/null 2>&1 && deactivate || true');
  }
  return term;
}

// Returns true if a given binary is on PATH and runs without error.
async function isOnPath(binary: string, args: string[] = []): Promise<boolean> {
  try {
    await execFileAsync(binary, args);
    return true;
  } catch {
    return false;
  }
}

// Returns true if `locust` appears available.
async function isLocustAvailable(locustPath: string): Promise<boolean> {
  try {
    await execFileAsync(locustPath, ['--version']);
    return true;
  } catch {
    return false;
  }
}

// Interpreter helper
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
 * auto-activation for UX. Only writes if path exists.
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
 * Optional: repair invalid interpreter path on activation.
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

/**
 * Always write a fresh .vscode/mcp.json that points to the workspace venv.
 * This overwrites any existing file on purpose.
 */
async function writeMcpConfig(envFolder: string) {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  const pyInterpAbs = getEnvInterpreterPath(envFolder);
  const serverAbs = path.join(ws.uri.fsPath, MCP_SERVER_REL);

  const freshConfig = {
    runtimes: {
      python: {
        command: pyInterpAbs,
        args: ["-u", serverAbs]
      }
    },
    servers: [
      {
        id: "mcp-har2locust",
        name: "HAR → Locustfile (Python)",
        runtime: "python",
        autoStart: true,
        tools: ["har.to_locust"]
      }
    ],
    toolsets: [
      {
        name: "locust-tools",
        description: "Locust authoring helpers",
        servers: ["mcp-har2locust"]
      }
    ]
  };

  const dir = vscode.Uri.joinPath(ws.uri, ".vscode");
  const target = vscode.Uri.joinPath(dir, "mcp.json");

  try { await vscode.workspace.fs.stat(dir); } catch { await vscode.workspace.fs.createDirectory(dir); }
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(freshConfig, null, 2), "utf8"));

  vscode.window.setStatusBarMessage("MCP configured (fresh) to use workspace venv.", 4000);
}


/**
 * Main setup entry:
 * - prompts only if locust isn't available (unless forced),
 * - pip-only,
 * - deactivates existing venv in a fresh terminal,
 * - creates envFolder (default: locust_env),
 * - installs either workspace requirements.txt or locust,
 * - installs MCP server requirements (mcp/requirements.txt) if present,
 * - activates new env,
 * - sets workspace interpreter to new env (if valid),
 * - writes .vscode/mcp.json pointing at env python.
 */
export async function checkAndOfferSetup(
  context: vscode.ExtensionContext,
  opts: { forcePrompt?: boolean } = {}
) {
  if (!vscode.workspace.isTrusted) return;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const { locustPath, envFolder } = getConfig();

  const hasLocust = await isLocustAvailable(locustPath);
  if (hasLocust && !opts.forcePrompt) {
    await context.workspaceState.update(WS_SETUP_KEY, true);
    return;
  }

  const workspacePath = folder.uri.fsPath;
  const wsReqAbs = path.join(workspacePath, WORKSPACE_REQ_REL);
  const hasWsReq = await fileExists(wsReqAbs);

  const picks: vscode.QuickPickItem[] = hasWsReq
    ? [
        { label: 'Set up with venv + pip: Install from workspace requirements.txt', detail: `Create ${envFolder} and pip install -r requirements.txt` },
        { label: 'Set up with venv + pip: Locust only', detail: `Create ${envFolder} and pip install locust` },
        { label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' }
      ]
    : [
        { label: 'Set up with venv + pip: Locust only', detail: `Create ${envFolder} and pip install locust` },
        { label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' }
      ];

  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Set up a local Locust environment?' });
  if (!choice || choice.label.startsWith('Skip')) return;

  const installFromReq = choice.label.includes('Install from workspace requirements.txt');

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Setting up Locust environment', cancellable: false },
    async () => {
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
      if (installFromReq) {
        const reqQuoted = `"${wsReqAbs.replace(/\\/g, isWin ? '\\\\' : '\\/')}"`;
        term.sendText(`"${pipPath}" install -r ${reqQuoted}`);
      } else {
        term.sendText(`"${pipPath}" install locust`);
      }

      // Install MCP server requirements if present
      const mcpReqAbs = path.join(workspacePath, MCP_REQ_REL);
      if (await fileExists(mcpReqAbs)) {
        const reqQuoted = `"${mcpReqAbs.replace(/\\/g, isWin ? '\\\\' : '\\/')}"`;
        term.sendText(`"${pipPath}" install -r ${reqQuoted}`);
      }

      // Activate env, follow-up user commands run inside it
      term.sendText(activateCmd);

      vscode.window.showInformationMessage(
        installFromReq
          ? `Installing from workspace requirements.txt into ${envFolder}...`
          : `Installing Locust into ${envFolder}...`
      );

      // Set workspace interpreter to new env (only if valid)
      await setWorkspacePythonInterpreter(envFolder);

      // Write/update MCP config for Copilot Chat
      await writeMcpConfig(envFolder);

      await context.workspaceState.update(WS_SETUP_KEY, true);
    }
  );
}
