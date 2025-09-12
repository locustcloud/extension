**Headless example:**

locust -f locustfile.py --headless -u 10 -r 2 -t 1m URL (No worries we set it for you already)

Command button uses your configured default host if set in settings, or the `host` on the class

**Copilot Prompt:**

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
