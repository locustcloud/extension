import * as assert from 'assert';
import * as vscode from 'vscode';

/** 
 * You can import and use all API from the 'vscode' module
 * as well as import your extension to test it
 * import * as myExtension from '../src/extension';
 */

suite('Extension Basics', () => {
  test('Extension activates and registers commands', async () => {
    // IMPORTANT: this ID must be <publisher>.<name> from your package.json
    const ext = vscode.extensions.getExtension('locust.locust-vscode-extension');
    assert.ok(ext, 'Extension not found by ID (publisher.name)');
    await ext!.activate();

    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('locust.refreshTree'), 'locust.refreshTree not registered');
    assert.ok(cmds.includes('locust.createSimulation'), 'locust.createSimulation not registered');
  });
});
