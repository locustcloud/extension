
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

## 2. Convert with MCP

Open **Copilot Chat** inside VS Code and run:

```json
/har.to_locust {
  "har_path": "/absolute/path/to/recording.har",
  "user_class": "RecordedUser",
  "write_to": "locustfile_from_har.py"
}
````

* `har_path`: absolute path to your `.har` file.
* `user_class`: optional: the class name for the generated user.
* `write_to`: optional: path where the `locustfile.py` should be written.

The generated Locustfile will also be displayed inline in Copilot Chat.

---

## 3. Run the generated Locustfile

Once created, run the scenario just like any other Locust test:

```bash
locust -f locustfile_from_har.py --headless -u 20 -r 2 -t 1m
```

or open the Web UI:

```bash
locust -f locustfile_from_har.py
```

---

## Notes

* HARs with **no entries** will produce an empty script. Make sure you capture real traffic.
* The generated file is a starting point, you can tweak tasks, headers, or add assertions as needed.
* You can keep both **hand-written** and **HAR-generated** files in your workspace and run either.

```


