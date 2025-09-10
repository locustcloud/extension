**What this does**
- Creates a Python venv (default: `locust_env`)
- Installs Locust (and your MCP server deps)
- Sets VS Code’s interpreter to the venv
- Writes `.vscode/mcp.json` so Copilot MCP tools work

If you already have Locust globally, this still sets up a local, isolated environment.
