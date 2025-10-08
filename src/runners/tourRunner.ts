import * as vscode from 'vscode';
import * as path from 'path';

export class TourRunner {
  private log = vscode.window.createOutputChannel('Locust Tour');

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  // Ensure the CodeTour extension exists and is active.
  private async ensureCodeTour(): Promise<boolean> {
    const id = 'vsls-contrib.codetour';
    let ext = vscode.extensions.getExtension(id);

    if (!ext) {
      const choice = await vscode.window.showWarningMessage(
        'The CodeTour extension is required to run this tour.',
        'Install CodeTour', 'Cancel'
      );
      if (choice !== 'Install CodeTour') return false;

      await vscode.commands.executeCommand('workbench.extensions.installExtension', id);

      // Try post-install, requires reload
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
      try { await ext.activate(); }
      catch (e: any) {
        this.log.appendLine(`Failed to activate CodeTour: ${e?.message || e}`);
        vscode.window.showErrorMessage('Could not activate CodeTour.');
        return false;
      }
    }
    return true;
  }

  // Prepare or refresh tour files without running CodeTour.
  public async ensureBeginnerTourFiles(
    wsUri?: vscode.Uri,
    opts: { overwrite?: boolean } = {}
  ): Promise<{ tutorialFile: vscode.Uri; tourFile: vscode.Uri } | undefined> {
    const ws = wsUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) return;

    const overwrite = opts.overwrite ?? true;

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

    // Write tutorial .py
    const toursDirUri = vscode.Uri.file(path.join(ws.fsPath, '.tours'));
    await vscode.workspace.fs.createDirectory(toursDirUri); // idempotent

    const tutorialFile = vscode.Uri.file(path.join(toursDirUri.fsPath, 'locustfile_tour.py'));
    if (overwrite) {
      await vscode.workspace.fs.writeFile(tutorialFile, Buffer.from(content, 'utf8'));
    } else {
      try { await vscode.workspace.fs.stat(tutorialFile); }
      catch { await vscode.workspace.fs.writeFile(tutorialFile, Buffer.from(content, 'utf8')); }
    }

    // Build steps from the content
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const lineOf = (pattern: RegExp | string): number => {
      const re = typeof pattern === 'string'
        ? new RegExp(`^${pattern.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`)
        : pattern;
      const idx = lines.findIndex(l => re.test(l));
      return idx >= 0 ? idx + 1 : 1;
    };

    const relTourPy = '.tours/locustfile_tour.py';
    const steps = [
      {
        title: 'Imports',
        description:
          'Bring in stdlib **time** and the Locust APIs: **HttpUser** (base class), **@task** (mark tasks), and **between** (random wait helper).',
        file: relTourPy,
        line: lineOf(/^from locust import HttpUser, task, between$/)
      },
      {
        title: 'User class + wait time',
        description:
          'Define the simulated user. Locust creates one instance per virtual user. **wait_time = between(1, 5)** pauses 1–5s between tasks (randomized).',
        file: relTourPy,
        line: lineOf(/^\s{4}wait_time = between\(1, 5\)$/)
      },
      {
        title: 'Task: hello_world',
        description:
          'Mark **hello_world** with **@task** so Locust schedules it. Inside, two sequential GETs (**/hello**, **/world**) via session-aware **self.client**.',
        file: relTourPy,
        line: lineOf(/^\s{8}self\.client\.get\("\/world"\)$/)
      },
      {
        title: 'Weighted task: view_items',
        description:
          '`@task(3)` gives this task 3× the weight of default tasks. Loop 10 items, request **/item?id={item_id}** but set **name="/item"** for aggregated stats. **time.sleep(1)** simulates think time.',
        file: relTourPy,
        line: lineOf(/time\.sleep\(1\)\s*$/)
      },
      {
        title: 'on_start (login once)',
        description:
          '**on_start** runs once per simulated user before tasks. POST to **/login** with JSON; auth is kept on **self.client** for later requests.',
        file: relTourPy,
        line: lineOf(/^\s{8}self\.client\.post\("\/login", json=\{"username":"foo", "password":"bar"\}\)$/)
      }
    ];

    const tourFile = vscode.Uri.file(path.join(toursDirUri.fsPath, 'locust_beginner.tour'));
    const tourJson = {
      $schema: 'https://aka.ms/codetour-schema',
      title: 'Locustfile',
      description: 'Build your first locustfile step by step.',
      isPrimary: true,
      steps
    };

    const bytes = Buffer.from(JSON.stringify(tourJson, null, 2), 'utf8');
    if (overwrite) {
      await vscode.workspace.fs.writeFile(tourFile, bytes);
    } else {
      try { await vscode.workspace.fs.stat(tourFile); }
      catch { await vscode.workspace.fs.writeFile(tourFile, bytes); }
    }

    return { tutorialFile, tourFile };
  }

  async runBeginnerTour(): Promise<void> {
    if (!(await this.ensureCodeTour())) return;

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a workspace folder to start the Locust tour.');
      return;
    }

    try {
      const prepared = await this.ensureBeginnerTourFiles(ws.uri, { overwrite: true });
      if (!prepared) return;
      const { tutorialFile, tourFile } = prepared;

      try { await vscode.commands.executeCommand('codetour.refreshTours'); } catch {}

      const doc = await vscode.workspace.openTextDocument(tutorialFile);
      await vscode.window.showTextDocument(doc, { preview: false });

      await new Promise(res => setTimeout(res, 200));

      // Start by passing JSON object; fallback to URI
      const tourJson = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(tourFile)).toString('utf8'));
      try {
        await vscode.commands.executeCommand('codetour.startTour', {
          title: tourJson.title,
          description: tourJson.description,
          isPrimary: true,
          steps: tourJson.steps
        });
      } catch {
        try { await vscode.commands.executeCommand('codetour.startTour', tourFile); }
        catch { await vscode.commands.executeCommand('codetour.startTour'); }
      }
    } catch (err: any) {
      this.log.appendLine(`Tour error: ${err?.stack || err?.message || String(err)}`);
      this.log.show(true);
      vscode.window.showErrorMessage('Failed to start Locust tour. See "Locust Tour" output for details.');
    }
  }
}
