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
        const webhook = await Apify.addWebhook({
            requestUrl: input.finishWebhookUrl,
            eventTypes: [
                'ACTOR.RUN.SUCCEEDED',
                'ACTOR.RUN.FAILED',
                'ACTOR.RUN.ABORTED',
                'ACTOR.RUN.TIMED_OUT',
            ],

            // This is to ensure that on actor restart, the webhook will not be added again
            idempotencyKey: `finish-webhook-${process.env.APIFY_ACTOR_RUN_ID}`,

            // Note that ACTOR_TASK_ID might be undefined if not running in an actor task,
            // other fields can undefined when running this locally
            payloadTemplate: `{
    "actorId": ${JSON.stringify(process.env.ACTOR_ID || null)},
    "taskId": ${JSON.stringify(process.env.ACTOR_TASK_ID || null)},
    "runId": ${JSON.stringify(process.env.ACTOR_RUN_ID || null)},
    "datasetId": ${JSON.stringify(process.env.APIFY_DEFAULT_DATASET_ID || null)},
    "data": ${JSON.stringify(input.finishWebhookData || null)}
}`,
        });
        log.info('Added finish webhook', { webhook: _.pick(webhook, 'id', 'idempotencyKey', 'requestUrl') });
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
