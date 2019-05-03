const _ = require('underscore');
const util = require('util');
const Apify = require('apify');
const utils = require('apify-shared/utilities');

const { log } = Apify.utils;

/* global exports */


/**
 * Defines which properties of Request object are modified since the request's page is loaded
 * in browser and its content analysed.
 * NOTE: this field is copied from ../../crawler/constants.js !!!
 */
exports.AFTER_LOAD_UPDATABLE_REQUEST_FIELDS = [
    'loadingStartedAt',
    'loadedUrl',
    'loadingFinishedAt',
    'loadErrorCode',
    'pageFunctionStartedAt',
    'pageFunctionFinishedAt',
    'pageFunctionResult',
    'errorInfo',
    'downloadedBytes',
    '_skipOutput',
    'responseStatus',
    'responseHeaders',
];

/**
 * Helper function that parses string dates in legacy Request object into Date instances.
 * They are typically lost during conversion to JSON.
 */
const fixLegacyRequestDates = (request) => {
    ['requestedAt', 'loadingStartedAt', 'loadingFinishedAt', 'pageFunctionStartedAt', 'pageFunctionFinishedAt'].forEach((key) => {
        if (request[key] && !_.isDate(request[key])) {
            request[key] = utils.parseDateFromJson(request[key]);
        }
    });
};

/**
 * Converts legacy Crawler's `Request` object to `Apify.Request`.
 */
const requestLegacyToRaw = (request) => {
    const data = {
        // null value is not supported by RemoteRequestQueue!
        id: request.id || undefined,
        url: request.url,
        uniqueKey: request.uniqueKey,
        method: request.method,
        payload: request.postData,
        headers: !request.contentType
            ? undefined
            : { 'Content-Type': request.contentType },
        errorMessages: !request.errorInfo
            ? undefined
            : [request.errorInfo],
        handledAt: request.pageFunctionFinishedAt || null,
        retryCount: request._retryCount,
        // keepUrlFragment: request.keepUrlFragment, TODO ???
        userData: _.omit(request, 'id', 'url', 'uniqueKey', 'method', 'postData', 'contentType', 'errorInfo', '_retryCount'),
    };

    const rawRequest = new Apify.Request(data);

    // console.log('\nXXXXX requestLegacyToRaw');
    // console.log('\nlegacyRequest');
    // console.dir(request);
    // console.log('\nrawRequest');
    // console.dir(rawRequest);

    return rawRequest;
};

/**
 * Converts `Apify.Request` object to legacy Crawler's `Request`.
 */
const requestRawToLegacy = (rawRequest) => {
    const request = { ...rawRequest.userData };

    request.id = rawRequest.id;
    request.url = rawRequest.url;
    request.uniqueKey = rawRequest.uniqueKey;
    request.method = rawRequest.method;
    request.postData = rawRequest.payload;
    request.contentType = rawRequest.headers
        ? rawRequest.headers['Content-Type'] || rawRequest.headers['content-type']
        : null;
    request.errorInfo = rawRequest.errorMessages && rawRequest.errorMessages.length > 0
        ? _.last(rawRequest.errorMessages)
        : '';
    request._retryCount = rawRequest.retryCount;

    fixLegacyRequestDates(request);

    // console.log('\nYYYYYYY requestRawToLegacy');
    // console.log('\nrawRequest');
    // console.dir(rawRequest);
    // console.log('\nlegacyRequest');
    // console.dir(request);

    return request;
};


/**
 * An implementation of PhantomJS request manager that stores all requests to a RequestQueue.
 */
class PageManager {
    constructor(phantomCrawler) {
        this.phantomCrawler = phantomCrawler;
        this.requestQueue = phantomCrawler.requestQueue;
        this.dataset = phantomCrawler.dataset;
        this.input = phantomCrawler.input;

        this.pagesCrawled = null;
        this.pagesOutputted = null;
        this.pagesInQueue = null;
    }

    async initialize() {
        const [ queueInfo, datasetInfo ] = await Promise.all([
            this.requestQueue.getInfo(),
            this.dataset.getInfo(),
        ]);
        this.pagesCrawled = queueInfo.handledRequestCount;
        this.pagesInQueue = queueInfo.pendingRequestCount;
        this.pagesOutputted = datasetInfo.itemCount;
    }

    /**
     * Notifies the manager about a new page request.
     * @param request Page object, note that it's meta-data fields will be modified so it should not be used after.
     */
    async addNewPageRequest(request, slaveId) {
        log.debug('PageManager.addNewPageRequest', { slaveId, request: _.pick(request, 'id', 'uniqueKey') });

        // Don't enqueue new requests if there are too many already
        // NOTE: If the request is forefront, we should enqueue it anyway,
        // but we want to keep the same behavior of the legacy Crawler product
        if (this.input.maxCrawledPages) {
            // NOTE: pageInQueue can be inaccurate, so we compute a heuristic estimate
            // TODO: This can use the hadMultipleClients for a more accurate estimate
            const pagesInQueueLowerBound = Math.floor(Math.max(0, this.pagesInQueue * 0.95 - 10));

            if (pagesInQueueLowerBound + this.pagesCrawled >= this.input.maxCrawledPages) {
                log.info('Skipping adding new page to the queue because too many pages were already crawled or added to queue', {
                    request: _.pick(request, 'url', 'uniqueKey'),
                    pagesCrawled: this.pagesCrawled,
                    pagesInQueueLowerBound: pagesInQueueLowerBound,
                    maxCrawledPages: this.input.maxCrawledPages,
                });
                return;
            }
        }

        const rawRequest = requestLegacyToRaw(request);
        const forefront = request.queuePosition === 'FIRST';
        const opInfo = await this.requestQueue.addRequest(rawRequest, { forefront });

        if (!opInfo.wasAlreadyPresent) this.pagesInQueue++;

        log.info('Page added to queue', {
            requestId: opInfo.requestId,
            url: utils.truncate(request.url, 200, '...'),
            forefront,
            wasAlreadyPresent: opInfo.wasAlreadyPresent,
        });

        request.id = opInfo.requestId;
    }

    /**
     * Checks whether maxCrawledPages or maxOutputPages limits were exceeded.
     * If yes, the function abort the AutoscaledPool and thus finishes the crawling.
     */
    checkLimits() {
        let msg;
        if (this.input.maxCrawledPages && this.input.maxCrawledPages <= this.pagesCrawled) {
            msg = `Crawled ${this.pagesCrawled} pages, limit is ${this.input.maxCrawledPages} pages`;
        } else if (this.input.maxOutputPages && this.input.maxOutputPages <= this.pagesOutputted) {
            msg = `Outputted ${this.pagesOutputted} pages, limit is ${this.input.maxCrawledPages} pages`;
        }
        if (msg) {
            log.info(`Shutting down the crawler: ${msg}`);
            this.phantomCrawler.autoscaledPool.abort();
        }
    }

    /**
     * Fetches next request from the queue and invokes a user callback or returns a promise if no callback supplied.
     * Note that once the request is fetched, it is a caller's responsibility to call markRequestHandled(),
     * retryRequestSoon() or reclaimRequest() for that request, otherwise the request will stay in the queue forever
     * (until the process exits).
     * The result of this operation is an object like {request: Object, statusMessage: String}
     */
    async fetchNextRequest(slaveId) {
        let requestRaw = await this.requestQueue.fetchNextRequest();
        if (!requestRaw) {
            log.debug('Page not fetched: queue is empty', { slaveId });
            // This could be also error "Error fetching request from queue"
            return { request: null, statusMessage: 'Crawling queue is empty' };
        }

        log.debug('Page fetched', { requestId: requestRaw.id, slaveId });

        const result = {
            request: null,
            statusMessage: null,
        };

        const request = requestRawToLegacy(requestRaw);

        if (request.loadingFinishedAt) {
            // this happens sometimes, update of page's _queueOrderNo took a very long and is not reflected
            // in the queue head index
            result.statusMessage = 'Error fetching request from queue';
            log.warning('Page fetched from queue was already crawled', {
                request: _.pick(request, 'id', 'url'),
                slaveId,
            });
            return result;
        }

        result.statusMessage = 'Request was fetched successfully';
        result.request = request;

        // Pass current stats to the slave
        result.request._stats = {
            pagesCrawled: this.pagesCrawled,
            pagesOutputted: this.pagesOutputted,
            pagesInQueue: this.pagesInQueue,
        };

        // Load referring request if needed
        if (request.referrerId) {
            const referringRawRequest = await this.requestQueue.getRequest(request.referrerId);
            if (referringRawRequest) {
                const referringRequest = requestRawToLegacy(referringRawRequest);
                if (referringRequest) {
                    result.request.referrer = referringRequest;
                } else {
                    log.warning('Cannot find referring request', {
                        requestId: result.requestId,
                        referrerId: result.request.referrerId,
                        slaveId,
                    });
                }
            }
        }

        return result;
    }

    /**
     * Notifies the manager that a requested page has been crawled.
     * @param request Page object. Note that some of its fields will be modified.
     */
    async markRequestHandled(request, slaveId) {
        if (!request) throw new Error("Parameter 'request' must be specified.");

        try {
            log.debug('Marking request as handled', { requestId: request.id, slaveId });

            const skipOutput = !!request._skipOutput;

            // request._outputSeqNo = !request._skipOutput ? ++this.lastOutputSeqNo : null;

            // Remove unnecessary fields
            delete request._skipOutput;
            delete request._stats;
            delete request.referrer;

            // Save results before calling markRequestHandled(), otherwise the result might be lost on crash.
            // However, this also means that results might be duplicated.
            if (!skipOutput) {
                await this.dataset.pushData(request);
            }

            const requestRaw = requestLegacyToRaw(request);
            const opInfo = await this.requestQueue.markRequestHandled(requestRaw);
            if (opInfo.wasAlreadyHandled) {
                // This shouldn't happen, it might cause inconsistencies in output
                log.warning('The page was already marked as crawled', { requestId: request.id, slaveId });
                return;
            }

            // Increment counters and check whether limits were exceeded
            if (!skipOutput) this.pagesOutputted++;
            this.pagesCrawled++;
            this.pagesInQueue = Math.max(this.pagesInQueue - 1, 0);

            this.checkLimits();
        } catch (e) {
            this.phantomCrawler.fatalError(e);
        }
    }

    /**
     * Notifies the page manager that a page load failed or that a slave to which the request was to be sent abruptly exited.
     * The request is reinserted back to the local cache of crawling queue so that it can be crawled again.
     *
     * This function saves the updated page request back to the page store and
     * reinserts it to the end of local cache of the crawling queue, so that it will be retried soon again.
     * @param request Page object, note that it's meta-data fields will be modified so it should not be used after.
     */
    async reclaimRequest(request, slaveId) {
        log.info('Reclaiming request to queue, it will be retried again', { requestId: request.id, slaveId });

        delete request.referrer;

        const requestRaw = requestLegacyToRaw(request);
        await this.requestQueue.reclaimRequest(requestRaw, { forefront: true });
    }
}


exports.PageManager = PageManager;
exports.fixLegacyRequestDates = fixLegacyRequestDates;
