import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { EnvService } from './envService';
import { McpService } from './mcpService';
import { TourRunner } from '../runners/tourRunner';
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

// Build environment similar to `source .venv/bin/activate` for child processes. 
function envForVenv(absPy: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const venvDir = path.dirname(path.dirname(absPy)); // .../.locust_env/{bin|Scripts}/python -> .../.locust_env
  const binDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  env.VIRTUAL_ENV = venvDir;
  env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ''}`;
  return env;
}

// Only create settings.json if missing
async function ensureWorkspaceSettingsIfMissing(workspacePath: string): Promise<boolean> {
  const vscodeDir = path.join(workspacePath, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');

  if (await fileExists(settingsPath)) {
    return false; // respect existing settings.json.
  }

  await fs.mkdir(vscodeDir, { recursive: true });

  const fresh = {
    "python.terminal.activateEnvironment": true,
    "markdown.preview.enableCommandUris": true,
    // Enable pytest by default
    "python.testing.pytestEnabled": true,
    "python.testing.unittestEnabled": false,
    "python.testing.nosetestsEnabled": false,
    "python.testing.pytestArgs": [
      "tests",
      "."
    ],

    // Disable all Copilot
    "chat.sendElementsToChat.enabled": false,
    "chat.sendElementsToChat.attachCSS": false,
    "chat.sendElementsToChat.attachImages": false,

    // Ruff fixes can be enabled by users later.
    "[python]": {
      "editor.codeActionsOnSave": { "source.fixAll.ruff": "never" },
      "editor.formatOnSave": true
    },
    // Hide internal folders
    "files.exclude": {
      "**/.locust_env": true,
      "**/.tours": true,
      "**/.ruff.toml": true
    },
    "search.exclude": {
      "**/.locust_env/**": true,
      "**/.tours/**": true
    },
    "files.watcherExclude": {
      "**/.locust_env/**": true,
      "**/.tours/**": true
    }
  };

  await fs.writeFile(settingsPath, JSON.stringify(fresh, null, 2), 'utf8');
  return true;
}

/**
 * Prefer bundled Ruff config.
 * Only when creating settings.json..
 * No fallback write .ruff.toml.
 */
async function configureRuffIfNew(ctx: vscode.ExtensionContext, createdSettings: boolean) {
  if (!createdSettings) return;

  const bundled = path.join(ctx.extensionUri.fsPath, 'media', 'ruff', 'ruff.toml');
  try {
    await fs.stat(bundled);
    await vscode.workspace.getConfiguration('ruff')
      .update('configuration', bundled, vscode.ConfigurationTarget.Workspace);
  } catch {
    // No bundled Ruff config packaged; silently skip.
  }
}

// Ensure launch.json active-file Locust config + pytest configs
async function ensurePythonActiveFileLaunch(wsPath: string, absPy: string) {
  const vscodeDir = path.join(wsPath, '.vscode');
  const launchPath = path.join(vscodeDir, 'launch.json');
  await fs.mkdir(vscodeDir, { recursive: true });

  let launchJson: any = { version: '0.2.0', configurations: [] as any[] };
  try {
    const txt = await fs.readFile(launchPath, 'utf8');
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object') {
      launchJson.version = parsed.version ?? '0.2.0';
      launchJson.configurations = Array.isArray(parsed.configurations) ? parsed.configurations : [];
    }
  } catch { /* no existing launch.json */ }

  const venvDir = path.dirname(path.dirname(absPy));
  const locustName = 'Locust: run_single_user (active file)';
  const locustCfg = {
    name: locustName,
    type: 'python',
    request: 'launch',
    python: absPy,
    program: '${file}',
    cwd: '${fileDirname}',
    console: 'integratedTerminal',
    justMyCode: false,
    args: [],
    env: {
      VIRTUAL_ENV: venvDir,
      PATH:
        process.platform === 'win32'
          ? '${workspaceFolder}\\.locust_env\\Scripts;${env:PATH}'
          : '${workspaceFolder}/.locust_env/bin:${env:PATH}',
      // gevent support in debugger
      GEVENT_SUPPORT: 'True',
    },
  };

  // Pytest: run the whole suite
  const pytestAllName = 'Pytest: all tests';
  const pytestAllCfg = {
    name: pytestAllName,
    type: 'python',
    request: 'launch',
    python: absPy,
    module: 'pytest',
    cwd: '${workspaceFolder}',
    console: 'integratedTerminal',
    justMyCode: false,
    args: [
      '-q'
    ],
    env: {
      VIRTUAL_ENV: venvDir,
      PATH:
        process.platform === 'win32'
          ? '${workspaceFolder}\\.locust_env\\Scripts;${env:PATH}'
          : '${workspaceFolder}/.locust_env/bin:${env:PATH}',
      GEVENT_SUPPORT: 'True',
    },
  };

  // Pytest: run current file
  const pytestFileName = 'Pytest: current file';
  const pytestFileCfg = {
    name: pytestFileName,
    type: 'python',
    request: 'launch',
    python: absPy,
    module: 'pytest',
    cwd: '${fileDirname}',
    console: 'integratedTerminal',
    justMyCode: false,
    args: [
      '-q',
      '${file}'
    ],
    env: {
      VIRTUAL_ENV: venvDir,
      PATH:
        process.platform === 'win32'
          ? '${workspaceFolder}\\.locust_env\\Scripts;${env:PATH}'
          : '${workspaceFolder}/.locust_env/bin:${env:PATH}',
      GEVENT_SUPPORT: 'True',
    },
  };

  const upsert = (cfg: any) => {
    const i = launchJson.configurations.findIndex((c: any) => c?.name === cfg.name);
    if (i >= 0) launchJson.configurations[i] = cfg;
    else launchJson.configurations.push(cfg);
  };

  upsert(locustCfg);
  upsert(pytestAllCfg);
  upsert(pytestFileCfg);

  await fs.writeFile(launchPath, JSON.stringify(launchJson, null, 2), 'utf8');
}

// Setup service
async function readJson(uriOrPath: vscode.Uri | string): Promise<any | undefined> {
  try {
    const text =
      typeof uriOrPath === 'string'
        ? await fs.readFile(uriOrPath, 'utf8')
        : Buffer.from(await vscode.workspace.fs.readFile(uriOrPath)).toString('utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class SetupService {
  constructor(
    private env: EnvService,
    private mcp: McpService,
    private ctx: vscode.ExtensionContext
  ) {}

  // Use ABS path if present in settings, else 'python'.
  async resolveInterpreter(): Promise<string> {
    const preferredRaw = await readWorkspaceSetting<string>('python', 'defaultInterpreterPath');
    const preferred = expandWs(preferredRaw);
    return preferred && preferred.trim().length > 0 ? preferred : 'python';
  }

  // AUTO setup.
  async autoSetupSilently() {
    try {
      if (!vscode.workspace.isTrusted) return;
      const wsPath = wsRoot();
      if (!wsPath) return;

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

      // Install deps if missing OR first time
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

      // Write MCP config
      await this.mcp.writeMcpConfig(absPy);

      // Create settings.json if missing
      const createdSettings = await ensureWorkspaceSettingsIfMissing(wsPath);
      await configureRuffIfNew(this.ctx, createdSettings);

      // removed: await ensureWorkspaceTour(this.ctx, wsPath);

      // Ensure active file debug config
      await ensurePythonActiveFileLaunch(wsPath, absPy);

      try {
        const tr = new TourRunner(this.ctx);
        await tr.ensureBeginnerTourFiles(vscode.Uri.file(wsPath), { overwrite: false });
      } catch { /* ignore */ }

      // Mark as done
      await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
    } catch (err: any) {
      const ch = vscode.window.createOutputChannel('Locust Setup');
      ch.appendLine(`[auto-setup] ${err?.stack || err?.message || String(err)}`);
      ch.show(true);
      vscode.window.showWarningMessage('Locust: automatic setup hit an issue. Check "Locust Setup" output for details.');
    }
  }

  async checkAndOfferSetup(_opts: { forcePrompt?: boolean } = {}) {
    return this.autoSetupSilently();
  }

  private async finalizeWorkspace(wsPath: string, python: string) {
    await this.mcp.writeMcpConfig(python);
    const createdSettings = await ensureWorkspaceSettingsIfMissing(wsPath);
    await configureRuffIfNew(this.ctx, createdSettings);
    await ensurePythonActiveFileLaunch(wsPath, python);
    await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
  }
}
