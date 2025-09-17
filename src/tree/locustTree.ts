import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Locustfile tree: files → users → tasks
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

const CV = {
  file: 'locust.file',
  user: 'locust.user',
  task: 'locust.task',
} as const;

export class LocustTreeProvider implements vscode.TreeDataProvider<LocustNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<LocustNode | null | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private watchers: vscode.FileSystemWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;

  constructor() {
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());

    if (vscode.workspace.workspaceFolders?.length) {
      this.watchers.push(
        vscode.workspace.createFileSystemWatcher('**/*.py')
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
      // Root: list locust files (support both conventional name and templates folder)
      const ignore = '**/{.locust_env,.venv,.git,__pycache__,node_modules}/**';
      const a = await vscode.workspace.findFiles('**/locustfile*.py', ignore);
      const b = await vscode.workspace.findFiles('**/templates/*.py', ignore);

      const byPath = new Map<string, vscode.Uri>();
      [...a, ...b].forEach(u => byPath.set(u.fsPath, u));
      return [...byPath.values()].map((f) => ({
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

    // namespaced context keys for menus: viewItem == locust.file|user|task
    item.contextValue = CV[element.kind];

    // nice icons/tooltip
    item.resourceUri = element.fileUri;
    item.tooltip = element.kind === 'task'
      ? `${element.userName}.${element.taskName} — ${path.basename(element.fileUri.fsPath)}`
      : element.kind === 'user'
      ? `${element.userName} — ${path.basename(element.fileUri.fsPath)}`
      : element.label;

    // double-click to open file for any child node; keep files collapsible only
    if (element.kind !== 'file') {
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
}
