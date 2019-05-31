/*!
 * Configurable web crawler for PhantomJS.
 * This module contains core functions of the crawler.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014-2015 Apifier. All rights reserved.
 *
 */
"use strict";

/*global phantom*/

require('./polyfills');
require('./clientutils');

var webpage      = require('webpage');
var fs           = require('fs');
var utils        = require('./utils');
var requests     = require('./requests');
var crawlerUtils = require('./crawlerutils');
var constants    = require('./constants');

var clientUtils = new window.CrawlerClientUtils();

/**
 * Returns a new instance of the Crawler class.
 */
exports.createCrawler = function createCrawler(config, requestManager, settings) {
	"use strict";
	return new Crawler(config, requestManager, settings);
};

/**
 * Custom base error.
 */
function CrawlerError(msg) {
	"use strict";

	Error.call(this);
	this.message = msg;
	this.name = 'CrawlerError';
}
CrawlerError.prototype = Object.getPrototypeOf(new Error());


/**
 * The main Crawler class.
 */
function Crawler(config, requestManager, settings) {
	"use strict";

	if( !config ) {
		throw new CrawlerError("Parameter 'config' must be provided.");
	}
    if( !config._isPrepared ) {
        throw new CrawlerError("Configuration is not prepared to be used by crawler.");
    }
	if( !requestManager ) {
		throw new CrawlerError("Parameter 'requestManager' must be provided.");
	}

	// the currently processed page request, or null
	this.currentRequest = null;

	// the current PhantomJS WebPage object corresponding to currentRequest, or null
	this.webPage = null;

	// user configuration
	this.config = config;

    // global settings from command line, currently not used
    this.settings = settings || {};

	// manages the page requests
	this.requestManager = requestManager;

	// details from the last onResourceError() call
	this.lastResourceError = null;

	// details from the last onResourceTimeout() call
	this.lastResourceTimeoutResponse = null;

    // result of setTimeout() that invoked onLoadFinished() after certain timeout
    this.onLoadFinishedTimeoutId = null;
}


/**
  * Creates a new PhantomJS WebPage object and attaches the crawler's handlers to its callbacks.
  */
Crawler.prototype.newWebPage = function newWebPage() {
	"use strict";
	var webPage = webpage.create();

    if( typeof(this.config.userAgent)==='string' )
	    webPage.settings.userAgent = this.config.userAgent;
    else if( typeof(this.config.userAgent)==='function' )
        webPage.settings.userAgent = this.config.userAgent();
    else if( this.config.customHttpHeaders && this.config.customHttpHeaders['User-Agent'] )
        webPage.settings.userAgent = this.config.customHttpHeaders['User-Agent'];
    else
        webPage.settings.userAgent = constants.DEFAULT_USER_AGENT;

	webPage.settings.loadImages = typeof(this.config.loadImages)==='boolean' ? this.config.loadImages : constants.DEFAULT_LOAD_IMAGES;
	webPage.settings.resourceTimeout = typeof(this.config.resourceTimeout)==='number' ? this.config.resourceTimeout : constants.DEFAULT_RESOURCE_TIMEOUT;

    if( this.config.customHttpHeaders )
        webPage.customHeaders = this.config.customHttpHeaders;

    // the viewport should be large enough so that most of the time
	// we don't need to scroll the page to emulate the click in sendClick()
    // but not too long so that small sites aren't filled with white-space at the bottom
	webPage.viewportSize = { width: 1280, height: 960 };

	// attach our handlers to PhantomJS events,
	// make sure 'this' in the handlers will always refer to the this Crawler instance !
	webPage.onNavigationRequested = this.onNavigationRequested.bind(this);
	webPage.onAlert = this.onAlert.bind(this);
	webPage.onPrompt = this.onPrompt.bind(this);
	webPage.onConfirm = this.onConfirm.bind(this);
	webPage.onError = this.onError.bind(this);
	webPage.onLoadStarted = this.onLoadStarted.bind(this);
	webPage.onLoadFinished = (function(status) {
	    this.onLoadFinished(webPage, status);
    }).bind(this);
    webPage.onResourceRequested = this.onResourceRequested.bind(this);
    webPage.onResourceReceived = this.onResourceReceived.bind(this);
	webPage.onResourceError = this.onResourceError.bind(this);
	webPage.onResourceTimeout = this.onResourceTimeout.bind(this);
	webPage.onUrlChanged = this.onUrlChanged.bind(this);
	webPage.onFilePicker = this.onFilePicker.bind(this);
	webPage.onPageCreated = this.onPageCreated.bind(this);
	webPage.onConsoleMessage = this.onConsoleMessage.bind(this);
	webPage.onLongRunningScript = this.onLongRunningScript.bind(this);
    webPage.onCallback = this.onCallback.bind(this);

	return webPage;
};


/**
  * Invoked by PhantomJS if there is an error in a JavaScript executed in the webpage's context
  * (e.g. using this.webPage.evaluate() function).
  */
Crawler.prototype.onError = function onError(msg, trace) {
	"use strict";
	// pages often have script errors, and there's no point to display them in our log,
	// thus only do it in debug mode.
	utils.log("Crawler.onError(): JavaScript on page threw an exception | msg: " + msg + ", trace:\n" + utils.traceToString(trace), "debug");
};

Crawler.prototype.onAlert = function onAlert(msg) {
	"use strict";
	utils.log("ON ALERT | msg: " + msg);
};

Crawler.prototype.onPrompt = function onPrompt(msg, defaultVal) {
	"use strict";
	utils.log("ON PROMPT | msg: " + msg + ", defaultVal: " + defaultVal, "debug");
};

Crawler.prototype.onConfirm = function onConfirm(msg) {
	"use strict";
	utils.log("ON CONFIRM | msg: " + msg, "debug");
	// HOTFIX: returning true for sex.cz
	// TODO: return false and allow user to override, including onPrompt etc.
	return true;
};

Crawler.prototype.onUrlChanged = function onUrlChanged(targetUrl) {
	"use strict";
	utils.log("ON URL CHANGED | targetUrl: " + targetUrl, "debug");

    // the JavaScript on pages is executing already before the pages are loaded
    // which means that a page might navigate away even before we receive onLoadFinished()
    // (for example: http://trackthemissingchild.gov.in/trackchild/photograph_missing.php?type=2)
    // To prevent this we can lock navigation alredy here, but that means that no child frames
    // will be loaded, hence this name of configuration setting
    if( this.webPage && this.config.skipLoadingFrames )
        this.webPage.navigationLocked = true;

    // try to inject request object already now, because if the page issues some redirect before it's loaded,
    // interceptRequest() function wouldn't have 'context' which would confuse users!
    // (also happens at http://trackthemissingchild.gov.in/trackchild/photograph_missing.php?type=2)
    if( this.webPage && !crawlerUtils.areClientUtilsInjected(this.webPage) ) {
        crawlerUtils.injectRequestObject(this.webPage, this.currentRequest, this.config.customData, this.config.actorRunId, this.config.actorTaskId);
    }

	// In some pages, links to other pages (e.g. product details on http://www.supremenewyork.com/shop/all)
	// do not generate new navigation requests but rather change the page content dynamically using AJAX.
	// In order to track these links without a need to implement a complex asynchronous page function,
	// we consider these URL changes as navigation requests too. Chances are that the new URL can be opened
	// directly in a browser and everything will work just fine.

	// make sure the URL change was initiated from an already loaded page,
	// to avoid invoking onNavigationRequested() when crawler is loading a page
	if( targetUrl && this.currentRequest && this.currentRequest.loadingFinishedAt ) {
		this.onNavigationRequested(targetUrl, 'OnUrlChanged', false, true, '', '', 'GET');
	}

	return false;
};

Crawler.prototype.onFilePicker = function onFilePicker(oldFile) {
	"use strict";
	utils.log("ON FILE PICKER | oldFile: " + oldFile, "debug");
	return null;
};

Crawler.prototype.onLoadStarted = function onLoadStarted() {
	utils.log("ON LOAD STARTED", "debug");
};

Crawler.prototype.onConsoleMessage = function onConsoleMessage(msg) {
    // enable this because users expect console.log() to work!
	utils.log('ON CONSOLE MESSAGE | ' + msg );
};

Crawler.prototype.onResourceRequested = function (requestData, request) {
    var loadCss = typeof(this.config.loadCss)==='boolean' ? this.config.loadCss : constants.DEFAULT_LOAD_CSS;
    if( !loadCss || this.config.avoidPrivateNetwork ) {
        var parsedUrl = clientUtils.parseUrl(requestData['url']);
        var abort = false;

        // abort loading of CSS files, if desired
        if( !loadCss
            && ( (parsedUrl && parsedUrl['file'] && parsedUrl['file'].toLowerCase().endsWith(".css"))
                || requestData.headers['Content-Type'] == 'text/css') ) {
            utils.log("Aborting loading of CSS file: " + requestData.url + " (resource id: " + requestData.id + ")", "debug");
            abort = true;
        }

        // abort access to private IP addresses
        // TODO: this solution is far from perfect and can probably be hacked by spoofing DNS records or some other means,
        // we should implement this functionality in PhantomJS directly on socket level !!!
        // (NOTE: same code is used in utilities.js)
        var ipLikeRegex = /^(\.|[0-9])+$/;
        var privateAddressRegex = /(^127\.)|(^10\.)|(^172\.1[6-9]\.)|(^172\.2[0-9]\.)|(^172\.3[0-1]\.)|(^192\.168\.)/;
        var localhostRegex = /^localhost$/i;
        if( this.config.avoidPrivateNetwork
            && parsedUrl
            && parsedUrl['host']
            && ( (ipLikeRegex.test(parsedUrl['host']) && privateAddressRegex.test(parsedUrl['host']))
                 || localhostRegex.test(parsedUrl['host']) ) ) {
            utils.log("Resources from private addresses will not be loaded: " + requestData.url + " (resource id: " + requestData.id + ")");
            abort = true;
        }

        if( abort ) {
            request.abort();
            if( !webPage.ignoreErrorsForResourceIds ) {
                webPage.ignoreErrorsForResourceIds = {};
            }
            webPage.ignoreErrorsForResourceIds[requestData.id] = true;
        }
    }
};

Crawler.prototype.onResourceReceived = function onResourceReceived(response) {
    "use strict";
    //utils.log('ON RESOURCE RECEIVED | response: ' + JSON.stringify(response,null,2));
    if( this.currentRequest && response ) {
        this.currentRequest.downloadedBytes += response.bodySize | 0; // sometimes it's undefined!
        // save the first info about the first resource on every unique URL,
        // so that we can later retrieve HTTP status and headers for the final loaded page
        if( this.webPage && response.url ) {
            var dict = this.webPage.firstResources = this.webPage.firstResources || {};
            if( !dict[response.url] )
                dict[response.url] = response;
        }
    }
};

Crawler.prototype.onResourceError = function onResourceError(resourceError) {
	"use strict";
    // silently ignore errors caused by skipped CSS files, to avoid pollution of log files
    if( !utils.isDebugMode && this.webPage && this.webPage.ignoreErrorsForResourceIds && this.webPage.ignoreErrorsForResourceIds[resourceError.id] )
        return;

    // Ignore the following error, it's most likely caused by disabled CSS
    // {“errorCode”:301,“errorString”:“Protocol \“\” is unknown”,“id”:3,“status”:null,“statusText”:null,“url”:“”}
    if( resourceError && resourceError.errorCode===301 && resourceError.errorString==="Protocol \"\" is unknown" )
        return;

    utils.log('ON RESOURCE ERROR | resourceError: ' + JSON.stringify(resourceError));
	this.lastResourceError = resourceError;
};

Crawler.prototype.onResourceTimeout = function onResourceTimeout(response) {
	"use strict";
	utils.log("ON RESOURCE TIMEOUT | response: " + JSON.stringify(response));
	this.lastResourceTimeoutResponse = response;
};

Crawler.prototype.onLongRunningScript = function onLongRunningScript() {
	"use strict";
	utils.log("ON LONG RUNNING SCRIPT", "debug");
	if( this.webPage ) {
		utils.log("The page script stopped responding and will be interrupted", "warning");
		this.webPage.stopJavaScript();
	}
};

Crawler.prototype.onCallback = function onCallback(message) {
    "use strict";
    //utils.log("ON CALLBACK | message: " + JSON.stringify(message), "debug");
    try {
        message = JSON.parse(message);
        if( message && this.currentRequest && message.requestId === this.currentRequest.id ) {
            switch( message.messageType ) {

                case "PAGE_FUNCTION_FINISHED":
                    utils.log("Page function finished asynchronously", "debug");

                    // Calling wrapUpPageFunction() in setTimeout() so that pending interceptRequest calls are performed
                    // NOTE: using timeout 1 ms to ensure the crawler finishes after all pending USER_ENQUEUED_PAGE messages are processed
                    setTimeout( function() {
                        this.wrapUpPageFunction(message.pageFunctionResult, message.userFlags);
                    }.bind(this), 1);
                    break;

                case "USER_ENQUEUED_PAGE":
                    var opts = {
                        type: 'UserEnqueued',
                        isMainFrame: true
                    };

                    // copy only allowed options and ensure they are string
                    // (except 'interceptRequestData' which can be anything)
                    requests.ENQUEUE_PAGE_FIELDS.forEach( function(key) {
                        if( key === 'interceptRequestData' )
                            opts[key] = message.options[key];
                        else
                            opts[key] = utils.toString( message.options[key] );
                    });

                    // check and fix the URL (trim and default to http://)
                    var url = utils.fixUrl(opts.url);
                    if( !url ) {
                        utils.log("Invalid URL provided to context.enqueuePage(), will be ignored (" + JSON.stringify(opts.url) + ")", "error");
                        break;
                    }
                    opts.url = url;
                    utils.log("Enqueuing user page ('" + opts.url + "')", "debug");

                    // NOTE: postpone the operation, because if user calls context.enqueuePage() in a long loop,
                    // the message to worker would time out and no page would be enqueued
                    setTimeout( function() {
                        this.onNavigationRequestedImpl(opts);
                    }.bind(this), 0);
                    break;

                case "SAVE_SNAPSHOT":
                    utils.log("Saving snapshot (customName: '" + (message.customName || "N/A") + "')", "debug");
                    this.saveSnapshot(true, message.customName);
                    break;

                case "SAVE_COOKIES":
                    if (message.cookies) {
                        utils.log('Saving user-provided cookies (count: '+message.cookies.length+')', 'debug');
                        phantom.cookies = message.cookies;
                    } else {
                        utils.log('Saving browser cookies', 'debug');
                    }
                    this.requestManager.saveCookies(phantom.cookies);
                    break;

                default:
                    utils.log("Unexpected callback message: " + JSON.stringify(message), "warning");
                    break;
            }
        }
    } catch(e) {
        this.logPageError("An exception occurred while handling page callback", e);
    }
};


/**
 * Helper function that logs and error to console and the current request's 'errorInfo' fields.
 */
Crawler.prototype.logPageError = function logPageError(message, exception) {
	// this function must always succeed, otherwise the application will hang!
	utils.logException(message, exception);
	if (this.currentRequest) {
		this.currentRequest.errorInfo += message + ": " + exception + "\n";
	}
};


/**
 * Called by PhantomJS after webPage.open() finished loading a page.
 * It mainly injects our utils to the page and then schedules next actions.
 */
Crawler.prototype.onLoadFinished = function onLoadFinished(webPage, status) {
	"use strict";
	try
	{
	    if( this.webPage !== webPage ) {
            utils.log("ON LOAD FINISHED ('"+status+"') invoked for older web page, ignoring it", "debug");
            return;
        }

		// sometimes JavaScript on page causes onLoadFinished() to be called multiple
		// times for the same page, e.g. during infinite scroll
		if( this.currentRequest.loadingFinishedAt ) {
			utils.log("ON LOAD FINISHED ('"+status+"') invoked second time for the same page, ignoring it");
			return;
		}

		utils.log("ON LOAD FINISHED | status: "+status+", url: "+(this.webPage && this.webPage.url ? this.webPage.url : "N/A"));

		this.currentRequest.loadingFinishedAt = new Date();
        this.currentRequest.loadedUrl = this.webPage ? this.webPage.url : null;

        if( this.onLoadFinishedTimeoutId ) {
            clearTimeout( this.onLoadFinishedTimeoutId );
            this.onLoadFinishedTimeoutId = null;
        }

        // save page's HTTP status and headers
        // (if page redirects, we want the status of the final page and not the intermediate responses)
        // TODO: if PhantomJS loads page from cache, there's no onResourceReceived and this will not work!!!
        if( this.webPage && this.webPage.url && this.webPage.firstResources ) {
            var resource = this.webPage.firstResources[this.webPage.url];
            if( resource ) {
                this.currentRequest.responseStatus = resource.status;
                var headers = this.currentRequest.responseHeaders = {};
                if( resource.headers ) {
                    resource.headers.forEach( function(rec) {
                        headers[rec.name] = rec.value;
                    });
                }
            }
        }

		if( status != 'success' ) {
            if( this.lastResourceError && this.lastResourceError.errorCode > 0 )
                this.currentRequest.loadErrorCode = this.lastResourceError.errorCode;
            else
                this.currentRequest.loadErrorCode = 999;
            // show this.lastResourceError and lastResourceTimeoutResponse, hopefully there will be some details...
			throw new CrawlerError("The page couldn't be opened (status: " + status + ", url: " + this.currentRequest.url + ", lastResourceError: " + JSON.stringify(this.lastResourceError) + ", lastResourceTimeoutResponse: " + JSON.stringify(this.lastResourceTimeoutResponse) + ")");
		}

        // lock the navigation so that we can click on DOM elements and capture page requests
		this.webPage.navigationLocked = true;

		// inject scripts and other stuff to page
        // NOTE: request object might already be injected from onUrlChanged() but we want to provide new verson anyway
		if( !crawlerUtils.injectClientUtils(this.webPage) ) {
			throw new CrawlerError("Couldn't inject client utils to the web page");
		}
		if( this.config.injectJQuery && !crawlerUtils.injectJQuery(this.webPage) ) {
			throw new CrawlerError("Couldn't inject jQuery script to the web page");
		}
		if( this.config.injectUnderscoreJs && !crawlerUtils.injectUnderscoreJs(this.webPage) ) {
			throw new CrawlerError("Couldn't inject underscore.js script to the web page");
		}
		if( this.config.injectClientScripts ) {
			try {
				crawlerUtils.injectClientScripts(this.webPage, this.config.injectClientScripts);
			} catch(e) {
				throw new CrawlerError("Error injecting one of the 'injectClientScripts' scripts from configuration: "+e);
			}
		}

		crawlerUtils.injectRequestObject( this.webPage, this.currentRequest, this.config.customData, this.config.actorRunId, this.config.actorTaskId );

        // when initiating the crawl, give control back to page's open() callback
        // (must be done after the page is injected with all the stuff)
        if( this.currentRequest.type === 'InitialAboutBlank' ) {
            utils.log("Initial about:blank page was loaded", "debug");
            return;
        }

		// continue...
		if( this.config.maxInfiniteScrollHeight > 0 && this.currentRequest.type !== 'InitialAboutBlank' ) {
			// scroll the page to load dynamic content
			// TODO: we might store info about infinite scroll to the request...
			crawlerUtils.infiniteScroll(
				this.webPage,
				this.config.maxInfiniteScrollHeight,
				function _onLoadFinished_infiniteScrollFinished(e) {
                    this.invokePageFunction();
				}.bind(this),
				true );
		} else {
            this.invokePageFunction();
		}
	} catch(e) {
		this.logPageError("An exception occurred while processing the web page", e);
        this.handleNextRequest();
	}
};

/**
 * Captures screenshot and saves HTML of the page to two files.
 * It also notifies RemoteRequestManager (if used) about the new files so that it can send them to server.
 */
Crawler.prototype.saveSnapshot = function saveSnapshot(calledFromPageFunction, customName) {
    if( !this.webPage )
        return;
    if( this.requestManager.shouldSaveSnapshots === false )
        return; // server said no images whatsoever!

    // if called on server
    // skip too large images, they won't be displayed in Chrome/Firefox anyway or they would choke the system
    // TODO: if image is large, we should send at least HTML snapshot without image...
    if( typeof(this.requestManager.shouldSaveSnapshots)==='boolean' ) {
        var documentSize = crawlerUtils.callClientUtils(this.webPage, 'getDocumentSize');
        if( documentSize && (documentSize.width > 20000 || documentSize.height > 20000 || documentSize.width*documentSize.height > 5000*5000) ) {
            // TODO: use a picture saying "image was too large"
            utils.log("Document size too large, skipping snapshot ("+JSON.stringify(documentSize)+")");
            return;
        }
    }

    // TODO: sometimes images were not properly deleted and disk space went to zero,
    // if page function called context.saveSnapshot() in a loop,
    // we'll need some better handling of that!!!

    if( calledFromPageFunction || this.requestManager.shouldSaveSnapshots ) {
        if( typeof(customName) === 'string' )
            customName = customName.replace(/[^a-zA-Z0-9_-]/g, ''); // make sure the filename will be valid
        else
            customName = "screenshot";
        var fileName = customName + "_" + utils.dateToString(new Date(), true).replace(/:/g, '-') + '_req' + this.currentRequest.id;
        var screenshotFileName = fileName + '.png';
        var htmlFileName = fileName + '.html';

        utils.log("Capturing snapshots to: " + fileName + ".(png|html)");
        this.webPage.render(screenshotFileName);
        // what about iframes??? maybe we can iterate iframes and paste code into between <ifram></iframe> in html
        // (document.getElementById('myframe').contentWindow.document)
        var htmlContent = this.webPage.content;

        if( this.requestManager.saveSnapshot )
            this.requestManager.saveSnapshot(screenshotFileName, htmlContent, this.webPage.url);

        if( utils.isNullOrUndefined(this.requestManager.shouldSaveSnapshots) && calledFromPageFunction ) {
            // we know this script is called from command-line (not from worker!) and saveSnapshot() was requested from
            // pageFunction, so save HTML to file so that user can look at it
            fs.write(htmlFileName, htmlContent, 'w');
        }
    }
};

// this is our secret marker indicating that pageFunction didn't finish yet
var PAGE_FUNCTION_NOT_FINISHED_MARKER = "MARKER_1TDLgm4deCz5M";

/**
 * Invokes user-provided 'pageFunction' on the page to extract its content.
 */
Crawler.prototype.invokePageFunction = function invokePageFunction() {
    "use strict";
    try {
        utils.log("Crawler.invokePageFunction()", "debug");

        // capture screenshot right before pageFunction!
        this.saveSnapshot(false);

        if (this.currentRequest.type !== 'InitialAboutBlank' && this.config.pageFunction) {
            utils.log("Crawler.invokePageFunction(): Invoking user-provided 'pageFunction'.", "debug");

            // if pageFunction doesn't finish in specified timeout, finish it forcibly
            this.currentRequest.pageFunctionResult = PAGE_FUNCTION_NOT_FINISHED_MARKER;
            if( this.config.pageFunctionTimeout > 0 ) {
                var request = this.currentRequest;
                setTimeout( function() {
                    if( request === this.currentRequest && request.pageFunctionResult === PAGE_FUNCTION_NOT_FINISHED_MARKER ) {
                        utils.log("User pageFunction() did not finish in a timeout of "+this.config.pageFunctionTimeout+" milliseconds and was aborted", "debug");
                        this.currentRequest.errorInfo += "Error: pageFunction() did not finish in a timeout of "+this.config.pageFunctionTimeout+" milliseconds and was aborted.\n";
                        // note that on error the page will be outputted regardless of user skipOutput flag
                        this.wrapUpPageFunction(null, crawlerUtils.getInjectedUserFlags(this.webPage));
                    }
                }.bind(this), this.config.pageFunctionTimeout);
            }

            this.currentRequest.pageFunctionStartedAt = new Date();

            var pageFunctionResult;
            var failed = false;
            try {
                pageFunctionResult = crawlerUtils.invokeUserFunction(this.webPage, this.config.pageFunction);
            } catch (e) {
                this.currentRequest.errorInfo += "Error invoking user-provided 'pageFunction': " + e + "\n";
                utils.log("Error invoking user-provided 'pageFunction': " + e, "error");
                failed = true;
            }

            // handle instructions from user
            var userFlags = crawlerUtils.getInjectedUserFlags(this.webPage);
            if( userFlags && userFlags.willFinishLater && !failed ) {
                utils.log("Page function will asynchronously finish later (if the crawler hangs here, make sure context.finish() is really called in pageFunction!).");
                return;
            }

            // Calling wrapUpPageFunction() in setTimeout() so that pending interceptRequest calls are performed
            setTimeout( function() {
                this.wrapUpPageFunction(pageFunctionResult, userFlags);
            }.bind(this), 0);
            return;
        }

        this.findClickableElements();
    }
    catch(e) {
        this.logPageError("An exception occurred while invoking user-provided pageFunction", e);
        this.findClickableElements();
    }
};


/**
 * Handles results from the just finished 'pageFunction'.
 */
Crawler.prototype.wrapUpPageFunction = function wrapUpPageFunction(pageFunctionResult, userFlags) {
    "use strict";
    try {
        utils.log("Crawler.wrapUpPageFunction()", "debug");

        // if wrapUpPageFunction was already called then quit immediately
        // (this might happen when config.pageFunctionTimeout is reached while crawler is clicking active elements)
        if( this.currentRequest.pageFunctionResult !== PAGE_FUNCTION_NOT_FINISHED_MARKER ) {
            utils.log("Crawler.wrapUpPageFunction() was already called on current request, second call will be ignored", "debug");
            return;
        }

        // this should never happen
        if( pageFunctionResult === PAGE_FUNCTION_NOT_FINISHED_MARKER ) {
            utils.log("Page function finished with result equal to PAGE_FUNCTION_NOT_FINISHED_MARKER!!!!", "warning");
            pageFunctionResult = null;
        }

        this.currentRequest.pageFunctionFinishedAt = new Date();
        this.currentRequest.pageFunctionResult = pageFunctionResult;
        // NOTE: pageFunctionResult can be stringified because it comes from evaluateJavaScript()
        // logging of results was disabled because it was too much data for our servers
        //utils.log("Page function results (request " + this.currentRequest + "): " + JSON.stringify(pageFunctionResult, null, 2));
        utils.log("Page function finished (request " + this.currentRequest + ")");

        // if there was an error, don't skip output because user will never see it and can't debug it!!!
        if( userFlags && userFlags.skipOutput && this.currentRequest.errorInfo==="" ) {
            // the request won't be written to output JSON
            this.currentRequest._skipOutput = true;
        }
        if( userFlags && userFlags.skipLinks ) {
            utils.log("User instructed to skip links from this page, continuing with next request.");
            this.handleNextRequest();
            return;
        }

        this.findClickableElements();
    }
    catch(e) {
        this.logPageError("An exception occurred while wrapping up user-provided pageFunction", e);
        this.findClickableElements();
    }
};


/**
 * Schedules clicking of active DOM elements using 'clickNextElement' function.
 */
Crawler.prototype.findClickableElements = function findClickableElements() {
	"use strict";
	try {
		utils.log("Crawler.findClickableElements()", "debug");

        var conf = this.config;

        // for BACKWARD COMPATIBILITY: if the page is in search area, schedule clicking of all active elements
        // in order to capture corresponding page requests
        if( conf.searchAreaPurlsParsed.length !== 0 || conf.targetPagePurlsParsed.length !== 0 ) {
            if( this.currentRequest.type !== 'StartUrl' && !this.currentRequest.matchesSearchArea ) {
                this.handleNextRequest();
                return;
            }
        }

        if( !utils.isNullOrUndefined(conf.maxCrawlDepth) && this.currentRequest.depth >= conf.maxCrawlDepth ) {
            utils.log("Maximum crawl depth was reached therefore page links won't be followed.");
            this.handleNextRequest();
        } else {
            var selector = constants.DEFAULT_CLICKABLE_ELEMENTS_SELECTOR;
            if( !utils.isEmpty(conf.clickableElementsSelector) ) {
                selector = conf.clickableElementsSelector;
            }
            // save an array of active elements to window.__activeElements__
            // (in reverse order, so that we can pop elements in the original order)
            var elementCount = this.webPage.evaluate(function (selector) {
                if( !document || !document.body )
                    return "N/A"; // this happens sometimes...
                var nodeList = document.body.querySelectorAll(selector);
                var array = new Array(nodeList.length);
                for (var i = 0; i < nodeList.length; i++) {
                    array[nodeList.length - 1 - i] = nodeList[i];
                }
                window.__activeElements__ = array;
                return nodeList.length;
            }, selector);

            if( elementCount )
                utils.log("Found "+elementCount+" clickable HTML elements, clicking them now.");
            else
                utils.log("Found 0 clickable HTML elements matching the CSS selector");

            this.clickNextElement();
        }
	} catch( e ) {
		this.logPageError("An exception occurred while finding clickable elements on the web page", e);
        this.handleNextRequest();
	}
};


/**
 * Clicks next active element on the page, or schedules a call
 * to handleNextRequest() if there are no elements to click.
 */
Crawler.prototype.clickNextElement = function clickNextElement() {
	"use strict";
	try {
		//utils.log("Crawler.clickNextElement()", "debug");

		var result = this.webPage.evaluate(function() {
			// get next active element to click
			if( !window.__activeElements__ ) {
				return {
                    status: 'NO_ACTIVE_ELEMENTS'
                };
			}
			var elem = window.__activeElements__.pop();
			if( !elem ) {
				return {
                    status: 'ALL_ACTIVE_ELEMENTS_CLICKED'
                };
			}
			// save a reference to the element for the user-provided 'interceptRequest' function
			window.__context__ = window.__context__ || {};
			window.__context__.clickedElement = elem;

            var result = {
                htmlElement: elem.outerHTML,
                aHref: elem.tagName==='A' || elem.tagName==='a' ? elem.href : null
            };

			// click the element
			if( window.__clientUtils__.click(elem) ) {
                result.status = 'CLICKED';
				return result;
			}
			// if click failed, fallback to the PhantomJS' mouse click emulation
			var pos = elem.getBoundingClientRect();
			if( pos.left === pos.right && pos.top === pos.bottom ) {
				// special case: the element is not visible
                result.status = 'NOT_VISIBLE';
                return result;
			}
            result.status = 'CLICKED_XY';
            result.x = Math.floor((pos.left + pos.right) / 2);
            result.y = Math.floor((pos.top + pos.bottom) / 2);
            return result;
		});

        if( typeof(result) === 'object' ) {

            // FIXME: we should log this before the actual click, so that logs make more sense!
            utils.log("Crawler.clickNextElement() result: " + result.status + " | " + result.htmlElement, "debug");

            // Sometimes <a> elements are not normal links that load a new page, but rather they invoke AJAX
            // requests that fetch the target page and then rewrite the page body, e.g. http://www.storageunitsnearme.com/
            // From crawlers' perspective, these are not navigation events and as such the links are not enqueued.
            // Unfortunately that's not very intuitive for users.
            // So we added this workaround and manually add hrefs from all matched <a> elements with 'FoundLink' type.
            // Note that these shrefs are always absolute URLs.
            if( result.aHref ) {
                this.onNavigationRequested(result.aHref, 'FoundLink', false, true, '', '', 'GET');
            }

            // if there's nothing to click, call to handleNextRequest()
            if( result.status === 'NO_ACTIVE_ELEMENTS' || result.status === 'ALL_ACTIVE_ELEMENTS_CLICKED' ) {
                utils.log("Crawler.clickNextElement() finished: No elements to click (" + result.status + "), calling handleNextRequest()", "debug");
                this.handleNextRequest();
                return;
            }

            // "recursively" continue clicking elements
            if( result.status === 'CLICKED' || result.status === 'NOT_VISIBLE' ) {
				// must be called in setTimeout() to give the web page time to send queued onNavigationRequested events
				setTimeout(this.clickNextElement.bind(this), 0);
                return;
            }

            // click the requested [X,Y] coordinates and "recursively" continue
            if( result.status === 'CLICKED_XY' ) {
                utils.log("Falling back to PhantomJS click emulation (" + result.status + ", X="+result.x+", Y="+result.y+")", "warning");
                crawlerUtils.sendClick(this.webPage, result.x, result.y);
                setTimeout(this.clickNextElement.bind(this), 0);
                return;
            }
        }

		// this shouldn't happen, but...
		throw new CrawlerError("How the hell did we end up here? (result: " + JSON.stringify(result) + ")");
	} catch( e ) {
		this.logPageError("An exception occurred while clicking elements on the web page", e);
        this.handleNextRequest();
	}
};


/**
 * Called by PhantomJS when it is requested to navigate to a new page.
 */
Crawler.prototype.onNavigationRequested = function onNavigationRequested(url, type, willNavigate, isMainFrame, postData, contentType, method) {
    "use strict";
    var options = {
        url: url,
        type: type,
        isMainFrame: isMainFrame,
        postData: postData,
        contentType: contentType,
        method: !utils.isEmpty(postData) ? 'POST' : method // method from PhantomJS might not be correct
    };
    if( willNavigate ) {
        utils.log("Crawler.onNavigationRequested("+JSON.stringify(options)+"): Page requested by the crawler, it will open.", "debug");
        return;
    }
    this.onNavigationRequestedImpl(options);
};


Crawler.prototype.onNavigationRequestedImpl = function onNavigationRequested(options) {
	"use strict";
	try {
		utils.log("Crawler.onNavigationRequested("+JSON.stringify(options)+")", "debug");

        if( !this.webPage ) {
            utils.log("Crawler.onNavigationRequested(): Web page is already closed, request will be ignored.", "debug");
            return;
        }

        // don't enqueue potentially harmful URLs: only those starting with http:// and https:// are allowed !!!
        var url = utils.fixUrl(options.url);
        if( !url ) {
            utils.log("URL is not valid and will not be enqueued ('"+options.url+"')", "debug");
            return;
        }

        var userFlags = crawlerUtils.getInjectedUserFlags(this.webPage);
        if( userFlags && userFlags.skipLinks && options.type!=='UserEnqueued' ) {
            utils.log("User invoked context.skipLinks(), ignoring this navigation request.", "debug");
            return;
        }

		// create a new request object
		var newRequest = requests.createRequest();
		newRequest.url = url;
		newRequest.requestedAt = new Date();
		newRequest.type = options.type;
		newRequest.isMainFrame = !!options.isMainFrame;
        // NOTE: type==='FormSubmitted' || type==='FormResubmitted' doesn't mean POST request, it's same for GET !!!
		newRequest.method = /^post$/i.test(options.method) ? 'POST' : 'GET';
        newRequest.postData = newRequest.method==='POST' ? options.postData : null;
        newRequest.contentType = newRequest.method==='POST' ? options.contentType : null;
		newRequest.referrer = (options.type==='StartUrl' || options.type==='SingleUrl') ? null : this.currentRequest;
        newRequest.depth = newRequest.referrer ? newRequest.referrer.depth + 1 : 0;
        newRequest.queuePosition = /^first$/i.test(options.queuePosition) ? 'FIRST' : 'LAST';
        newRequest.interceptRequestData = options.interceptRequestData;

        newRequest.computeStuff(this.config, options.label, options.uniqueKey);

		// invoke 'interceptRequest' function and update newRequest with its result
		if( this.config.interceptRequest ) {
			// utils.log("Crawler.onNavigationRequested(): Invoking user-provided 'interceptRequest' function.", "debug");
			try {
				var result = crawlerUtils.invokeUserFunction(this.webPage, this.config.interceptRequest, newRequest.explicitToJSON(true));
				if( result !== null ) {
					// check the result
					if( typeof result !== 'object' )
						throw "Return value must either be null or a request object.";

					// performance optimization - skip the check if url was already checked
					if( result.url !== url ) {
                        var fixedUrl = utils.fixUrl( result.url );
                        if( !fixedUrl )
                            throw "The returned request object defines an invalid 'url' property (" + JSON.stringify( result.url ) + ")";
                        result.url = fixedUrl;
                    }

					if( typeof result.uniqueKey !== 'string' )
						throw "The returned request object must define the 'uniqueKey' property of string type.";

					// only copy certain fields to newRequest, in order to preserve important
					// and non-stringifyable fields of the original newRequest object
					var logResult = {};
					var somethingChanged = false;
					requests.INTERCEPTABLE_REQUEST_FIELDS.forEach(function(field) {
					    if (newRequest[field] !== result[field]) somethingChanged = true;
						logResult[field] = newRequest[field] = result[field];
					});
					if (somethingChanged) {
					    // Only log this if something changed, otherwise debug log is just too fast and large
                        utils.log("Crawler.onNavigationRequested(): User-provided 'interceptRequest' function returned a modified result:\n" + JSON.stringify(logResult, undefined, 2), "debug");
                    }
				} else {
					utils.log("Crawler.onNavigationRequested(): User-provided 'interceptRequest' function returned null and thus canceled the request, continuing.", "debug");
					return;
				}
			} catch( e ) {
				// put the error info into current request, because newRequest might never make it to the queue
				if( this.currentRequest && this.currentRequest.type!=='InitialAboutBlank' ) {
					this.currentRequest.errorInfo += "Error invoking user-provided 'interceptRequest' function (for a new request coming from this one): " + e + "\n";
				} else {
					newRequest.errorInfo += "Error invoking user-provided 'interceptRequest' function (for THIS request): " + e + "\n";
				}
				utils.logException("Error invoking user-provided 'interceptRequest' function", e);
			}
		}

        if( !newRequest.willLoad ) {
			utils.log("Request will not be loaded (doesn't match any PURL etc.)", "debug");
			return;
		}

		// enqueue the request
        this.requestManager.addNewRequest(newRequest);
	} catch(e) {
		this.logPageError("An exception occurred while navigation was requested from the web page", e);
	}
};


/**
 * Called by PhantomJS when it is requested to open a new child window, e.g. using window.open().
 */
Crawler.prototype.onPageCreated = function onPageCreated(newPage) {
    "use strict";
    try {
        utils.log("Crawler.onPageCreated()", "debug");
        newPage.navigationLocked = true;
        newPage.onNavigationRequested = this.onNavigationRequested.bind(this);
        newPage.onClosing = function(closingPage) {
            utils.log("A child page is closing", "debug");
        };
    } catch(e) {
        this.logPageError("An exception occurred while new page object was being created", e);
    }
};


/**
  * Opens a new web page from the requests queue.
  */
Crawler.prototype.handleNextRequest = function handleNextRequest() {
	"use strict";
	try {
		utils.log("Crawler.handleNextRequest()", "debug");

		// close current web page to prevent this issue: http://stackoverflow.com/questions/15005830/phantomjs-using-too-many-threads
		// also, our tests showed that we can't simply reuse same page anyway, eventually new page load gets canceled
		if( this.webPage != null ) {
			try {
				// also close the child pages and stop JavaScript
				this.webPage.pages.forEach(function(childPage) {
					childPage.close();
				});
				this.webPage.stopJavaScript();
				this.webPage.close();
				this.webPage = null;
			} catch( e ) {
				utils.logException("An exception occurred while closing the page", e);
			} finally {
				this.webPage = null;
			}
		}

		// mark request as handled
		// NOTE: we need to do this after all clicks are processed, so that
		//       errors in the user-provided 'interceptRequest' function are reported back to control process
		if( this.currentRequest && this.currentRequest.type !== 'InitialAboutBlank' ) {
			this.requestManager.markRequestHandled(this.currentRequest);
		}

        // if this is single process crawl or boostrapping slave, and config.saveCookies is set
        // and cookies file was provided, save the current cookies to it
        // This way, other slave (non-bootstrapping) processes will be able to reuse the cookies
        // from first slave, for example to maintain a login
        // NOTE: this solution is not perfect, if there are more parallel processes
        // we have no guarantee that some other slaves won't be fired before a page login is finished
        // NOTE: this must be called here, because cookies might be set in page function!!!
        if( (!this.settings.isSlave || this.settings.isBootstrapper)
            && this.settings.cookiesJsonPath
            && this.config.saveCookies ) {
            utils.log("Saving "+phantom.cookies.length+" cookie(s) to: " + this.settings.cookiesJsonPath, "debug");
            try {
                fs.write(this.settings.cookiesJsonPath, JSON.stringify(phantom.cookies, null, 2), "w");
            } catch(e) {
                utils.logException("Cannot save cookies to " + this.settings.cookiesJsonPath, e);
            }
        }

		if( this.currentRequest && this.currentRequest.type === 'SingleUrl' ) {
			utils.log("Crawler ran with '--single' option, we are done.");
			this.exit();
			return;
		}

		// fetch next request to process
		// (we're using a callback function because this action might require access to server)
		this.requestManager.fetchNextRequest( function handleNextRequest_callback(request, statusMessage) {
			if( !request ) {
				utils.log("PhantomJS process is finished: " + statusMessage);
				this.exit();
				return;
			}

            if( request.loadingFinishedAt ) {
                utils.log("WARNING: fetchNextRequest returned request that was already crawled ("+this.currentRequest+")");
                this.exit();
                return;
            }

            // make sure we don't open next page before a random interval
            // specified in config.randomWaitBetweenRequests elapsed since the last request opened
            var millisToWait = 0;

            if( this.config.randomWaitBetweenRequests ) {
                // when the last page finished loading?
                var lastLoadedTime = 0; // by default 1 January 1970 00:00:00 UTC
                if( this.currentRequest && this.currentRequest.loadingFinishedAt && this.currentRequest.type !== 'InitialAboutBlank' ) {
                    // there is some previous page, just add protection against clock shift
                    lastLoadedTime = Math.min(this.currentRequest.loadingFinishedAt.getTime(), Date.now());
                } else if( this.settings.isSlave && !this.settings.isBootstrapper ) {
                    // this is the first request from a new non-bootstrapping slave,
                    // enforce waiting too (users can set maxCrawledPagesPerSlave to 1, effectively avoiding minimum wait)
                    lastLoadedTime = Date.now();
                }

                var rand = Math.round(utils.randomNormal(
                    this.config.randomWaitBetweenRequests.mean,
                    this.config.randomWaitBetweenRequests.stdev));
                millisToWait = Math.max(lastLoadedTime + rand - Date.now(), millisToWait);
                utils.log("Waiting " + millisToWait + " ms before loading next page", "debug");
            }

            setTimeout( function() {
                try {
                    this.currentRequest = request;

                    // reset last errors
                    this.lastResourceError = null;
                    this.lastResourceTimeoutResponse = null;

                    // and open the corresponding page in PhantomJS
                    this.webPage = this.newWebPage();
                    this.currentRequest.loadingStartedAt = new Date();

                    if( this.currentRequest.method === "POST" ) {
                        // HTTP POST request
                        // NOTE: logging POST request using the same convention as we have for startUrls
                        utils.log("OPEN | " + this.currentRequest.url + "[POST]" + this.currentRequest.postData);
                        var httpConf = {
                            operation: "POST",
                            data: this.currentRequest.postData
                        };
                        if( this.currentRequest.contentType ) {
                            httpConf.headers = {
                                "Content-Type": this.currentRequest.contentType
                            };
                        }
                        this.webPage.openUrl(this.currentRequest.url, httpConf, this.webPage.settings);
                    }
                    else {
                        // HTTP GET request
                        utils.log("OPEN | " + this.currentRequest.url);
                        this.webPage.open(this.currentRequest.url);
                    }
                    // sometimes PhantomJS forgets to call onLoadFinished(), hence this workaround
                    var self = this;
                    if( this.webPage.settings.resourceTimeout > 0 ) {
                        self.onLoadFinishedTimeoutId = setTimeout( function() {
                            self.onLoadFinished(self.webPage, 'timeout');
                        }, this.config.pageLoadTimeout || constants.DEFAULT_PAGE_LOAD_TIMEOUT_MILLIS );
                    }
                } catch(e) {
                    utils.logException("handleNextRequest() threw an exception (in setTimeout), this is a fatal error!", e);
                    this.exit();
                }
            }.bind(this), millisToWait);
		}.bind(this));
	} catch( e ) {
		utils.logException("handleNextRequest() threw an exception, this is a fatal error!", e);
        this.exit();
	}
};



/**
 * Gracefully closes the request manager and exits PhantomJS (with exit code 0).
 * Beware that the function might return immediately and continue in background!
 */
Crawler.prototype.exit = function exit() {
	utils.log("Shutting down PhantomJS process...");
	this.requestManager.close( function() {
        // don't call forceExit() immediately, so that log messages are flushed to stdout
        // also it seems that PhantomJS is more likely to crash without setTimeout()
        setTimeout( function() {
            utils.forceExit(0);
        }, 100);
	});
};

/**
 * Starts the crawler, either of a single URL or a complete crawl starting with 'startUrls' from config.
 * This method returns immediately but crawling continues in background.
 * @param mode Can be 'SINGLE_URL', 'CONFIG_START_URLS' or 'FETCH'
 * @param singleUrl
 */
Crawler.prototype.start = function start(mode, singleUrl) {
	"use strict";

	mode = mode.toUpperCase();

	// check args and config
	if( mode==='SINGLE_URL' && typeof(singleUrl) !== 'string' ) {
		throw new CrawlerError("For SINGLE_URL mode, parameter 'singleUrl' must be specified.");
	}
	if( mode==='CONFIG_START_URLS' && !this.config.startUrls.length ) {
		throw new CrawlerError("For CONFIG_START_URLS mode, some 'startUrls' must be specified in configuration.");
	}

    // let the request manager periodically check in with the server
    if( this.requestManager.schedulePeriodicPing )
        this.requestManager.schedulePeriodicPing();

	switch(mode) {
		case 'SINGLE_URL':
		case 'CONFIG_START_URLS':
			// First open "about:blank" page to have a page context for 'interceptRequest' function,
			// which might be invoked by the following onNavigationRequested() calls,
			// which then insert the singleUrl/startUrls into the request queue.
			// After that, start opening the queued pages.
			this.currentRequest = requests.createRequest();
			this.currentRequest.url = "about:blank";
			this.currentRequest.type = 'InitialAboutBlank';
			this.webPage = this.newWebPage();
			this.webPage.open( this.currentRequest.url, function(status) {
                try {
                    if( mode === 'SINGLE_URL' ) {
                        this.onNavigationRequested(singleUrl, 'SingleUrl', false, true, '', '', 'GET');
                    } else {
                        this.config.startUrls.forEach(function (rec) {
                            var options = {
                                type: 'StartUrl',
                                isMainFrame: true,
                                contentType: '',
                                label: rec.label
                            };

                            // if there's a [POST] directive in startUrl, send a POST request instead
                            var startUrl, postData, method;
                            var matches = rec.url.match(/(.*)\[POST\](.*)/);
                            if( matches && matches.length > 2 ) {
                                options.url = matches[1];
                                options.postData = matches[2];
                                options.method = 'POST';
                            } else {
                                options.url = rec.url;
                                options.postData = "";
                                options.method = 'GET';
                            }

                            this.onNavigationRequestedImpl(options);
                        }, this);
                    }
                    this.handleNextRequest();
                }
                catch(e) {
                    utils.logException("Error occurred while start the crawler", e);
                    utils.forceExit(63);
                }
			}.bind(this) );
			break;

		case 'FETCH':
			this.handleNextRequest();
			break;

		default:
			throw new CrawlerError("Parameter 'mode' has an unknown value ('"+mode+"').");
	}
};



