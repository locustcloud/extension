# Copilot prompt examples

+ **Copilot: Convert HAR → Locustfile**

    Use GitHub Copilot (with MCP enabled) to generate a Locustfile from a HAR capture.

    **Prompt:**

    Convert your_file.har to a locustfile and save it in your_directory

    **What happens:**
    - Copilot calls the `har.to_locust` MCP tool.
    - It creates `your_directory/sample_locustfile.py` with a runnable Locust test class.

* **Convert HAR to Locustfile Run Test**

    ***Prompt:***

    
    could you convert the filename har file and run result in test ui?

    
    **What happens:***
    - Copilot calls Har2Locust tool.
    - Use created locustfile directly.

* **Regenerate Locustfile**

    ***Prompt:***


    1. Could you write me a locustfile containing one user and 3 tasks?

    2. Could you please regenerate a locustfile that loop through a list of URL:s using FastHttp user that do 3 different tasks authenticate (POST), inventory (GET), cart/add (POST)


    **What Happens:**
    - Copilot creates locustfile as instructed.