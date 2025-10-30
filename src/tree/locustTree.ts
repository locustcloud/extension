// tree/locustTree.ts
import * as vscode from 'vscode';
import * as path from 'path';

type NodeKind = 'file' | 'user' | 'task';
interface LocustNode {
  kind: NodeKind;
  label: string;
  fileUri: vscode.Uri;
  userName?: string;
  taskName?: string;
  filePath?: string;
}

export class LocustTreeProvider implements vscode.TreeDataProvider<LocustNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<LocustNode | null | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private watchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;

  // Keep a central list of known locustfiles for the picker
  private _knownFiles: vscode.Uri[] = [];

  constructor() {
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
    if (vscode.workspace.workspaceFolders?.length) {
      this.watchers.push(
        vscode.workspace.createFileSystemWatcher('**/locustfile*.py'),
        vscode.workspace.createFileSystemWatcher('**/*.py')
      );
      for (const w of this.watchers) {
        w.onDidCreate(() => this.refreshDebounced());
        w.onDidChange(() => this.refreshDebounced());
        w.onDidDelete(() => this.refreshDebounced());
      }
    }
  }

  refresh(): void { this.emitter.fire(undefined); }
  private refreshDebounced(ms = 250) {
    clearTimeout(this.refreshTimer as any);
    this.refreshTimer = setTimeout(() => this.refresh(), ms);
  }
  dispose(): void {
    this.emitter.dispose();
    this.watchers.forEach(w => w.dispose());
    clearTimeout(this.refreshTimer as any);
  }

  async getChildren(element?: LocustNode): Promise<LocustNode[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    if (!element) {
      // Root: known files
      const exclude = '**/{.venv,.locust_env,.tour,.git,__pycache__,node_modules,site-packages,dist,build}/**';
      const explicit = await vscode.workspace.findFiles('**/locustfile*.py', exclude);

      // Also infer based on import
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

      const files = [...explicit, ...inferred].sort((a, b) => a.fsPath.localeCompare(b.fsPath));

      // Cache known files for pickers/runners
      this._knownFiles = files;

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
      const start = text.indexOf(`class ${element.userName}`);
      const next = start >= 0 ? text.indexOf('\nclass ', start + 1) : -1;
      const body = start >= 0 ? (next > -1 ? text.slice(start, next) : text.slice(start)) : text;
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
    if (element.kind === 'user' || element.kind === 'task') {
      item.command = { command: 'vscode.open', title: 'Open locustfile', arguments: [element.fileUri] };
    }
    return item;
  }

  private async read(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  private async looksLikeLocustFile(uri: vscode.Uri): Promise<boolean> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
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

    // Prefer the active editor.
    const active = vscode.window.activeTextEditor?.document;
    if (active?.uri?.scheme === 'file' && active.languageId === 'python') {
      const fsPath = active.uri.fsPath;
      const name = path.basename(fsPath).toLowerCase();
      // If the active file looks like a locustfile by filename, is in the known list, or imports locust → use it.
      if (name.startsWith('locustfile') || this.isKnown(fsPath) || await this.looksLikeLocustFile(active.uri)) {
        return active.uri;
      }
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
