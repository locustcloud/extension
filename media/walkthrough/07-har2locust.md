## Convert a HAR recording into a Locustfile

Locust isn’t limited to hand-written scenarios. You can also **record real traffic in your browser**, save it as a [HAR file](https://en.wikipedia.org/wiki/HAR_(file_format)), and convert that directly into a `locustfile`.

- Choose Convert HAR -> Locust.
- Choose HAR file.
- Name new `locustfile`. Default har file name + _locustfile.py.
- The new `file_name_locustfile.py` appears in LOCUST TESTS menu. 

## Notes

* HARs with **no entries** will produce an empty script. Make sure you capture real traffic.
* The generated file is a starting point, you can tweak tasks, headers, or add assertions as needed.
* You can keep both **hand-written** and **HAR-generated** files in your workspace and run either.


