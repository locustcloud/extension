# Copilot: List Tasks & Tags in a Locustfile

Ask Copilot to inspect a Locustfile for `@task` functions and `@tag` values.

**Prompt:**

List tasks and tags in templates/locustfile.py

**What happens:**
- Copilot calls the `locust.list_tasks` MCP tool.
- It returns discovered tasks/tags, e.g.:
```json
{
  "file": "templates/locustfile.py",
  "tasks": ["browse_home", "add_items_and_checkout"],
  "tags": ["checkout"]
}
