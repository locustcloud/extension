from locust import HttpUser, task, between

class WebsiteUser(HttpUser):
    wait_time = between(1, 5)

    @task
    def get_root(self):
        self.client.get("/", headers={"Accept": "text/html"})

    @task
    def post_authenticate(self):
        self.client.post(
            "/authenticate",
            headers={"Content-Type": "application/json"},
            json={"password": "bar"}
        )
