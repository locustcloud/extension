from __future__ import annotations

import sys
import subprocess
from pathlib import Path
from typing import Optional, List


# ✅ Use the official SDK wrapper, not the third-party "fastmcp" package
try:
    from mcp.server.fastmcp import FastMCP
except Exception as e:
    # Print to stderr so the error shows up in Copilot logs
    print(f"FastMCP import failed: {e}", file=sys.stderr)
    sys.exit(1)


mcp = FastMCP("mcp-har2locust")


def _run_h2l(python_cmd: Optional[str], cwd: Path, har: Path, args: List[str]) -> str:
    """
    Run `har2locust` as a module using the given (or current) Python interpreter.
    Returns generated locustfile source as text, or raises with stderr included.
    """
    # Prefer the interpreter Copilot used to launch this server
    interpreter = python_cmd or sys.executable
    cmd = [interpreter, "-m", "har2locust", *args, str(har)]
    try:
        p = subprocess.run(cmd, cwd=str(cwd), check=True, capture_output=True, text=True)
        return p.stdout
    except subprocess.CalledProcessError as e:
        # Surface the stderr to Copilot so users see why it failed (e.g., missing plugin)
        raise RuntimeError(f"har2locust failed: {e.stderr or e.stdout or e}") from e


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
    cwd = Path.cwd()
    har = Path(har_path)

    if not har.exists():
        raise ValueError(f"HAR file not found: {har_path}")

    args: List[str] = []
    if template:
        args += ["--template", template]
    if plugins:
        args += ["--plugins", plugins]
    if disable_plugins:
        args += ["--disable-plugins", disable_plugins]
    if resource_types:
        args += ["--resource-types", resource_types]
    if loglevel:
        args += ["--loglevel", loglevel]

    code = _run_h2l(python_cmd, cwd, har, args)

    if write_to:
        out = (cwd / write_to).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(code, encoding="utf-8")
        return {"path": str(out), "code": code}

    return {"path": "", "code": code}


if __name__ == "__main__":
    # Prefer explicit stdio runner if available in the SDK
    if hasattr(mcp, "run_stdio"):
        mcp.run_stdio()
    else:
        mcp.run(transport="stdio")
