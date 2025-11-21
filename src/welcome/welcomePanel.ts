import * as vscode from 'vscode';
import { isWebEditor } from 'core/utils/env';

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
    },
  );

  const csp = panel.webview.cspSource;
  const nonce = Math.random().toString(36).slice(2);

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

    .what p{margin:8px 0 0; line-height:1.5;}

    /* features list */
    ul.features{list-style:disc;margin:8px 0 0 20px;padding:0;}
    ul.features li{margin:6px 0; line-height:1.45;}
    ul.features b{font-weight:600;}
    .controls{margin-top:12px;}
    .controls label{display:flex;align-items:center;gap:8px;}
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

      <!-- Right: Features -->
      <div class="card">
        <h3>Features</h3>
        <ul class="features">
          <li><b>Automated setup</b>: Zero touch installation and environment setup</li>
          <li><b>Run Test Locally</b>: Run Test in Integrated webUI</li>
          <li><b>Run Locust Cloud Test</b>: Run Locust Cloud Test in new browser window</li>
          <li><b>Stop Test</b>: Stop running test</li>
          <li><b>Copilot</b>: Locust specialized</li>
          <li><b>Create</b>: Generate a basic locustfile</li>
          <li><b>Convert HAR</b>: Convert HAR file to locustfile</li>
          <li><b>Run in Debugger</b>: Run single user in debugger</li>
          <li><b>Beginner Guide</b>: Your first locustfile code walk</li>
        </ul>

        <div class="controls">
          <label class="muted">
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

  panel.webview.onDidReceiveMessage(async msg => {
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
    vscode.commands.registerCommand(CMD_SHOW, () => void openWelcomePanel(ctx)),
  );

  if (!isWebEditor && autoOpen && getShowOnStartup(ctx)) {
    void openWelcomePanel(ctx);
  }
}
