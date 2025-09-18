## Run Locust headless (no UI)

**Prompt:**

```
Run headless for 1m with 10 users, spawn rate 2, tags=checkout using templates/locustfile.py
```

**Copilot:**

* Calls the `locust.run_headless` MCP tool with the requested parameters.
* Runs:

  ```bash
  locust -f templates/locustfile.py \
         --headless -u 10 -r 2 -t 1m \
         --tags checkout \
         --host=https://mock-test-target.eu-north-1.locust.cloud
  ```
* Returns stdout/stderr with test results.
