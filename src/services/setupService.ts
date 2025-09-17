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
  if (await fileExists(ruffPath)) return;

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
   * AUTO setup (no prompts). Safe to call on every activation.
   * - Creates hidden venv `.locust_env` if missing
   * - Installs deps (locust, har2locust, ruff, mcp, pytest or from mcp/requirements.txt)
   * - Sets workspace python interpreter to venv
   * - Writes MCP config
   * - Patches settings and ruff config
   */
  async autoSetupSilently() {
    try {
      if (!vscode.workspace.isTrusted) return;
      const wsPath = wsRoot();
      if (!wsPath) return;

      // If we already completed once, still verify presence; re-run if anything is missing.
      const already = this.ctx.workspaceState.get<boolean>(WS_SETUP_KEY, false);

      const envFolder = '.locust_env';
      const isWin = process.platform === 'win32';
      const absPy = path.join(wsPath, envFolder, isWin ? 'Scripts' : 'bin', 'python');
      const venvExists = await fileExists(absPy);

      // Create venv if needed
      if (!venvExists) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Locust: preparing local Python environment…', cancellable: false },
          async () => {
            try {
              await execFileAsync('python', ['-m', 'venv', envFolder], { cwd: wsPath });
            } catch {
              await execFileAsync('python3', ['-m', 'venv', envFolder], { cwd: wsPath });
            }
          }
        );
      }

      const venvEnv = envForVenv(absPy);

      // Ensure pip is up-to-date
      await execFileAsync(absPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: wsPath, env: venvEnv });

      // Install deps if any missing OR first time
      const needsLocust = !(await canImport(absPy, 'locust', wsPath));
      const needsH2L   = !(await canImport(absPy, 'har2locust', wsPath));
      const needsMCP   = !(await canImport(absPy, 'mcp', wsPath));

      if (!already || needsLocust || needsH2L || needsMCP) {
        const reqPath = path.join(wsPath, 'mcp', 'requirements.txt');
        if (await fileExists(reqPath)) {
          await execFileAsync(absPy, ['-m', 'pip', 'install', '-r', reqPath], { cwd: wsPath, env: venvEnv });
        } else {
          await execFileAsync(
            absPy,
            ['-m', 'pip', 'install', 'locust', 'har2locust', 'ruff', 'mcp', 'pytest'],
            { cwd: wsPath, env: venvEnv }
          );
        }
      }

      // Point workspace interpreter to the venv
      await vscode.workspace.getConfiguration('python')
        .update('defaultInterpreterPath', absPy, vscode.ConfigurationTarget.Workspace);

      // Write MCP config using validated interpreter
      await this.mcp.writeMcpConfig(absPy);

      // Patch editor settings + ruff config
      await ensureRuffToml(wsPath);
      await ensureWorkspaceSettingsPatched(wsPath);

      // Mark as done
      await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
    } catch (err: any) {
      // Be quiet, but log to OUTPUT to help debugging
      const ch = vscode.window.createOutputChannel('Locust Setup');
      ch.appendLine(`[auto-setup] ${err?.stack || err?.message || String(err)}`);
      ch.show(true);
      vscode.window.showWarningMessage('Locust: automatic setup hit an issue. Check "Locust Setup" output for details.');
    }
  }

  // --- Legacy: keep the API around in case something still calls it. It now just delegates silently.
  async checkAndOfferSetup(_opts: { forcePrompt?: boolean } = {}) {
    return this.autoSetupSilently();
  }

  // --- Optional: manual re-run command could call this (not used automatically)
  private async finalizeWorkspace(wsPath: string, python: string) {
    await this.mcp.writeMcpConfig(python);
    await ensureRuffToml(wsPath);
    await ensureWorkspaceSettingsPatched(wsPath);
    await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
  }
}
