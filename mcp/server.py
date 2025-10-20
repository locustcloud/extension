from __future__ import annotations

import os
import re
import sys
import signal
import socket
import subprocess
from pathlib import Path
from typing import Optional, List, Dict, Any, Set


try:
    from mcp.server.fastmcp import FastMCP
except Exception as e:
    print(f"FastMCP import failed: {e}", file=sys.stderr)
    sys.exit(1)

mcp = FastMCP("mcp-locust") 

# Helpers
WORKDIR = Path.cwd()
_PROCESS_REGISTRY: Dict[int, Dict[str, Any]] = {}  # pid -> {cmd,url,locustfile,mode}

def _is_locustfile(p: Path) -> bool:
    return p.is_file() and p.suffix.lower() == ".py" and "locustfile" in p.name.lower()

def _under(base: Path, p: Path) -> bool:
    try:
        p.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False

def _find_first_locustfile(workdir: Path = WORKDIR) -> Optional[Path]:
    return next((p for p in workdir.rglob("*locustfile*.py") if _is_locustfile(p)), None)

def _find_all_locustfiles(workdir: Path = WORKDIR) -> List[Path]:
    def depth(p: Path) -> int:
        return len(p.relative_to(workdir).parts)
    files = [p for p in workdir.rglob("*locustfile*.py") if _is_locustfile(p)]
    return sorted(files, key=lambda p: (depth(p), p.name.lower()))

def _resolve_locustfile(preferred: Optional[str | Path] = None) -> Path:
    if preferred:
        p = Path(preferred)
        if not p.is_absolute():
            p = (WORKDIR / p).resolve()
        if _under(WORKDIR, p) and _is_locustfile(p):
            return p
    found = _find_first_locustfile(WORKDIR)
    if not found:
        raise FileNotFoundError("No locustfile found under workspace.")
    return found

def _default_locustfile_path() -> Path:
    # Soft convention fallback
    return (WORKDIR / "templates" / "locustfile.py").resolve()

def _ensure_file(path: Optional[str], fallback: Optional[Path] = None) -> Path:
    if path:
        p = Path(path)
        if not p.is_absolute():
            p = (WORKDIR / p).resolve()
    else:
        p = fallback or _resolve_locustfile(None)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    return p

def _run_har2locust(python_cmd: Optional[str], cwd: Path, har: Path, args: List[str]) -> str:
    interpreter = python_cmd or sys.executable
    cmd = [interpreter, "-m", "har2locust", *args, str(har)]
    try:
        p = subprocess.run(cmd, cwd=str(cwd), check=True, capture_output=True, text=True)
        return p.stdout
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"har2locust failed: {e.stderr or e.stdout or e}") from e

def _parse_tasks_and_tags(source: str) -> Dict[str, Any]:
    tasks: List[str] = []
    tags: Set[str] = set()
    task_rx = re.compile(r"@task(?:\s*\([^)]*\))?\s*\r?\n\s*def\s+([A-Za-z_]\w*)\s*\(", re.MULTILINE)
    tasks.extend(task_rx.findall(source))
    tag_line_rx = re.compile(r"@tag\s*\(([^)]*)\)")
    for m in tag_line_rx.finditer(source):
        inner = m.group(1)
        for t in re.findall(r"""(['"])(.*?)\1""", inner):
            if t[1].strip():
                tags.add(t[1].strip())
    return {"tasks": sorted(set(tasks)), "tags": sorted(tags)}

def _free_tcp_port(start: int = 8089, max_tries: int = 50) -> int:
    port = start
    for _ in range(max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1
    raise RuntimeError("No free TCP port found for Locust UI.")

def _record_process(pid: int, info: Dict[str, Any]) -> None:
    _PROCESS_REGISTRY[pid] = info

# Tools: discovery & info
@mcp.tool(name="locust.find", description="Find the active or first matching locustfile; also list all matches.")
def locust_find(preferred_path: Optional[str] = None) -> dict:
    """
    Returns:
      {
        "file": "<best path or empty if none>",
        "all": ["<match1>", "<match2>", ...]
      }
    """
    all_matches = [str(p) for p in _find_all_locustfiles(WORKDIR)]
    try:
        best = str(_resolve_locustfile(preferred_path)) if all_matches else ""
    except FileNotFoundError:
        best = ""
    return {"file": best, "all": all_matches}

@mcp.tool(name="locust.env_info", description="Return interpreter and tool versions for diagnostics.")
def locust_env_info(python_cmd: Optional[str] = None) -> dict:
    interpreter = python_cmd or sys.executable
    def _version(mod: str) -> str:
        try:
            p = subprocess.run([interpreter, "-m", mod, "--version"], check=True, capture_output=True, text=True)
            return (p.stdout or p.stderr or "").strip()
        except Exception as e:
            return f"unavailable ({e})"
    return {
        "python": interpreter,
        "locust": _version("locust"),
        "har2locust": _version("har2locust"),
        "cwd": str(WORKDIR),
    }

# Tools: parsing / generation
@mcp.tool(name="locust.list_tasks", description="Parse a locustfile for @task names and @tag values.")
def locust_list_tasks(locustfile_path: Optional[str] = None) -> dict:
    lf = _ensure_file(locustfile_path, None if locustfile_path else _resolve_locustfile(None)).resolve()
    src = lf.read_text(encoding="utf-8")
    parsed = _parse_tasks_and_tags(src)
    return {"file": str(lf), **parsed}

@mcp.tool(name="har.to_locust", description="Convert a HAR file into a Locust script (optionally write to disk).")
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
    Returns:
      { "path": "<written path or ''>", "code": "<generated source>" }
    """
    har = Path(har_path)
    if not har.is_absolute():
        har = (WORKDIR / har).resolve()
    if not har.exists():
        raise ValueError(f"HAR file not found: {har_path}")

    args: List[str] = []
    if template:        args += ["--template", template]
    if plugins:         args += ["--plugins", plugins]
    if disable_plugins: args += ["--disable-plugins", disable_plugins]
    if resource_types:  args += ["--resource-types", resource_types]
    if loglevel:        args += ["--loglevel", loglevel]

    code = _run_har2locust(python_cmd, WORKDIR, har, args)

    if write_to:
        out = Path(write_to)
        if not out.is_absolute():
            out = (WORKDIR / out).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(code, encoding="utf-8")
        return {"path": str(out), "code": code}

    return {"path": "", "code": code}

# Tools: run/stop 
@mcp.tool(name="locust.run_ui", description="Start Locust UI in the background; returns PID and URL.")
def locust_run_ui(
    locustfile_path: Optional[str] = None,
    host: Optional[str] = None,
    web_port: Optional[int] = None,
) -> dict:
    lf = _ensure_file(locustfile_path, None if locustfile_path else _resolve_locustfile(None)).resolve()
    interpreter = sys.executable
    port = web_port if isinstance(web_port, int) and web_port > 0 else _free_tcp_port(8089)
    url = f"http://localhost:{port}"

    cmd = [interpreter, "-m", "locust", "-f", str(lf), "--web-port", str(port)]
    if host:
        cmd += ["--host", host]

    proc = subprocess.Popen(cmd, cwd=str(WORKDIR), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    _record_process(proc.pid, {"mode": "ui", "url": url, "command": " ".join(cmd), "locustfile": str(lf)})
    return {"pid": proc.pid, "url": url, "command": " ".join(cmd)}

@mcp.tool(name="locust.run_headless", description="Run Locust one-shot in headless mode; returns stdout/stderr.")
def locust_run_headless(
    locustfile_path: Optional[str] = None,
    host: Optional[str] = None,
    users: int = 10,
    spawn_rate: int = 2,
    duration: str = "1m",
    tags: Optional[str] = None,
    tasks: Optional[str] = None,
) -> dict:
    lf = _ensure_file(locustfile_path, None if locustfile_path else _resolve_locustfile(None)).resolve()
    interpreter = sys.executable
    cmd = [
        interpreter, "-m", "locust",
        "-f", str(lf),
        "--headless",
        "-u", str(users),
        "-r", str(spawn_rate),
        "-t", duration,
    ]
    if host:  cmd += ["--host", host]
    if tags:  cmd += ["--tags", tags]
    if tasks: cmd += ["--tasks", tasks]  # expects qualified names

    try:
        p = subprocess.run(cmd, cwd=str(WORKDIR), check=True, capture_output=True, text=True)
        return {"ok": True, "command": " ".join(cmd), "stdout": p.stdout, "stderr": p.stderr}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "command": " ".join(cmd), "stdout": e.stdout, "stderr": e.stderr or str(e)}

@mcp.tool(name="locust.stop", description="Stop a running Locust process by PID.")
def locust_stop(pid: int) -> dict:
    try:
        os.kill(pid, signal.SIGINT)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            return {"stopped": False}
    _PROCESS_REGISTRY.pop(pid, None)
    return {"stopped": True}

@mcp.tool(name="locust.ps", description="List processes started by this MCP.")
def locust_ps() -> dict:
    procs = []
    for pid, meta in list(_PROCESS_REGISTRY.items()):
        # if still exists
        alive = True
        try:
            os.kill(pid, 0)
        except Exception:
            alive = False
        procs.append({"pid": pid, "alive": alive, **meta})
        if not alive:
            _PROCESS_REGISTRY.pop(pid, None)
    return {"processes": procs}

# Tool: simple workflow (HAR -> write -> UI)
@mcp.tool(
    name="workflow.har_to_ui",
    description="Convert HAR to locustfile, write it, then start Locust UI. Returns written path + UI URL."
)
def workflow_har_to_ui(
    har_path: str,
    write_to: Optional[str] = None,
    host: Optional[str] = None,
    web_port: Optional[int] = None,
    template: Optional[str] = None,
    plugins: Optional[str] = None,
    disable_plugins: Optional[str] = None,
    resource_types: Optional[str] = None,
    loglevel: Optional[str] = None,
    python_cmd: Optional[str] = None,
) -> dict:
    write_target = write_to or str(_default_locustfile_path())
    gen = har_to_locust(
        har_path=har_path,
        template=template,
        plugins=plugins,
        disable_plugins=disable_plugins,
        resource_types=resource_types,
        loglevel=loglevel,
        write_to=write_target,
        python_cmd=python_cmd,
    )
    run = locust_run_ui(locustfile_path=gen["path"], host=host, web_port=web_port)
    return {"generated": gen, "run": run}

# Entrypoint 
if __name__ == "__main__":
    if hasattr(mcp, "run_stdio"):
        mcp.run_stdio()
    else:
        mcp.run(transport="stdio")
