import * as vscode from 'vscode';
import * as path from 'path';
import { LocustTreeProvider } from './locustTree';
import { checkAndOfferSetup, getConfig, repairWorkspaceInterpreterIfBroken } from './setup';

const LOCUST_TERMINAL_NAME = 'Locust';

// NEW: capture extension URI so helpers can access templates without threading ctx everywhere
let EXTENSION_URI: vscode.Uri;

export function activate(ctx: vscode.ExtensionContext) {
  EXTENSION_URI = ctx.extensionUri;

  // Try to repair a broken Python interpreter setting on startup (cross-platform).
  // If locust_env exists, it will re-point python.defaultInterpreterPath to it.
  repairWorkspaceInterpreterIfBroken().catch(err => console.error(err));

  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  ctx.subscriptions.push(treeView, tree); // tree is Disposable

  // Prompt set up env/locust on first activation (trusted workspaces only)
  checkAndOfferSetup(ctx).catch(err => console.error(err));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('locust.runFileUI', (node) => runFile(node, 'ui')),
    vscode.commands.registerCommand('locust.runFileHeadless', (node) => runFile(node, 'headless')),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runTaskHeadless(node)),
    vscode.commands.registerCommand('locust.init', async () => {
      // Expose setup via a command
      await checkAndOfferSetup(ctx, { forcePrompt: true });
    }),

    // ✅ NEW: open the walkthrough directly
    vscode.commands.registerCommand('locust.openWalkthrough', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'locust.locust-vscode-extension#locust.gettingStarted' // <publisher>.<name>#<walkthroughId>
      );
    }),

    // Generic run commands (palette) <<<
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

    // NEW: Run by Tag… (prompts for tag(s) and runs headless with --tags)
    vscode.commands.registerCommand('locust.runByTag', async () => {
      const file = await pickLocustfile();
      if (!file) return;

      const tag = await vscode.window.showInputBox({
        prompt: 'Enter a Locust tag to run (comma-separated for multiple)',
        placeHolder: 'e.g. checkout,auth'
      });
      if (!tag) return;

      // Locust accepts comma-separated tags in single --tags argument
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

      const templatesDir = vscode.Uri.joinPath(EXTENSION_URI, 'templates');
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
        label: require('path').basename(u.fsPath),
        description: u.fsPath,
        uri: u
      }));

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose a Locust template'
      });
      if (!choice) return;

      const defaultName = choice.label.toLowerCase().includes('locustfile') ? choice.label : 'locustfile.py';
      const dest = vscode.Uri.joinPath(folder.uri, defaultName);
      const templateBytes = await vscode.workspace.fs.readFile(choice.uri);
      const templateText = Buffer.from(templateBytes).toString('utf8');

      // If target exists, handle open/dirty editor properly
      let exists = true;
      try {
        await vscode.workspace.fs.stat(dest);
      } catch {
        exists = false;
      }

      // Helper: If any open document replace with new content
      const replaceOpenDoc = async (doc: vscode.TextDocument, newText: string) => {
        const edit = new vscode.WorkspaceEdit();
        const whole = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(dest, whole, newText);
        await vscode.workspace.applyEdit(edit);
      };

      // Show the final document in editor
      const showDoc = async () => {
        const doc = await vscode.workspace.openTextDocument(dest);
        await vscode.window.showTextDocument(doc, { preview: false });
      };

      if (exists) {
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === dest.toString());
        if (openDoc && openDoc.isDirty) {
          const choice = await vscode.window.showWarningMessage(
            `${defaultName} has unsaved changes. What would you like to do?`,
            { modal: true },
            'Save & Overwrite',
            'Replace (Discard)',
            'Cancel'
          );
          if (choice === 'Cancel' || !choice) return;

          if (choice === 'Save & Overwrite') {
            await openDoc.save();
            await vscode.workspace.fs.writeFile(dest, Buffer.from(templateText, 'utf8'));
            await showDoc();
          } else if (choice === 'Replace (Discard)') {
            await replaceOpenDoc(openDoc, templateText);
            await openDoc.save();
          }
        } else {
          await vscode.workspace.fs.writeFile(dest, Buffer.from(templateText, 'utf8'));
          await showDoc();
        }
      } else {
        await vscode.workspace.fs.writeFile(dest, Buffer.from(templateText, 'utf8'));
        await showDoc();
      }

      // Tree reflect new/updated tasks immediately
      vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});

      vscode.window.showInformationMessage(`Created ${defaultName} from template.`);
    }),
  );
}


export function deactivate() {}

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

// Commands called from tree/context menu
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

  // Build ignore globs dynamically from config
  const { envFolder } = getConfig();
  const ignoreDirs = new Set([envFolder, '.venv', '.git', '__pycache__', 'node_modules']);
  const ignoreList = Array.from(ignoreDirs).filter(Boolean);
  const ignoreGlob = ignoreList.length ? `**/{${ignoreList.join(',')}}/**` : '';

  const files = await vscode.workspace.findFiles('**/locustfile*.py', ignoreGlob, 50);

  if (files.length === 0) {
    // AUTO-CREATE from extension template on first run
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to create files.');
      return;
    }
    const templatesDir = vscode.Uri.joinPath(EXTENSION_URI, 'templates');
    try {
      const entries = await vscode.workspace.fs.readDirectory(templatesDir);
      const locustfileEntry = entries.find(
        ([name, type]) => type === vscode.FileType.File && name.toLowerCase() === 'locustfile.py'
      );
      const templateUri = locustfileEntry
        ? vscode.Uri.joinPath(templatesDir, locustfileEntry[0])
        : vscode.Uri.joinPath(templatesDir, entries.find(([, t]) => t === vscode.FileType.File)![0]);

      const bytes = await vscode.workspace.fs.readFile(templateUri);
      const dest = vscode.Uri.joinPath(ws.uri, 'locustfile.py');
      await vscode.workspace.fs.writeFile(dest, bytes);

      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc, { preview: false });

      // NEW: refresh the Locust tree immediately
      vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});

      vscode.window.showInformationMessage('Created locustfile.py from template.');
      return dest;
    } catch {
      vscode.window.showErrorMessage('No templates directory or template file found in the extension.');
      return;
    }
  }

  if (files.length === 1) return files[0];

  // Sort: prefer files closer to workspace root
  const picks = files
    .sort((a, b) => a.fsPath.length - b.fsPath.length)
    .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));

  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a locustfile to run' });
  return choice?.uri;
}

