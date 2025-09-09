# mcp/server.py
import json
import sys
import tempfile
import subprocess
import re
from pathlib import Path
from typing import Optional, List

from pydantic import BaseModel, Field

# ✅ High-level runner from the current SDK
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("mcp-har2locust")


class GenerateArgs(BaseModel):
    # Provide har_path or har_json
    har_path: Optional[str] = Field(default=None, description="Absolute path to a .har file")
    har_json: Optional[str] = Field(default=None, description="Raw HAR JSON (string)")
    user_class: str = Field(default="RecordedUser", description="Name of Locust HttpUser subclass to use in output")
    write_to: Optional[str] = Field(default=None, description="If set, save output to this path")


def _run_har2locust(input_path: Path, extra_args: Optional[List[str]] = None) -> str:
    """Invoke 'python -m har2locust <input.har>' using this interpreter (venv) and return stdout."""
    cmd = [sys.executable, "-m", "har2locust", str(input_path)]
    if extra_args:
        cmd.extend(extra_args)
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"har2locust failed (exit {proc.returncode}): {proc.stderr.strip()}")
    return proc.stdout


@mcp.tool("har.to_locust")
def har_to_locust(**inp) -> str:
    # Validate with Pydantic regardless of how the client sends args
    try:
        args = GenerateArgs.model_validate(inp)
    except Exception as e:
        return f"ERROR: invalid arguments: {e}"

    # Obtain input HAR path (file or temp file from inline JSON)
    har_path: Optional[Path] = None
    tmpdir: Optional[tempfile.TemporaryDirectory] = None

    if args.har_path:
        har_path = Path(args.har_path).expanduser().resolve()
        if not har_path.exists():
            return f"ERROR: File not found: {har_path}"
    elif args.har_json:
        try:
            data = json.loads(args.har_json)
        except json.JSONDecodeError as e:
            return f"ERROR: Invalid HAR JSON: {e}"
        tmpdir = tempfile.TemporaryDirectory(prefix="mcp-har2locust-")
        har_path = Path(tmpdir.name) / "input.har"
        har_path.write_text(json.dumps(data), encoding="utf-8")
    else:
        return "ERROR: Provide either 'har_path' or 'har_json'."

    # Run har2locust and capture the generated Python source
    try:
        locust_src: str = _run_har2locust(har_path)
    except Exception as e:
        return f"ERROR: har2locust invocation failed: {e}"

    # Optionally rename the first Locust user class to args.user_class.
    locust_src = re.sub(
        r"class\s+\w+\((HttpUser|FastHttpUser)\):",
        lambda m: f"class {args.user_class}({m.group(1)}):",
        locust_src,
        count=1,
    )

    # Optionally write to disk
    if args.write_to:
        out_path = Path(args.write_to).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(locust_src, encoding="utf-8")
        locust_src += f"\nSaved: {out_path}"

    # Cleanup temporary directory if used
    if tmpdir is not None:
        try:
            tmpdir.cleanup()
        except Exception:
            pass

    return locust_src


if __name__ == "__main__":
    # Prefer explicit stdio runner; fall back for older SDKs if needed
    if hasattr(mcp, "run_stdio"):
        mcp.run_stdio()
    else:
        mcp.run(transport="stdio")
