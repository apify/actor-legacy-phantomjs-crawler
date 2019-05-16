const Apify = require('apify');
const PhantomCrawler = require('./phantom_crawler');

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput();
    if (!input) throw new Error('The input was not provided');

    if (input.verboseLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    // Set up finish webhook
    if (input.finishWebhookUrl) {
        // TODO: Finish this, add custom data
        throw new Error('The "finishWebhookUrl" is not yet fully supported, please use Actor Webhooks instead.');
        await Apify.addWebhook({
            requestUrl: input.finishWebhookUrl,
            eventTypes: [
                'ACTOR.RUN.SUCCEEDED',
                'ACTOR.RUN.FAILED',
                'ACTOR.RUN.ABORTED',
                'ACTOR.RUN.TIMED_OUT',
            ],
            idempotencyKey: `finish-webhook-${process.env.APIFY_ACTOR_RUN_ID}`,
            // Note that ACTOR_TASK_ID might be empty when run from actor not task.
            payloadTemplate: `{
    "taskId": ${JSON.stringify(process.env.ACTOR_TASK_ID || null)},
    "runId": "${process.env.ACTOR_RUN_ID}",
    "data": input.finishWebhookData || null
}`,
        });
    }

    const requestQueue = await Apify.openRequestQueue();
    const dataset = await Apify.openDataset();

    const crawler = new PhantomCrawler({
        input,
        requestQueue,
        dataset,
    });

    await crawler.run();

    const datasetId = dataset.datasetId;
    if (datasetId) {
        log.info(`Crawler finished.

Full results in JSON format:
https://api.apify.com/v2/datasets/${datasetId}/items?format=json

Simplified results in JSON format:
https://api.apify.com/v2/datasets/${datasetId}/items?format=json&simplified=1`);
    } else {
        log.info('Crawler finished.');
    }

});
