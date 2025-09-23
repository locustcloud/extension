from locust import FastHttpUser, task, tag, constant

class MyUser(FastHttpUser):
    """Example user making a simple GET request."""
    wait_time = constant(1)

    @task
    def example(self):
        self.client.get("/")

    @tag("checkout")
    @task
    def checkout(self):
        self.client.post("/api/checkout", json={})
