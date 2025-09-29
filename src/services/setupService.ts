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

// Ruff + settings: keep generator as a fallback only.
async function ensureRuffToml(workspacePath: string) {
  const ruffPath = path.join(workspacePath, '.ruff.toml');
  if (await fileExists(ruffPath)) return;

  // Valid TOML; add .tours/** to excludes
  const ruffToml = `target-version = "py311"

extend-exclude = [
  ".locust_env/**",
  ".tours/**",
  "templates/**"
]

lint.select = ["E", "F", "W"]
`;
  await fs.writeFile(ruffPath, ruffToml, 'utf8');
}

/**
 * Prefer a bundled Ruff config so we DON'T create .ruff.toml in the workspace.
 * If a bundled config isn't present and no configuration is set, fall back to generating .ruff.toml.
 */
async function ensureRuffConfigured(ctx: vscode.ExtensionContext, workspacePath: string) {
  const ruffCfg = vscode.workspace.getConfiguration('ruff');
  const existing = ruffCfg.get<unknown>('configuration');

  // If user/workspace already set something (string path or inline object), leave it alone.
  if (existing !== undefined && existing !== null && `${existing}`.length > 0) {
    return;
  }

  // Try to use a bundled file from the extension (media/ruff/ruff.toml).
  const bundledPath = path.join(ctx.extensionUri.fsPath, 'media', 'ruff', 'ruff.toml');
  try {
    await fs.stat(bundledPath);
    await ruffCfg.update('configuration', bundledPath, vscode.ConfigurationTarget.Workspace);
    return;
  } catch {
    // No bundled config available — fall back to generating a hidden workspace file.
  }

  // Fallback: generate .ruff.toml in the workspace as before.
  await ensureRuffToml(workspacePath);
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

  // Set python.defaultInterpreterPath separately (after venv creation).
  const desired = {
    "python.terminal.activateEnvironment": true,
    "ruff.lint.run": "onType",
    "markdown.preview.enableCommandUris": true,
    "[python]": {
      "editor.codeActionsOnSave": { "source.fixAll.ruff": "never" },
      "editor.formatOnSave": false
    }
  };

  // Hide internal files/dirs in Explorer, Search, and file watcher
  const desiredFilesExclude = {
    "**/.locust_env": true,
    "**/.tours": true,
    "**/.ruff.toml": true
  };
  const desiredSearchExclude = {
    "**/.locust_env/**": true,
    "**/.tours/**": true
  };
  const desiredWatcherExclude = {
    "**/.locust_env/**": true,
    "**/.tours/**": true
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

  // Deep-merge excludes without overwriting explicit user choices
  const curFiles = current["files.exclude"] ?? {};
  const curSearch = current["search.exclude"] ?? {};
  const curWatch = current["files.watcherExclude"] ?? {};

  merged["files.exclude"] = {
    ...curFiles,
    "**/.locust_env": curFiles["**/.locust_env"] ?? desiredFilesExclude["**/.locust_env"],
    "**/.tours":      curFiles["**/.tours"]      ?? desiredFilesExclude["**/.tours"],
    "**/.ruff.toml":  curFiles["**/.ruff.toml"]  ?? desiredFilesExclude["**/.ruff.toml"]
  };

  merged["search.exclude"] = {
    ...curSearch,
    "**/.locust_env/**": curSearch["**/.locust_env/**"] ?? desiredSearchExclude["**/.locust_env/**"],
    "**/.tours/**":      curSearch["**/.tours/**"]      ?? desiredSearchExclude["**/.tours/**"]
  };

  merged["files.watcherExclude"] = {
    ...curWatch,
    "**/.locust_env/**": curWatch["**/.locust_env/**"] ?? desiredWatcherExclude["**/.locust_env/**"],
    "**/.tours/**":      curWatch["**/.tours/**"]      ?? desiredWatcherExclude["**/.tours/**"]
  };

  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
}

// --- Setup service
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
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Ensure <workspace>/.tours/locust_beginner.tour exists.
 * If it exists, only overwrite when bundled locustTourVersion !== workspace version.
 * (CodeTour ignores unknown keys, so 'locustTourVersion' is safe to include.)
 */
async function ensureWorkspaceTour(ctx: vscode.ExtensionContext, wsPath: string) {
  const srcUri = await findBundledTour(ctx);
  if (!srcUri) return;

  const destDir = path.join(wsPath, '.tours');
  const destPath = path.join(destDir, 'locust_beginner.tour');
  const destUri = vscode.Uri.file(destPath);

  let shouldCopy = false;

  // Read version from bundled tour
  const srcJson = await readJson(srcUri);
  const srcVersion = srcJson?.locustTourVersion ?? '0';

  // Ensure destination directory exists
  try { await fs.mkdir(destDir, { recursive: true }); } catch {}

  // Compare with existing workspace tour (if any)
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
   * - Patches settings and Ruff config (via bundled file; falls back to .ruff.toml only if needed)
   * - Stages CodeTour into <workspace>/.tours
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

      // Patch editor settings + Ruff configuration (prefer bundled; fallback to .ruff.toml)
      await ensureRuffConfigured(this.ctx, wsPath);
      await ensureWorkspaceSettingsPatched(wsPath);

      // Ensure the tour is available in the workspace.
      await ensureWorkspaceTour(this.ctx, wsPath);

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

  // Legacy: API
  async checkAndOfferSetup(_opts: { forcePrompt?: boolean } = {}) {
    return this.autoSetupSilently();
  }

  // Manual re-run command 
  private async finalizeWorkspace(wsPath: string, python: string) {
    await this.mcp.writeMcpConfig(python);
    await ensureRuffConfigured(this.ctx, wsPath);
    await ensureWorkspaceSettingsPatched(wsPath);
    await this.ctx.workspaceState.update(WS_SETUP_KEY, true);
  }
}
