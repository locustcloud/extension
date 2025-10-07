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
    const toursDir = vscode.Uri.file(path.join(ws.uri.fsPath, '.tours'));
    const tutorialFile = vscode.Uri.file(path.join(toursDir.fsPath, 'locustfile_tour.py'));
    try { await vscode.workspace.fs.stat(toursDir); } catch { await vscode.workspace.fs.createDirectory(toursDir); }
    await vscode.workspace.fs.writeFile(tutorialFile, Buffer.from(content, 'utf8'));

    // Open tutorial file
    const doc = await vscode.workspace.openTextDocument(tutorialFile);
    await vscode.window.showTextDocument(doc, { preview: false });

    // Build steps that reference lines.
    const lines = content.replace(/\r\n/g, '\n').split('\n');

    const lineOf = (pattern: RegExp | string): number => {
      const re = typeof pattern === 'string'
        ? new RegExp(`^${pattern.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`)
        : pattern;
      const idx = lines.findIndex(l => re.test(l));
      // CodeTour is 1-based; default to 1 if missing
      return idx >= 0 ? idx + 1 : 1;
    };

    // CodeTour step file path
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

    // Write .tour file
    const tourFile = vscode.Uri.file(path.join(toursDir.fsPath, 'locust_beginner.tour'));
    const tourJson = {
      $schema: 'https://aka.ms/codetour-schema',
      title: 'Locustfile',
      description: 'Build your first locustfile step by step.',
      isPrimary: true,
      steps
    };
    await vscode.workspace.fs.writeFile(tourFile, Buffer.from(JSON.stringify(tourJson, null, 2), 'utf8'));

    // Start tour
    const ct = vscode.extensions.getExtension('vsls-contrib.codetour');
    if (ct && !ct.isActive) {
      try { await ct.activate(); } catch { /* ignore */ }
    }
    try {
      // Pass the Uri directly
      await vscode.commands.executeCommand('codetour.startTour', tourFile);
    } catch {
      await vscode.commands.executeCommand('codetour.startTour');
    }
  }
}
