
  
**Simple TODOs**  

- Links in README don't work
- Live view - show info about number of parallel crawlers
- Input schema - add maxKeyLength/maxValueLength to key-value editor?
- not sure how `customData` works, needs to be tested
- For better security, we should remove APIFY_xxx env vars from the main process and other parent processes

  

**BACKWARDS (IN)COMPATIBILITY**

- `testUrl` is not supported and probably won't be. How to replicate test-url thing?
- Cookies persistence setting `OVER_CRAWLER_RUNS` is not supported.
  We can support it for tasks - basically the crawler will update the task.
  For a run straight from the actor, we should throw an error
- The detailed stats from the legacy crawler are not supported,
  but we could add them to some key-value store item. Are they needed?
- The legacy crawler had a validation of proxy groups directly in API, this will not be present now and will fail silently later.
  We should do at least some validation and fail the actor gracefully, rather than failing silently.
  Maybe the new Apify.getProxy() function plus Apify.exit() would solve this here well...
  
- context.actId and finishWebhook payload has actId - that was crawler ID.
  We should set this to "DEPRECATED" and add "taskId" instead.
  
- The legacy finish webhook was deprecated and needs to be replaced with new webhooks.
  The logic behind this is that the POST contained `{_id: "S76d9xzpvY7NLfSJc", actId: "lepE4f93lkDPqojdC"}`,
  i.e. crawler ID and run execution ID, neither of which makes sense after migration.
  So why support it.
  
**MIGRATION**

- For each crawler, create a new task (TODO: How to call them?)
- Test dot and dollar in cookies!
- Keep maxParallelCrawlers and set the memory accordingly (give or take)
- Transform proxy configuration to new setting
- Generate webhooks from finishWebhookUrl/finishWebhookData (TODO: need custom webhook stuff for this!)
- `timeout` field is not working, it must be set as part of the actor run options,
  and also overriden that way via API!
  We need to migrate it correctly!
