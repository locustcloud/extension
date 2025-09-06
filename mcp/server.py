import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Optional, List

from mcp.server import Server
from mcp.transport.stdio import stdio_server
from mcp.types import TextContent, Tool
from pydantic import BaseModel, Field

import subprocess


server = Server("mcp-har2locust", "0.1.0")


class GenerateArgs(BaseModel):
    # Provide har_path or har_json
    har_path: Optional[str] = Field(default=None, description="Absolute path to a .har file")
    har_json: Optional[str] = Field(default=None, description="Raw HAR JSON (string)")
    user_class: str = Field(default="RecordedUser", description="Name of Locust HttpUser subclass to use in output")
    write_to: Optional[str] = Field(default=None, description="If set, save output to this path")
    # Future knobs: plugins, template, resource_types, etc.


def _run_har2locust(input_path: Path, extra_args: Optional[List[str]] = None) -> str:
    """
    Prefer the console script inside the current venv (next to sys.executable),
    fall back to 'python -m har2locust', then to 'har2locust' from PATH.
    """
    candidates: List[List[str]] = []

    # Console script in same bin/Scripts directory as interpreter
    bin_dir = Path(sys.executable).parent
    exe_name = "har2locust.exe" if os.name == "nt" else "har2locust"
    bin_script = bin_dir / exe_name
    if bin_script.exists():
        candidates.append([str(bin_script), str(input_path)])

    # Module form check availability
    candidates.append([sys.executable, "-m", "har2locust", str(input_path)])

    # Fallback to PATH
    candidates.append(["har2locust", str(input_path)])

    if extra_args:
        for c in candidates:
            c.extend(extra_args)

    last_err = None
    for cmd in candidates:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            return proc.stdout
        last_err = f"{cmd[0]} failed (exit {proc.returncode}): {proc.stderr.strip()}"

    raise RuntimeError(last_err or "har2locust invocation failed")



@server.tool(
    Tool(
        name="har.to_locust",
        description="Convert a HAR (by path or JSON) into a locustfile.py using har2locust.",
        inputSchema=GenerateArgs.model_json_schema()
    )
)
async def har_to_locust(inp: dict):
    args = GenerateArgs.model_validate(inp)

    # Obtain input HAR path (file or temp file from inline JSON)
    har_path: Optional[Path] = None
    tmpdir: Optional[tempfile.TemporaryDirectory] = None

    if args.har_path:
        har_path = Path(args.har_path).expanduser().resolve()
        if not har_path.exists():
            return [TextContent(type="text", text=f"ERROR: File not found: {har_path}")]
    elif args.har_json:
        try:
            data = json.loads(args.har_json)
        except json.JSONDecodeError as e:
            return [TextContent(type="text", text=f"ERROR: Invalid HAR JSON: {e}")]
        tmpdir = tempfile.TemporaryDirectory(prefix="mcp-har2locust-")
        har_path = Path(tmpdir.name) / "input.har"
        har_path.write_text(json.dumps(data), encoding="utf-8")
    else:
        return [TextContent(type="text", text="ERROR: Provide either 'har_path' or 'har_json'.")]

    # Run har2locust and capture the generated Python source
    try:
        locust_src: str = _run_har2locust(har_path)
    except Exception as e:
        # Common causes: har2locust not installed or invalid HAR
        msg = f"ERROR: har2locust invocation failed: {e}"
        return [TextContent(type="text", text=msg)]

    # Optionally rename the first Locust user class to args.user_class.
    # har2locust typically generates "class WebsiteUser(HttpUser):"
    # or sometimes FastHttpUser; we replace the first match only.
    locust_src = re.sub(
        r"class\s+\w+\((HttpUser|FastHttpUser)\):",
        lambda m: f"class {args.user_class}({m.group(1)}):",
        locust_src,
        count=1,
    )

    # Optionally write to disk
    saved_msg = ""
    if args.write_to:
        out_path = Path(args.write_to).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(locust_src, encoding="utf-8")
        saved_msg = f"\nSaved: {out_path}"

    # Cleanup temporary directory if used
    if tmpdir is not None:
        try:
            tmpdir.cleanup()
        except Exception:
            pass

    return [TextContent(type="text", text=locust_src + saved_msg)]


async def main():
    async with stdio_server() as streams:
        await server.run(streams[0], streams[1])


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
