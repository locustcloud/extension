import * as vscode from 'vscode';
import * as path from 'path';

export class TourRunner {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /**
   * Opens the beginner tour that setup staged into <workspace>/.tours.
   * Avoids CodeTour's picker by opening the exact file.
   */
  async runBeginnerTour(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a workspace folder to start the Locust tour.');
      return;
    }

    const dest = vscode.Uri.file(path.join(ws.uri.fsPath, '.tours', 'locust_beginner.tour'));

    try {
      await vscode.workspace.fs.stat(dest);
    } catch {
      vscode.window.showErrorMessage(
        'Locust tour not found in this workspace (.tours/locust_beginner.tour). Try reloading the window so setup can stage it.'
      );
      return;
    }

    // Open the specific tour file (do NOT call codetour.startTour)
    await vscode.commands.executeCommand('codetour.openTourFile', dest);
  }
}
