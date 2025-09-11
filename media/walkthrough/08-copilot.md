
---

```markdown
# Copilot Walkthrough: HAR → Locustfile → Running UI

This walkthrough shows how GitHub Copilot (with MCP enabled) can generate a Locustfile from a HAR capture and run Locust in browser UI mode against the demo target.

---

## Step 1. Ask Copilot to convert HAR to Locustfile

**Prompt:**
```

Convert samples/sample.har to a Locustfile.

```

**Copilot:**
- Calls the `har.to_locust` MCP tool.
- Produces `templates/filename_locustfile.py` with a runnable Locust test class.


---

## Step 2. Ask Copilot to run the Locustfile in browser UI

**Prompt:**
```

run locust in locustfile.py in browser

````

**Copilot:**
- Finds the generated locustfile (`templates/locustfile.py`).
- Suggests running Locust with:
  ```bash
  locust -f templates/locustfile.py \
         --host=https://mock-test-target.eu-north-1.locust.cloud
````

---

## Step 3. Copilot runs the command in a background terminal

* A new terminal starts Locust.
* Locust’s web interface is launched at [http://localhost:8089](http://localhost:8089).


---

## Step 4. Open Locust UI

* VS Code’s **Simple Browser** opens to `http://localhost:8089`.
* You can configure number of users, spawn rate, and start the load test.


---

## Result

You now have:

* A working Locustfile (`sample_locustfile.py`).
* Locust running in UI mode against the demo target.
* Full workflow powered by **Copilot + MCP server integration**.

---

```


