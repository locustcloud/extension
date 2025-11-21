import * as vscode from 'vscode';

/**
 * Check if file exists.
 * Uses vscode.workspace.fs.stat which works with both local and remote files.
 */

export async function fileExists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}
