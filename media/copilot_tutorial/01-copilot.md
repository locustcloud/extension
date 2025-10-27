# Copilot: Prompt Examples


* **Convert HAR to Locustfile**

    
    ***Prompt:***

    
    Convert sample.har to locustfile and save it as templates/sample\_locustfile.py

    
    **What happens:**

    - Copilot calls the `har.to_locust` tool.
    - It creates `templates/sample_locustfile.py` with a runnable Locust test class.


* **Convert HAR to Locustfile Run Test**

    
    ***Prompt:***

    
    could you convert the sample har file and run the result in the ui?

    
    **What happens:***

    - Copilot calls Har2Locust tool.
    - Use created locustfile directly.


* **Regenerate Locustfile**


    ***Prompt:***


    1. [Simple] Could you write me a locustfile containing one user and 3 tasks?

    2. [Advanced] Could you please regenerate a locustfile that loop through a list of URL:s using FastHttp user that do 3 different tasks authenticate (POST), inventory (GET), cart/add (POST)


    **What Happens:**
    
    - Copilot creates locustfile as instructed.