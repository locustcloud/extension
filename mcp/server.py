from __future__ import annotations

import os
import re
import sys
import signal
import subprocess
from pathlib import Path
from typing import Optional, List, Dict, Any, Set

# Official MCP SDK wrapper
try:
    from mcp.server.fastmcp import FastMCP
except Exception as e:
    print(f"FastMCP import failed: {e}", file=sys.stderr)
    sys.exit(1)

mcp = FastMCP("mcp-har2locust")

# Helpers
WORKDIR = Path.cwd()


def _default_locustfile() -> Path:
    """Prefer templates/locustfile.py, else ./locustfile.py."""
    cand = [
        WORKDIR / "templates" / "locustfile.py",
        WORKDIR / "locustfile.py",
    ]
    for p in cand:
        if p.exists():
            return p
    # If neither exists, still return the first so callers get a sensible path
    return cand[0]


def _ensure_file(path: Optional[str], fallback: Path | None = None) -> Path:
    if path:
        p = (WORKDIR / path).resolve() if not os.path.isabs(path) else Path(path)
    else:
        p = fallback or _default_locustfile()
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    return p


def _run_h2l(python_cmd: Optional[str], cwd: Path, har: Path, args: List[str]) -> str:
    """
    Run `har2locust` as a module using the given (or current) Python interpreter.
    Returns generated locustfile source as text, or raises with stderr included.
    """
    interpreter = python_cmd or sys.executable
    cmd = [interpreter, "-m", "har2locust", *args, str(har)]
    try:
        p = subprocess.run(cmd, cwd=str(cwd), check=True, capture_output=True, text=True)
        return p.stdout
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"har2locust failed: {e.stderr or e.stdout or e}") from e


def _parse_tasks_and_tags(source: str) -> Dict[str, Any]:
    """
    Very lightweight scan for tasks and tags.
    - tasks: function names decorated with @task or @task(...)
    - tags:  values from @tag("foo"), @tag('bar'), @tag("a","b")
    """
    tasks: List[str] = []
    tags: Set[str] = set()

    # tasks: @task or @task(3) followed by def <name>(
    task_rx = re.compile(r"@task(?:\s*\([^)]*\))?\s*\r?\n\s*def\s+([A-Za-z_]\w*)\s*\(", re.MULTILINE)
    tasks.extend(task_rx.findall(source))

    # tags: @tag("a") or @tag('a') or @tag("a","b")
    tag_line_rx = re.compile(r"@tag\s*\(([^)]*)\)")
    for m in tag_line_rx.finditer(source):
        inner = m.group(1)
        # pick all quoted strings
        for t in re.findall(r"""(['"])(.*?)\1""", inner):
            if t[1].strip():
                tags.add(t[1].strip())

    return {"tasks": sorted(set(tasks)), "tags": sorted(tags)}

# Tools
@mcp.tool(name="har.to_locust")
def har_to_locust(
    har_path: str,
    template: Optional[str] = None,
    plugins: Optional[str] = None,
    disable_plugins: Optional[str] = None,
    resource_types: Optional[str] = None,
    loglevel: Optional[str] = None,
    write_to: Optional[str] = None,
    python_cmd: Optional[str] = None,
) -> dict:
    """
    Convert a HAR file into a Locust script.

    Returns:
      {
        "path": "<written path or empty string>",
        "code": "<generated locustfile source>"
      }
    """
    cwd = WORKDIR
    har = (cwd / har_path).resolve() if not os.path.isabs(har_path) else Path(har_path)
    if not har.exists():
        raise ValueError(f"HAR file not found: {har_path}")

    args: List[str] = []
    if template:        args += ["--template", template]
    if plugins:         args += ["--plugins", plugins]
    if disable_plugins: args += ["--disable-plugins", disable_plugins]
    if resource_types:  args += ["--resource-types", resource_types]
    if loglevel:        args += ["--loglevel", loglevel]

    code = _run_h2l(python_cmd, cwd, har, args)

    if write_to:
        out = (cwd / write_to).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(code, encoding="utf-8")
        return {"path": str(out), "code": code}

    return {"path": "", "code": code}


@mcp.tool(name="locust.list_tasks")
def locust_list_tasks(locustfile_path: Optional[str] = None) -> dict:
    """
    Parse a locustfile and return discovered @task names and @tag values.

    Returns:
      { "file": "<path>", "tasks": [...], "tags": [...] }
    """
    lf = _ensure_file(locustfile_path, _default_locustfile()).resolve()
    src = lf.read_text(encoding="utf-8")
    parsed = _parse_tasks_and_tags(src)
    return {"file": str(lf), **parsed}


@mcp.tool(name="locust.run_ui")
def locust_run_ui(
    locustfile_path: Optional[str] = None,
    host: Optional[str] = None,
    web_port: int = 8089,
) -> dict:
    """
    Launch Locust in UI mode. Non-blocking (returns PID and URL).
    Returns:
      { "pid": <int>, "url": "http://localhost:<port>", "command": "<...>" }
    """
    lf = _ensure_file(locustfile_path, _default_locustfile()).resolve()
    interpreter = sys.executable
    url = f"http://localhost:{web_port}"

    cmd = [interpreter, "-m", "locust", "-f", str(lf)]
    if host:
        cmd += ["--host", host]
    cmd += ["--web-port", str(web_port)]

    # Start in background
    proc = subprocess.Popen(
        cmd, cwd=str(WORKDIR), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    return {"pid": proc.pid, "url": url, "command": " ".join(cmd)}


@mcp.tool(name="locust.stop")
def locust_stop(pid: int) -> dict:
    """
    Stop a running Locust process by PID. Works for both UI and headless.
    Returns: { "stopped": true/false }
    """
    try:
        # Prefer SIGINT for graceful shutdown, fall back to SIGTERM
        os.kill(pid, signal.SIGINT)
        return {"stopped": True}
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
            return {"stopped": True}
        except Exception:
            return {"stopped": False}


@mcp.tool(name="locust.run_headless")
def locust_run_headless(
    locustfile_path: Optional[str] = None,
    host: Optional[str] = None,
    users: int = 10,
    spawn_rate: int = 2,
    duration: str = "1m",
    tags: Optional[str] = None,    # comma-separated
    tasks: Optional[str] = None,   # comma-separated; Locust supports --tasks <User.task>
) -> dict:
    """
    Run Locust once in headless mode and return stdout/stderr.
    Example flags:
      -u <users> -r <spawn_rate> -t <duration> [--tags foo,bar] [--host <host>]
    """
    lf = _ensure_file(locustfile_path, _default_locustfile()).resolve()
    interpreter = sys.executable

    cmd = [
        interpreter, "-m", "locust",
        "-f", str(lf),
        "--headless",
        "-u", str(users),
        "-r", str(spawn_rate),
        "-t", duration,
    ]
    if host:
        cmd += ["--host", host]
    if tags:
        cmd += ["--tags", tags]
    if tasks:
        # Locust expects fully qualified task names (e.g., MyUser.my_task)
        cmd += ["--tasks", tasks]

    try:
        p = subprocess.run(cmd, cwd=str(WORKDIR), check=True, capture_output=True, text=True)
        return {"ok": True, "command": " ".join(cmd), "stdout": p.stdout, "stderr": p.stderr}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "command": " ".join(cmd), "stdout": e.stdout, "stderr": e.stderr or str(e)}

# Entrypoint
if __name__ == "__main__":
    if hasattr(mcp, "run_stdio"):
        mcp.run_stdio()
    else:
        mcp.run(transport="stdio")
