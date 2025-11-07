import * as vscode from 'vscode';
import path from 'path';

// Fallback older VS Code API: emulate Uri.joinPath
function uriJoinPath(base: vscode.Uri, ...paths: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(base.fsPath, ...paths));
}

export class LocustRunner {
  /** Compute next available locustfile name: locustfile_001.py, 002, ... in given directory. */
  private async nextLocustfileUri(dir: vscode.Uri): Promise<vscode.Uri> {
    let maxIndex = 0;
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        // Match: locustfile.py  OR  locustfile_###.py
        const m = /^locustfile(?:_(\d+))?\.py$/i.exec(name);
        if (m) {
          const idx = m[1] ? parseInt(m[1], 10) : 0; // plain locustfile.py = index 0
          if (!Number.isNaN(idx)) maxIndex = Math.max(maxIndex, idx);
        }
      }
    } catch {
      // dir may not exist yet; caller will create it
    }
    const next = Math.max(1, maxIndex + 1);
    const nextName = `locustfile_${String(next).padStart(3, '0')}.py`;
    return uriJoinPath(dir, nextName);
  }

  // Create a starter, uniquely-numbered locustfile and return URI.
  async createLocustfile(opts: { open?: boolean } = {}) {
    const { open = true } = opts;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }

    // Pick workspace folder
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select folder for new locustfile',
      defaultUri: ws.uri,
    });
    if (!picked || picked.length === 0) {
      vscode.window.showInformationMessage('Locustfile creation cancelled.');
      return;
    }
    const dir = picked[0];

    // Ensure directory exists
    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
    }

    const dest = await this.nextLocustfileUri(dir);

    // Minimal boilerplate
    const content = `# Welcome to Locust Cloud's Online Test Editor!
#
# This is a quick way to get started with load tests without having
# to set up your own Python development environment.

from locust import FastHttpUser, task


class MyUser(FastHttpUser):
    # Change this to your actual target site, or leave it as is
    host = "https://mock-test-target.eu-north-1.locust.cloud"

    @task
    def t(self):
        # Simple request
        self.client.get("/")

        # Example rest call with validation
        with self.client.post(
            "/authenticate",
            json={"username": "foo", "password": "bar"},
            catch_response=True,
        ) as resp:
            if "token" not in resp.text:
                resp.failure("missing token in response")


# To deploy this test to the load generators click the Launch button.
#
# When you are done, or want to deploy an updated test, click Shut Down
#
# If you get stuck reach out to us at support@locust.cloud
#
# When you are ready to run Locust from your own machine,
# check out the documentation:
# https://docs.locust.io/en/stable/locust-cloud/locust-cloud.html
#
# Please remember to save your work outside of this editor as the
# storage is not permanent.
`;
    await vscode.workspace.fs.writeFile(dest, Buffer.from(content, 'utf8'));

    if (open) {
      const doc = await vscode.workspace.openTextDocument(dest);
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    vscode.commands.executeCommand('locust.refreshTree').then(undefined, () => {});
    vscode.window.showInformationMessage(`Created ${vscode.workspace.asRelativePath(dest)}.`);
    return dest;
  }
}
