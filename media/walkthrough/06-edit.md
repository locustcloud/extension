Open ex: `locustfile.py` and tweak a request.

### Add custom headers
Change:
```python
self.client.get("/")

to:

self.client.get("/", headers={"X-Demo": "true", "Accept": "application/json"})