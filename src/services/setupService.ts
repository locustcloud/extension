import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { EnvService } from './envService';
import { McpService } from './mcpService';
import { WS_SETUP_KEY } from '../core/config';

const execFileAsync = promisify(execFile);

async function readWorkspaceSetting<T = string>(section: string, key: string): Promise<T | undefined> {
  return vscode.workspace.getConfiguration(section).get<T>(key);
}
function wsRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function expandWs(p?: string): string | undefined {
  const root = wsRoot();
  return p && root ? p.replace('${workspaceFolder}', root) : p;
}
async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
async function runPythonCmd(python: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  return execFileAsync(python, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });
}
async function canImport(python: string, moduleName: string, cwd?: string): Promise<boolean> {
  try { await runPythonCmd(python, ['-c', `import ${moduleName}`], cwd); return true; } catch { return false; }
}

/** Build an environment similar to `source .venv/bin/activate` for child processes. */
function envForVenv(absPy: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const venvDir = path.dirname(path.dirname(absPy)); // .../.locust_env/{bin|Scripts}/python -> .../.locust_env
  const binDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  env.VIRTUAL_ENV = venvDir;
  env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ''}`;
  return env;
}

// Ruff + settings
async function ensureRuffToml(workspacePath: string) {
  const ruffPath = path.join(workspacePath, '.ruff.toml');
  if (await fileExists(ruffPath)) {return;}

  const ruffToml = `target-version = "py311"

extend-exclude = [
  ".locust_env/**",
  "templates/**"
]

lint.select = ["E", "F", "W"]
`;
  await fs.writeFile(ruffPath, ruffToml, 'utf8');
}

async function ensureWorkspaceSettingsPatched(workspacePath: string) {
  const vscodeDir = path.join(workspacePath, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  await fs.mkdir(vscodeDir, { recursive: true });

  let current: any = {};
  try {
    const buf = await fs.readFile(settingsPath, 'utf8');
    current = JSON.parse(buf);
  } catch { current = {}; }

  // We set python.defaultInterpreterPath separately (after venv creation).
  const desired = {
    "python.terminal.activateEnvironment": true,
    "ruff.lint.run": "onType",
    "[python]": {
      "editor.codeActionsOnSave": { "source.fixAll.ruff": false },
      "editor.formatOnSave": false
    }
  };

  const merged: any = { ...current, ...desired };
  if (current["[python]"]) {
    merged["[python]"] = {
      ...current["[python]"],
      ...desired["[python]"],
      editor: undefined,
      "editor.codeActionsOnSave": {
        ...(current["[python]"]?.["editor.codeActionsOnSave"] ?? {}),
        ...(desired["[python]"]?.["editor.codeActionsOnSave"] ?? {})
      },
      "editor.formatOnSave": desired["[python]"]?.["editor.formatOnSave"] ?? current["[python]"]?.["editor.formatOnSave"]
    };
    if (merged["[python]"].editor === undefined) { delete merged["[python]"].editor; }
  }

  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
}

// Prompt Copilot install
async function ensureCopilotInstalled() {
  const ids = ['github.copilot', 'github.copilot-chat'];
  const hasCopilot = ids.some(id => !!vscode.extensions.getExtension(id));
  if (hasCopilot) {return;}

  const choice = await vscode.window.showInformationMessage(
    'Optional: Install GitHub Copilot to use HAR → Locust via Copilot Chat (MCP).',
    { modal: true },
    'Install Copilot',
    'Skip'
  );
  if (choice !== 'Install Copilot') {return;}

  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', 'github.copilot');
    const reload = await vscode.window.showInformationMessage('GitHub Copilot installed. Reload now?', 'Reload', 'Later');
    if (reload === 'Reload') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
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

  /** Use ABS path if present in settings, else 'python'. */
  async resolveInterpreter(): Promise<string> {
    const preferredRaw = await readWorkspaceSetting<string>('python', 'defaultInterpreterPath');
    const preferred = expandWs(preferredRaw);
    return preferred && preferred.trim().length > 0 ? preferred : 'python';
  }

  /**
   * Main setup. Creates a hidden venv and installs deps.
   */
  async checkAndOfferSetup(opts: { forcePrompt?: boolean } = {}) {
    if (!vscode.workspace.isTrusted) {return;}

    const wsPath = wsRoot();
    if (!wsPath) {return;}

    const interp = await this.resolveInterpreter();

    const hasLocust = await canImport(interp, 'locust', wsPath);
    const hasH2L   = await canImport(interp, 'har2locust', wsPath);
    const hasMCP   = await canImport(interp, 'mcp', wsPath);
    if (hasLocust && hasH2L && hasMCP && !opts.forcePrompt) {
      await this.finalizeWorkspace(wsPath, interp);
      await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
      return;
    }

    const picks: vscode.QuickPickItem[] = [
      { label: 'Create hidden venv (.locust_env) and install', detail: `python -m venv .locust_env && pip install -r mcp/requirements.txt` },
      { label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' }
    ];

    const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Set up a dedicated environment for Locust + MCP?' });
    if (!choice || choice.label.startsWith('Skip')) {return;}

    if (choice.label.startsWith('Create hidden venv')) {
      await this.createVenvAndInstall(wsPath);
    }

    await this.finalizeWorkspace(wsPath, await this.resolveInterpreter());
    await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
  }

  private async createVenvAndInstall(wsPath: string) {
    const isWin = process.platform === 'win32';
    const envFolder = '.locust_env';
    const absPy = path.join(wsPath, envFolder, isWin ? 'Scripts' : 'bin', 'python');
    const venvEnv = envForVenv(absPy);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating .locust_env and installing…', cancellable: false },
      async () => {
        // Create venv
        try {
          await execFileAsync('python', ['-m', 'venv', envFolder], { cwd: wsPath });
        } catch {
          await execFileAsync('python3', ['-m', 'venv', envFolder], { cwd: wsPath });
        }

        // Upgrade pip inside the venv (with venv-like env)
        await execFileAsync(absPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: wsPath, env: venvEnv });

        // Install deps: prefer MCP requirements if present
        const reqPath = path.join(wsPath, 'mcp', 'requirements.txt');
        if (await fileExists(reqPath)) {
          await execFileAsync(absPy, ['-m', 'pip', 'install', '-r', reqPath], { cwd: wsPath, env: venvEnv });
        } else {
          await execFileAsync(absPy, ['-m', 'pip', 'install', 'locust', 'har2locust', 'ruff', 'mcp', 'pytest'], { cwd: wsPath, env: venvEnv });
        }

        // Write ABSOLUTE interpreter path into workspace settings
        await vscode.workspace.getConfiguration('python')
          .update('defaultInterpreterPath', absPy, vscode.ConfigurationTarget.Workspace);

        vscode.window.showInformationMessage(`Created ${envFolder} and installed: Locust + MCP requirements.`);
      }
    );
  }

  private async finalizeWorkspace(wsPath: string, python: string) {
    // Write MCP config using validated interpreter
    await this.mcp.writeMcpConfig(python);

    await ensureRuffToml(wsPath);
    await ensureWorkspaceSettingsPatched(wsPath);

    const offer = vscode.workspace.getConfiguration().get<boolean>('locust.offerCopilotOnInit', true);
    if (offer) {await ensureCopilotInstalled();}
  }
}
