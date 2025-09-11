import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { EnvService } from './envService';
import { McpService } from './mcpService';
import { getConfig, WS_SETUP_KEY } from '../core/config';

const execFileAsync = promisify(execFile);

// Fallback for older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

async function readWorkspaceSetting<T = string>(section: string, key: string): Promise<T | undefined> {
  return vscode.workspace.getConfiguration(section).get<T>(key);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

function guessWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function runPythonCmd(python: string, args: string[], cwd?: string) {
  return execFileAsync(python, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

async function canImport(python: string, moduleName: string, cwd?: string): Promise<boolean> {
  try {
    await runPythonCmd(python, ['-c', `import ${moduleName}`], cwd);
    return true;
  } catch {
    return false;
  }
}

//Ruff + settings (best-practice)
async function ensureRuffToml(workspacePath: string) {
  const ruffPath = path.join(workspacePath, '.ruff.toml');
  if (await fileExists(ruffPath)) {return;}

  const ruffToml = `target-version = "py311"

extend-exclude = [
  "mcp-generated/**",
  "templates/locustfile_from_har.py",
  "locustfile_from_har.py"
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

  const desired = {
    "python.defaultInterpreterPath": "${workspaceFolder}/locust_env/bin/python",
    "ruff.lint.run": "onType",
    "[python]": {
      "editor.codeActionsOnSave": {
        "source.fixAll.ruff": false
      },
      "editor.formatOnSave": false
    }
  };

  const merged: any = { ...current, ...desired };
  if (current["[python]"]) {
    merged["[python]"] = {
      ...current["[python]"],
      ...desired["[python]"],
      // Merge codeActionsOnSave and formatOnSave directly at the root of [python]
      editor: undefined,
      "editor.codeActionsOnSave": {
        ...(current["[python]"]?.["editor.codeActionsOnSave"] ?? {}),
        ...(desired["[python]"]?.["editor.codeActionsOnSave"] ?? {})
      },
      "editor.formatOnSave": desired["[python]"]?.["editor.formatOnSave"] ?? current["[python]"]?.["editor.formatOnSave"]
    };
    if (merged["[python]"].editor === undefined) {
      delete merged["[python]"].editor;
    }
  }

  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
}

// Suggest installing Copilot if not present
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

  async resolveInterpreter(): Promise<string> {
    const preferred = await readWorkspaceSetting<string>('python', 'defaultInterpreterPath');
    return preferred && preferred.trim().length > 0 ? preferred : 'python';
  }

  async checkAndOfferSetup(opts: { forcePrompt?: boolean } = {}) {
    if (!vscode.workspace.isTrusted) {return;}

    const wsPath = guessWorkspacePath();
    if (!wsPath) {return;}

    const python = await this.resolveInterpreter();

    const hasLocust = await canImport(python, 'locust', wsPath);
    const hasH2L   = await canImport(python, 'har2locust', wsPath);
    if (hasLocust && hasH2L && !opts.forcePrompt) {
      await this.finalizeWorkspace(wsPath, python);
      await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
      return;
    }

    const picks: vscode.QuickPickItem[] = [
      { label: 'Install into current interpreter', detail: `pip install locust har2locust ruff` },
      { label: 'Create venv here and install', detail: `python -m venv locust_env && pip install ...` },
      { label: 'Skip for now', detail: 'You can run “Locust: Initialize (Install/Detect)” later' }
    ];

    const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Missing dependencies detected. How do you want to proceed?' });
    if (!choice || choice.label.startsWith('Skip')) {return;}

    if (choice.label.startsWith('Install into current interpreter')) {
      await this.installIntoInterpreter(python, wsPath);
    } else if (choice.label.startsWith('Create venv here')) {
      await this.createVenvAndInstall(wsPath);
    }

    await this.finalizeWorkspace(wsPath, python);
    await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
  }

  private async installIntoInterpreter(python: string, cwd: string) {
    const pipArgs = ['-m', 'pip', 'install', 'locust', 'har2locust', 'ruff'];
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing into current interpreter…', cancellable: false },
        async () => { await runPythonCmd(python, pipArgs, cwd); }
      );
      vscode.window.showInformationMessage('Installed: locust, har2locust, ruff (current interpreter).');
    } catch (e: any) {
      vscode.window.showErrorMessage(`pip install failed: ${e?.stderr || e?.message || String(e)}`);
    }
  }

  private async createVenvAndInstall(wsPath: string) {
    const isWin = process.platform === 'win32';
    const envFolder = 'locust_env';
    const pyPath = isWin ? path.join(envFolder, 'Scripts', 'python') : path.join(envFolder, 'bin', 'python');

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating venv and installing…', cancellable: false },
      async () => {
        try {
          await runPythonCmd('python', ['-m', 'venv', envFolder], wsPath);
        } catch {
          await runPythonCmd('python3', ['-m', 'venv', envFolder], wsPath);
        }
        await runPythonCmd(pyPath, ['-m', 'pip', 'install', '--upgrade', 'pip'], wsPath);
        await runPythonCmd(pyPath, ['-m', 'pip', 'install', 'locust', 'har2locust', 'ruff'], wsPath);
        await vscode.workspace.getConfiguration('python')
          .update('defaultInterpreterPath',
            path.join('${workspaceFolder}', envFolder, isWin ? 'Scripts' : 'bin', 'python'),
            vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Created ${envFolder} and installed: locust, har2locust, ruff.`);
      }
    );
  }

  private async finalizeWorkspace(wsPath: string, python: string) {
    // Use the same interpreter for MCP that we just validated/installed into
    await this.mcp.writeMcpConfig(python);

    await ensureRuffToml(wsPath);
    await ensureWorkspaceSettingsPatched(wsPath);

    const offer = vscode.workspace.getConfiguration().get<boolean>('locust.offerCopilotOnInit', true);
    if (offer) {await ensureCopilotInstalled();}
  }
}
