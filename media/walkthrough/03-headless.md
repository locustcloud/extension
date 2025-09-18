## Locust Test

**Your first test**

A Locust test is essentially just a Python program making requests to the system you want to test. 
This makes it very flexible and particularly good at implementing complex user flows.


* Uses default locustfile.py to perform Locust Test targeting a mock server.
* Click "Run Test (Headless)" in menu to perform a headless Locust Test.

- Runs locust -f templates/locustfile.py --headless -u 10 -r 2 -t 1m URL
- Default templates/locustfile.py is and available in explorer: LOCUST TESTS

Command button uses your configured default host if set in settings, or the `host` on the class
