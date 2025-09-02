import * as vscode from 'vscode';
import { LocustTreeProvider } from './locustTree';

export function activate(context: vscode.ExtensionContext) {
  const tree = new LocustTreeProvider();
  const treeView = vscode.window.createTreeView('locust.scenarios', { treeDataProvider: tree });
  context.subscriptions.push(treeView, tree); // tree is Disposable

  // Commands declared in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand('locust.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('locust.runFileUI', (node) => runFile(node, 'ui')),
    vscode.commands.registerCommand('locust.runFileHeadless', (node) => runFile(node, 'headless')),
    vscode.commands.registerCommand('locust.runTaskHeadless', (node) => runTaskHeadless(node)),
    vscode.commands.registerCommand('locust.init', async () => {
      vscode.window.showInformationMessage('Locust: Initialize (stub). Add detection/uv env logic here.');
    }),
    vscode.commands.registerCommand('locust.createSimulation', async () => {
      vscode.window.showInformationMessage('Locust: Create Simulation (stub).');
    }),
    vscode.commands.registerCommand('locust.runUI', async () => {
      vscode.window.showInformationMessage('Locust: Run UI (stub).');
    }),
    vscode.commands.registerCommand('locust.runHeadless', async () => {
      vscode.window.showInformationMessage('Locust: Run Headless (stub).');
    }),
    vscode.commands.registerCommand('locust.stop', async () => {
      vscode.window.showInformationMessage('Locust: Stop (stub).');
    }),
  );
}

export function deactivate() {}

function runFile(node: any, mode: 'ui' | 'headless') {
  const filePath = node?.filePath ?? node?.resourceUri?.fsPath;
  if (!filePath) {
    vscode.window.showWarningMessage('No file node provided.');
    return;
  }
  vscode.window.showInformationMessage(`Would run Locust ${mode.toUpperCase()} for: ${filePath}`);
  // Real execution later via a Terminal or Task
}

function runTaskHeadless(node: any) {
  const { filePath, taskName } = node ?? {};
  if (!filePath || !taskName) {
    vscode.window.showWarningMessage('No task node provided.');
    return;
  }
  vscode.window.showInformationMessage(`Would run Locust HEADLESS task "${taskName}" in: ${filePath}`);
}
