import * as assert from 'assert';
import * as vscode from 'vscode';

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
