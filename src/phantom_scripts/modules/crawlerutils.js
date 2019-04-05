/*!
 * Configurable web crawler for PhantomJS.
 * This module contains helper functions related to the core crawler functionality.
 * They are also used by the actor.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014 Apifier. All rights reserved.
 *
 */
"use strict";

require('./polyfills');

var fs        = require('fs');
var utils     = require('./utils');
var pseudoUrl = require('./pseudourl');

/**
 * Loads a configuration from a JavaScript or JSON file and validates it.
 */
exports.readConfig = function readConfig(path) {
	path = fs.absolute(path);
	utils.log("Loading crawler configuration from: " + path);

    var config;
    if( /.json$/i.test(path) )
        config = JSON.parse(fs.read(path));
    else {
        config = require(path).crawlerConfig;
        if( typeof(config)==='undefined' )
            throw "The module doesn't export 'crawlerConfig' object.";
    }
	var validationError = this.prepareConfig(config);
	if( validationError ) {
		throw "Crawler configuration is not valid: " + validationError;
	}
	// save original file path, it's needed by master process
	config.originalPath = path;
	return config;
};


/**
 * Loads a JSON file with PhantomJS process arguments and validates it.
 */
exports.readPhantomArgsJsonFile = function readPhantomArgsJsonFile(path) {
	if( !path )
		return null;
	path = fs.absolute(path);
	utils.log("Opening JSON file with PhantomJS args: " + path);
	var json = fs.read(path);
	var arr = JSON.parse(json);
	if( arr && arr.constructor!==Array ) {
		throw "The top-level object must be an array.";
	}
	for( var i=0; i<arr.length; i++ ) {
		if( !arr[i] || arr[i].constructor!==Array ) {
			throw "The second-level object must be an array (index "+i+").";
		}
		for( var j=0; j<arr[i].length; j++ ) {
			if( typeof(arr[i][j]) !== 'string' ) {
				throw "The third-level object must be a string (index "+i+":"+j+").";
			}
		}
	}
	return arr;
};


/**
  * This function checks and prepares the crawler configuration and returns a string containing
  * a description of the error or null if everything is valid.
  */
exports.prepareConfig = function prepareConfig(config) {

	utils.log("crawlerUtils.prepareConfig()", "debug");

    try {
        var c = config;
        var fieldError;

        if( !c )
            throw "No configuration provided?!";
        if( typeof(c)!=='object' )
            throw "Configuration object is not an object?!";

        if( fieldError = this._validateField("id", c.id, "string") ) {
            throw fieldError;
        }

        // check 'startUrls'
        // it can be either an array of URLs or an array of objects { key: '', value: '' }
        // We want to normalize all these forms into an array of {label:'', url:''} objects
        var startUrlsFinal = [];
        if( !utils.isNullOrUndefined(c.startUrls) ) {
            if( !utils.isArray(c.startUrls) ) {
                throw "'startUrls' must be an array.";
            }
            c.startUrls.forEach(function (elem, index) {
                if( typeof(elem) === 'string' )
                    startUrlsFinal.push({label: null, url: elem});
                else if( typeof(elem)==='object'
                         && ( elem.key===null || elem.key===undefined || typeof(elem.key)==='string' )
                         && typeof(elem.value) === 'string' )
                    startUrlsFinal.push({label: utils.isEmpty(elem.key) ? null : elem.key, url: elem.value});
                else
                    throw "'startUrls' array must only contain strings or {key:String,value:String} objects ('" + elem + "' found at index " + index + ").";
                if( startUrlsFinal[startUrlsFinal.length - 1].url === '' )
                    throw "'startUrls' cannot contain an empty URL (at index " + index + ").";
            });
        }
        c.startUrls = startUrlsFinal;
        //utils.log("Found startUrls: " + JSON.stringify(c.startUrls, null, 2), "debug");

        if( fieldError = this._validateField("clickableElementsSelector", c.clickableElementsSelector, "string") ) {
            throw fieldError;
        }

        // Check and parse 'crawlPurls', it can be either an array of strings,
        // dictionary with keys and values or an array of {key:'', value:''} objects.
        // We want to normalize all these forms into an array of {label:'', purl:'', parsedPurl:{}} objects
        var crawlPurlsFinal = [];
        if( !utils.isNullOrUndefined(c.crawlPurls) ) {
            if( utils.isArray(c.crawlPurls) ) {
                // crawlPurls is an array
                if( c.crawlPurls.length > 0 ) {
                    if( typeof(c.crawlPurls[0]) === 'string' ) {
                        // crawlPurls must be an array of strings
                        c.crawlPurls.forEach(function (elem, index) {
                            if( typeof(elem) !== 'string' )
                                throw "'crawlPurls' array cannot mix string and non-string elements ('" + elem + "' found at index " + index + ").";
                            crawlPurlsFinal.push({label: null, purl: elem});
                        });
                    } else if( typeof(c.crawlPurls[0]) === 'object' ) {
                        // crawlPurls must be an array of {key:'', value:''} objects
                        c.crawlPurls.forEach(function (elem, index) {
                            if( typeof(elem) !== 'object'
                                || !( elem.key===null || elem.key===undefined || typeof(elem.key)==='string' )
                                || typeof(elem.value) !== 'string' )
                                throw "'crawlPurls' array contains an invalid object (at index " + index + ").";
                            // only copy key and value
                            crawlPurlsFinal.push({label: utils.isEmpty(elem.key) ? null : elem.key, purl: elem.value});
                        });
                    } else
                        throw "'crawlPurls' must be an array of strings, a dictionary or an array of {key:String,value:String} objects.";
                }
            } else if( typeof(c.crawlPurls) === 'object' ) {
                // crawlPurls must be a string:string dictionary
                for( var key in c.crawlPurls ) {
                    if( c.crawlPurls.hasOwnProperty(key) ) {
                        var val = c.crawlPurls[key];
                        if( typeof(key) !== 'string' && typeof(val) !== 'string' ) {
                            throw "'crawlPurls' dictionary must only contain string keys and values ('" + val + "' found at key '" + key + "').";
                        }
                        crawlPurlsFinal.push({label: key, purl: val});
                    }
                }
            } else {
                throw "'crawlPurls' must be an array of strings, a dictionary or an array of {key:String,value:String} objects.";
            }

            // parse PURLs (this will check for empty PURL)
            crawlPurlsFinal.forEach(function (rec, index) {
                try {
                    rec.parsedPurl = pseudoUrl.create(rec.purl);
                } catch( e ) {
                    utils.logException(e);
                    throw "'crawlPurls' contains an invalid PURL ('" + rec.purl + "' at key '" + rec.label + "'): " + e;
                }
            });
        }
        c.crawlPurls = crawlPurlsFinal;
        //utils.log("Found crawlPurls: " + JSON.stringify(c.crawlPurls, null, 2), "debug");


        // BACKWARD COMPATIBILITY: check 'searchAreaPurls'
        c.searchAreaPurlsParsed = [];
        if( !utils.isNullOrUndefined(c.searchAreaPurls) ) {
            if( c.crawlPurls.length > 0 )
                throw "'searchAreaPurls' cannot be used in combination with 'crawlPurls'.";
            if( !utils.isArray(c.searchAreaPurls) ) {
                throw "'searchAreaPurls' must be an array.";
            }
            for( var i = 0; i < c.searchAreaPurls.length; i++ ) {
                var purl = c.searchAreaPurls[i];
                if( !purl || typeof purl !== 'string' ) {
                    throw "'searchAreaPurls' array must only contain strings ('" + purl + "' found).";
                }
                try {
                    c.searchAreaPurlsParsed.push(pseudoUrl.create(purl));
                } catch( e ) {
                    utils.logException(e);
                    throw "'searchAreaPurls' array contains an invalid PURL ('" + purl + "'): " + e;
                }
            }
        }

        // BACKWARD COMPATIBILITY: check 'targetPagePurls'
        c.targetPagePurlsParsed = [];
        if( !utils.isNullOrUndefined(c.targetPagePurls) ) {
            if( c.crawlPurls.length > 0 )
                throw "'targetPagePurls' cannot be used in combination with 'crawlPurls'.";
            if( !utils.isArray(c.targetPagePurls) ) {
                throw "'targetPagePurls' must be an array.";
            }
            for( var i = 0; i < c.targetPagePurls.length; i++ ) {
                var purl = c.targetPagePurls[i];
                if( !purl || typeof purl !== 'string' ) {
                    throw "'targetPagePurls' array must only contain strings ('" + purl + "' found).";
                }
                try {
                    c.targetPagePurlsParsed.push(pseudoUrl.create(purl));
                } catch( e ) {
                    utils.logException(e);
                    throw "'targetPagePurls' array contains an invalid PURL ('" + purl + "'): " + e;
                }
            }
        }

        // issue warnings
        if( c.crawlPurls.length === 0 ) {
            if( c.searchAreaPurlsParsed.length === 0 && c.targetPagePurlsParsed.length === 0 ) {
                utils.log("No 'crawlPurls' specified in the configuration!", "warning");
            } else {
                utils.log("The 'searchAreaPurls' and 'targetPagePurls' configuration options are deprecated, use 'crawlPurls' instead!", "warning");
            }
        }

        // check simple fields
        if( fieldError = this._validateField("considerUrlFragment", c.considerUrlFragment, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxCrawlDepth", c.maxCrawlDepth, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxCrawledPages", c.maxCrawledPages, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxCrawledPagesPerSlave", c.maxCrawledPagesPerSlave, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxOutputPages", c.maxOutputPages, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxParallelRequests", c.maxParallelRequests, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxPageRetryCount", c.maxPageRetryCount, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("loadImages", c.loadImages, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("loadCss", c.loadCss, "boolean") ) {
            throw fieldError;
        }
        if( typeof(c.userAgent)!=='function' && (fieldError = this._validateField("userAgent", c.userAgent, "string")) ) {
            throw fieldError + " Alternatively, it can be a function returning a string.";
        }
        if( fieldError = this._validateField("resourceTimeout", c.resourceTimeout, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("pageLoadTimeout", c.pageFunctionTimeout, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("pageFunctionTimeout", c.pageFunctionTimeout, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("ignoreRobotsTxt", c.ignoreRobotsTxt, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("ignoreRelNofollow", c.ignoreRelNofollow, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("ignoreMetaNoindex", c.ignoreMetaNoindex, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("saveCookies", c.saveCookies, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("maxInfiniteScrollHeight", c.maxInfiniteScrollHeight, "number") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("injectJQuery", c.injectJQuery, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("injectUnderscoreJs", c.injectUnderscoreJs, "boolean") ) {
            throw fieldError;
        }
        if( fieldError = this._validateField("skipLoadingFrames", c.skipLoadingFrames, "boolean") ) {
            throw fieldError;
        }

        // check 'randomWaitBetweenRequests'
        // TODO: this one is not read from acts !!!
        if( !utils.isNullOrUndefined(c.randomWaitBetweenRequests) ) {
            if( typeof(c.randomWaitBetweenRequests)==='number' ) {
                // convert from number to { mean: X, stdev: Y }
                c.randomWaitBetweenRequests = {
                    mean: c.randomWaitBetweenRequests,
                    stdev: c.randomWaitBetweenRequests * 0.25
                };
            }
            else if( typeof(c.randomWaitBetweenRequests) !== 'object'
                || typeof(c.randomWaitBetweenRequests.mean) !== 'number'
                || typeof(c.randomWaitBetweenRequests.stdev) !== 'number' )
                throw "'randomWaitBetweenRequests' must be a number or an object with numeric properties 'mean' and 'stdev'.";
            //utils.log("Found randomWaitBetweenRequests: " + JSON.stringify(c.randomWaitBetweenRequests), "debug");
        }

        // check 'customHttpHeaders', it can either be a dictionary or array of {key:String, value:String} objects
        // any way, normalize it to a dictionary
        var customHttpHeadersFinal = {};
        if( !utils.isNullOrUndefined(c.customHttpHeaders) ) {
            if( utils.isArray(c.customHttpHeaders) ) {
                // customHttpHeaders must be an array of {key:String, value:String} objects
                if( c.customHttpHeaders.length > 0 ) {
                    if( typeof(c.customHttpHeaders[0]) === 'object' ) {
                        // customHttpHeaders must be an array of {key:'', value:''} objects
                        c.customHttpHeaders.forEach(function (elem, index) {
                            if( typeof(elem) !== 'object'
                                || typeof(elem.key) !== 'string'
                                || typeof(elem.value) !== 'string' )
                                throw "'customHttpHeaders' array contains an invalid object (at index " + index + ").";
                            customHttpHeadersFinal[elem.key] = elem.value;
                        });
                    } else
                        throw "'customHttpHeaders' must be a string dictionary or an array of {key:String,value:String} objects.";
                }
            } else if( typeof(c.customHttpHeaders) === 'object' ) {
                // customHttpHeaders must be a String:String dictionary
                for( var key in c.customHttpHeaders ) {
                    if( c.customHttpHeaders.hasOwnProperty(key) ) {
                        var val = c.customHttpHeaders[key];
                        if( typeof(key) !== 'string' || typeof(val) !== 'string' ) {
                            throw "'customHttpHeaders' dictionary must only contain string keys and values ('" + val + "' found at key '" + key + "').";
                        }
                        customHttpHeadersFinal[key] = val;
                    }
                }
            } else {
                throw "'customHttpHeaders' must be a dictionary or an array of {key:String,value:String} objects.";
            }
            if( customHttpHeadersFinal['']!==undefined )
                throw "'customHttpHeaders' cannot contain empty string as a key.";
        }
        c.customHttpHeaders = customHttpHeadersFinal;
        //utils.log("Found customHttpHeaders: " + JSON.stringify(c.customHttpHeaders,null,2), "debug");

        // check 'injectClientScripts'
        if( !utils.isNullOrUndefined(c.injectClientScripts) ) {
            if( !utils.isArray(c.injectClientScripts) ) {
                throw "'injectClientScripts' must be an array.";
            }
            for( var i = 0; i < c.injectClientScripts.length; i++ ) {
                if( !c.injectClientScripts[i] || typeof c.injectClientScripts[i] != 'string' ) {
                    throw "'injectClientScripts' array must only contain strings ('" + c.injectClientScripts[i] + "' found).";
                }
            }
            // TODO: check the files exist
        }

        // check 'pageFunction' from the configuration
        if( !utils.isNullOrUndefined(c.pageFunction)
            && !(c.pageFunction instanceof Function || typeof(c.pageFunction) === 'string') ) {
            throw "'pageFunction' must be a pure JavaScript function or string.";
        }

        // check 'interceptRequest'
        if( !utils.isNullOrUndefined(c.interceptRequest)
            && !(c.interceptRequest instanceof Function || typeof(c.interceptRequest) === 'string') ) {
            throw "'interceptRequest' must be a pure JavaScript function or string.";
        }

        // check 'customData'
        try {
            JSON.stringify(c.customData);
        } catch(e) {
            throw "'customData' cannot be stringified to JSON.";
        }

        // print complete configuration to log
        // (necessary to debug cloud service crawls)
       //utils.log("Configuration prepared: " + JSON.stringify(c,null,2));

        // all good
        c._isPrepared = true;
        return null;
    }
    catch(e) {
        if( typeof(e)==='string' )
            return e;
        else if(e)
            throw e;
        else
            throw new Error("An unknown error was thrown");
    }
};


/**
 * Helper method to validate simple configuration fields.
 * @private
 */
exports._validateField = function _validateField(name, value, type) {
	if( typeof value !== 'undefined' && value !== null && typeof(value) !== type ) {
		return "'"+name+"' must be a "+type+" value (was '"+value+"' of type '"+typeof(value)+"').";
	}
	return "";
};


/**
 * Injects 'polyfills.js' and 'clientutils.js' modules into a PhantomJS page.
 * The clientutils module will be accessible  via 'window.__context__.utils'.
 * Note that the name '__context__' might be changed in the future, in order
 * to prevent a detection of the Crawler by websites.
 * The function returns 'true' on success and 'false' otherwise.
 */
exports.injectClientUtils = function injectClientUtils(page) {
	"use strict";
	if( true === page.injectJs(utils.resolvePath('modules/polyfills.js'))
	    && true === page.injectJs(utils.resolvePath('modules/clientutils.js')) ) {
		var result = page.evaluate( function _injectClientUtils() {
			window.__clientUtils__ = new window.CrawlerClientUtils();
			window.__context__ = window.__context__ || {};
			window.__context__.utils = window.__clientUtils__;
			return true;
		});
		if( true === result ) {
			utils.log("CrawlerUtils.injectClientUtils(): injected client-side utilities to page", "debug");
			return true;
		}
	}
	return false;
};


/**
 * Determines whether injectClientUtils() has been calle on a page.
 */
exports.areClientUtilsInjected = function areClientUtilsInjected(page) {
	"use strict";
	var clientUtilsInjected = page.evaluate( function() {
		return typeof window.__context__ === "object" && typeof window.__context__.utils === "object";
	});
	return clientUtilsInjected;
};


/**
 * Injects the 'jquery.js' module into a PhantomJS page. The jQuery object is included in the no-conflict
 * mode and is accessible via 'window.__context__.jQuery'. Note that the name '__context__' might
 * be changed in the future, in order to prevent a detection of  the Crawler by websites.
 * If 'isDebugMode' is false or undefined, the function injects the 'jquery.min.js' module.
 * The function returns 'true' on success and 'false' otherwise.
 */
exports.injectJQuery = function injectJQuery(page) {
	"use strict";
	// when ran from CasperJS, the base directory is the CasperJS directory
	var path = this.resolveClientScriptPath('thirdparty/jquery.js');
	if( true === page.injectJs(path) ) {
		// in the page context, don't override the 'window.$' variable,
		// it might be used by the page itself
		var result = page.evaluate( function _injectJQuery() {
			window.__context__ = window.__context__ || {};
			window.__context__.jQuery = $.noConflict(true);
			return true;
		});
		if( true === result ) {
			utils.log("CrawlerUtils.injectJQuery(): injected jQuery to page", "debug");
			return true;
		}
	}
	return false;
};


/**
 * Injects the 'underscore.js' module into a PhantomJS page. The jQuery object is included in the no-conflict
 * mode and is accessible via 'window.__context__.underscoreJs'. Note that the name '__context__' might
 * be changed in the future, in order to prevent a detection of  the Crawler by websites.
 * If 'isDebugMode' is false or undefined, the function injects the 'underscore.min.js' module.
 * The function returns 'true' on success and 'false' otherwise.
 */
exports.injectUnderscoreJs = function injectUnderscoreJs(page) {
	"use strict";
	// when ran from CasperJS, the base directory is the CasperJS directory
	var path = this.resolveClientScriptPath('thirdparty/underscore.js');
	if( true === page.injectJs(path) ) {
		// in the page context, don't override the 'window._' variable,
		// it might be used by the page itself
		var result = page.evaluate( function _injectUnderscoreJs() {
			window.__context__ = window.__context__ || {};
			window.__context__.underscoreJs = _.noConflict();
			return true;
		});
		if( true === result ) {
			utils.log("CrawlerUtils.injectUnderscoreJs(): injected underscore.js to page", "debug");
			return true;
		}
	}
	return false;
};


/**
 * Injects a set of user scripts (specified by an array of paths) to the current web page.
 * The method throws an exception if a script cannot be injected.
 */
exports.injectClientScripts = function injectClientScripts(page, clientScriptPaths) {
	"use strict";
	clientScriptPaths.forEach( function _forEachClientScript(path) {
		// TODO: the path should be relative to the config script, not the main script !!!
		path = this.resolveClientScriptPath(path);
        if( page.injectJs(path) ) {
            utils.log("CrawlerUtils.injectClientScripts(): injected user script from '"+path+"' to page", "debug");
        } else {
			throw new Error("Failed injecting '"+path+"' client script, check that the path is correct!");
        }
	}.bind(this) );
};

/**
 * Resolves a full path to a client script file, using the utils.resolvePath() function.
 * Additionally, if not in DEBUG mode, the function checks if there's a minified version
 * of the client script (ending with ".min.js") and if so, injects this version instead.
 * @param path
 */
exports.resolveClientScriptPath = function resolveClientScriptPath(path) {
	"use strict";
	var path = utils.resolvePath(path);
	if( !utils.isDebugMode && path.endsWith(".js") ) {
		var pathMinified = path.substr(0, path.length-3) + ".min.js";
		if( fs.exists(pathMinified) && fs.isFile(pathMinified) ) {
			path = pathMinified;
		}
	}
	return path;
};

/**
 * Injects a request object into window.__context__ object on the web page.
 */
exports.injectRequestObject = function injectRequestObject(page, request, customData, actorRunId, actorTaskId) {
	"use strict";

	page.evaluate( function _injectRequestObject(request, customData, actorRunId, actorTaskId) {
		var context     = window.__context__   = window.__context__   || {};
		var userFlags   = window.__userFlags__ = window.__userFlags__ || {};
		var jsonStringify = window.__clientUtils__ && window.__clientUtils__.safeJsonStringify ? window.__clientUtils__.safeJsonStringify : JSON.stringify;
		context.request = request;
        context.customData = customData;
        context.stats = request._stats;
        context.actorRunId = actorRunId;
        context.actorTaskId = actorTaskId;
        delete request._stats;
		var requestId = request.id;
		// attach special functions for user
		context.skipLinks = function() {
            userFlags.skipLinks = true;
		};
		context.skipOutput = function() {
            userFlags.skipOutput = true;
		};
		context.willFinishLater = function() {
            userFlags.willFinishLater = true;
		};
		context.finish = function(result) {
			// ignore repeated finish() calls
			if( userFlags.finished )
				return;
			userFlags.finished = true;
			// ensure the normal pageFunction return will also be ignored
			userFlags.willFinishLater = true;
			// notify crawler that pageFunction finished
            if( typeof(window.callPhantom) === 'function' ) {
                // make sure this is not called when pageFunction is still executing, otherwise it causes that
                // findClickableElements() function is called inside pageFunction, causing weird effects
                // NOTE: we use JSON.stringify() because PhantomJS would otherwise convert null values to string !!!
                setTimeout( function() {
                    window.callPhantom(jsonStringify({
                        messageType: "PAGE_FUNCTION_FINISHED",
                        requestId: requestId, // to ensure the call corresponds to the current request
                        pageFunctionResult: result,
                        userFlags: userFlags // to speed things up
                    }));
                }, 0);
            } else {
                // TODO: log warning and handle this situation, but first wait until this really happens!
				alert("WARNING: web page destroyed window.callPhantom !?!");
            }
		};
		context.enqueuePage = function(url, method, postData, contentType) {
		    var msg = {
                messageType: "USER_ENQUEUED_PAGE",
                requestId: requestId, // to ensure the call corresponds to the current request
                userFlags: userFlags // to speed things up
            };
		    if( typeof(url)==='object' ) {
		        // new way of calling this function as enqueuePage(object)s
                msg.options = url;
            } else {
                // legacy way of calling this method
                msg.options = {
                    url: url,
                    method: method,
                    postData: postData,
                    contentType: contentType
                };
            }
			if( typeof(window.callPhantom) === 'function' ) {
				window.callPhantom(jsonStringify(msg));
			} else {
				// TODO: same as above
				alert("WARNING: web page destroyed window.callPhantom !?!");
			}
		};
		context.saveSnapshot = function(customName) {
			if( typeof(window.callPhantom) === 'function' ) {
				window.callPhantom(jsonStringify({
					messageType: "SAVE_SNAPSHOT",
					requestId: requestId, // to ensure the call corresponds to the current request
					customName: customName
				}));
			} else {
				// TODO: same as above
				alert("WARNING: web page destroyed window.callPhantom !?!");
			}
		};
        context.saveCookies = function(cookies) {
            if (cookies && cookies.constructor!==Array) {
                throw new Error("Parameter 'cookies' must be an array!");
            }
            if( typeof(window.callPhantom) === 'function' ) {
                window.callPhantom(jsonStringify({
                    messageType: "SAVE_COOKIES",
                    requestId: requestId, // to ensure the call corresponds to the current request
                    cookies: cookies,
                }));
            } else {
                // TODO: same as above
                alert("WARNING: web page destroyed window.callPhantom !?!");
            }
        };

		return true;
	}, request.explicitToJSON(true), customData, actorRunId, actorTaskId);
	return true; // always successful
};

/**
 * Gets user flags object injected by injectRequestObject(), which contains user-provided instructions
 * from the pageFunction.
 */
exports.getInjectedUserFlags = function getInjectedUserFlags(page) {
	"use strict";
    if( !page )
        return null;
	return page.evaluate( function() {
		return window.__userFlags__;
	});
};

/**
 * Invokes a user-provided function in the context of the web page.
 * The method either returns the result returned by the page function,
 * or throws a string exception that contains details of the error.
 */
exports.invokeUserFunction = function invokeUserFunction(page, func, arg) {
	"use strict";

	if( !(func instanceof Function) && typeof(func)!=='string' )
		throw new Error("The 'func' parameter of invokeUserFunction() must be a pure JavaScript function or string.");

	// NOTE: we stringify the result ourselves, because PhantomJS' evaluateJavaScript()
	//       would recursively convert null values to empty string which used to cause weird bugs

    var js = 'function _invokeUserFunction() {' +
		'try {' +
		'    var result = (' + func.toString() + ')(window.__context__' + (arg ? ',' + JSON.stringify(arg) : '') + ');' +
        '    return (window.__clientUtils__ && window.__clientUtils__.safeJsonStringify ? window.__clientUtils__.safeJsonStringify : JSON.stringify)(result);' +
		'} catch(e) {' +
		'    return "__INVOKE_USER_FUNCTION_ERROR__:"+e;' +
		'}}';

	var prevOnError = page.onError;

	try	{
		// track JavaScript errors on the page
		var lastError = { message: null };
		page.onError = function myOnError(msg, trace) {
			var trace = utils.traceToString(trace);
			lastError.message = msg + ( trace ? "\n" + trace : "" );
		};

		var result = page.evaluateJavaScript(js);

		if( lastError.message != null ) {
			// PhantomJS caught an error in evaluateJavaScript()
			throw new Error(lastError.message);
		}
		else if( typeof(result) === "string" && result.indexOf("__INVOKE_USER_FUNCTION_ERROR__:")===0 ) {
			// user function threw an error that we caught
			throw new Error(result.replace("__INVOKE_USER_FUNCTION_ERROR__:", ""));
		}
		else {
			// user function returned a JSON-encoded value...
			return JSON.parse(result);
		}
	} finally {
		// restore the previous handler !!!
		page.onError = prevOnError;
	}
};


/**
 * Invokes a client side utils object method within the remote page, with arguments.
 *
 * @param  {String}   method  Method name
 * @return {...args}          Arguments
 * @return {Mixed}
 */
exports.callClientUtils = function callClientUtils(page, method) {
	"use strict";
	var args = [].slice.call(arguments, 1);
	var result = page.evaluate( function(method, args) {
		return window.__clientUtils__.__call(method, args);
	}, method, args);
	if( typeof(result)==='object' && result.__isCallError ) {
		throw new Error("callUtils("+method+") with args "+args+" threw an error: " + result.message);
	}
	return result;
};


/**
 * Emulates a mouse click in a web browser window.
 */
exports.sendClick = function sendClick(page, x, y) {
	"use strict";
	utils.log("CrawlerUtils.sendClick(): x="+x+", y="+y+"", "debug");
	try {
		// scroll the webpage's viewport so that [x,y] is "visible" !
		var viewportSize = page.viewportSize;
		var documentSize = this.callClientUtils(page, 'getDocumentSize');
		var oldScrollPosition = page.scrollPosition;
		var newScrollPosition = {
			left: Math.max(0, Math.min(Math.floor(x - viewportSize.width/2), documentSize.width-viewportSize.width)),
			top: Math.max(0, Math.min(Math.floor(y - viewportSize.height/2), documentSize.height-viewportSize.height))
		};
		if( oldScrollPosition.left != newScrollPosition.left || oldScrollPosition.top != newScrollPosition.top )
			page.scrollPosition = newScrollPosition;

		// use the true scrollPosition value for click coordinates computation
		newScrollPosition = page.scrollPosition;
		page.sendEvent("click", x-newScrollPosition.left, y-newScrollPosition.top);
		return true;
	} catch(e) {
		utils.logException("Couldn't emulate 'click' event at X="+x+", Y="+y, e);
		return false;
	}
};


/**
 * Scrolls the page down to load a dynamic content for pages with "infinite scroll".
 * The page is scrolled as long as there's more content loading and until a certain maximum height.
 * Note that it is not sufficient to set a large height to the virtual browser window,
 * because typically the content loads only if the window is actually scrolled.
 */
exports.infiniteScroll = function infiniteScroll(page, maxHeight, onFinished, callPageResourceHandlers) {
	"use strict";
	utils.log("CrawlerUtils.infiniteScroll(): maxHeight="+maxHeight, "debug");

	// save original page handlers
	var original = {
		onResourceRequested: page.onResourceRequested,
		onResourceReceived: page.onResourceReceived,
		onResourceTimeout: page.onResourceTimeout,
		onResourceError: page.onResourceError
	};

	// compute stats about the resources loaded
	var resourcesStats = {
		requested: 0,
		received: 0,
		timeout: 0,
		err: 0, // not using word "error", people search for it in log files to find real errors
		forgotten: 0
	};

	// track when resources were requested by the page during scrolling and weren't loaded yet,
	// key is resource ID, value is Date.now() when the resource was requested
	var pendingResources = {};
	page.onResourceRequested = function _onResourceRequested(requestData, networkRequest) {
		"use strict";
		pendingResources[requestData.id] = Date.now();
		resourcesStats.requested++;
		if( callPageResourceHandlers && original.onResourceRequested ) {
			original.onResourceRequested(requestData, networkRequest);
		}
	};
	page.onResourceReceived = function _onResourceReceived(response) {
		"use strict";
		var wasIn = false;
		if (response.id in pendingResources) {
			wasIn = true;
			if (response.stage === "end") {
				delete pendingResources[response.id];
				resourcesStats.received++;
			}
		}
		if ((callPageResourceHandlers || !wasIn) && original.onResourceReceived) {
			original.onResourceReceived(response);
		}
	};
	page.onResourceTimeout = function _onResourceTimeout(request) {
		"use strict";
		var wasIn = false;
		if (request.id in pendingResources) {
			wasIn = true;
			delete pendingResources[request.id];
			resourcesStats.timeout++;
		}
		if ((callPageResourceHandlers || !wasIn) && original.onResourceTimeout) {
			original.onResourceTimeout(request);
		}
	};
	page.onResourceError = function _onResourceError(resourceError) {
		"use strict";
		var wasIn = false;
		if( resourceError.id in pendingResources ) {
			wasIn = true;
			delete pendingResources[resourceError.id];
			resourcesStats.err++;
		}
		if( (callPageResourceHandlers || !wasIn) && original.onResourceError ) {
			original.onResourceError(resourceError);
		}
	};

	// function restores original page handlers and invokes user callback
	var finish = function _infiniteScroll_finish(status) {
		//utils.log("infiniteScroll(): finished with '"+status+"'", "debug");
		page.onResourceRequested = original.onResourceRequested;
		page.onResourceTimeout = original.onResourceTimeout;
		page.onResourceError = original.onResourceError;

        // scroll back up, otherwise the screenshot of the browser would only show the bottom of the page
        page.scrollPosition = { top: 0, left: 0 };

		if( onFinished ) {
			onFinished(status);
		}
	};

	// function that is periodically invoked to perform the infinitely scroll
	var crawlerUtils = this;
	var firstTime = true;
	var heartBeat = function _infiniteScroll_heartBeat() {
		try {
			var viewportSize = page.viewportSize;
			var scrollPosition = page.scrollPosition;
			var documentSize = crawlerUtils.callClientUtils(page, 'getDocumentSize');

			//utils.log("infiniteScroll(): scrollPosition="+JSON.stringify(scrollPosition)+", documentSize="+JSON.stringify(documentSize)+", viewportSize="+JSON.stringify(viewportSize)+", pendingReqs="+Object.keys(pendingResources).length, "debug");

			// forget pending resources that didn't finish loading in time
			// (sometimes resources stay forever in "start" stage and
			//  neither onResourceTimeout nor onResourceError gets called)
			var now = Date.now();
			var timeout = page.settings.resourceTimeout || 30000;
			for( var requestId in pendingResources ) {
				if( pendingResources[requestId] + timeout < now ) {
					delete pendingResources[requestId];
					resourcesStats.forgotten++;
				}
			}

			// if there are no more pending requests
			if( Object.keys(pendingResources).length === 0 ) {
				// if the page is scrolled to the very bottom or beyond maximum height, we are done
				if( scrollPosition.top + viewportSize.height >= Math.min(documentSize.height, maxHeight) ) {
                    // show this message all the time for infinite scroll debugging (was if(!firstTime))
					utils.log("Infinite scroll finished (scrollPosition.top=" + scrollPosition.top + ", viewportSize.height=" + viewportSize.height + ", documentSize.height=" + documentSize.height + ", maxHeight=" + maxHeight + ", resourcesStats="+JSON.stringify(resourcesStats)+")");
					finish('success');
					return;
				}

				// scroll down one full page
				var newScrollPosition = {
					top: scrollPosition.top + viewportSize.height,
					left: scrollPosition.left
				};
				if( newScrollPosition.top + viewportSize.height > documentSize.height ) {
					newScrollPosition.top = documentSize.height - viewportSize.height;
				}
				if( newScrollPosition.top < 0 ) {
					newScrollPosition.top = 0;
				}
				if( firstTime && newScrollPosition.top != scrollPosition.top ) {
					firstTime = false;
					utils.log("Infinite scroll started (scrollPosition.top=" + scrollPosition.top + ", viewportSize.height=" + viewportSize.height + ", documentSize.height=" + documentSize.height + ", maxHeight=" + maxHeight + ")");
				}
				page.scrollPosition = newScrollPosition;
				//utils.log("infiniteScroll(): scrolling to top=" + scrollPosition.top, "debug");
			}

            // do this again in a while...
            // NOTE: previously we had 200 ms here, but then infinite scroll didn't work on the following web:
            // http://www.topshop.com/en/tsuk/category/clothing-427/N-82zZdgl?No=0&Nrpp=20&siteId=%2F12556&geoip=noredirect
            setTimeout( heartBeat, 400 );
		} catch(e) {
			utils.logException("An exception thrown in infiniteScroll():heartBeat", e);
			finish('fail');
		}
	};

	// start scrolling
	setTimeout( heartBeat, 0 );
}
