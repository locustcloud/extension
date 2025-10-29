import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

const WELCOME_STATE_KEY = 'locust.welcome.showOnStartup';
const CMD_SHOW = 'locust.showWelcomePanel';

function getShowOnStartup(ctx: vscode.ExtensionContext) {
  return ctx.globalState.get<boolean>(WELCOME_STATE_KEY, true);
}

async function setShowOnStartup(ctx: vscode.ExtensionContext, v: boolean) {
  await ctx.globalState.update(WELCOME_STATE_KEY, !!v);
}

async function openWelcomePanel(ctx: vscode.ExtensionContext) {
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

  // Build Command Palette list from package.json -> "commandPalette"
  const pkgPath = path.join(ctx.extensionUri.fsPath, 'package.json');
  let commandListItems = '';
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);

    // "commandPalette": [ { "command": "locust.xyz", "when": "..." }, ... ]
    const palette: Array<{ command: string; when?: string }> = Array.isArray(pkg?.commandPalette)
      ? pkg.commandPalette
      : [];

    // Labels
    const friendly: Record<string, string> = {
      'locust.startBeginnerTour': 'Beginner tour',
      'locust.runUI': 'Run local UI test',
      'locust.runHeadless': 'Run local headless test',
      'locust.openLocustCloud': 'Run Locust Cloud test',
      'locust.stopLastRun': 'Stop test',
      'locust.deleteLocustCloud': 'Shut down Locust Cloud',
      'locust.showScenarios': 'Show locustfiles',
      'locust.hideScenarios': 'Hide locustfiles',
    };

    // Keep command pallette order.
    const items = palette
      .filter(e => typeof e?.command === 'string' && e.command.startsWith('locust.'))
      .map(e => {
        const label = friendly[e.command] ?? e.command;
        return `<li><span class="left">${label}</span><code class="right">${e.command}</code></li>`;
      })
      .join('\n');

    commandListItems = items || `<li class="muted">No Locust commands found in commandPalette.</li>`;
  } catch {
    commandListItems = `<li class="muted">No commands found.</li>`;
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
    .wrap{max-width:1100px;margin:0 auto;}
    h1{font-size:28px;margin:0 0 8px;}
    .sub{color:var(--muted);margin:0 0 24px;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    @media (max-width: 900px){ .grid{grid-template-columns:1fr;} }
    .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;}
    .muted{color:var(--muted);}
    .title-accent{color:#28a745;}

    /* list styling */
    ul.cmds{list-style:none;margin:8px 0 0 0;padding:0;}
    ul.cmds li{
      margin:6px 0;
      display:flex; align-items:center; justify-content:space-between; gap:12px;
      border-bottom:1px dashed var(--border);
      padding:6px 0;
    }
    ul.cmds li:last-child{border-bottom:none;}
    ul.cmds .left{white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
    ul.cmds .right{
      opacity:.9;
      background: transparent;
      border:1px solid var(--border);
      border-radius:6px;
      padding:2px 6px;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
      font-size: 12px;
    }

    .what p{margin:8px 0 0; line-height:1.5;}
  </style>
</head>
<body>
  <div class="wrap">
    <h1><span class="title-accent">Locust</span> for VS Code</h1>
    <p class="sub">Get Started.</p>

    <div class="grid">
      <!-- Left: What is Locust? -->
      <div class="card what">
        <h3>What is Locust?</h3>
        <p>Locust is an open source performance/load testing tool for HTTP and other protocols. Its developer-friendly approach lets you define your tests in regular Python code.</p>
        <p>Locust tests can be run from command line or using its web-based UI. Throughput, response times and errors can be viewed in real time and/or exported for later analysis.</p>
        <p>You can import regular Python libraries into your tests, and with Locust’s pluggable architecture it is infinitely expandable. Unlike when using most other tools, your test design will never be limited by a GUI or domain-specific language.</p>
      </div>

      <!-- Right: Command Palette (from package.json commandPalette) -->
      <div class="card">
        <h3>Command Palette</h3>
        <p class="muted">Key commands exposed by this extension (from <code>package.json</code> → <code>commandPalette</code>).</p>
        <ul class="cmds" id="commandsList">
          ${commandListItems}
        </ul>
        <div style="margin-top:12px;">
          <label class="muted" style="display:flex;align-items:center;gap:8px;">
            <input id="showOnStartup" type="checkbox" checked>
            Show welcome page on startup
          </label>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const box = document.getElementById('showOnStartup');
    box.addEventListener('change', () => vscode.postMessage({ type: 'toggle', value: box.checked }));

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
  });

  panel.webview.postMessage({ type: 'init', value: getShowOnStartup(ctx) });
}

export function registerWelcomePanel(ctx: vscode.ExtensionContext, opts?: { autoOpen?: boolean }) {
  const autoOpen = opts?.autoOpen ?? true;

  ctx.subscriptions.push(
    vscode.commands.registerCommand(CMD_SHOW, () => void openWelcomePanel(ctx))
  );

  if (autoOpen && vscode.env.uiKind !== vscode.UIKind.Web && getShowOnStartup(ctx)) {
    void openWelcomePanel(ctx);
  }
}
