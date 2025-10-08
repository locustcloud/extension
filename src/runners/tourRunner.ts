import * as vscode from 'vscode';
import * as path from 'path';

export class TourRunner {
  private log = vscode.window.createOutputChannel('Locust Tour');

  constructor(private readonly ctx: vscode.ExtensionContext) {}


  private async ensureCodeTour(): Promise<boolean> {
    const id = 'vsls-contrib.codetour';
    let ext = vscode.extensions.getExtension(id);

    if (!ext) {
      const choice = await vscode.window.showWarningMessage(
        'The CodeTour extension is required to run this tour.',
        'Install CodeTour', 'Cancel'
      );
      if (choice !== 'Install CodeTour') return false;

      // Trigger install
      await vscode.commands.executeCommand('workbench.extensions.installExtension', id);

      // After install, ext may need a reload to activate reliably
      ext = vscode.extensions.getExtension(id);
      if (!ext) {
        const reload = await vscode.window.showInformationMessage(
          'CodeTour was installed. Reload to continue?',
          'Reload'
        );
        if (reload === 'Reload') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        return false;
      }
    }

    if (!ext.isActive) {
      try { await ext.activate(); } catch (e: any) {
        this.log.appendLine(`Failed to activate CodeTour: ${e?.message || e}`);
        vscode.window.showErrorMessage('Could not activate CodeTour.');
        return false;
      }
    }
    return true;
  }

  async runBeginnerTour(): Promise<void> {

    if (!(await this.ensureCodeTour())) return;

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a workspace folder to start the Locust tour.');
      return;
    }

    try {
      // Author the tutorial file content
      const content = `import time
from locust import HttpUser, task, between

class QuickstartUser(HttpUser):
    wait_time = between(1, 5)

    @task
    def hello_world(self):
        self.client.get("/hello")
        self.client.get("/world")

    @task(3)
    def view_items(self):
        for item_id in range(10):
            self.client.get(f"/item?id={item_id}", name="/item")
            time.sleep(1)

    def on_start(self):
        self.client.post("/login", json={"username":"foo", "password":"bar"})
`;

      // Ensure .tours exists and write tutorial file
      const toursDirUri = vscode.Uri.file(path.join(ws.uri.fsPath, '.tours'));
      await vscode.workspace.fs.createDirectory(toursDirUri); // idempotent

      const tutorialFile = vscode.Uri.file(path.join(toursDirUri.fsPath, 'locustfile_tour.py'));
      await vscode.workspace.fs.writeFile(tutorialFile, Buffer.from(content, 'utf8'));

      // Build steps from content
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      const lineOf = (pattern: RegExp | string): number => {
        const re = typeof pattern === 'string'
          ? new RegExp(`^${pattern.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`)
          : pattern;
        const idx = lines.findIndex(l => re.test(l));
        return idx >= 0 ? idx + 1 : 1; // CodeTour is 1-based
      };

      const relTourPy = '.tours/locustfile_tour.py';
      const steps = [
        {
          title: 'Imports',
          description: 'Import stdlib **time** and the Locust classes/decorators we need.',
          file: relTourPy,
          line: lineOf(/^from locust import HttpUser, task, between$/)
        },
        {
          title: 'User class',
          description: 'Define the simulated user. Locust will create an instance per virtual user.',
          file: relTourPy,
          line: lineOf(/^class QuickstartUser\(HttpUser\):$/)
        },
        {
          title: 'Wait time',
          description: 'Between tasks, each user waits a random time between 1–5 seconds.',
          file: relTourPy,
          line: lineOf(/^\s{4}wait_time = between\(1, 5\)$/)
        },
        {
          title: 'First task (decorator)',
          description: 'Mark **hello_world** as a task. Code in a task runs sequentially.',
          file: relTourPy,
          line: lineOf(/^\s{4}@task$/)
        },
        {
          title: 'First task (body)',
          description: 'Make a couple of simple GET requests.',
          file: relTourPy,
          line: lineOf(/^\s{8}self\.client\.get\("\/hello"\)$/)
        },
        {
          title: 'Weighted task',
          description: '`@task(3)` makes this task 3× more likely to be scheduled than weight 1 tasks.',
          file: relTourPy,
          line: lineOf(/^\s{4}@task\(3\)$/)
        },
        {
          title: 'Looping work',
          description: 'Iterate items and request a normalized name **/item** for aggregation.',
          file: relTourPy,
          line: lineOf(/^\s{4}def view_items\(self\):$/)
        },
        {
          title: 'Login on start',
          description: 'Authenticate once per simulated user using **on_start**.',
          file: relTourPy,
          line: lineOf(/^\s{4}def on_start\(self\):$/)
        },
        {
          title: 'Login request',
          description: 'POST to **/login** with a JSON body.',
          file: relTourPy,
          line: lineOf(/^\s{8}self\.client\.post\("\/login", json=\{"username":"foo", "password":"bar"\}\)$/)
        }
      ];

      // Always write the .tour file
      const tourUri = vscode.Uri.file(path.join(toursDirUri.fsPath, 'locust_beginner.tour'));
      const tourJson = {
        $schema: 'https://aka.ms/codetour-schema',
        title: 'Locustfile',
        description: 'Build your first locustfile step by step.',
        isPrimary: true,
        steps
      };
      await vscode.workspace.fs.writeFile(tourUri, Buffer.from(JSON.stringify(tourJson, null, 2), 'utf8'));

      // Refresh CodeTour’s view
      try { await vscode.commands.executeCommand('codetour.refreshTours'); } catch {}

      // Open the code file UX
      const doc = await vscode.workspace.openTextDocument(tutorialFile);
      await vscode.window.showTextDocument(doc, { preview: false });

      // Ensure CodeTour is active
      const ct = vscode.extensions.getExtension('vsls-contrib.codetour');
      if (ct && !ct.isActive) { try { await ct.activate(); } catch {} }

      // Start the tour
      try {
        await vscode.commands.executeCommand('codetour.startTour', { uri: tourUri });
      } catch {
        await vscode.commands.executeCommand('codetour.startTour');
      }
    } catch (err: any) {
      this.log.appendLine(`Tour error: ${err?.stack || err?.message || String(err)}`);
      this.log.show(true);
      vscode.window.showErrorMessage('Failed to start Locust tour. See "Locust Tour" output for details.');
    }
  }
}
