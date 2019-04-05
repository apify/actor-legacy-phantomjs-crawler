
  
**Simple TODOs**  

- Test `customData` works with both string and object
- Test dot and dollar in cookies!


- TEST MIGRATION: https://my.apify.com/crawlers/Yf7kdZZoRzzp2Jg6Q => https://my.apify.com/tasks/PmmhAGHpQ85dXTmKo#/runs/o6N3cu7RNnbTxJHyu
  maxParallelRequests empty sets it to default 50, it should be 1

- Feedback from testing:
  - I’m getting “Error: Value of input.proxyGroups is not an array.” in apify/legacy-phantomjs-crawler after migration - CANNOT REPRODUCE
  - Another one: “Error: Cannot start actor run with the provided actor task (Invalid value provided in options: Timeout is required [invalid-value])” - MAREK WILL FIX
  
  - avoid waiting for queue:  
  2019-03-26T08:40:44.453Z [S0000001] Crawling process is finished: The slave already opened 1 pages, reaching the 'maxCrawledPagesPerSlave' limit from the configuration.
  2019-03-26T08:40:44.455Z [S0000001] Shutting down the crawling process and PhantomJS...
  2019-03-26T08:40:44.633Z {"level":"INFO","msg":"Slave exited","slaveId":1,"pid":20,"code":0,"signal":null}
  2019-03-26T08:40:53.045Z {"level":"INFO","msg":"Live view client connected","clientId":"sHzKtGQqj8RamDqIAAAA"}
  2019-03-26T08:41:03.200Z {"level":"INFO","msg":"PhantomCrawler: Shutting down the crawler: The request queue is empty"}
  2019-03-26T08:41:03.203Z {"level":"INFO","msg":"Crawler finished, results were stored into the default dataset."}
  

  
  
**MIGRATION**

- For each crawler, create a new task (TODO: How to call them?)
- Keep maxParallelCrawlers and set the memory accordingly (give or take)
- Transform proxy configuration to new setting
- Generate webhooks from finishWebhookUrl/finishWebhookData (TODO: need custom webhook stuff for this!)
- `timeout` field is not working, it must be set as part of the actor run options,
  and also overriden that way via API!
  We need to migrate it correctly!
