import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export class LocustWelcome {
  static readonly STATE_KEY = 'locust.welcome.showOnStartup';
  static readonly CMD_SHOW = 'locust.showWelcome';

  static register(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(LocustWelcome.CMD_SHOW, () =>
        LocustWelcome.show(ctx)
      )
    );
  }

  static maybeShowOnActivate(ctx: vscode.ExtensionContext, isCloud: boolean) {
    if (isCloud) return; // only show locally
    const show = ctx.globalState.get<boolean>(LocustWelcome.STATE_KEY, true);
    if (show) LocustWelcome.show(ctx);
  }

  private static async loadLocustCommands(ctx: vscode.ExtensionContext): Promise<Array<{ id: string; title: string }>> {
    try {
      const pkgPath = path.join(ctx.extensionUri.fsPath, 'package.json');
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as any;
      const contributed = (pkg?.contributes?.commands ?? []) as Array<{ command?: string; title?: string }>;
      return contributed
        .filter(c => typeof c?.command === 'string' && c.command.startsWith('locust.'))
        .map(c => ({ id: c.command!, title: String(c.title ?? c.command) }));
    } catch {
      return [];
    }
  }

  private static escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  static async show(ctx: vscode.ExtensionContext) {
    const cmds = await LocustWelcome.loadLocustCommands(ctx);

    const panel = vscode.window.createWebviewPanel(
      'locustWelcome',
      'Locust – Welcome',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const csp = panel.webview.cspSource;
    const nonce = String(Date.now());

    const commandsHtml = cmds.length
      ? cmds
          .map(
            c => `
              <div class="cmd">
                <code class="cmd-id">${LocustWelcome.escapeHtml(c.id)}</code>
                <span class="cmd-title">${LocustWelcome.escapeHtml(c.title)}</span>
              </div>`
          )
          .join('')
      : `<p class="muted">No Locust commands were found in this extension.</p>`;

    panel.webview.html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${csp} https:;
                 script-src 'nonce-${nonce}';
                 style-src ${csp} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Locust Welcome</title>
  <style>
    :root{
      --bg:#111315; --panel:#1a1d1f; --border:#2a2f34;
      --text:#e6e6e6; --muted:#9aa0a6;
      --accent:#28a745; --accent-hover:#23913d;
      --link:#28a745;
    }
    body{margin:0;padding:32px;font-family:var(--vscode-font-family, ui-sans-serif);
         background:var(--bg);color:var(--text);}
    .wrap{max-width:980px;margin:0 auto;}
    h1{font-size:28px;margin:0 0 8px;}
    .sub{color:var(--muted);margin:0 0 24px;}
    .grid{display:grid;grid-template-columns:1fr; gap:16px;}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;}
    .card h3{margin:0 0 6px;}
    .muted{color:var(--muted);}
    .title-accent{color:#28a745;}
    .row{display:flex;align-items:center;gap:12px;margin-top:12px;}
    a.btn,button.btn{
      appearance:none;border:1px solid var(--border);background:transparent;
      color:var(--text);padding:10px 14px;border-radius:10px;cursor:pointer;text-decoration:none;
    }
    a.btn.primary,button.btn.primary{background:var(--accent);border-color:transparent;color:#fff;}
    a.btn.primary:hover,button.btn.primary:hover{background:var(--accent-hover);}
    .cmd-list{display:flex;flex-direction:column;gap:8px;margin-top:8px;}
    .cmd{display:flex;gap:10px;align-items:center;}
    .cmd-id{
      background:#0c0f12;border:1px solid var(--border);padding:2px 6px;border-radius:6px;
      font-family:var(--vscode-editor-font-family, ui-monospace);font-size:12px;
    }
    .cmd-title{opacity:0.9;}
    .checkbox{display:flex;align-items:center;gap:8px;}
    .footer{margin-top:22px;}
  </style>
</head>
<body>
  <div class="wrap">
    <h1><span class="title-accent">Locust</span> for VS Code</h1>
    <p class="sub">A quick reference page: example prompts and available commands.</p>

    <div class="grid">

      <div class="card">
        <h3>Copilot: Prompt Examples</h3>
        <p class="muted">Open a short guide with ready-to-use prompts for HAR → Locustfile and more.</p>
        <div class="row">
          <button class="btn primary" id="openTutorial">Open Example Prompts</button>
        </div>
      </div>

      <div class="card">
        <h3>Available Locust Commands</h3>
        <p class="muted">These commands are contributed by this extension and visible in the Command Palette.</p>
        <div class="cmd-list">
          ${commandsHtml}
        </div>
      </div>

    </div>

    <div class="footer">
      <div class="checkbox">
        <input id="showOnStartup" type="checkbox" checked>
        <label for="showOnStartup" class="muted">Show this page on startup</label>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const box = document.getElementById('showOnStartup');
    box.addEventListener('change', () => vscode.postMessage({ type: 'toggle', value: box.checked }));

    const openBtn = document.getElementById('openTutorial');
    openBtn.addEventListener('click', () => vscode.postMessage({ type: 'openTutorial' }));

    window.addEventListener('message', e => {
      const { type, value } = e.data || {};
      if (type === 'init') box.checked = !!value;
    });
  </script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'toggle') {
        await ctx.globalState.update(LocustWelcome.STATE_KEY, !!msg.value);
        return;
      }

      if (msg?.type === 'openTutorial') {
        // Always within the directory: media/copilot_tutorial/01-copilot.md
        const baseDir = vscode.Uri.file(path.join(ctx.extensionUri.fsPath, 'media', 'copilot_tutorial'));

        const openMarkdown = async (uri: vscode.Uri) => {
          await vscode.commands.executeCommand('markdown.showPreview', uri);
        };

        try {
          const preferred = vscode.Uri.file(path.join(baseDir.fsPath, '01-copilot.md'));
          // Try the preferred file first
          await vscode.workspace.fs.stat(preferred);
          await openMarkdown(preferred);
          return;
        } catch {
          // If 01-copilot.md is not there, open the first *.md in the folder
          try {
            const entries = await vscode.workspace.fs.readDirectory(baseDir);
            const mdNames = entries
              .filter(([name, type]) => type === vscode.FileType.File && /\.md$/i.test(name))
              .map(([name]) => name)
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            if (mdNames.length) {
              const firstMd = vscode.Uri.file(path.join(baseDir.fsPath, mdNames[0]));
              await openMarkdown(firstMd);
              return;
            }
          } catch {
            // fall through to warning
          }
          vscode.window.showWarningMessage('Could not find any Markdown files in media/copilot_tutorial/.');
        }
        return;
      }
    });

    // send persisted checkbox state
    panel.webview.postMessage({
      type: 'init',
      value: ctx.globalState.get<boolean>(LocustWelcome.STATE_KEY, true),
    });
  }
}
