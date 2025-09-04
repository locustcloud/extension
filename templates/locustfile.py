# Minimal, simple starter for HTTP load testing with Locust.
# Web UI:  locust -f locustfile.py
# Headless: locust -f locustfile.py --headless -u 10 -r 2 -t 1m -H http://localhost:5000

import os
import random
from locust import task, constant
from locust.contrib.fasthttp import FastHttpUser  # Fast, requires a base host

# locustfile.py
import os
import random
from locust import task, constant, events
from locust.contrib.fasthttp import FastHttpUser  # explicit import

DEFAULT_HOST = os.getenv("TARGET_HOST", "http://localhost:5000")

# Fallback: if Locust is started without --host, set one
@events.init.add_listener
def set_default_host(environment, **_):
    if not environment.host:
        environment.host = DEFAULT_HOST

class MockTarget(FastHttpUser):
    # Class-level default (still overridable via --host / -H)
    host = DEFAULT_HOST

    wait_time = constant(1)
    product_ids = [1, 2, 42, 4711]

    def on_start(self):
        # Log visibility that host was set:
        self.environment.runner.environment.events.quitting.fire(
            reverse=False
        ) if False else None  # no-op to keep import tools happy
        pass

    @task
    def browse_home(self):
        self.client.get("/")

    @task
    def add_items_and_checkout(self):
        for pid in random.sample(self.product_ids, k=min(2, len(self.product_ids))):
            self.client.post("/cart/add", json={"productId": pid})
        with self.client.post("/checkout/confirm", json={}, catch_response=True) as resp:
            try:
                ok = bool(resp.json().get("orderId"))
            except Exception:
                ok = False
            if not ok:
                resp.failure("orderId missing in checkout response")
