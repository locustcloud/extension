import * as vscode from 'vscode';

/** Extract the Locust web UI URL from a log line and ensure ?dashboard=false is set. */
export function extractLocustUrl(line: string): string | undefined {
  // 1) Normal path
  let m = line.match(/Starting web interface at (\S+)/i);
  let url = m?.[1];

  // 2) "already running" path
  if (!url) {
    m = line.match(/available at (\S+)/i);
    url = m?.[1];
  }

  // 3) Fallback: first http(s) URL in the line
  if (!url) {
    m = line.match(/https?:\/\/[^\s)>\]]+/);
    url = m?.[0];
  }

  if (!url) return undefined;

  // Strip trailing punctuation that often rides along in logs
  url = url.replace(/[)\].,;'"!?]+$/, "");

  // Keep fragment aside (if any) so we can add/modify query cleanly
  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : "";

  // Force dashboard=false append if missing, overwrite if present
  let newBase: string;
  if (/[?&]dashboard=/.test(base)) {
    newBase = base.replace(/([?&]dashboard=)[^&#]*/i, "$1false");
  } else {
    const joiner = base.includes("?") ? "&" : "?";
    newBase = `${base}${joiner}dashboard=false`;
  }

  return newBase + fragment;
}
