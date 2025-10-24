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

  // NEW: cache of currently known files as URIs
  private _knownFiles: vscode.Uri[] = [];
  getKnownFiles(): vscode.Uri[] { return this._knownFiles.slice(); }
  isKnown(fsPath: string): boolean {
    const norm = path.normalize(fsPath);
    return this._knownFiles.some(u => path.normalize(u.fsPath) === norm);
  }

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
      // NOTE: remove stray space after .locust_env in your original glob
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

      // NEW: cache known files for pickers/runners
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

  // locustfile.py template. 
  private async findWorkspaceTemplate(): Promise<vscode.Uri | undefined> {
    const exclude = '**/{.venv,.locust_env,.tour,.git,__pycache__,node_modules,site-packages,dist,build}/**';
    const hits = await vscode.workspace.findFiles('**/templates/locustfile.py', exclude, 1);
    return hits[0];
  }

  /** Read file contents as UTF-8. */
  private async readUtf8(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  /** Compute next available locustfile name: locustfile_001.py, 002, ... in dir. */
  private async nextLocustfileUri(dir: vscode.Uri): Promise<vscode.Uri> {
    let maxIndex = 0;
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        // Match: locustfile.py  OR  locustfile_###.py
        const m = /^locustfile(?:_(\d+))?\.py$/i.exec(name);
        if (m) {
          const idx = m[1] ? parseInt(m[1], 10) : 0; // plain locustfile.py = 0
          if (!Number.isNaN(idx)) maxIndex = Math.max(maxIndex, idx);
        }
      }
    } catch {
      // dir may not exist; caller will create it
    }
    const next = Math.max(1, maxIndex + 1);
    const nextName = `locustfile_${String(next).padStart(3, '0')}.py`;
    return vscode.Uri.file(path.join(dir.fsPath, nextName));
  }

  /**
   * Create locustfile from template (templates/locustfile.py).
   * Returns the created file Uri (or undefined if cancelled).
   */
  public async createLocustfileFromTemplate(opts: { open?: boolean } = {}): Promise<vscode.Uri | undefined> {
    const { open = true } = opts;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return undefined;
    }

    // Choose destination
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select folder for new locustfile',
      defaultUri: ws.uri,
    });
    if (!picked || picked.length === 0) {
      vscode.window.showInformationMessage('Locustfile creation cancelled.');
      return undefined;
    }
    const dir = picked[0];


    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
    }

    // Resolve template
    let content: string;
    const tmpl = await this.findWorkspaceTemplate();
    if (tmpl) {
      try {
        content = await this.readUtf8(tmpl);
      } catch {
        content = `from locust import FastHttpUser, task

class MyUser(FastHttpUser):
    host = "http://localhost"
    @task
    def t(self):
        self.client.get("/")\n`;
      }
    } else {
      content = `from locust import FastHttpUser, task

class MyUser(FastHttpUser):
    host = "http://localhost"
    @task
    def t(self):
        self.client.get("/")\n`;
    }

    // Pick unique filename and write
    const dest = await this.nextLocustfileUri(dir);
    await vscode.workspace.fs.writeFile(dest, Buffer.from(content, 'utf8'));

    // 5) Open & refresh tree
    if (open) {
      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    this.refresh(); // update known files cache when getChildren runs again

    vscode.window.showInformationMessage(`Created ${vscode.workspace.asRelativePath(dest)}.`);
    return dest;
  }

  // Locustfile picker
  async pickLocustfileOrActive(scaffoldCmdId = 'locust.createLocustfile'): Promise<vscode.Uri | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    // Accept active
    const active = vscode.window.activeTextEditor?.document;
    if (active && /(?:^|[\/\\])locustfile.*\.py$/i.test(active.fileName) && this.isKnown(active.fileName)) {
      return vscode.Uri.file(active.fileName);
    }

    // QuickPick from known files
    if (this._knownFiles.length > 0) {
      if (this._knownFiles.length === 1) return this._knownFiles[0];

      const picks = this._knownFiles.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
      const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Choose a locustfile to run',
        matchOnDescription: true,
      });
      if (chosen?.uri) return chosen.uri;
    }

    // User skip or None locustfile.py: Choose / Scaffold
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(file-code) Choose a Python file…', action: 'choose' },
        { label: '$(add) Scaffold a new locustfile', action: 'scaffold' },
        { label: '$(x) Cancel', action: 'cancel' },
      ],
      { placeHolder: 'No locustfile found. Create a locustfile.py template?' }
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
