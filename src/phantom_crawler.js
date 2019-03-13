const http = require('http');
const util = require('util');
const path = require('path');
const fs = require('fs');
const _ = require('underscore');
const tmp = require('tmp');
const express = require('express');
const bodyParser = require('body-parser');
const Apify = require('apify');
const log = require('apify-shared/log');
const { spawn } = require('child_process');
const utils = require('./utils');
const LinkedList = require('apify-shared/linked_list');
const { ACTOR_EVENT_NAMES } = require('apify-shared/consts');
const { PageManager, AFTER_LOAD_UPDATABLE_REQUEST_FIELDS } = require('./page_manager');
const LiveViewServer = require('./live_view_server');


// resolve path to 'crawler-slave.js' here so that an error it thrown early if it's not available
const slaveScriptPath = require.resolve('./phantom_scripts/crawler-slave.js');

/**
 * Since there's no set number of seconds before the container is terminated after
 * a migration event, we need some reasonable number to use for RequestList persistence.
 * Once a migration event is received, the Crawler will be paused and it will wait for
 * this long before persisting the RequestList state. This should allow most healthy
 * requests to finish and be marked as handled, thus lowering the amount of duplicate
 * results after migration.
 *
 * @type {number}
 * @ignore
 */
const SAFE_MIGRATION_WAIT_MILLIS = 20000;

const INITIAL_SLAVE_ID = 1;

const DEFAULT_MAX_CONCURRENCY = 100;

const DEFAULT_EXECUTOR_HEARTBEAT_MILLIS = 5 * 1000;

const SNAPSHOTS_UNTIL_PARALLEL_CRAWLER_COUNT = 1;

const PHANTOMJS_COMMAND = 'phantomjs';

// Let phantomjs use the lowest priority possible, to avoid blocking worker process
const PHANTOMJS_SCHEDULING_PRIORITY = 39;

// Upper estimate of a typical memory consumption of PhantomJS process (500 MB).
const PHANTOMJS_PROCESS_ESTIMATED_MEMORY_BYTES = 500 * 1000 * 1000;

const LOG_PREFIX = 'PhantomCrawler: ';

// max time since the last message was received from slave (note that RemoteRequestManager sends ping every 10 seconds,
// and if no ping was received this long, the crawler is most likely in infinite loop). This number should be larger than
// REMOTE_REQUEST_MANAGER_TIMEOUT in constants.js !
const NON_RESPONSIVE_SLAVE_MIN_MILLIS = 60 * 1000;
const MAX_BOOTSTRAP_ATTEMPTS = 4;
const MAX_CRASHES_PER_REQUEST = 3;

const STATE_KEY = 'PhantomCrawlerState';

const DEFAULT_PROXY_GROUP_ID = 'DEFAULT';
const CUSTOM_PROXY_GROUP_ID = 'CUSTOM';

const COOKIES_PERSISTENCE = {
    PER_PROCESS: 'PER_PROCESS',
    PER_CRAWLER_RUN: 'PER_CRAWLER_RUN',
    OVER_CRAWLER_RUNS: 'OVER_CRAWLER_RUNS',
};

const writeFilePromised = util.promisify(fs.writeFile);
const renamePromised = util.promisify(fs.rename);


/**
 * A class representing a slave PhantomJS process.
 */
class Slave {
    constructor (id, childProcess, isBootstrapper) {
        // a unique identifier of the slave
        this.id = id;

        // process instance (result of spawn() function)
        this.childProcess = childProcess;

        // store PID locally, so that it's available even after process exits
        // never leak this info to execution log file!
        this.pid = childProcess.pid;

        // indicates this is a bootstrapping process, i.e. a process whose task is only
        // to enqueue startUrls while invoking interceptRequest on them
        this.isBootstrapper = isBootstrapper;

        // time of last message from slave, used to kill non-responsive processes
        this.lastMessageAt = new Date();

        // the request that was sent back to the slave after last 'fetchNextRequest' message.
        // this fields becomes null again after slave sends 'markRequestHandled' message
        this.lastFetchedRequest = null;

        // if true, the slave process already exited (basically whenever record is removed from slaves dictionary)
        this.isExited = false;

        // Anonymized proxy URL used by the slave process or null, it's passed to Request.proxy
        this.proxy = null;

        // Command used to start the process
        this.fullCmd = null
    }
}

/**
 * Generates a 'logPrefix' for a crawler process.
 */
const generateLogPrefix = (slaveId) => {
    return typeof slaveId === 'number' ? `S${slaveId.toString().padStart(7, '0')}` : 'EXECUTOR';
};

/**
 * Converts actor's input to PhantomJS crawler configuration file.
 */
const inputToConfig = (input) => {
    // TODO: customData is okay???
    const config = _.pick(input,
        'customId', 'startUrls', 'crawlPurls', 'clickableElementsSelector', 'pageFunction', 'interceptRequest',
        'considerUrlFragment', 'loadImages', 'loadCss', 'injectJQuery', 'injectUnderscoreJs',
        'ignoreRobotsTxt', 'skipLoadingFrames', 'verboseLog', 'disableWebSecurity', 'rotateUserAgents',
        'maxCrawledPages', 'maxOutputPages', 'maxCrawlDepth', 'timeout', 'resourceTimeout',
        'pageLoadTimeout', 'pageFunctionTimeout', 'maxInfiniteScrollHeight',
        'randomWaitBetweenRequests', 'maxCrawledPagesPerSlave', 'maxParallelRequests',
        'maxPageRetryCount', 'customHttpHeaders', 'cookies',
        'cookiesPersistence', 'customData');

    // log.debug('Converted input to crawler configuration', { input, config });

    return config;
};


class PhantomCrawler {
    constructor({ input, requestQueue, dataset }) {
        this.input = input;
        this.requestQueue = requestQueue;
        this.dataset = dataset;
        this.isRunning = false;
        this.pageManager = new PageManager(this);

        this.proxyConfiguration = this.input.proxyConfiguration;

        if (this.input.cookiesPersistence === COOKIES_PERSISTENCE.OVER_CRAWLER_RUNS
            && !process.env.APIFY_ACTOR_TASK_ID) {
            throw new Error('The "cookiesPersistence" setting of "OVER_CRAWLER_RUNS" can only be used when actor is run via an actor task.');
        }

        // WORKAROUND: On 2016-08-19 we changed semantics of "clickableElementsSelector" field.
        // Now if it's empty then no elements will be clicked. Previously, empty value meant the
        // default selector "a:not([rel=nofollow]), input, button, [onclick]:not([rel=nofollow])" was used.
        // We could change this in the crawler's PhantomJS code, but this is easier...
        if (!this.input.clickableElementsSelector) {
            this.input.clickableElementsSelector = 'DONT_CLICK_ANYTHING';
        }

        // Convert legacy proxy input settings to new proxyConfiguration object.
        // Note that new proxyConfiguration has priority over the legacy settings.
        if (!this.proxyConfiguration) {
            // Backwards compatibility for super-old API calls where you could send just proxy groups and not proxyType
            if (this.input.proxyGroups && this.input.proxyGroups.length && !this.input.proxyType) {
                this.input.proxyType = 'SELECTED_PROXY_GROUPS';
            }
            switch (this.input.proxyType) {
                case 'AUTO':
                    this.proxyConfiguration = {
                        useApifyProxy: true,
                        apifyProxyGroups: null,
                        proxyUrls: null,
                    };
                    break;
                case 'SELECTED_PROXY_GROUPS':
                    this.proxyConfiguration = {
                        useApifyProxy: true,
                        apifyProxyGroups: _.without(this.input.proxyGroups, CUSTOM_PROXY_GROUP_ID, DEFAULT_PROXY_GROUP_ID),
                        proxyUrls: null,
                    };
                    break;
                case 'CUSTOM':
                    this.proxyConfiguration = {
                        useApifyProxy: false,
                        apifyProxyGroups: null,
                        proxyUrls: this.input.customProxies && _.isString(this.input.customProxies)
                            ? this.input.customProxies.trim().split(/\s+/)
                            : null,
                    };
                    break;
                case 'NONE':
                default:
                    // No legacy proxy settings
                    break;
            }
        }

        // Filter provided custom URLs and only store valid ones.
        // Keep null if custom proxies are not used.
        this.customProxyUrls = null;
        if (this.proxyConfiguration && !this.proxyConfiguration.useApifyProxy && this.proxyConfiguration.proxyUrls) {
            this.customProxyUrls = utils.filterProxyUrls(this.proxyConfiguration.proxyUrls);
        }

        if (this.proxyConfiguration && this.proxyConfiguration.useApifyProxy && !process.env.APIFY_PROXY_PASSWORD) {
            throw new Error('To use Apify Proxy, the APIFY_PROXY_PASSWORD environment variable must be set.');
        }

        // to generate unique slave IDs
        this.nextSlaveId = INITIAL_SLAVE_ID;

        // A dictionary where key is slave.id, value is a Slave instance
        this.slaves = {};

        // HTTP server handling requests from slaves
        this.httpServer = http.createServer();

        // Express routes for the HTTP server
        this.app = express();
        this.app.use(bodyParser.json({ limit: '15mb' }));
        this.app.post('/slave/:slaveId', this._enqueueTaskFromSlave.bind(this));
        this.app.all('*', utils.http404Route);
        this.app.use((err, req, res, next) => {
            log.warning(`${LOG_PREFIX}Client HTTP request failed`, { url: req.url, errMsg: err.message });
            if (res.headersSent) return next(err);
            res.status(505);
            res.send(`Internal server error: ${err.message}`);
        });
        this.httpServer.on('request', this.app);

        // queue of HTTP requests from all slaves, they are handled one-by-one so that one crawl cannot overload the DynamoDB capacity
        this.tasksFromSlaves = new LinkedList();

        // a TCP port on which the server listens (if started)
        this.port = null;

        // indicates that bootstrapper slave process finished successfully
        this.isBootstrapFinished = false;

        // number of slaves that already exited
        this.exitedSlavesCount = 0;

        // return value of setInterval() for _executorHeartbeat function,
        // or null if heart beat wasn't started or was already stopped
        // TODO: Cancel this on stop/finish/abort
        this.heartbeatIntervalId = null;

        // temporary directory which is the CWD of the crawler,
        // and a callback that can be used to delete it (incl. all files in it!)
        this.tempDirPath = null;

        // path to generated config file in temporary directory
        this.configPath = null;

        // path to cookies.json from the crawl
        this.cookiesPath = null;

        // Copy of cookies from the cookies.json that should were persisted by the crawler
        this.persistedCookies = null;

        this.autoscaledPoolOptions = {
            minConcurrency: 1,
            maxConcurrency: input.maxParallelRequests || DEFAULT_MAX_CONCURRENCY,
            runTaskFunction: this._runTaskFunction.bind(this),
            isTaskReadyFunction: async () => {
                // During bootstrapping, the queue is empty, but we still need to run a task
                const { isBootstrapperAlive } = this.probeSlaves();
                if (!isBootstrapperAlive && !this.isBootstrapFinished) return true;

                // If RequestQueue is not empty, then some task is ready are return true, otherwise false.
                const isEmpty = await this.requestQueue.isEmpty();
                return !isEmpty;
            },
            isFinishedFunction: async () => {
                if (!this.isBootstrapFinished) return false;

                const isFinished = await this.requestQueue.isFinished();
                if (isFinished) {
                    log.info(`${LOG_PREFIX}Shutting down the crawler: The request queue is empty`);
                }

                return isFinished;
            },
        };

        this.autoscaledPool = new Apify.AutoscaledPool(this.autoscaledPoolOptions);

        this.liveViewServer = new LiveViewServer();
    }

    /**
     * Runs the crawler. Returns a promise that gets resolved once all the requests are processed.
     *
     * @return {Promise}
     */
    async run() {
        if (this.isRunning) throw new Error('Crawler is already running');
        this.isRunning = true;

        // TODO: A lot of things here can be done in parallel for speedup

        await this.pageManager.initialize();

        await this.liveViewServer.start();

        const state = await Apify.getValue(STATE_KEY);
        if (state) {
            this.isBootstrapFinished = state.isBootstrapFinished;
            this.persistedCookies = state.persistedCookies;
        }

        // Start HTTP server
        await utils.promisifyServerListen(this.httpServer)();
        const addr = this.httpServer.address();
        this.port = addr.port;
        log.debug(`${LOG_PREFIX}Started HTTP server`, { serverUrl: `http://localhost:${addr.port}` });

        // Create temporary dir where all files will be stored (don't delete it for easier debugging)
        this.tempDirPath = await util.promisify(tmp.dir)({ keep: true });
        this.configPath = path.join(this.tempDirPath, 'config.json');
        this.cookiesPath = path.join(this.tempDirPath, 'cookies.json');
        log.debug(`${LOG_PREFIX}Created temporary directory`, { tempDirPath: this.tempDirPath });

        // Write crawler configuration to file
        const config = inputToConfig(this.input);
        await writeFilePromised(this.configPath, JSON.stringify(config, null, 2));

        // Generate cookies.json file, either from persistent cookies (after migration or actor restart), or from input
        const cookies = this.persistedCookies || this.input.cookies;
        if (cookies) {
            log.debug('Loading cookies', { cookiesCount: cookies.length });
            const cookiesJson = JSON.stringify(cookies, null, 2);
            await writeFilePromised(this.cookiesPath, cookiesJson);
        }

        // Let the heart beat
        this.heartbeatIntervalId = setInterval(
            this._executorHeartbeat.bind(this),
            DEFAULT_EXECUTOR_HEARTBEAT_MILLIS,
        );

        log.debug(`${LOG_PREFIX}Starting auto-scaled pool`);

        // Adjust AutoscaledPool's desiredConcurrency to speed up the start of crawling
        const memInfo = await Apify.getMemoryInfo();
        const min = this.autoscaledPool.minConcurrency;
        const max = this.autoscaledPool.maxConcurrency;
        const desired = Math.max(Math.min(Math.floor(memInfo.freeBytes / PHANTOMJS_PROCESS_ESTIMATED_MEMORY_BYTES), max), min);
        this.autoscaledPool.desiredConcurrency = desired;
        log.info('Adjusted initial concurrency of the autoscaled pool', { min, max, desired, freeMbytes: Math.round(memInfo.freeBytes / (10 ** 6)) });

        // Attach a listener to handle migration events gracefully.
        Apify.events.on(ACTOR_EVENT_NAMES.MIGRATING, this._pauseOnMigration.bind(this));

        await this.autoscaledPool.run();

        this.isRunning = false;

        // Kill leftover slaves
        _.each(this.slaves, (slave) => {
            slave.childProcess.kill('SIGKILL');
        });
    }

    async _pauseOnMigration() {
        await this.autoscaledPool.pause(SAFE_MIGRATION_WAIT_MILLIS)
            .catch(() => {
                log.error(`${LOG_PREFIX}The crawler was paused due to migration to another host, but some requests did not finish in time. Those requests' results may be duplicated.`);
            });
    }

    /**
     * Determines the number of slaves and whether the bootstrapping slave is alive.
     * Also, the function checks whether the crawler didn't enter infinite restart-bootstrap loop
     */
    probeSlaves() {
        // Figure out whether whether the bootstrapping Phantom process is alive
        let isBootstrapperAlive = false;
        let slaveCount = 0;
        let minSlaveId = 999999999999;
        _.each(this.slaves, (slave) => {
            isBootstrapperAlive = isBootstrapperAlive || slave.isBootstrapper;
            slaveCount++;
            minSlaveId = Math.min(slave.id, minSlaveId);
        });

        // Check that bootstrapping didn't enter infinite loop
        // (happens also if there's some problem with configuration, e.g. startUrls are empty)
        if (slaveCount === 0 && !this.isBootstrapFinished && this.exitedSlavesCount >= MAX_BOOTSTRAP_ATTEMPTS) {
            // TODO: How to ensure the crawler will not be restarted by platform? Apify.fail() would be great
            this.fatalError(null, 'Crawl could not be bootstrapped, giving up', { attempts: MAX_BOOTSTRAP_ATTEMPTS });
        }

        if (slaveCount === 0) minSlaveId = null;

        return { isBootstrapperAlive, slaveCount, minSlaveId };
    }

    /**
     * Called by auto-scaling pool if there is enough system resources.
     * It spawns a new PhantomJS process and waits for it to finish.
     */
    async _runTaskFunction() {
        try {
            const { isBootstrapperAlive, slaveCount } = this.probeSlaves();

            // If bootstrapper slave process died before all startUrls were added to queue, restart it
            const isBootstrapper = !isBootstrapperAlive && !this.isBootstrapFinished;
            const slave = this._spawnSlave(isBootstrapper);
            if (!slave) return;

            const { childProcess } = slave;

            // Forward standard output and error to actor's stdout/stderr
            childProcess.stdout.on('data', (data) => {
                // Data might be a Buffer instance!
                if (typeof data !== 'string') data = `${data}`;
                // All stdout messages should come from log.info() and hence are prefixed with time
                // remove trailing newlines
                data = data.trim();
                // WORKAROUND: sometimes newlines become '\r\r\n', which looks bad in log
                data = data.replace(/(\r)*(\n)(\r)*/g, '\n');
                console.log(data);
            });
            childProcess.stderr.on('data', (data) => {
                // Data might be a Buffer instance!
                if (typeof data !== 'string') data = `${data}`;
                // Our code doesn't produce stderr output, so surely this needs to be prefixed
                // (note sure this is useful for anything, PhantomJS crash doesn't write info to stderr...)
                // WORKAROUND: sometimes newlines become '\r\r\n', which looks bad in log
                data = data.replace(/(\r)*(\n)(\r)*/g, '\n');
                console.log(`${generateLogPrefix(slave.id)}: ERROR: ${data}`);
            });

            // Wait for the child process to exit
            const { exitCode, signal } = await new Promise((resolve) => {
                let wasExitHandlerCalled = false;

                const exitHandler = function (exitCode, signal) {
                    // Sometimes on 'error' the 'exit' event is not called, keeping the slaves respawning infinitely,
                    // so we forcibly call 'exit' on 'error', but make sure the handler is not called twice
                    if (wasExitHandlerCalled) return;
                    wasExitHandlerCalled = true;
                    resolve({ exitCode, signal });
                };

                // We must always handle the error, otherwise it would terminate the whole process
                childProcess.on('error', (err) => {
                    log.exception(err, `${LOG_PREFIX}Slave process failed`, { slaveId: slave.id, fullCmd: slave.fullCmd });
                    exitHandler(99, null);
                });

                childProcess.on('exit', exitHandler);
            });

            log.info('Slave exited', { slaveId: slave.id, pid: slave.pid, code: exitCode, signal: signal });

            slave.isExited = true;
            delete this.slaves[slave.id];
            this.exitedSlavesCount++;

            const request = slave.lastFetchedRequest;
            if (request && this.isRunning) {
                // apparently PhantomJS crashed, keep track how many times it happened for this request,
                // retry the request few times and then give up on it
                request._crashesCount = (request._crashesCount | 0) + 1;
                if (request._crashesCount < MAX_CRASHES_PER_REQUEST) {
                    await this.pageManager.reclaimRequest(request, slave.id);
                } else {
                    request.errorInfo += `Crawler crashed ${MAX_CRASHES_PER_REQUEST} times while processing the page, giving up.\n`;
                    delete request._crashesCount;
                    request._pageCrashed = true;
                    await this.pageManager.markRequestHandled(request, slave.id);
                }
            }

            // Adjust the OOM killer score for PhantomJS processes, so they are the first ones
            // to get killed when the system is running out of memory
            // const score = this.workerServer.config.adjustPhantomOomScore;
            // if (score) {
            //    // TODO: this fails with EACCESS !!!!
            //    fs.writeFile(`/proc/${slave.pid}/oom_score_adj`, `${score}`, (err) => {
            //        if (err) log.exception(err, 'Failed to adjust OOM killer score');
            //    });
            // }
        } catch (e) {
            this.fatalError(e);
        }
    }

    /**
     * Invoked by the web server whenever there's an incoming HTTP request from one of the slave PhantomJS processes.
     * It only enqueues the request so that it can be handle by _handleNextTaskFromSlave() function.
     * @private
     */
    _enqueueTaskFromSlave(httpRequest, httpResponse) {
        try {
            if (!this.isRunning) return;

            // The whole point of queuing HTTP requests from slaves is to throttle crawls if the the DynamoDB write capacity is exceeded.
            // Multiple slaves can send multiple messages with piggybackBufferedRequests at the same time
            // and quickly overload the DynamoDB capacity. Therefore we handle the requests one-by-one, if request takes too long
            // to be handled then it timeouts, the corresponding phantomjs process dies and crawl slows down even more.

            // analyze the message
            const slaveId = parseInt(httpRequest.params.slaveId, 10);
            const message = httpRequest.body;
            if (typeof slaveId !== 'number' || !message || !message.messageType) {
                log.warning(`${LOG_PREFIX}Request from slave is not valid`, { message: utils.truncate(JSON.stringify(message, 1000)) });
                httpResponse.end();
                return;
            }

            // NOTE: we need to assign slave here, because it might exit before the message is processed,
            // in which case the message would be discarded and all the slave's work lost
            const slave = this.slaves[slaveId];
            if (!slave) {
                log.warning(`${LOG_PREFIX}Received request from unknown slave`, {
                    slaveId,
                    messageType: message.messageType
                });
                httpResponse.end();
                return;
            }

            log.debug(`${LOG_PREFIX}Received message from slave`, {
                url: httpRequest.url,
                messageType: message.messageType
            });
            slave.lastMessageAt = new Date();

            const task = {
                slave,
                message,
                httpResponse,
            };
            this.tasksFromSlaves.add(task);

            if (this.tasksFromSlaves.length === 1) {
                this._handleNextTaskFromSlave().catch(this.fatalError);
            }
        } catch (e) {
            this.fatalError(e);
        }
    };


    /**
     * Handles next HTTP request from slave.
     * @private
     */
    async _handleNextTaskFromSlave() {
        // Ignore any delayed messages, slave process will be killed soon anyway and web server closed
        if (!this.isRunning) return;

        const task = this.tasksFromSlaves.head.data;
        if (!task) throw new Error('There is no task to handle?!');

        const { message, slave } = task;
        const responseMessage = {};
        let request; // this is the Request object from crawler, not HTTP request from Node.js!

        const softFail = (msg) => {
            log.softFail('Server failed to handle a request from slave', {
                msg,
                slaveId: slave.id,
                messageType: message ? message.messageType : null,
                request: _.pick(request, 'id', 'url'),
            });
            try {
                task.httpResponse.writeHead(500);
                task.httpResponse.end('Internal server error');
            } catch (e) {
                // This one can be ignored
                log.exception(e);
            }
        };

        // Check the piggybacked requests and store them to requestManager
        if (message.piggybackBufferedRequests) {
            if (!_.isArray(message.piggybackBufferedRequests)) {
                return softFail("The 'piggybackBufferedRequests' field must be an array.");
            }
            const requestsToAdd = [];
            for (let i = 0; i < message.piggybackBufferedRequests.length; i++) {
                request = message.piggybackBufferedRequests[i];
                log.debug('Add new request', { request });
                if (!request) {
                    return softFail(`Some request in 'piggybackBufferedRequests' array is undefined (index: ${i}).`);
                }
                if (!utils.isNullOrUndefined(request.id)) {
                    return softFail(`Some request in 'piggybackBufferedRequests' defines 'id' property; that is an error (index: ${i}, id: '${request.id}').`);
                }
                if (!utils.isNullOrUndefined(request.referrer)) {
                    return softFail(`Some request in 'piggybackBufferedRequests' defines 'referrer' property; that is an error (index: ${i}, referrer.id: ${request.referrer.id}).`);
                }

                // if the slave is still bootstrapping...
                if (slave.isBootstrapper && !this.isBootstrapFinished) {
                    // ...then the request must be one of the bootstrap requests without any referrer
                    if (slave.lastFetchedRequest) {
                        return softFail('Internal error (code 1)');
                    }
                    if (!utils.isNullOrUndefined(request.referrerId)) {
                        return softFail(`Some request in 'piggybackBufferedRequests' from bootsrapper defines referrerId (index: ${i}, referrerId: '${request.referrerId}').`);
                    }
                } else {
                    // ...otherwise the referring request must be the request last fetched by the slave!
                    if (!slave.lastFetchedRequest) {
                        return softFail('Internal error (code 2)');
                    }
                    if (request.referrerId !== slave.lastFetchedRequest.id) {
                        return softFail(`Some request in 'piggybackBufferedRequests' has invalid 'referrerId' property (index: ${i}, referrerId: ${request.referrerId}, lastFetchedRequest.id: ${slave.lastFetchedRequest.id}).`);
                    }
                }

                this.pageManager.fixLegacyRequestFromJson(request);
                requestsToAdd.push(request);
            }

            // Don't fetch next request until all new ones have been stored.
            // Add requests sequentially to avoid overloading the API
            for (const requestToAdd of requestsToAdd) {
                if (!this.isRunning) return;
                await this.pageManager.addNewPageRequest(requestToAdd, slave.id);
            }
        }

        if (!this.isRunning) return;

        // Process the message
        switch (message.messageType) {
            case 'fetchNextRequest':
                // if bootstrapping slave sent a 'fetchNextRequest' message, it means
                // that all startUrls were already requested and thus bootstrapping is finished
                if (slave.isBootstrapper && !this.isBootstrapFinished) {
                    log.debug(`${LOG_PREFIX}Bootstrapping is finished (the bootstrapping slave process invoked 'fetchNextRequest')`);
                    this.isBootstrapFinished = true;

                    // Persist info that bootstrapping finished
                    await this._persistState();

                    // TODO: maybe we should send some signal to AutoscaledPool to run its heartbeat
                    // to spawn the slaves ASAP
                }

                if (slave.isExited) break;

                const result = await this.pageManager.fetchNextRequest(slave.id);

                // Save proxy used for the request (it might be used from page function)
                if (result.request) {
                    result.request.proxy = slave.proxy;
                }

                responseMessage.request = result.request;
                responseMessage.statusMessage = result.statusMessage;
                slave.lastFetchedRequest = result.request;
                // Slave might have exited in the meantime, ensure the fetched request will be handled by someone else!
                if (slave.isExited && result.request) {
                    await this.pageManager.reclaimRequest(result.request);
                }
                break;

            /* eslint-disable no-case-declarations */
            case 'markRequestHandled':
                // eslint-disable-next-line prefer-destructuring
                request = message.request;
                if (!request) {
                    return softFail("A 'markRequestHandled' message does not contain 'request' field.");
                }
                if (!slave.lastFetchedRequest || slave.lastFetchedRequest.id !== request.id) {
                    return softFail(`A 'markRequestHandled' message does not refer to the last fetched request (request.id: ${request.id}, lastFetchedRequest.id: ${slave.lastFetchedRequest ? slave.lastFetchedRequest.id : 'N/A'}).`);
                }
                if (request.referrer) {
                    return softFail("The request defines the 'referrer' property; this is an error.");
                }

                this.pageManager.fixLegacyRequestFromJson(request);

                // If the page load failed, retry it a few times and then give up
                // (don't update the request in database with data from crawler!)
                let errorInfoSuffix = null;
                if (request.loadErrorCode > 0 && this.input.maxPageRetryCount > 0) {
                    slave.lastFetchedRequest._retryCount |= 0;
                    if (slave.lastFetchedRequest._retryCount < this.input.maxPageRetryCount) {
                        slave.lastFetchedRequest._retryCount++;
                        log.info('Page load failed, it will be tried again later', {
                            requestId: slave.lastFetchedRequest.id,
                            retryCount: slave.lastFetchedRequest._retryCount,
                            maxPageRetryCount: this.input.maxPageRetryCount,
                        });
                        await this.pageManager.reclaimRequest(slave.lastFetchedRequest, slave.id);
                        slave.lastFetchedRequest = null;
                        break;
                    }
                    log.warning('Page load failed too many times, giving up', {
                        requestId: request.id,
                        retryCount: slave.lastFetchedRequest._retryCount,
                    });
                    errorInfoSuffix = `\nPage load failed ${slave.lastFetchedRequest._retryCount + 1} times, giving up.`;
                }

                // only copy request fields that can be modified by slave between 'fetchNextRequest' and 'markRequestHandled' states !
                AFTER_LOAD_UPDATABLE_REQUEST_FIELDS.forEach((field) => {
                    slave.lastFetchedRequest[field] = request[field];
                });
                request = slave.lastFetchedRequest;
                slave.lastFetchedRequest = null;
                if (errorInfoSuffix) {
                    request.errorInfo += errorInfoSuffix;
                    request._pageFailed = true;
                }

                // Mark the request as handled
                await this.pageManager.markRequestHandled(request, slave.id);
                break;

            case 'saveSnapshot':
                // Crawler captured a screenshot to a file
                if (typeof message.screenshotFilename !== 'string') {
                    return softFail("A 'saveSnapshot' message doesn't contain valid 'screenshotFilename' field.");
                }
                if (typeof message.htmlContent !== 'string') {
                    return softFail("A 'saveSnapshot' message doesn't contain valid 'htmlContent' field.");
                }
                if (!utils.isNullOrUndefined(message.pageUrl) && typeof message.pageUrl !== 'string') {
                    return softFail("A 'saveSnapshot' message doesn't contain valid 'pageUrl' field.");
                }
                log.debug('Received crawler snapshots in files', { screenshot: message.screenshotFilename, html: message.htmlFilename });
                const screenshotFilePath = path.join(this.tempDirPath, message.screenshotFilename);

                await this.liveViewServer.pushSnapshot(screenshotFilePath, message.htmlContent, message.pageUrl);
                break;

            case 'dummy':
                // This message type is used when only passing piggybackBufferedRequests or for periodic pings
                break;

            case 'saveCookies':
                const { cookies } = message;
                const cookiesJson = JSON.stringify(cookies, null, 2);
                const tmpFile = `${this.cookiesPath}_tmp_${Math.random().toString(36).slice(2)}`;

                log.info('Overriding cookies', { cookiesCount: cookies.length });

                // TODO: These operations can be done in parallel

                // Update cookie file (using rename to be atomic).
                await writeFilePromised(tmpFile, cookiesJson);
                await renamePromised(tmpFile, this.cookiesPath);

                // Save cookies to actor task
                if (this.input.cookiesPersistence === COOKIES_PERSISTENCE.OVER_CRAWLER_RUNS) {
                    await Apify.client.tasks.updateTask({
                        taskId: process.env.APIFY_ACTOR_TASK_ID,
                        task: {
                            cookies,
                        },
                    });
                }

                // Save cookies to state, so they are reused on actor run migration
                if (this.input.cookiesPersistence === COOKIES_PERSISTENCE.OVER_CRAWLER_RUNS
                    || this.input.cookiesPersistence === COOKIES_PERSISTENCE.PER_CRAWLER_RUN) {
                    this.persistedCookies = cookies;
                    await this._persistState();
                }

                break;

            /* eslint-enable no-case-declarations */
            default:
                return softFail(`An unknown message type received ('${message.messageType}')`);
        }

        if (!this.isRunning || slave.isExited) {
            // If crawler shut down or slave exited in the meantime, don't bother with response
            task.httpResponse.end();
        } else {
            // Tell crawler whether we want the screenshots or not.
            // We're only doing screenshots in the slave with the lowest slave ID, to avoid overheads in highly parallel crawlers
            const { minSlaveId } = this.probeSlaves();
            responseMessage.shouldSaveSnapshots = slave.id === minSlaveId && this.liveViewServer.hasClients();

            responseMessage.verboseLog = this.input.verboseLog;

            task.httpResponse.writeHead(200, {
                Cache: 'no-cache',
                'Content-Type': 'application/json; charset=utf-8',
                Connection: 'keep-alive',
                'Keep-Alive': 'timeout=20, max=100',
            });
            task.httpResponse.end(JSON.stringify(responseMessage));
        }

        // Handle next task
        if (this.tasksFromSlaves.removeFirst() !== task) {
            throw new Error('Somebody else removed the first task?!');
        }
        if (this.tasksFromSlaves.length > 0) {
            // Handle next task in a new tick
            setTimeout(() => {
                this._handleNextTaskFromSlave().catch(this.fatalError);
            }, 0);
        }
    }

    /**
     * Persist info that bootstrapping finished
     * @private
     */
    async _persistState() {
        await Apify.setValue(STATE_KEY, {
            isBootstrapFinished: this.isBootstrapFinished,
            persistedCookies: this.persistedCookies,
        });
    }

    /**
     * This function is called periodically to kill unresponsive slaves
     * and to check whether bootstrapping didn't enter infinite loop.
     * @private
     */
    _executorHeartbeat() {
        try {
            // log.debug(`${LOG_PREFIX}_executorHeartbeat() called`);

            // If terminating, ignore delayed invocations
            if (!this.isRunning) return;

            // Check that bootstrapping didn't enter infinite loop
            this.probeSlaves();

            // Kill non-responsive slaves
            const now = Date.now();
            _.each(this.slaves, (slave, slaveId) => {
                if (slave.lastMessageAt.getTime() + NON_RESPONSIVE_SLAVE_MIN_MILLIS < now) {
                    log.info(`${LOG_PREFIX}Slave process is non-responsive, killing it`, {
                        slaveId,
                        pid: slave.childProcess.pid,
                        lastMessageAt: slave.lastMessageAt,
                    });
                    slave.childProcess.kill('SIGKILL');
                    delete this.slaves[slaveId];
                    slave.isExited = true;
                }
            });
        } catch (e) {
            this.fatalError(e);
        }
    };


    /**
     * Spawns a new slave process and saves a reference to it into our internal records.
     * Returns the newly created `Slave` instance, or null if the new process was spawned in an invalid state.
     * @param isBootstrapper
     * @private
     */
    _spawnSlave(isBootstrapper) {
        // Start the slave process
        const slaveId = this.nextSlaveId++;
        const serverUrl = `http://localhost:${this.port}/slave/${slaveId}`;
        let cmd = PHANTOMJS_COMMAND;
        const args = [];
        if (process.platform !== 'win32') {
            // on Linux/Mac, start the phantomjs processes with the lowest priority, so they don't choke the system
            cmd = 'nice';
            args.push('-n');
            args.push(`${PHANTOMJS_SCHEDULING_PRIORITY - 20}`);
            args.push(PHANTOMJS_COMMAND);
            // moreover, on Mac https pages always fails with "SSL handshake failed", so use this flag to avoid it
            if (process.platform === 'darwin') {
                args.push('--ignore-ssl-errors=true');
            }
        }
        // Enable cross-domain XHR requests
        // NOTE: this setting is on a flag, because it might affect normal behaviour of web pages
        if (this.input.disableWebSecurity) {
            args.push('--web-security=false');
            args.push('--ignore-ssl-errors=true');
        }

        // Prevent access to file:// and qrc:// protocols
        args.push('--local-url-access=false');

        // Pick proxy and add corresponding arguments to PhantomJS process
        let proxyUrl = null;
        let proxyPhantomjsArgs = null;
        let proxyPublicInfo = null;
        if (this.proxyConfiguration && this.proxyConfiguration.useApifyProxy) {
            // Using Apify Proxy
            let username;
            if (this.proxyConfiguration.apifyProxyGroups && this.proxyConfiguration.apifyProxyGroups.length > 0) {
                // Selected proxy groups
                username = `groups-${this.proxyConfiguration.apifyProxyGroups.join(',')},session-${_.random(9999999999)}`;
            } else {
                // Automatic mode
                username = `session-${_.random(9999999999)}`;
            }
            proxyUrl = `http://${username}:${process.env.APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`;
            proxyPhantomjsArgs = utils.proxyUrlToPhantomArgs(proxyUrl);
            proxyPublicInfo = utils.canonicalizeProxyUrl(proxyUrl, username);
        } else if (this.customProxyUrls && this.customProxyUrls.length > 0) {
            // Using custom proxies
            proxyUrl = this.customProxyUrls[(slaveId - INITIAL_SLAVE_ID) % this.customProxyUrls.length];
            proxyPhantomjsArgs = utils.proxyUrlToPhantomArgs(proxyUrl);
            proxyPublicInfo = utils.canonicalizeProxyUrl(proxyUrl, '<REDACTED>');
        }
        _.each(proxyPhantomjsArgs, (arg) => args.push(arg));

        args.push(slaveScriptPath);
        args.push(this.configPath);
        args.push(serverUrl, generateLogPrefix(slaveId));
        if (isBootstrapper) {
            args.push('--bootstrap');
        }
        args.push(`--cookies=${this.cookiesPath}`);

        if (this.input.verboseLog) {
            args.push('--dbg');
        }

        // NOTE: Unfortunately, in PhantomJS there's no way to determine whether a child process actually started.
        //       If it didn't and we try to access its 'pid' property, our own process will crash.
        //       The best thing we can do is to log what we were doing before the crash happens...
        let fullCmd = `${cmd} ${args.join(' ')}`;
        // Remove proxy password from the log message !!!
        // eslint-disable-next-line no-useless-escape
        fullCmd = fullCmd.replace(/(--proxy-auth=[^\s:]+):([^\s]+)/g, '$1:<REDACTED>');

        log.debug(`PhantomCrawler: Spawning slave process`, { slaveId, fullCmd });
        const options = {
            cwd: this.tempDirPath,
            // For security, only pass a few selected environment variables to PhantomJS
            env: _.pick(process.env, 'HOME', 'HOSTNAME', 'OLDPWD', 'LANG', 'PATH', 'SHELL', 'SHLVL', 'TERM'),
        };
        const childProcess = spawn(cmd, args, options);

        // It happened that these were undefineds
        if (!childProcess.stdout || !childProcess.stderr) {
            log.warning(`${LOG_PREFIX}Child process' stdout or stderr is undefined! (will try again later)`, { pid: childProcess.pid, slaveId });
            childProcess.kill('SIGKILL');
            return null;
        }

        // save the record before attaching process handlers!
        const slave = new Slave(slaveId, childProcess, isBootstrapper);
        this.slaves[slaveId] = slave;
        slave.proxy = proxyPublicInfo;
        slave.fullCmd = fullCmd;

        // log.debug('PhantomCrawler: Slave process spawned', { slaveId, pid: slave.pid });

        return slave;
    };


    fatalError(exception, message, data) {
        log.exception(exception, `${LOG_PREFIX}${message || 'Unhandled exception'}`, data);
        process.exit(1);
    }
}

module.exports = PhantomCrawler;
