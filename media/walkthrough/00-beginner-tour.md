# Locustfile Introduction

A locust file is just a normal Python module, it can import code from other files or packages.

---

Simple locustfile example:

```python
# Import dependencies
import time
from locust import HttpUser, task, between

# Define user class that we will be simulating. 
# It inherits from HttpUser which gives each user a client attribute.
# At least one inherited User needed for valid locustfile.
# Locust creates a instance for every user. 

class QuickstartUser(HttpUser):
    # Wait time defines how long users wait between taks.
    wait_time = between(1, 5)
    # task decorator creates a greenlet. Code within a task is executed sequentially.
    # Only the methods decorated with task will be picked.
    @task
    def hello_world(self):
        self.client.get("/hello")
        self.client.get("/world")
    # task with weight increase the likelyhood of pick.
    @task(3)
    def view_items(self):
        for item_id in range(10):
            self.client.get(f"/item?id={item_id}", name="/item")
            time.sleep(1)

    # on_start is called for each simulated user when they start.
    def on_start(self):
        self.client.post("/login", json={"username":"foo", "password":"bar"})

```

---
