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

    // For increased security, delete sensitive environment variables from the current process,
    // so they don't leak into PhantomJS processes
    delete process.env.APIFY_PROXY_PASSWORD;
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_USER_ID;
    delete process.env.APIFY_CONTAINER_URL;

    await crawler.run();

    log.info('Crawler finished, results were stored into the default dataset.');
});
