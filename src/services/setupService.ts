import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { EnvService } from './envService';
import { McpService } from './mcpService';
import { getConfig, WS_SETUP_KEY, MCP_REQ_REL, WORKSPACE_REQ_REL } from '../core/config';
import { fileExists } from '../core/utils/fs';

/** 
* Automation service Setup Interpreter, locust_env dependencies and MCP config
* Initialized on end user command: "Locust: Initialize (Install/Detect)" 
* Also runs optional prompt on activation if locust not found.
*/

const execFileAsync = promisify(execFile);

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

async function isInterpreterPathValid(interpreterPath: string): Promise<boolean> {
  if (!interpreterPath) return false;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(interpreterPath));
    return true;
  } catch {
    return false;
  }
}

async function ensureCopilotInstalled() {
  // Copilot used to have a separate "copilot-chat" ID; check both just in case.
  const ids = ['github.copilot', 'github.copilot-chat'];
  const hasCopilot = ids.some(id => !!vscode.extensions.getExtension(id));

  if (hasCopilot) return;

  const choice = await vscode.window.showInformationMessage(
    'Optional: Install GitHub Copilot to use HAR → Locust via Copilot Chat (MCP) directly from this workspace.',
    { modal: true },
    'Install Copilot',
    'Skip'
  );
  if (choice !== 'Install Copilot') return;

  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', 'github.copilot');

    const reload = await vscode.window.showInformationMessage(
      'GitHub Copilot installed. Reload VS Code to enable it now?',
      'Reload',
      'Later'
    );
    if (reload === 'Reload') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Could not install GitHub Copilot: ${err?.message ?? String(err)}`);
  }
}


export class SetupService {
  constructor(
    private env: EnvService,
    private mcp: McpService,
    private ctx: vscode.ExtensionContext
  ) {}

  /**
   * Set workspace's Python interpreter to created env, enable terminal auto-activation for UX.
   * Only writes if path exists.
   */
  async setWorkspacePythonInterpreter(envFolder: string) {
    const interpreter = this.env.getEnvInterpreterPath(envFolder);
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
   * Repair invalid interpreter path on activation.
   */
  async repairWorkspaceInterpreterIfBroken() {
    const cfg = vscode.workspace.getConfiguration('python');
    const current = cfg.get<string>('defaultInterpreterPath');
    const { envFolder } = getConfig();

    const currentValid = current ? await isInterpreterPathValid(current) : false;
    if (currentValid) return;

    const envInterp = this.env.getEnvInterpreterPath(envFolder);
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
   * Main setup entry
   */
  async checkAndOfferSetup(opts: { forcePrompt?: boolean } = {}) {
    if (!vscode.workspace.isTrusted) return;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const { locustPath, envFolder } = getConfig();

    const hasLocust = await isLocustAvailable(locustPath);
    if (hasLocust && !opts.forcePrompt) {
      await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
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
        const term = this.env.createFreshLocustTerminal();

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

        // Ensure har2locust is present for MCP/CLI usage
        term.sendText(`"${pipPath}" install har2locust`);

        // ✅ Also install ruff (used by har2locust default plugin)
        term.sendText(`"${pipPath}" install ruff`);

        /** Add a shim so "har-to-locust" also works (Copilot workaround)
        if (isWin) {
          // Windows: create Scripts\har-to-locust.cmd
          const shimPathWin = `${envFolder}\\Scripts\\har-to-locust.cmd`;
          // Use PowerShell to create the file if it doesn't exist
          term.sendText(
            `$shim = "${shimPathWin}"; ` +
            `if (!(Test-Path $shim)) { ` +
              `@'` + // here-string start
        `\@echo off
        "%~dp0python.exe" -m har2locust %*` + // note: leading backslash escapes @ in PS here-string above
        `'@ | Out-File -FilePath $shim -Encoding ascii -Force; ` +
            `}`
          );
        } else {
          // POSIX: create bin/har-to-locust
          const shimPathPosix = `${envFolder}/bin/har-to-locust`;
          term.sendText(
            `SHIM="${shimPathPosix}"; ` +
            `if [ ! -f "$SHIM" ]; then ` +
              `printf '%s\n' '#!/usr/bin/env bash' '"${envFolder}/bin/python" -m har2locust "$@"' > "$SHIM"; ` +
              `chmod +x "$SHIM"; ` +
            `fi`
          );
        } */

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
        await this.setWorkspacePythonInterpreter(envFolder);

        // Write/update MCP config for Copilot Chat
        await this.mcp.writeMcpConfig(envFolder);
        
        // 🔸 Only offer Copilot if enabled in settings (defaults to true)
        const offer = vscode.workspace.getConfiguration().get<boolean>('locust.offerCopilotOnInit', true);
        if (offer) {
          await ensureCopilotInstalled();
        }

        await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
      }
    );
  }
}
