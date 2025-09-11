
---

```markdown
# Copilot Walkthrough: HAR → Locustfile → Running UI / Headless

This walkthrough shows how GitHub Copilot (with MCP enabled) can generate a Locustfile from a HAR capture, list available tasks/tags, and run Locust in either **UI** mode or **headless** mode against the demo target.

---

## Step 1. Ask Copilot to convert HAR to Locustfile

**Prompt:**
```

Convert samples/sample.har to a locustfile and save it as templates/sample\_locustfile.py

```

**Copilot:**
- Calls the `har.to_locust` MCP tool.
- Produces `templates/sample_locustfile.py` with a runnable Locust test class.

---

## Step 2. Ask Copilot to list tasks and tags

**Prompt:**
```

List tasks and tags in templates/sample\_locustfile.py

````

**Copilot:**
- Calls the `locust.list_tasks` MCP tool.
- Returns discovered `@task` functions and `@tag` values.
- Example:
  ```json
  {
    "file": "templates/sample_locustfile.py",
    "tasks": ["browse_home", "add_items_and_checkout"],
    "tags": ["checkout"]
  }
````

---

## Step 3. Run Locust in browser UI

**Prompt:**

```
Start Locust UI using templates/sample_locustfile.py against https://mock-test-target.eu-north-1.locust.cloud
```

**Copilot:**

* Calls the `locust.run_ui` MCP tool.
* Launches Locust with:

  ```bash
  locust -f templates/sample_locustfile.py \
         --host=https://mock-test-target.eu-north-1.locust.cloud
  ```
* Returns a PID and the URL `http://localhost:8089`.

---

## Step 4. Open Locust UI

* VS Code’s **Simple Browser** opens to `http://localhost:8089`.
* You can configure number of users, spawn rate, and start the load test.

---

## Step 5. Stop a running Locust process

**Prompt:**

```
Stop Locust process PID 12345
```

**Copilot:**

* Calls the `locust.stop` MCP tool.
* Stops the background Locust process gracefully.

---

## Step 6. Run Locust headless (no UI)

**Prompt:**

```
Run headless for 1m with 10 users, spawn rate 2, tags=checkout using templates/sample_locustfile.py
```

**Copilot:**

* Calls the `locust.run_headless` MCP tool with the requested parameters.
* Runs:

  ```bash
  locust -f templates/sample_locustfile.py \
         --headless -u 10 -r 2 -t 1m \
         --tags checkout \
         --host=https://mock-test-target.eu-north-1.locust.cloud
  ```
* Returns stdout/stderr with test results.

---

## Result

You now have:

* A working Locustfile (`sample_locustfile.py`).
* The ability to list tasks and tags directly from Copilot.
* Locust running in **UI mode** with browser interface, or **headless mode** with full CLI output.
* Control to stop a running test from Copilot Chat.
* Full workflow powered by **Copilot + MCP server integration**.

---

