/*!
 * This module defines the PageQueue class, which represents
 * a data structure to store and search web page requests.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014-2015 Apifier. All rights reserved.
 *
 */
"use strict";

/*global phantom, exports*/

// TODO: rename this class to 'requestmanagers'

require('./polyfills');
var utils          = require('./utils');
var constants      = require('./constants');
var linkedList     = require('./linkedlist');
var listDictionary = require('./listdictionary');


/** Returns a new instance of the Request class. */
exports.createRequest = function createRequest() {
	"use strict";
	return new Request();
};

/** Returns a new instance of the LocalRequestManager class. */
exports.createLocalRequestManager = function createLocalRequestManager(config, outputJsonStream) {
	"use strict";
	return new LocalRequestManager(config, outputJsonStream);
};

/** Returns a new instance of the RemoteRequestManager class. */
exports.createRemoteRequestManager = function createRemoteRequestManager(config, masterServerUrl) {
	"use strict";
	return new RemoteRequestManager(config, masterServerUrl);
};

/**
 * Defines which properties of Request object can be modified by a user-provided 'interceptRequest' function.
 */
exports.INTERCEPTABLE_REQUEST_FIELDS =
	['url', 'uniqueKey', 'label', 'willLoad', 'matchesSearchArea', 'matchesTargetPage', 'interceptRequestData',
     'method', 'postData', 'contentType', 'queuePosition'];

/**
 * Defines which properties of Request object are taken into account by the context.enqueuePage() function.
 */
exports.ENQUEUE_PAGE_FIELDS =
    ['url', 'uniqueKey', 'label', 'method', 'postData', 'contentType', 'queuePosition', 'interceptRequestData'];


/**
 * Defines which properties of Request object are modified since the request's page is loaded
 * in browser and its content analysed.
 * WARNING: if you change it here, also change it in ../src/worker/page_manager.js !!!!!!!!!!!!!!!!
 */
exports.AFTER_LOAD_UPDATABLE_REQUEST_FIELDS =
	['loadingStartedAt', 'loadedUrl', 'loadingFinishedAt', 'loadErrorCode', 'pageFunctionStartedAt', 'pageFunctionFinishedAt',
	 'pageFunctionResult', 'errorInfo', 'downloadedBytes', '_skipOutput', 'responseStatus', 'responseHeaders'];


/**
  * Represents a single web page request.
  */
function Request() {
	"use strict";

	// NOTE: these fields are present in web documentation, keep them in sync!

	// An auto-incremented ID
	this.id = null;

	// The URL that was specified in the web page's navigation request,
	// possibly updated by the 'interceptRequest' function
	this.url = null;

	// The final URL reported by the browser after the page was opened
	// (will be different from 'url' if there was a redirect)
	this.loadedUrl = null;

	// Date and time of the original web page's navigation request
	this.requestedAt = null;
	// Date and time when the page load was initiated in the web browser, or null if it wasn't
	this.loadingStartedAt = null;
	// Date and time when the page was actually loaded, or null if it wasn't
	this.loadingFinishedAt = null;

	// If the page couldn't be loaded for any reason (e.g. on timeout), this field contains a best guess of
	// the code of the error. The value is either one of the codes from
	// http://doc.qt.io/qt-4.8/qnetworkreply.html#NetworkError-enum or value 999 for an unknown error.
	// This field is used internally to retry failed page loads.
	this.loadErrorCode = null;

	// Date and time when the page function started and finished
	this.pageFunctionStartedAt = null;
	this.pageFunctionFinishedAt = null;

	// A unique key under which this request can be found in the crawling queue,
	// by default it equals to URL stripped of the hashtag part (unless considerUrlFragment config setting was enabled),
	// it can also be modified by the 'interceptRequest' function
	this.uniqueKey = null;

	// Describes the type of the request. It can be either one of the following values:
	// 'InitialAboutBlank', 'StartUrl', 'SingleUrl', 'ActorRequest', 'OnUrlChanged', 'UserEnqueued', 'FoundLink'
	// or in case the request originates from PhantomJS' onNavigationRequested() it can be one of the following values:
	// 'Undefined', 'LinkClicked', 'FormSubmitted', 'BackOrForward', 'Reload', 'FormResubmitted', 'Other'
	this.type = null;

	// Boolean value indicating whether the page was opened in a main frame or a child frame
	this.isMainFrame = null;

	// HTTP POST data
	this.postData = null;

	// Content-Type HTTP header of the POST request
	this.contentType = null;

	// Contains "GET" or "POST"
	this.method = null;

	// Indicates whether the page will be loaded by the crawler or not
	this.willLoad = null;

	// Indicates the label specified in startUrls or crawlPurls config settings where URL/PURL corresponds
	// to this page request. If more labels are matching, this field contains the first one
	// in order from startUrls to crawlPurls, in order in which the labels appear in those arrays.
	// Note that labels are not mandatory, so the field might be null.
	this.label = null;

	// ID of the Request object from whose page this Request was first initiated, or null.
	this.referrerId = null;

	// Contains the Request object corresponding to 'referrerId'.
	// This value is only available in pageFunction and interceptRequest functions
	// and can be used to access properties and page function results of pages linking to the current page.
	// Note that this object can also recursively define a 'referrer' property, which can also define a 'referrer' property, etc.
	// The depth of such a recursion is limited to 10 (see MAX_REFERRER_REQUEST_DEPTH constant).
	this.referrer = null;

	// How many links away from start URLs was this page found
	this.depth = null;

	// If the page handling failed, this field will receive the error info.
	// do always append to this field and suffix your string with "\n".
	// an empty string means no error!
	this.errorInfo = "";

	// Results of the user-provided 'pageFunction'
	this.pageFunctionResult = null;

	// A field that might be used by 'interceptRequest' function to save custom data related to this page request
	// TODO: will this be propagated from second request for the same page???
	this.interceptRequestData = null;

	// Total size of all resources downloaded during this request
	this.downloadedBytes = 0;

    // Indicates the position where the request will be placed in the crawling queue.
    // Can either be 'LAST' to put the request to the end of the queue (default behavior)
    // or 'FIRST' to put it before any other requests.
    // TODO: 'RANDOM' for random position (TODO: not yet implemented)
	this.queuePosition = 'LAST';

	// additionally, there might be internal fields that are not saved to JSON or database, such as:
	// _skipOutput ..... indicates that the pageFunction requested not to save the request to JSON or database
	// _crashesCount ... how many times PhantomJS crashed on this request, only used in src/worker/crawler_executor.js
	// _retryCount ..... how many times page load was retried on error
	// _stats .......... only passed from executor to slave, contains current ActExecution.stats
	// TODO: ... more than this

    // HTTP status and headers of the loaded page.
    // If there were any redirects, the status and headers correspond to the finally loaded page, not the intermediate responses.
    this.responseStatus = null;
    this.responseHeaders = null;
}

/**
 * This function computes the following Request fields: uniqueKey, willLoad and label,
 * and possibly matchesSearchArea/matchesTargetPage (for backwards compatibility).
 * Must be called before interceptRequest!
 */
Request.prototype.computeStuff = function computeStuff(crawlerConfig, label, uniqueKey) {
    var c = crawlerConfig;

    var url = this.url;

    // use uniqueKey provided by user in context.enqueuePage() or generate it from the URL
    if( typeof(uniqueKey)==='string' )
        this.uniqueKey = uniqueKey;
    else
        this.uniqueKey = utils.normalizeUrl(url, c.considerUrlFragment) || url || "";

    this.willLoad = false;
    this.label = label;

    // * start URL must be loaded always, even if it doesn't match any PURL or start URL
	// * single URL must be loaded always too, e.g. user might want to test pageFunction on a new page
	// * page was requested by user in the pageFunction(), so it will be loaded no matter what
    if( this.type === 'StartUrl'
		|| this.type === 'SingleUrl'
		|| this.type === 'UserEnqueued' )
        this.willLoad = true;

    // if label is not defined, try to find the FIRST!!! matching crawlPurls to fill it from (in specified order)
    for( var i = 0; i < c.crawlPurls.length && utils.isEmpty(this.label); i++ ) {
        if( c.crawlPurls[i].parsedPurl.matches(url) ) {
            this.willLoad = true;
            this.label = c.crawlPurls[i].label;
        }
    }

    // BACKWARD COMPATIBILITY: check whether URL matches the search area or a target page PURLs
    if( c.searchAreaPurlsParsed.length !== 0 || c.targetPagePurlsParsed.length !== 0 ) {
        this.matchesSearchArea = false;
        this.matchesTargetPage = false;
        for( var i = 0; i < c.searchAreaPurlsParsed.length; i++ )
            this.matchesSearchArea = this.matchesSearchArea || c.searchAreaPurlsParsed[i].matches(url);
        for( var i = 0; i < c.targetPagePurlsParsed.length; i++ )
            this.matchesTargetPage = this.matchesTargetPage || c.targetPagePurlsParsed[i].matches(url);
        if( this.matchesSearchArea || this.matchesTargetPage )
            this.willLoad = true;
    }
};


/**
 * Called by JSON.stringify() when serializing this object, it returns result of this.explicitToJSON(false).
 */
Request.prototype.toJSON = function toJSON() {
	// NOTE: the reason why we need to have two functions toJSON() and explicitToJSON() is that
	// JSON.stringify() passes some unknown arguments to toJSON(), which interfere with our
	// 'keepReferrers' argument. For example, this happens when serializing an array of Request objects.
	// Try this to see: utils.log("toJSON("+Array.prototype.slice.call(arguments, 0)+")", "debug");
	return this.explicitToJSON(false);
};

/**
 * Returns a clone of this object that can be stringified to JSON.
 * @param keepReferrers If true, the chain of referrers is preserved.
 * Otherwise, the 'referrer' property is not copied and it's replaced with 'referrerId' instead.
 * @returns {{}}
 */
Request.prototype.explicitToJSON = function explicitToJSON(keepReferrers, depth) {
	"use strict";

	// TODO: we might add parameter 'compress' to remove null fields, useful for HTTP communication...

	var copy = {};
	for( var property in this ) {
		copy[property] = this[property];
	}

	// avoid unnecessary (and potentially harmful) second call to explicitToJSON(),
	// for example if we are invoked as 'JSON.stringify(req.explicitToJSON())'
	delete copy.explicitToJSON;
	delete copy.toJSON;

	depth = depth|0;
	// keep referrerId present even if keepReferrers, because referrers are kept only till a specific depth
	// and we want to have referrerId available even if 'referrer' is null, so this is consistent
	copy.referrerId = this.referrer ? this.referrer.id : null;
	if( keepReferrers && depth < constants.MAX_REFERRER_REQUEST_DEPTH ) {
		// stringify a reference, but recursively ensure it can also be strinigified
		copy.referrer = this.referrer ? this.referrer.explicitToJSON(keepReferrers, depth+1) : null;
	} else {
		delete copy.referrer;
	}

	return copy;
};

/**
 * Prints a string like "{123:http://www.example.com}".
 * @returns {string}
 */
Request.prototype.toString = function toString() {
	return "{" + this.id + ":" + this.uniqueKey + "}";
};

/**
 * Attaches local Request functions to a request object that was deserialized from JSON,
 * and returns that object.
 * @param request
 */
exports.localizeFromJSON = function localizeFromJSON(request) {
	if( !utils.isNullOrUndefined(request)
		&& ((!request.toJSON || !request.explicitToJSON || !request.toString)) ) {
        request.computeStuff = Request.prototype.computeStuff.bind(request);
		request.toJSON = Request.prototype.toJSON.bind(request);
		request.explicitToJSON = Request.prototype.explicitToJSON.bind(request);
		request.toString = Request.prototype.toString.bind(request);
		// recursively localize referrers !
		if( request.referrer ) {
			this.localizeFromJSON(request.referrer);
		}
	}
	return request;
};

/**
 * An implementation of request manager that stores all requests locally in a list-dictionary
 * data structure and emits processed requests to a JSON output file.
 */
function LocalRequestManager(config, outputJsonStream) {
	"use strict";

	// crawler configuration
	this.config = config;

	// queued and handled requests,
	// in both lists, key is url, value is a Request object
	this.queuedRequests  = listDictionary.create();
	this.handledRequests = listDictionary.create();

	// a counter to generate unqiue request IDs
	this.lastRequestId = 0;

	// various statistics
	this.stats = {
		pagesInQueue: 0,
		pagesCrawled: 0,
		pagesOutputted: 0,
		pagesRetried: 0
	};

	// output JSON file stream to save processed requests
	this.outputJsonStream = outputJsonStream;

    // indicates that at least one request was written to output
    this.outputHasSomeRecords = false;

	// prepare the output JSON file
	if( outputJsonStream ) {
		outputJsonStream.write('[');
		outputJsonStream.flush();
	}
};


/**
 * Notifies the manager about a new page request.
 */
LocalRequestManager.prototype.addNewRequest = function addNewRequest(request) {
	"use strict";
	utils.log("LocalRequestManager.addNewRequest(): request=" + request, "debug");
	// check whether the requested page was already visited
	var existingRequest = this.handledRequests.get(request.uniqueKey);
	if( existingRequest ) {
		utils.log("LocalRequestManager.addNewRequest(): Page was already visited.", "debug");
	} else {
		existingRequest = this.queuedRequests.get(request.uniqueKey);
		if( existingRequest ) {
			utils.log("LocalRequestManager.addNewRequest(): Page is already in the queue.", "debug");
		} else {
			utils.log("Adding page to queue (url: "+request.url+", request: "+request+", label: "+JSON.stringify(request.label)+", queue len: "+this.queuedRequests.length()+").");
			// generate new ID
			request.id = ++this.lastRequestId;
			// add record
			this.queuedRequests.add(request.uniqueKey, request);
		}
	}
};


/**
 * Fetches a request from the queue and invokes a user callback.
 * @param callback A function that is called on success or error.
 * It takes 2 arguments: request and statusMessage.
 */
LocalRequestManager.prototype.fetchNextRequest = function fetchNextRequest(callback) {
	"use strict";
	utils.log("LocalRequestManager.fetchNextRequest()", "debug");
	var request = null;
	var statusMessage = null;
	if( !utils.isNullOrUndefined(this.config.maxCrawledPages) && this.config.maxCrawledPages <= this.handledRequests.length() ) {
		statusMessage = "" + this.handledRequests.length() + " pages crawled, reaching the 'maxCrawledPages' limit from the configuration.";
		// this is necessary if we're the master process,
		// otherwise the master would continue spawning new slaves!
		this.queuedRequests.clear();
	}
	else if( !utils.isNullOrUndefined(this.config.maxOutputPages) && this.config.maxOutputPages <= this.stats.pagesOutputted ) {
		statusMessage = "" + this.stats.pagesOutputted + " pages outputted, reaching the 'maxOutputPages' limit from the configuration.";
		this.queuedRequests.clear();
	}
	else {
		// note that LocalRequestManager is also used by control server when parallelizing crawling
		// among more processes, therefore we move the returned 'request' to the end of the queue
		// to give the calling slave process some time to process the request, before other process
		// gets its chance
		request = this.queuedRequests.moveFirstToEnd();
		if( request ) {
			statusMessage = "A request was fetched successfully";
		} else {
			statusMessage = "No more pages in the queue to crawl.";
		}
	}
	utils.log("LocalRequestManager.fetchNextRequest() results: request="+request+", statusMessage='"+statusMessage+"'", "debug");
	if( callback ) {
		callback( request, statusMessage );
	}
};

/**
 * A helper function that determines whether a request is in queuedRequests.
 * @param request
 */
LocalRequestManager.prototype.inQueue = function inQueue(request) {
	"use strict";
	return !utils.isNullOrUndefined(request) && this.queuedRequests.get(request.uniqueKey)!==null;
};

/**
 * Notifies the manager that a request has been handled.
 * @param request
 */
LocalRequestManager.prototype.markRequestHandled = function markRequestHandled(request) {
	"use strict";
	utils.log("LocalRequestManager.markRequestHandled(): request="+request, "debug");

	if( !request ) {
		throw new Error("Parameter 'request' must be specified.");
	}
	if( !this.queuedRequests.get(request.uniqueKey) ) {
		throw new Error("The request was not found in the queue under this uniqueKey ('"+request.uniqueKey+"').");
	}
	if( this.handledRequests.get(request.uniqueKey) ) {
		throw new Error("There already is a handled request with same uniqueKey ('"+request.uniqueKey+"').");
	}

	// 'handle' the request
	this.queuedRequests.remove(request.uniqueKey);
	this.handledRequests.add(request.uniqueKey, request);

	// update stats
	this.stats.pagesInQueue = this.queuedRequests.length();
	this.stats.pagesCrawled = this.handledRequests.length();
	this.stats.pagesRetried += request._retryCount>0 ? 1 : 0;

	// log the previous request to output JSON file
	if( this.outputJsonStream && !request._skipOutput ) {
		try	{
			// the JSON file must be valid at any time, so we always close the main array,
			// and seek back to delete the ']' char before every write
			// NOTE: for some reason, this doesn't work on Linux, so we had to remove it (on 2015-01-26)
			/*var size = fs.size( this.outputJsonPath );
			 stream.seek( size - 1 );
			 if( size > 10 ) {
			 // this is not the first request emitted
			 stream.write(',');
			 }
			 stream.write('\n');
			 stream.write(this.currentRequest.toJson(this.stats));
			 stream.write(']');
			 stream.flush();*/
			this.stats.pagesOutputted++;
			var reqCopy = request.explicitToJSON(false);
			reqCopy.stats = this.stats; // add the stats
            if( !utils.verbosePostData && reqCopy.postData && reqCopy.postData.length > 200 ) {
                reqCopy.postData = reqCopy.postData.substring(0,150) + " (...trimmed, use --verbosePostData option to show in full)";
            }
            delete reqCopy.willOpen; // this one will always be true so there's no value to have it in JSON
            if( this.outputHasSomeRecords )
                this.outputJsonStream.write(',\n');
			this.outputJsonStream.write(JSON.stringify(reqCopy, null, 2));
			this.outputJsonStream.flush();
            this.outputHasSomeRecords = true;
		} catch(e) {
			utils.logException("Cannot log the request instance to JSON output", e);
		}
	}
};


/**
 * Closes the output JSON file and invokes a callback.
 */
LocalRequestManager.prototype.close = function close(callback) {
	"use strict";
	// close the output file
	if( this.outputJsonStream ) {
		this.outputJsonStream.write("]");
		this.outputJsonStream.close();
	}
	if( callback ) {
		callback();
	}
};


/**
 * An implementation of request manager that stores requests on a remote server.
 * It communicates with the server using the HTTP protocol.
 */
function RemoteRequestManager(config, masterServerUrl) {
	"use strict";
	if( !masterServerUrl ) {
		throw new Error("Parameter 'masterServerUrl' must be specified.");
	}

	this.config = config;

	// URL of the control server
	this.masterServerUrl = masterServerUrl;

	// a PhantomJS page used to communicate with the remote server
	this.webPage = this._newWebPage();

	// indicates that 'webPage' is currently used to send a message
	this.webPageIsBusy = false;

	// user callback passed to close() function, or null. this callback must be
	// invoked only after all enqueued messages were sent and the responses received !
	this.closeCallback = null;

	// linked list of messages to be sent to control server
	// each object is of '{ message: ..., callback: ... }' form
	this.enqueuedMessages = linkedList.create();

	// there are many addNewRequest() calls on every page crawled,
	// so we buffer them and send them in batches once in a while
	this.bufferedRequests = [];

	// a set containing searchKeys of all requests that were added by this
	// slave process (dictionary key is uniqueKey, value is true).
	// it is used to avoid sending the same requests to the control server multiple times.
	this.addedSearchKeys = {};

	// number of requests fetched from the control server. it's used to check
	// whether the slave reached 'maxCrawledPagesPerSlave' configuration setting
	this.requestsFetchedCount = 0;

    // indicates whether the crawler should capture screenshots of every page during crawl
    // and send them to the server using saveScreenshot() method.
    // This field is set by the server in order to avoid taking screenshots unless necessary to be more efficient.
    // If null, the server didn't say anything so stick to default behavior
    this.shouldSaveSnapshots = null;

	// indicates whether logging should include debug messages
	// This field is set by the server in order to avoid taking screenshots unless necessary to be more efficient.
	// If null, the server didn't say anything so stick to default behavior
	this.verboseLog = null;

	// result of setInterval() for periodic ping signal to the server
	this.pingIntervalId = null;
};

/**
 * Schedules a periodic sending of messages to the server, which the server uses to determine whether this process
 * is still running or if it got stuck (e.g. infinte loop in pageFunction).
 * TODO: use a separate WebPage object for this, so that we can increase REMOTE_REQUEST_MANAGER_TIMEOUT !!!
 */
RemoteRequestManager.prototype.schedulePeriodicPing = function schedulePeriodicPing() {
	"use strict";
	utils.log("Scheduling periodic PING to server", "debug");
	if( !this.pingIntervalId ) {
		this.pingIntervalId = setInterval( function() {
			try {
				utils.log("Sending periodic PING to server", "debug");
				this._sendBufferedRequests(true);
			} catch(e) {
				utils.logException("An error occurred during periodic ping to server", e);
			}
		}.bind(this), constants.REMOTE_REQUEST_MANAGER_PING_INTERVAL );
	}
};

/**
 * Notifies the manager about a new page request.
 */
RemoteRequestManager.prototype.addNewRequest = function addNewRequest(request) {
	"use strict";
	if( !this.addedSearchKeys[request.uniqueKey] ) {
        utils.log("Captured new request ("+request+")", "debug");
		this.bufferedRequests.push(request);
		if( this.bufferedRequests.length >= constants.REMOTE_REQUEST_MANAGER_BUFFER_SIZE )
			this._sendBufferedRequests();
		this.addedSearchKeys[request.uniqueKey] = true;
	} else {
		utils.log("Skipping already captured request ("+request+")", "debug");
    }
};

/**
 * Fetches a request from the queue and invokes a user callback.
 * @param callback A function that is called on success or error.
 * It takes 2 arguments: request and statusMessage.
 */
RemoteRequestManager.prototype.fetchNextRequest = function fetchNextRequest(callback) {
	"use strict";
	utils.log("RemoteRequestManager.fetchNextRequest()", "debug");

	// if more than maxCrawledPagesPerSlave pages opened, initiate the shutdown of slave process
	if( this.config.maxCrawledPagesPerSlave > 0 && this.requestsFetchedCount >= this.config.maxCrawledPagesPerSlave ) {
		if( callback ) {
			callback(null, "The slave already opened " + this.requestsFetchedCount + " pages, reaching the 'maxCrawledPagesPerSlave' limit from the configuration.");
		}
		return;
	}

	var message = {
		messageType: 'fetchNextRequest',
		piggybackBufferedRequests: this.bufferedRequests
	};
	this._enqueueMessage( message, function fetchNextRequestCallback(responseMessage) {
		var request = responseMessage.request;
		var statusMessage = responseMessage.statusMessage;
		if( utils.isNullOrUndefined(statusMessage) ) {
			throw new Error("The response for 'fetchNextRequest' message doesn't define 'statusMessage' field.");
		}
		//utils.log("FETCH NEXT REQUEST RESULT: " + JSON.stringify(request,null,2), "debug")
		exports.localizeFromJSON(request);
		if( request ) {
			this.requestsFetchedCount++;
		}
		utils.log("RemoteRequestManager.fetchNextRequest() results: request="+request+", statusMessage='"+statusMessage+"', requestsFetchedCount='"+this.requestsFetchedCount+"'", "debug");
		if( callback ) {
			callback(request, statusMessage);
		}
	}.bind(this));
	this.bufferedRequests = [];
};


/**
 * Notifies the manager that a request has been handled.
 * @param request
 */
RemoteRequestManager.prototype.markRequestHandled = function markRequestHandled(request) {
	"use strict";
	utils.log("RemoteRequestManager.markRequestHandled(): request="+request, "debug");
	// don't send stats object back, to save bandwidth
	delete request._stats;
	var message = {
		messageType: 'markRequestHandled',
		request: request,
		piggybackBufferedRequests: this.bufferedRequests
	};
	this._enqueueMessage( message );
	this.bufferedRequests = [];
};


/**
 * Sends all pending messages and invokes a callback.
 */
RemoteRequestManager.prototype.close = function close(callback) {
	"use strict";
	utils.log("RemoteRequestManager.close()", "debug");

	if( this.pingIntervalId ) {
		clearInterval(this.pingIntervalId);
		this.pingIntervalId = null;
	}

	this._sendBufferedRequests();
	if( callback ) {
		// don't invoke callback before all pending messages are sent!
		this.closeCallback = callback;
		this._sendNextMessage();
	} else {
		// there's no point to send anything, the process is going to exit asap...
	}
};

/**
 * Called by crawler every time a screenshot and HTML was captured, so that it can be transmitted to server (if server wants).
 */
RemoteRequestManager.prototype.saveSnapshot = function saveSnapshot(screenshotFilename, htmlContent, pageUrl) {
    "use strict";
    utils.log("RemoteRequestManager.saveSnapshot()", "debug");

    if( this.shouldSaveSnapshots ) {
        // make sure htmlContent won't take more than SNAPSHOT_HTML_MAX_BYTES bytes
        // (an UTF-8 character can take up to 6 bytes)
        if( htmlContent && htmlContent.length > constants.SNAPSHOT_HTML_MAX_BYTES / 6 ) {
            var bytes = utils.utf8ByteLength(htmlContent);
            if( bytes > constants.SNAPSHOT_HTML_MAX_BYTES ) {
                htmlContent = htmlContent.substr(0, htmlContent.length - (bytes - constants.SNAPSHOT_HTML_MAX_BYTES))
                    + " ...HTML truncated because it was too long";
            }
        }

        var message = {
            messageType: 'saveSnapshot',
            screenshotFilename: screenshotFilename,
            htmlContent: htmlContent,
            pageUrl: pageUrl,
            piggybackBufferedRequests: this.bufferedRequests
        };
        this._enqueueMessage(message);
        this.bufferedRequests = [];
    }
};

/**
 * Called by crawler to transmit new cookies to server.
 */
RemoteRequestManager.prototype.saveCookies = function saveSnapshot(cookies) {
    'use strict';

    utils.log('RemoteRequestManager.saveCookies()', 'debug');
    this._enqueueMessage({
        messageType: 'saveCookies',
        cookies: cookies,
        piggybackBufferedRequests: this.bufferedRequests
    });
    this.bufferedRequests = [];
};

/**
 * Creates a new PhantomJS page that is used to communicate with the remote server.
 * @private
 */
RemoteRequestManager.prototype._newWebPage = function _newWebPage() {
	"use strict";
	var webPage = require('webpage').create();
	webPage.settings.javascriptEnabled = false;
	webPage.settings.resourceTimeout = constants.REMOTE_REQUEST_MANAGER_TIMEOUT;
	webPage.onResourceError = function onResourceError(resourceError) {
		"use strict";
		utils.log('RemoteRequestManager.webPage.onResourceError(): ' + JSON.stringify(resourceError,null,2), "error");
	}.bind(this);
	webPage.onResourceTimeout = function onResourceTimeout(response) {
		"use strict";
		utils.log('RemoteRequestManager.webPage.onResourceTimeout(): ' + JSON.stringify(response,null,2), "error");
	}.bind(this);
	return webPage;
};

/**
 * Sends all requests buffered by addNewRequest() function to the server, if there are any.
 * @private
 */
RemoteRequestManager.prototype._sendBufferedRequests = function _sendBufferedRequests(force) {
	"use strict";
	utils.log("RemoteRequestManager._sendBufferedRequests(): length=" + this.bufferedRequests.length, "debug");
	if( force || this.bufferedRequests.length > 0 ) {
		var message = {
			messageType: 'dummy',
			piggybackBufferedRequests: this.bufferedRequests
		};
		this._enqueueMessage( message );
		this.bufferedRequests = [];
	}
};

/**
 * Enqueues a message to be sent to server after all previously enqueued messages are sent.
 * After a response is received, a callback will be invoked to pass response data to the caller.
 * Callback function has one parameter, which receives the parsed response object,
 * which is always not null!
 * @private
 */
RemoteRequestManager.prototype._enqueueMessage = function _enqueueMessage(message, callback) {
	"use strict";
	utils.log("RemoteRequestManager._enqueueMessage(): messageType=" + message.messageType, "debug");
	// stringify here, so that the caller can catch the error
	this.enqueuedMessages.add({
		messageType: message.messageType, // for logging
		messageJson: JSON.stringify(message),
		callback: callback
	});
	this._sendNextMessage();
};


/**
 * Sends a next message from the queue to the control server, if possible.
 * If there are no more messages and this.closeCallback is set, it will be invoked.
 * @private
 */
RemoteRequestManager.prototype._sendNextMessage = function _sendNextMessage() {
	"use strict";
	utils.log("RemoteRequestManager._sendNextMessage(): webPageIsBusy=" + this.webPageIsBusy+", enqueuedMessages.length="+this.enqueuedMessages.length, "debug");

	if( this.webPageIsBusy ) {
		return;
	}
	// if there are no more messages and closeCallback is set, we are done here...
	if( !this.enqueuedMessages.head ) {
		if( this.closeCallback ) {
			utils.log("RemoteRequestManager._sendNextMessage(): Invoking close callback", "debug");
			this.closeCallback();
		}
		return;
	}

	// dequeue first message
	var node = this.enqueuedMessages.head;
	var messageType = node.data.messageType;
	var messageJson = node.data.messageJson;
	var callback = node.data.callback;
	this.enqueuedMessages.removeNode(node);

	// send the message
	var settings = {
		operation: "POST",
		encoding: "utf8",
		headers: { "Content-Type": "application/json" },
		data: messageJson
	};
	var page = this.webPage;
	this.webPageIsBusy = true;
	page.open(this.masterServerUrl, settings, function(status) {
		try {
			utils.log("RemoteRequestManager._sendNextMessage(): message sent (messageType="+messageType+", status="+status+")", "debug");

			this.webPageIsBusy = false;
			if( status !== 'success' ) {
				this.fail("Couldn't send message to control server at '" + this.masterServerUrl + "' (messageType="+messageType+", status: '" + status + "')");
			}

			// parse and check response
			var responseMessage;
			try {
				responseMessage = JSON.parse(page.plainText);
				if( typeof(responseMessage)!=='object' ) {
					throw "The response must be an object.";
				}
			} catch(e) {
			    this.fail("Control server sent an invalid response ("+this.masterServerUrl+"): " + page.plainText, e);
			}

            // only override default null value if server reported shouldSaveSnapshots,
            // otherwise we are probably called from command line and want to keep the default behaviour
            if( typeof(responseMessage.shouldSaveSnapshots)==='boolean' )
                this.shouldSaveSnapshots = responseMessage.shouldSaveSnapshots;
			// if verboseLog is set, toggle the debug logging mode
			if( typeof(responseMessage.verboseLog)==='boolean' )
				utils.isDebugMode = responseMessage.verboseLog;

			if( callback ) {
				callback(responseMessage);
			}
			this._sendNextMessage();
		} catch(e) {
			this.fail("An unknown exception occurred while processing control server's response", e);
		}
	}.bind(this) );
};

/**
 * Logs information about an error and shuts down the PhantomJS process.
 */
RemoteRequestManager.prototype.fail = function fail(message, exception, details) {
	utils.logException(message, exception);
	if( details ) {
		utils.log("Error details: " + details);
	}
	utils.log("A fatal error occurred, shutting down...");
    utils.forceExit(1000);
};
