# mcp/server.py
from pathlib import Path
import subprocess, sys
try:
    from fastmcp import FastMCP, tool
except Exception as e:
    # Print to stderr so you can see import failures in Copilot logs
    sys.stderr.write(f"FastMCP import failed: {e}\n")
    sys.exit(1)


app = FastMCP("mcp-har2locust")


def _run_h2l(python_cmd: str, cwd: Path, har: Path, args: list[str]) -> str:
    cmd = [python_cmd, "-m", "har2locust", *args, str(har)]
    p = subprocess.run(cmd, cwd=str(cwd), check=True, capture_output=True, text=True)
    return p.stdout


@tool("har.to_locust")
def har_to_locust(
    har_path: str,
    template: str | None = None,
    plugins: str | None = None,
    disable_plugins: str | None = None,
    resource_types: str | None = None,
    loglevel: str | None = None,
    write_to: str | None = None,
    python_cmd: str = "python"
) -> dict:
    """Convert HAR → Locust script. Returns {"path": "...", "code": "..."}."""
    cwd = Path.cwd()
    har = Path(har_path)
    args: list[str] = []
    if template:        args += ["--template", template]
    if plugins:         args += ["--plugins", plugins]
    if disable_plugins: args += ["--disable-plugins", disable_plugins]
    if resource_types:  args += ["--resource-types", resource_types]
    if loglevel:        args += ["--loglevel", loglevel]

    code = _run_h2l(python_cmd, cwd, har, args)

    if write_to:
        out = cwd / write_to
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(code, encoding="utf-8")
        return {"path": str(out), "code": code}

    return {"path": "", "code": code}


if __name__ == "__main__":
    # If FastMCP loads, this should block and respond to initialize
    app.run_stdio()
