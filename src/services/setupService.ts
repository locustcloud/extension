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

// --- Only create settings.json if missing (no merge/touch otherwise)
async function ensureWorkspaceSettingsIfMissing(workspacePath: string): Promise<boolean> {
  const vscodeDir = path.join(workspacePath, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');

  if (await fileExists(settingsPath)) {
    return false; // respect existing settings.json; do not rewrite or merge
  }

  await fs.mkdir(vscodeDir, { recursive: true });

  const fresh = {
    "python.terminal.activateEnvironment": true,
    "markdown.preview.enableCommandUris": true,
    // Disable all Copilot
    "chat.sendElementsToChat.enabled": false,
    "chat.sendElementsToChat.attachCSS": false,
    "chat.sendElementsToChat.attachImages": false,
    // Keep Python formatting sane; Ruff fixes can be enabled by users later.
    "[python]": {
      "editor.codeActionsOnSave": { "source.fixAll.ruff": "never" },
      "editor.formatOnSave": true
    },
    // Hide internal folders by default in a new workspace
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
 * Prefer a bundled Ruff config so we DON'T create .ruff.toml in the workspace.
 * Only set this when we just created settings.json (to avoid mutating an existing file).
 * No fallback that writes .ruff.toml.
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

function bundledTourCandidates(ctx: vscode.ExtensionContext): vscode.Uri[] {
  return [
    vscode.Uri.file(path.join(ctx.extensionUri.fsPath, 'media', '.tours', 'locust_beginner.tour')),
    vscode.Uri.file(path.join(ctx.extensionUri.fsPath, 'media', '.tour',  'locust_beginner.tour')),
  ];
}

async function findBundledTour(ctx: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  for (const cand of bundledTourCandidates(ctx)) {
    try {
      await vscode.workspace.fs.stat(cand);
      return cand;
    } catch { /* try next */ }
  }
  return undefined;
}

/**
 * Ensure <workspace>/.tours/locust_beginner.tour exists (versioned copy).
 */
async function ensureWorkspaceTour(ctx: vscode.ExtensionContext, wsPath: string) {
  const srcUri = await findBundledTour(ctx);
  if (!srcUri) return;

  const destDir = path.join(wsPath, '.tours');
  const destPath = path.join(destDir, 'locust_beginner.tour');
  const destUri = vscode.Uri.file(destPath);

  let shouldCopy = false;

  const srcJson = await readJson(srcUri);
  const srcVersion = srcJson?.locustTourVersion ?? '0';

  try { await fs.mkdir(destDir, { recursive: true }); } catch {}

  const exists = await fileExists(destPath);
  if (!exists) {
    shouldCopy = true;
  } else {
    const dstJson = await readJson(destPath);
    const dstVersion = dstJson?.locustTourVersion ?? '0';
    if (dstVersion !== srcVersion) {
      shouldCopy = true;
    }
  }

  if (shouldCopy) {
    const bytes = await vscode.workspace.fs.readFile(srcUri);
    await vscode.workspace.fs.writeFile(destUri, bytes);
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

  /**
   * AUTO setup (no prompts). Safe to call on every activation.
   * - Creates hidden venv `.locust_env` if missing
   * - Installs deps (locust, har2locust, ruff, mcp, pytest or from mcp/requirements.txt)
   * - Sets workspace python interpreter to venv
   * - Writes MCP config
   * - Creates .vscode/settings.json **only if missing**
   * - DOES NOT write ./.ruff.toml (uses bundled Ruff config only when creating settings.json)
   * - Stages CodeTour into <workspace>/.tours
   */
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

    //  Point workspace interpreter to the venv
    //  await vscode.workspace.getConfiguration('python')
    //  .update('defaultInterpreterPath', absPy, vscode.ConfigurationTarget.Workspace);

      // Write MCP config using validated interpreter
      await this.mcp.writeMcpConfig(absPy);

      // Only create settings.json if missing; avoid writing ./.ruff.toml
      const createdSettings = await ensureWorkspaceSettingsIfMissing(wsPath);
      await configureRuffIfNew(this.ctx, createdSettings);

      // Ensure the tour is available in the workspace.
      await ensureWorkspaceTour(this.ctx, wsPath);

      // Mark as done
      await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
    } catch (err: any) {
      const ch = vscode.window.createOutputChannel('Locust Setup');
      ch.appendLine(`[auto-setup] ${err?.stack || err?.message || String(err)}`);
      ch.show(true);
      vscode.window.showWarningMessage('Locust: automatic setup hit an issue. Check "Locust Setup" output for details.');
    }
  }

  // Legacy: API
  async checkAndOfferSetup(_opts: { forcePrompt?: boolean } = {}) {
    return this.autoSetupSilently();
  }

  // Manual re-run command
  private async finalizeWorkspace(wsPath: string, python: string) {
    await this.mcp.writeMcpConfig(python);
    const createdSettings = await ensureWorkspaceSettingsIfMissing(wsPath);
    await configureRuffIfNew(this.ctx, createdSettings);
    await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
  }
}
