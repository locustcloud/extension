# Welcome to Locust Cloud's Online Test Editor!
#
# This is a quick way to get started with load tests without having
# to set up your own Python development environment.

from locust import FastHttpUser, task


class MyUser(FastHttpUser):
    # Change this to your actual target site, or leave it as is
    host = "https://mock-test-target.eu-north-1.locust.cloud"

    @task
    def t(self):
        # Simple request
        self.client.get("/")

        # Example rest call with validation
        with self.client.post(
            "/authenticate",
            json={"username": "foo", "password": "bar"},
            catch_response=True,
        ) as resp:
            if "token" not in resp.text:
                resp.failure("missing token in response")


# To deploy this test to the load generators click the Launch button.
#
# When you are done, or want to deploy an updated test, click Shut Down
#
# If you get stuck reach out to us at support@locust.cloud
#
# When you are ready to run Locust from your own machine,
# check out the documentation:
# https://docs.locust.io/en/stable/locust-cloud/locust-cloud.html
#
# Please remember to save your work outside of this editor as the
# storage is not permanent.
