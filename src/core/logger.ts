import * as vscode from 'vscode';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (err: unknown) => void;
  dispose: () => void;
}

export function createLogger(channelName = 'Locust'): Logger {
  const ch = vscode.window.createOutputChannel(channelName);
  const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

  return {
    info: (msg) => ch.appendLine(`[${stamp()}] INFO  ${msg}`),
    warn: (msg) => ch.appendLine(`[${stamp()}] WARN  ${msg}`),
    error: (err) => ch.appendLine(`[${stamp()}] ERROR ${err instanceof Error ? err.stack || err.message : String(err)}`),
    dispose: () => ch.dispose(),
  };
}
