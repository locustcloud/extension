import * as vscode from 'vscode';
import * as path from 'path';

export class TourRunner {
  private log = vscode.window.createOutputChannel('Locust Tour');

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async runBeginnerTour(): Promise<void> {
    // Optional: skip while setup is running (SetupService should set this flag)
    if (this.ctx.workspaceState.get<boolean>('locust.isSettingUp', false)) {
      vscode.window.showInformationMessage('Locust is still setting up… try again in a moment.');
      return;
    }

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
        { title: 'Imports', description: 'Import stdlib **time** and the Locust classes/decorators we need.', file: relTourPy, line: lineOf(/^from locust import HttpUser, task, between$/) },
        { title: 'User class', description: 'Define the simulated user. Locust will create an instance per virtual user.', file: relTourPy, line: lineOf(/^class QuickstartUser\(HttpUser\):$/) },
        { title: 'Wait time', description: 'Between tasks, each user waits a random time between 1–5 seconds.', file: relTourPy, line: lineOf(/^\s{4}wait_time = between\(1, 5\)$/) },
        { title: 'First task (decorator)', description: 'Mark **hello_world** as a task. Code in a task runs sequentially.', file: relTourPy, line: lineOf(/^\s{4}@task$/) },
        { title: 'First task (body)', description: 'Make a couple of simple GET requests.', file: relTourPy, line: lineOf(/^\s{8}self\.client\.get\("\/hello"\)$/) },
        { title: 'Weighted task', description: '`@task(3)` makes this task 3× more likely to be scheduled than weight 1 tasks.', file: relTourPy, line: lineOf(/^\s{4}@task\(3\)$/) },
        { title: 'Looping work', description: 'Iterate items and request a normalized name **/item** for aggregation.', file: relTourPy, line: lineOf(/^\s{4}def view_items\(self\):$/) },
        { title: 'Login on start', description: 'Authenticate once per simulated user using **on_start**.', file: relTourPy, line: lineOf(/^\s{4}def on_start\(self\):$/) },
        { title: 'Login request', description: 'POST to **/login** with a JSON body.', file: relTourPy, line: lineOf(/^\s{8}self\.client\.post\("\/login", json=\{"username":"foo", "password":"bar"\}\)$/) }
      ];

      // Write .tour file only if missing (avoid races with SetupService pre-seed)
      const tourUri = vscode.Uri.file(path.join(toursDirUri.fsPath, 'locust_beginner.tour'));
      let hasTour = true;
      try { await vscode.workspace.fs.stat(tourUri); }
      catch { hasTour = false; }

      if (!hasTour) {
        const tourJson = {
          $schema: 'https://aka.ms/codetour-schema',
          title: 'Locustfile',
          description: 'Build your first locustfile step by step.',
          isPrimary: true,
          steps
        };
        await vscode.workspace.fs.writeFile(tourUri, Buffer.from(JSON.stringify(tourJson, null, 2), 'utf8'));
      }

      // Refresh CodeTour’s view (helps if user had the tree open)
      try { await vscode.commands.executeCommand('codetour.refreshTours'); } catch {}

      // Open the code file (nice UX), then start the tour
      const doc = await vscode.workspace.openTextDocument(tutorialFile);
      await vscode.window.showTextDocument(doc, { preview: false });

      const ct = vscode.extensions.getExtension('vsls-contrib.codetour');
      if (ct && !ct.isActive) { try { await ct.activate(); } catch {} }

      await vscode.commands.executeCommand('codetour.startTour', tourUri);
    } catch (err: any) {
      this.log.appendLine(`Tour error: ${err?.stack || err?.message || String(err)}`);
      this.log.show(true);
      vscode.window.showErrorMessage('Failed to start Locust tour. See "Locust Tour" output for details.');
    }
  }
}
