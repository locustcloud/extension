import * as vscode from 'vscode';
import * as path from 'path';

export class TourRunner {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async runBeginnerTour(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a workspace folder to start the Locust tour.');
      return;
    }

    // Ensure an empty locustfile.py exists
    await this.ensureLocustfile(ws.uri);

    // Focus it so steps line up
    await this.focusNewestLocustfile();

    // Locate bundled tour
    const srcCandidates = [
      vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', '.tours', 'locust_beginner.tour')),
      vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', '.tour', 'locust_beginner.tour')),
    ];

    let src: vscode.Uri | undefined;
    for (const c of srcCandidates) {
      try {
        await vscode.workspace.fs.stat(c);
        src = c;
        break;
      } catch {}
    }
    if (!src) {
      vscode.window.showErrorMessage('Bundled Locust tour not found in the extension package.');
      return;
    }

    // Copy tour into workspace
    const destDir = vscode.Uri.file(path.join(ws.uri.fsPath, '.tours'));
    const dest = vscode.Uri.file(path.join(destDir.fsPath, 'locust_beginner.tour'));
    try {
      await vscode.workspace.fs.stat(destDir);
    } catch {
      await vscode.workspace.fs.createDirectory(destDir);
    }
    const bytes = await vscode.workspace.fs.readFile(src);
    await vscode.workspace.fs.writeFile(dest, bytes);

    // Ensure CodeTour is active
    const ct = vscode.extensions.getExtension('vsls-contrib.codetour');
    if (ct && !ct.isActive) {
      try {
        await ct.activate();
      } catch {}
    }

    // Start tour
    try {
      await vscode.commands.executeCommand('codetour.startTour', { uri: dest });
    } catch {
      await vscode.commands.executeCommand('codetour.startTour');
    }
  }

  /** Create an empty locustfile.py in the workspace root if none exists. */
  private async ensureLocustfile(wsUri: vscode.Uri) {
    const dest = vscode.Uri.file(path.join(wsUri.fsPath, 'locustfile.py'));

    try {
      await vscode.workspace.fs.stat(dest);
      return; // already exists
    } catch {
      // no file, create it
    }

    const buf = Buffer.from('', 'utf8');
    await vscode.workspace.fs.writeFile(dest, buf);

    // Open immediately
    const doc = await vscode.workspace.openTextDocument(dest);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async focusNewestLocustfile(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    const config = vscode.workspace.getConfiguration('locust');
    const envFolder = (config.get<string>('envFolder') || '.locust_env').trim();
    const ignore = ['.venv', '.git', '__pycache__', 'node_modules', envFolder].filter(Boolean);
    const ignoreGlob = ignore.length ? `**/{${ignore.join(',')}}/**` : '';

    const files = await vscode.workspace.findFiles('**/locustfile*.py', ignoreGlob, 50);
    if (!files.length) return;

    const withStats: Array<{ uri: vscode.Uri; mtime: number }> = [];
    for (const f of files) {
      try {
        const st = await vscode.workspace.fs.stat(f);
        withStats.push({ uri: f, mtime: st.mtime });
      } catch {}
    }
    if (!withStats.length) return;

    withStats.sort((a, b) => b.mtime - a.mtime);
    const newest = withStats[0].uri;
    const doc = await vscode.workspace.openTextDocument(newest);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
