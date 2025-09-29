import random

from locust import FastHttpUser, constant, run_single_user, task


class SimpleUrl(FastHttpUser):
    wait_time = constant(1)

    @task
    def index(self):
        self.client.get("/")


class MockTarget(FastHttpUser):
    wait_time = constant(1)
    host = "https://mock-test-target.eu-north-1.locust.cloud"
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


if __name__ == "__main__":
    run_single_user(MockTarget)
