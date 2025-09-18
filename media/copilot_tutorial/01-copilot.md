# Copilot: Convert HAR → Locustfile

Use GitHub Copilot (with MCP enabled) to generate a Locustfile from a HAR capture.

**Prompt:**

Convert samples/sample.har to a locustfile and save it as templates/sample\_locustfile.py

**What happens:**
- Copilot calls the `har.to_locust` MCP tool.
- It creates `templates/sample_locustfile.py` with a runnable Locust test class.
