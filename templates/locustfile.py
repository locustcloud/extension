import random
from locust import task, constant, events
from locust.contrib.fasthttp import FastHttpUser  

# Minimal, simple starter for HTTP load testing with Locust.
# Web UI:  locust -f locustfile.py 
# Headless: locust -f locustfile.py --headless -u 10 -r 2 -t 1m -H http://0.0.0.0:5000

class MockTarget(FastHttpUser):

    # Class-level default (still overridable via --host / -H)
    host = "https://mock-test-target.eu-north-1.locust.cloud"
    wait_time = constant(1)
    product_ids = [1, 2, 42, 4711]
    

    def on_start(self):
        # Authenticate once per simulated user
        resp = self.client.post("/authenticate", json={"password": "bar"})
        if resp.status_code != 200:
            resp.failure("Login failed")

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
