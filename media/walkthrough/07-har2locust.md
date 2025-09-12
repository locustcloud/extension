
---

````markdown
# Convert a HAR recording into a Locustfile

Locust isn’t limited to hand-written scenarios. You can also **record real traffic in your browser**, save it as a [HAR file](https://en.wikipedia.org/wiki/HAR_(file_format)), and convert that directly into a `locustfile.py` using the built-in MCP server.

---

## 1. Record a HAR file

- **Chrome / Edge / Brave**  
  1. Open DevTools (`F12` or `Ctrl+Shift+I`).  
  2. Go to the **Network** tab.  
  3. Make sure “Preserve log” is enabled.  
  4. Interact with the site (log in, click around).  
  5. Right-click anywhere in the network list →  
     **Save all as HAR with content…**

- **Firefox**  
  1. Open DevTools (`F12`).  
  2. Go to **Network**.  
  3. Perform some actions.  
  4. Right-click → **Save All As HAR**.

This gives you a file like `recording.har` with the full request/response log.

---

## 2. Ask Copilot to convert HAR to Locustfile


**Prompt:**
```

Convert samples/sample.har to a locustfile and save it as templates/sample\_locustfile.py

```

**Copilot:**
- Calls the `har.to_locust` MCP tool.
- Produces `templates/sample_locustfile.py` with a runnable Locust test class.

---

---

## 3. Run the generated Locustfile

Once created, run the scenario just like any other Locust test:

```bash
locust -f recording_locustfile.py --headless -u 20 -r 2 -t 1m
```

or open the Web UI:

```bash
locust -f recording_locustfile.py
```

---

## Notes

* HARs with **no entries** will produce an empty script. Make sure you capture real traffic.
* The generated file is a starting point, you can tweak tasks, headers, or add assertions as needed.
* You can keep both **hand-written** and **HAR-generated** files in your workspace and run either.

```


