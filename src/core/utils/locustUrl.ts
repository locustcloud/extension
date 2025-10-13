import * as vscode from 'vscode';

/**
 * Extract the first Locust web UI URL from a log line.
 */
export function extractLocustUrl(
  line: string,
  opts?: { forceDashboardFalse?: boolean }
): string | undefined {
  // Normal path
  let m = line.match(/Starting web interface at (\S+)/i);
  let url = m?.[1];

  // "already running" path
  if (!url) {
    m = line.match(/available at (\S+)/i);
    url = m?.[1];
  }

  // Fallback: first http(s) URL in the line
  if (!url) {
    m = line.match(/https?:\/\/[^\s)>\]]+/);
    url = m?.[0];
  }

  if (!url) return undefined;

  // Strip trailing punctuation
  url = url.replace(/[)\].,;'"!?]+$/, '');

  // Keep fragment aside
  const hashIdx = url.indexOf('#');
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : '';

  if (!opts?.forceDashboardFalse) {
    // Local use: no dashboard param rewrite
    return base + fragment;
  }

  // Cloud use: force dashboard=false
  let newBase: string;
  if (/[?&]dashboard=/.test(base)) {
    newBase = base.replace(/([?&]dashboard=)[^&#]*/i, '$1false');
  } else {
    const joiner = base.includes('?') ? '&' : '?';
    newBase = `${base}${joiner}dashboard=false`;
  }

  return newBase + fragment;
}
