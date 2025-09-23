import * as vscode from 'vscode';
import * as path from 'path';

export class TourRunner {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /**
   * Ensures the beginner tour exists inside the current workspace,
   * then opens it directly (no picker).
   */
  async runBeginnerTour(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a workspace folder to start the Locust tour.');
      return;
    }

    // Source bundled inside the extension (try .tours then .tour)
    const srcCandidates = [
      vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', '.tours', 'locust_beginner.tour')),
      vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', '.tour',  'locust_beginner.tour')),
    ];

    let src: vscode.Uri | undefined;
    for (const c of srcCandidates) {
      try {
        await vscode.workspace.fs.stat(c);
        src = c;
        break;
      } catch {/* try next */}
    }
    if (!src) {
      vscode.window.showErrorMessage('Bundled Locust tour not found in the extension package.');
      return;
    }

    // Copy into the workspace so CodeTour treats it as a workspace tour
    const destDir = vscode.Uri.file(path.join(ws.uri.fsPath, '.tours'));
    const dest = vscode.Uri.file(path.join(destDir.fsPath, 'locust_beginner.tour'));

    try {
      await vscode.workspace.fs.stat(destDir);
    } catch {
      await vscode.workspace.fs.createDirectory(destDir);
    }

    const bytes = await vscode.workspace.fs.readFile(src);
    await vscode.workspace.fs.writeFile(dest, bytes);

    // Ensure CodeTour is activated
    const ct = vscode.extensions.getExtension('vsls-contrib.codetour');
    if (ct && !ct.isActive) {
      try { await ct.activate(); } catch {/* ignore, we can still try to start */}
    }

    // Start the tour directly (do not open the JSON)
    try {
      await vscode.commands.executeCommand('codetour.startTour', { uri: dest });
    } catch {
      // Fallback: open the tour picker if targeted start failed
      await vscode.commands.executeCommand('codetour.startTour');
    }
  }
}
