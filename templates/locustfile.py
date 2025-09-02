# Minimal, simple starter for HTTP load testing with Locust.
# Run:
#   locust -f locustfile.py         # web UI
#   locust -f locustfile.py --headless -u 10 -r 2 -t 1m -H http://localhost:8000

from locust import FastHttpUser, task, constant
import random


class MockTarget(FastHttpUser):
    # Simulated user wait between tasks
    wait_time = constant(1)

    # Example “catalog”
    product_ids = [1, 2, 42, 4711]

    def on_start(self):
        """
        Called once when a simulated user starts.
        Good place for login or session setup.
        """
        # If your target needs auth, do it here. This is a no-op example.
        # Example:
        # resp = self.client.post("/authenticate", json={"user": "foo", "password": "bar"})
        # resp.raise_for_status()
        pass

    @task
    def browse_home(self):
        """Simple GET to the home page."""
        self.client.get("/")

    @task
    def add_items_and_checkout(self):
        """
        POST a couple of items to the cart and try a checkout.
        Demonstrates JSON payloads and basic success validation.
        """
        # Add 2 random items
        for product_id in random.sample(self.product_ids, k=min(2, len(self.product_ids))):
            self.client.post("/cart/add", json={"productId": product_id})

        # Attempt checkout with simple validation
        with self.client.post("/checkout/confirm", json={}, catch_response=True) as resp:
            ok = False
            try:
                data = resp.json()
                ok = bool(data.get("orderId"))
            except Exception:
                ok = False

            if not ok:
                resp.failure("orderId missing in checkout response")

