/**
 * Extract the first Locust web UI URL from a log line and (by default)
 * ensure `dashboard=false` so we land on the Start form instead of the
 * live dashboard. Pass { addDashboardFalse: false } to preserve as-is.
 */
export function extractLocustUrl(
  line: string,
  opts?: { addDashboardFalse?: boolean }   // default: true
): string | undefined {
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

  const addDashboard = opts?.addDashboardFalse ?? true;
  if (!addDashboard) return base + fragment;

  // Use URL to edit query robustly
  let next = base;
  try {
    const u = new URL(base);
    u.searchParams.set("dashboard", "false");
    next = u.toString();
  } catch {
    // Fallback if URL ctor fails (very unlikely given our regex)
    if (/[?&]dashboard=/.test(base)) {
      next = base.replace(/([?&]dashboard=)[^&#]*/i, "$1false");
    } else {
      const joiner = base.includes("?") ? "&" : "?";
      next = `${base}${joiner}dashboard=false`;
    }
  }

  return next + fragment;
}
