import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

from mcp.server import Server
from mcp.transport.stdio import stdio_server
from mcp.types import TextContent, Tool
from pydantic import BaseModel, Field

# har-transformer API
try:
    from transformer.har import Har
    from transformer.generator import generate_locustfile
except Exception as e:
    print("har-transformer is required. pip install har-transformer", file=sys.stderr)
    raise

server = Server("mcp-har2locust", "0.1.0")

class GenerateArgs(BaseModel):
    # Provide har_path/har_json
    har_path: Optional[str] = Field(default=None, description="Absolute path to a .har file")
    har_json: Optional[str] = Field(default=None, description="Raw HAR JSON (string)")
    user_class: str = Field(default="RecordedUser", description="Name of Locust HttpUser subclass")
    write_to: Optional[str] = Field(default=None, description="If set, save output to this path")
    # Knobs expose later (headers filter, domains, etc.)
    min_wait: float = Field(default=1.0, description="Seconds (informational; kept for future templates)")
    max_wait: float = Field(default=3.0, description="Seconds (informational; kept for future templates)")

@server.tool(
    Tool(
        name="har.to_locust",
        description="Convert a HAR (by path or JSON) into a locustfile.py using har-transformer.",
        inputSchema=GenerateArgs.model_json_schema()
    )
)
async def har_to_locust(inp: dict):
    args = GenerateArgs.model_validate(inp)

    # Load HAR either from path or from JSON string
    har_path = None
    cleanup_tmp = False
    if args.har_path:
        har_path = Path(args.har_path).expanduser().resolve()
        if not har_path.exists():
            return [TextContent(type="text", text=f"ERROR: File not found: {har_path}")]
        har = Har.from_file(str(har_path))
    elif args.har_json:
        # Validate JSON & persist to tmp (har-transformer accepts file+in-mem)
        try:
            data = json.loads(args.har_json)
        except json.JSONDecodeError as e:
            return [TextContent(type="text", text=f"ERROR: Invalid HAR JSON: {e}")]
        tmpdir = tempfile.TemporaryDirectory(prefix="mcp-har-")
        cleanup_tmp = True
        har_path = Path(tmpdir.name) / "input.har"
        har_path.write_text(json.dumps(data), encoding="utf-8")
        har = Har.from_file(str(har_path))
    else:
        return [TextContent(type="text", text="ERROR: Provide either 'har_path' or 'har_json'.")]

    # Generate locustfile source (string)
    # har-transformer builds a Python source string compatible with Locust
    try:
        locust_src: str = generate_locustfile(har)
    except Exception as e:
        return [TextContent(type="text", text=f"ERROR: har-transformer failed: {e}")]

    # Optionally rename the HttpUser class (simple, but reliable)
    # The generated code typically contains "class WebsiteUser(HttpUser):" or similar.
    # We replace the first subclass definition.
    import re
    locust_src = re.sub(r"class\s+\w+\(HttpUser\):", f"class {args.user_class}(HttpUser):", locust_src, count=1)

    # Optionally write to disk
    saved_msg = ""
    if args.write_to:
        out_path = Path(args.write_to).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(locust_src, encoding="utf-8")
        saved_msg = f"\nSaved: {out_path}"

    if cleanup_tmp:
        try:
            tmpdir.cleanup()  # type: ignore[name-defined]
        except Exception:
            pass

    return [TextContent(type="text", text=locust_src + saved_msg)]

async def main():
    async with stdio_server() as streams:
        await server.run(streams[0], streams[1])

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
