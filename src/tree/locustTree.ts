import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Locustfile manipulation, refresh and discard changes
 * Tree data provider for Locust files, users, and tasks
 */

type NodeKind = 'file' | 'user' | 'task';

interface LocustNode {
  kind: NodeKind;
  label: string;
  fileUri: vscode.Uri;
  userName?: string;
  taskName?: string;
  filePath?: string; // convenience for commands
}

export class LocustTreeProvider implements vscode.TreeDataProvider<LocustNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<LocustNode | null | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private watchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;

  // ► NEW: keep a central list of known locustfiles for the picker
  private _knownFiles: vscode.Uri[] = [];

  constructor() {
    // Refresh when workspace changes
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());

    // Watch for relevant file changes
    if (vscode.workspace.workspaceFolders?.length) {
      this.watchers.push(
        vscode.workspace.createFileSystemWatcher('**/locustfile*.py'),
        vscode.workspace.createFileSystemWatcher('**/*.py') // tasks may move between files
      );
      for (const w of this.watchers) {
        w.onDidCreate(() => this.refreshDebounced());
        w.onDidChange(() => this.refreshDebounced());
        w.onDidDelete(() => this.refreshDebounced());
      }
    }
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  private refreshDebounced(ms = 250) {
    clearTimeout(this.refreshTimer as any);
    this.refreshTimer = setTimeout(() => this.refresh(), ms);
  }

  dispose(): void {
    this.emitter.dispose();
    this.watchers.forEach(w => w.dispose());
    clearTimeout(this.refreshTimer as any);
  }

  // Tree API
  async getChildren(element?: LocustNode): Promise<LocustNode[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    if (!element) {
      // Root: list Locust files (canonical names + any *.py that import locust)
      const exclude = '**/{.venv,.locust_env, .tour, .git,__pycache__,node_modules,site-packages,dist,build}/**';

      // Canonical names
      const explicit = await vscode.workspace.findFiles('**/locustfile*.py', exclude);

      // Inferred from imports
      const candidates = await vscode.workspace.findFiles('**/*.py', exclude);
      const seen = new Set(explicit.map(u => u.fsPath));
      const inferred: vscode.Uri[] = [];
      for (const uri of candidates) {
        if (seen.has(uri.fsPath)) continue;
        if (await this.looksLikeLocustFile(uri)) {
          inferred.push(uri);
          seen.add(uri.fsPath);
        }
      }

      const files = [...explicit, ...inferred];

      // ► NEW: keep this list for the picker
      this._knownFiles = files;

      return files.map((f) => ({
        kind: 'file',
        label: vscode.workspace.asRelativePath(f),
        fileUri: f,
        filePath: f.fsPath
      }));
    }

    if (element.kind === 'file') {
      const text = await this.read(element.fileUri);
      const users: LocustNode[] = [];
      // class MyUser(FastHttpUser|HttpUser|User):
      const userRegex = /class\s+([A-Za-z_]\w*)\s*\(\s*(FastHttpUser|HttpUser|User)\s*\)\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = userRegex.exec(text)) !== null) {
        users.push({
          kind: 'user',
          label: m[1],
          fileUri: element.fileUri,
          userName: m[1],
          filePath: element.fileUri.fsPath
        });
      }
      return users;
    }

    if (element.kind === 'user' && element.userName) {
      const text = await this.read(element.fileUri);

      // Narrow to the class body (simple heuristic)
      const start = text.indexOf(`class ${element.userName}`);
      const next = start >= 0 ? text.indexOf('\nclass ', start + 1) : -1;
      const body = start >= 0 ? (next > -1 ? text.slice(start, next) : text.slice(start)) : text;

      // @task or @task(3) followed by def <name>(
      const taskRegex = /@task(?:\s*\([^)]*\))?\s*\r?\n\s*def\s+([A-Za-z_]\w*)\s*\(/g;
      const tasks: LocustNode[] = [];
      let m2: RegExpExecArray | null;
      while ((m2 = taskRegex.exec(body)) !== null) {
        tasks.push({
          kind: 'task',
          label: m2[1],
          fileUri: element.fileUri,
          userName: element.userName,
          taskName: m2[1],
          filePath: element.fileUri.fsPath
        });
      }
      return tasks;
    }

    return [];
  }

  getTreeItem(element: LocustNode): vscode.TreeItem {
    const collapsible =
      element.kind === 'file' || element.kind === 'user'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, collapsible);
    item.contextValue = element.kind;

    if (element.kind !== 'file') {
      item.description = path.basename(element.fileUri.fsPath);
    }

    // Optional double-click behavior
    if (element.kind === 'user' || element.kind === 'task') {
      item.command = {
        command: 'vscode.open',
        title: 'Open locustfile',
        arguments: [element.fileUri]
      };
    }

    return item;
  }
 
  // Utils
  private async read(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  // Heuristic: treat a *.py as a locust file if it imports locust
  private async looksLikeLocustFile(uri: vscode.Uri): Promise<boolean> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      // Read only the first ~16KB to keep it snappy; imports are usually near the top.
      const text = Buffer.from(bytes).toString('utf8', 0, Math.min(bytes.byteLength, 16 * 1024));
      return /(from\s+locust\s+import\s+|import\s+locust\b)/.test(text);
    } catch {
      return false;
    }
  }

  // Helper picker to check if file is from known list
  private isKnown(fsPath: string): boolean {
    return this._knownFiles.some(u => u.fsPath === fsPath);
  }

  /**
   * Centralized picker used by both local & cloud runs.
   * Logic:
   *  1) If active editor is a locustfile (name matches, known in tree, or imports locust) → use it.
   *  2) Else, if we have known locustfiles, QuickPick them.
   *  3) Else, let user choose a Python file or scaffold a new one.
   *
   * @param scaffoldCmdId command id that returns a vscode.Uri (e.g. 'locust.createLocustfile')
   */
  async pickLocustfileOrActive(scaffoldCmdId = 'locust.createLocustfile'): Promise<vscode.Uri | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    // Prefer the active editor if it looks like a locustfile
    const active = vscode.window.activeTextEditor?.document;
    if (active?.uri?.scheme === 'file' && active.languageId === 'python') {
      const fsPath = active.uri.fsPath;

      // Match canonical filenames: locustfile*.py
      if (/(?:^|[\\/])locustfile.*\.py$/i.test(fsPath)) {
        return active.uri;
      }

      // If it's already in our tree list
      if (this.isKnown(fsPath)) {
        return active.uri;
      }

      // If it imports locust near the top
      try {
        if (await this.looksLikeLocustFile(active.uri)) {
          return active.uri;
        }
      } catch {
        // ignore
      }
    }

    // If files discovered by the tree, offer them
    if (this._knownFiles.length > 0) {
      if (this._knownFiles.length === 1) return this._knownFiles[0];

      const picks = this._knownFiles.map(u => ({
        label: vscode.workspace.asRelativePath(u),
        description: path.basename(u.fsPath),
        uri: u
      }));
      const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Choose a locustfile to run',
        matchOnDescription: true,
      });
      if (chosen?.uri) return chosen.uri;
    }

    // Otherwise: Choose or Scaffold
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(file-code) Choose a Python file…', action: 'choose' as const },
        { label: '$(add) Scaffold a new locustfile', action: 'scaffold' as const },
        { label: '$(x) Cancel', action: 'cancel' as const },
      ],
      { placeHolder: 'No locustfile found. What would you like to do?' }
    );
    if (!action || action.action === 'cancel') return;

    if (action.action === 'choose') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { Python: ['py'] },
        title: 'Select locustfile.py',
        defaultUri: ws.uri,
      });
      return picked?.[0];
    }

    if (action.action === 'scaffold') {
      const dest = await vscode.commands.executeCommand(scaffoldCmdId);
      if (dest && typeof dest === 'object' && 'fsPath' in dest) {
        return dest as vscode.Uri;
      }
    }

    return undefined;
  }
}
