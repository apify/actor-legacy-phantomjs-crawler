const Apify = require('apify');
const PhantomCrawler = require('./phantom_crawler');

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput();
    if (!input) throw new Error('The input was not provided');

    if (input.verboseLog) {
        log.setLevel(log.LEVELS.DEBUG);
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
https://api.apify.com/v2/datasets/${datasetId}/items?format=json&fields=url,pageFunctionResult,errorInfo&unwind=pageFunctionResult`);
    } else {
        log.info('Crawler finished.');
    }

});
