const Apify = require('apify');
const log = require('apify-shared/log');
const PhantomCrawler = require('./phantom_crawler');

Apify.main(async () => {
    const input = await Apify.getInput();
    if (!input) throw new Error('The input was not provided');

    if (input.verboseLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    const requestQueue = await Apify.openRequestQueue();
    const dataset = await Apify.openDataset();

    // TODO: For increased security, delete sensitive environment variables from the current process,
    // but also for init, is it even needed?

    const crawler = new PhantomCrawler({
        input,
        requestQueue,
        dataset,
    });

    await crawler.run();

    log.info('Crawler finished, results were stored into the default dataset.');
});
