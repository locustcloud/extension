import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises'; // 🔹 NEW

const WELCOME_STATE_KEY = 'locust.welcome.showOnStartup';
const CMD_SHOW = 'locust.showWelcomePanel';

function getShowOnStartup(ctx: vscode.ExtensionContext) {
  return ctx.globalState.get<boolean>(WELCOME_STATE_KEY, true);
}
async function setShowOnStartup(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.globalState.update(WELCOME_STATE_KEY, !!v);
}

async function openWelcomePanel(ctx: vscode.ExtensionContext) { // 🔹 made async
  const panel = vscode.window.createWebviewPanel(
    'locust.welcome.panel',
    'Locust Welcome',
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [ctx.extensionUri],
    }
  );

  const csp = panel.webview.cspSource;
  const nonce = Math.random().toString(36).slice(2);

  // 🔹 Build Commands list from package.json (filter to locust.*)
  const pkgPath = path.join(ctx.extensionUri.fsPath, 'package.json');
  let commandButtons = '';
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    const cmds: Array<{ command: string; title?: string; category?: string }> =
      (pkg?.contributes?.commands ?? []) as any[];

    const locustCmds = cmds.filter(c => typeof c?.command === 'string' && c.command.startsWith('locust.'));
    commandButtons = locustCmds.map(c => {
      const title = c.title || c.command;
      const category = c.category ? `${c.category}: ` : '';
      return `<button class="btn" data-cmd="${c.command}" title="${c.command}">${category}${title}</button>`;
    }).join('\n');
  } catch {
    // best effort; show a fallback
    commandButtons = `<span class="muted">No commands found.</span>`;
  }

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
    .wrap{max-width:960px;margin:0 auto;}
    h1{font-size:28px;margin:0 0 8px;}
    .sub{color:var(--muted);margin:0 0 24px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;}
    .cta-row{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 0;}
    a.btn,button.btn{
      appearance:none;border:1px solid var(--border);background:transparent;
      color:var(--text);padding:10px 14px;border-radius:10px;cursor:pointer;text-decoration:none;
    }
    a.btn.primary,button.btn.primary{background:var(--accent);border-color:transparent;color:#fff;}
    a.btn.primary:hover,button.btn.primary:hover{background:var(--accent-hover);}
    a.link{color:var(--link);text-decoration:none;}
    a.link:hover{text-decoration:underline;}
    .muted{color:var(--muted);}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;}
    .checkbox{display:flex;align-items:center;gap:8px;}
    .title-accent{color:#28a745;}
  </style>
</head>
<body>
  <div class="wrap">
    <h1><span class="title-accent">Locust</span> for VS Code</h1>
    <p class="sub">Get Started.</p>

    <div class="grid">
      <div class="card">
        <h3>Commands</h3>
        <p class="muted">Run extension commands</p>
        <div class="cta-row" id="commandsRow">
          ${commandButtons}
        </div>
      </div>

    </div>

    <div class="row" style="margin-top:22px;">
      <div class="checkbox">
        <input id="showOnStartup" type="checkbox" checked>
        <label for="showOnStartup" class="muted">Show welcome page on startup</label>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const box = document.getElementById('showOnStartup');
    box.addEventListener('change', () => vscode.postMessage({ type: 'toggle', value: box.checked }));

    document.querySelectorAll('[data-cmd]').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = el.getAttribute('data-cmd');
        if (cmd) vscode.postMessage({ type: 'run', command: cmd });
      });
    });

    window.addEventListener('message', e => {
      const { type, value } = (e.data || {});
      if (type === 'init') box.checked = !!value;
    });
  </script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'toggle') {
      await setShowOnStartup(ctx, !!msg.value);
      return;
    }
    if (msg.type === 'run' && typeof msg.command === 'string') {
      try {
        await vscode.commands.executeCommand(msg.command);
      } catch (e:any) {
        vscode.window.showErrorMessage(e?.message ?? `Failed to run ${msg.command}`);
      }
      return;
    }
  });

  panel.webview.postMessage({ type: 'init', value: getShowOnStartup(ctx) });
}

export function registerWelcomePanel(ctx: vscode.ExtensionContext, opts?: { autoOpen?: boolean }) {
  const autoOpen = opts?.autoOpen ?? true;

  // command to open later
  ctx.subscriptions.push(
    vscode.commands.registerCommand(CMD_SHOW, () => void openWelcomePanel(ctx)) // safe if async
  );

  // auto-open on desktop if enabled
  if (autoOpen && vscode.env.uiKind !== vscode.UIKind.Web && getShowOnStartup(ctx)) {
    void openWelcomePanel(ctx);
  }
}
