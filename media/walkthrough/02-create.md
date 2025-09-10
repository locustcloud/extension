**No locustfile yet?** Click **Create Simulation** above.

The extension will scaffold a minimal `locustfile.py` with:
- `FastHttpUser` and `wait_time = constant(1)`
- `host = "https://mock-test-target.eu-north-1.locust.cloud"`
- one simple `@task` that hits `/`
