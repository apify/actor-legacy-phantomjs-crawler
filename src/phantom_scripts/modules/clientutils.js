/*!
 * Configurable web crawler for PhantomJS.
 * This module contains utility functions that are injected to every crawled page.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014-2015 Apifier. All rights reserved.
 *
 */
 "use strict";

/*global console, window*/

// NOTE: we need to attach utils directly to windows and avoid using the 'typeof exports ===  "object" ? exports : window' trick,
// because some web sites (e.g. http://www.bodychef.com/) define "exports" object which broke our crawler!


/**
 * Crawler client-side helpers. Note that we need to use a different name than CasperJS's 'ClientUtils'.
 */
window.CrawlerClientUtils = function CrawlerClientUtils() {

	/**
	 * Logs a message. Will format the message a way the crawler will be able
	 * to log phantomjs side.
	 *
	 * @param  String  message  The message to log
	 * @param  String  level    The log level
	 */
	this.log = function log(message, level) {
		"use strict";
		// TODO: parse this on crawler side!!!
		console.log("[crawler:" + (level || "debug") + "] " + message);
	};

	/**
	 * Emualtes a click at a DOM element.
	 *
	 * @param  String  elem  A DOM element
	 * @return Boolean
	 */
	this.click = function click(elem) {
		"use strict";
		return this.mouseEvent('click', elem);
	};

	/**
	 * Dispatches a mouse event to the DOM element behind.
	 *
	 * @param  String   type     Type of event to dispatch
	 * @param  String   elem   A DOM element to click
	 * @return Boolean
	 */
	this.mouseEvent = function mouseEvent(type, elem) {
		"use strict";
		if( !elem ) {
			this.log("mouseEvent(): Parameter 'elem' must be provided.", "error");
			return false;
		}
		try {
			var evt = document.createEvent("MouseEvents");
			var x = 1, y = 1;
			try {
				var pos = elem.getBoundingClientRect();
				x = Math.floor((pos.left + pos.right) / 2);
				y = Math.floor((pos.top + pos.bottom) / 2);
			} catch(e) {}
			evt.initMouseEvent(type, true, true, window, 1, 1, 1, x, y, false, false, false, false, 0, elem);
			// dispatchEvent return value is false if at least one of the event
			// handlers which handled this event called preventDefault;
			// so we cannot returns this results as it cannot accurately informs on the status
			// of the operation
			// let's assume the event has been sent ok it didn't raise any error
			elem.dispatchEvent(evt);
			return true;
		} catch (e) {
			this.log("mouseEvent(): Failed dispatching " + type + " mouse event on " + elem + ": " + e, "error");
			return false;
		}
	};

	/**
	 * Retrieves total document width and height, represented as an array [width, height].
	 */
	this.getDocumentSize = function getDocumentSize() {
		"use strict";
		// inspired by http://james.padolsey.com/javascript/get-document-height-cross-browser/
		// NOTE: once it happened that document.body is not yet defined, if the page was just loaded!
		// (pages http://dilbert.com/strip/1989-04-16 and then http://dilbert.com/strip/1989-04-17)
		var body = document.body || {};
		var doc = document.documentElement || {};
		var width = Math.max(
			Math.max(body.scrollWidth || 0, doc.scrollWidth || 0),
			Math.max(body.offsetWidth || 0, doc.offsetWidth || 0),
			Math.max(body.clientWidth || 0, doc.clientWidth || 0) );
		var height = Math.max(
			Math.max(body.scrollHeight || 0, doc.scrollHeight || 0),
			Math.max(body.offsetHeight || 0, doc.offsetHeight || 0),
			Math.max(body.clientHeight || 0, doc.clientHeight || 0)	);
		return {width: width, height: height};
	};

	/**
	 * Parses an URL and returns an object with its components.
	 * Code inspired by http://blog.stevenlevithan.com/archives/parseuri
     * NOTE: this code is also in src/commons/utilities.phantom.js but it cannot be easily re-used...
	 */
	this.parseUrl = function parseUrl(str) {
		if( typeof(str)!=='string')
			return {};
		var o   = {
					strictMode: false,
					key: ["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","fragment"],
					q:   {
						name:   "queryKey",
						parser: /(?:^|&)([^&=]*)=?([^&]*)/g
					},
					parser: {
						strict: /^(?:([^:\/?#]+):)?(?:\/\/((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?))?((((?:[^?#\/]*\/)*)([^?#]*))(?:\?([^#]*))?(?:#(.*))?)/,
						loose:  /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/
					}
				  },
			m   = o.parser[o.strictMode ? "strict" : "loose"].exec(str),
			uri = {},
			i   = 14;

		while (i--) uri[o.key[i]] = m[i] || "";

		uri[o.q.name] = {};
		uri[o.key[12]].replace(o.q.parser, function ($0, $1, $2) {
			if ($1) uri[o.q.name][$1] = $2;
		});

		// our extension - parse fragment using a query string format (i.e. "#key1=val1&key2=val2")
		// this format is used by many websites
		uri['fragmentKey'] = {};
		if( uri['fragment'] ) {
			uri['fragment'].replace(o.q.parser, function ($0, $1, $2) {
				if ($1) uri['fragmentKey'][$1] = $2;
			});
		}

		return uri;
	};

	/**
	 * Calls a method part of the current prototype, with arguments.
	 *
	 * @param  {String} method Method name
	 * @param  {Array}  args   arguments
	 * @return {Mixed}
	 */
	this.__call = function __call(method, args) {
		if (method === "__call") {
			return;
		}
		try {
			return this[method].apply(this, args);
		} catch(err) {
			err.__isCallError = true;
			return err;
		}
	};

    // NOTE: safeJsonStringify is to ensure that page-provided toJSON() functions won't be called. For example,
    // page at http://www.logarun.com/leaderboards.aspx defines toJSON function on Array.prototype,
    // which causes: Error invoking user-provided 'pageFunction': Error: TypeError: undefined is not a function (evaluating 'this[i].toJSON()')
    this.safeJsonStringify = function(value, replacer, space) {
        var types = [Array, Date, Object, Number, Boolean, String];
        var prevToJson = [];
        for (var i=0; i<types.length; i++) {
            prevToJson.push(types[i].prototype.toJSON);
            delete types[i].prototype.toJSON;
        }
        // see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toJSON !!!
        Date.prototype.toJSON = Date.prototype.toISOString;
        try {
            return JSON.stringify(value, replacer, space);
        } finally {
            for (var i=0; i<types.length; i++) {
                if (prevToJson[i] !== undefined) types[i].prototype.toJSON = prevToJson[i];
            }
        }
    };

};
