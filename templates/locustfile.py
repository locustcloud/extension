from locust import FastHttpUser, HttpUser, between, task, constant
import time

# Standard Template.
class MockTarget(FastHttpUser):
    wait_time = constant(1)
    product_ids = [1, 2, 42, 4711]


    @task
    def t(self):
        self.client.get("/")
        self.client.post("/authenticate", json={"user": "foo", "password": "bar"})
        for product_id in random.sample(self.product_ids, 2):
            self.client.post("/cart/add", json={"productId": product_id})
        with self.client.post("/checkout/confirm", catch_response=True) as resp:
            if not resp.json().get("orderId"):
                resp.failure("orderId missing")
