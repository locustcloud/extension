from locust import task, run_single_user
from locust import FastHttpUser


class sample(FastHttpUser):
    host = "https://mock-test-target.eu-north-1.locust.cloud"

    @task
    def t(self):
        with self.client.request(
            "GET", "/", headers={"Accept": "text/html"}, catch_response=True
        ) as resp:
            pass
        with self.rest(
            "POST", "/authenticate", headers={}, json={"password": "bar"}
        ) as resp:
            pass


if __name__ == "__main__":
    run_single_user(sample)
