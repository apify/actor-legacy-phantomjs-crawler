/*!
 * Configurable web crawler for PhantomJS.
 *
 * This file represents the main PhantomJS script that exectues the crawl.
 * Run "phantomjs crawler.js" to display command-line options.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014-2015 Apifier. All rights reserved.
 *
 */
"use strict";

/*global phantom*/

require('./modules/polyfills');

var fs           = require('fs');
var system       = require('system');
var utils        = require('./modules/utils');
var constants    = require('./modules/constants');
var crawlerUtils = require('./modules/crawlerutils');
var crawlerCore  = require('./modules/crawlercore');
var requests     = require('./modules/requests');

// attach a fatal error handler
phantom.onError = function(msg, trace) {
	utils.log("FATAL ERROR: " + msg + "\n" + utils.traceToString(trace));
	utils.forceExit(999);
};

// parse command-line args
var args = system.args;
if( args.length < 3 || args.length > 7 ) {
	console.log("Configurable web crawler for PhantomJS: a slave process module.");
	console.log("Copyright(c) 2015 Apifier. All rights reserved.");
	console.log("");
	console.log("Usage: phantomjs crawler-slave.js CONFIG_JS_FILE MASTER_SERVER_URL LOG_PREFIX");
	console.log("                                  [--bootstrap] [--cookies=JSON_FILE] [--dbg]");
	console.log("");
	console.log(" CONFIG_JS_FILE      Path to a crawler JavaScript or JSON configuration file.");
	console.log(" MASTER_SERVER_URL   URL to the master server that controls the crawling.");
	console.log(" LOG_PREFIX          Prefix used to distinguish log messages from this slave.");
	console.log(" --bootstrap         If specified, the crawler only sends the server requests");
	console.log("                     to open 'startUrls' from configuration and then exits.");
	console.log(" --cookies=JSON_FILE JSON file with session and normal cookies to load.");
	console.log("                     If --bootstrap used, the cookies file will also be");
	console.log("                     updated with the new cookies after every page load");
	console.log(" --cookies=JSON_FILE JSON file with cookies. If it exists cookies will be");
	console.log("                     loaded from it. If config option saveCookies is set");
	console.log("                     and --bootstrap is used, cookies will be saved to this");
	console.log("                     file on every page load.");
	console.log(" --dbg               Runs the crawler in DEBUG mode.");
    utils.forceExit(10);
}
var configJsPath = args[1];
var masterServerUrl = args[2];
utils.logPrefix = args[3];
var settings = {};
for( var i=4; i<args.length; i++ ) {
	var matches = /^--([a-zA-Z\-]+)(=(.*))?$/.exec(args[i]);
	switch( matches ? matches[1].toLowerCase() : null ) {
		case 'bootstrap': settings.isBootstrapper = true; break;
		case 'dbg': utils.isDebugMode = true; break;
		case 'cookies': settings.cookiesJsonPath = matches[3]; break;
		default:
			console.log("ERROR: Invalid command-line option '"+args[i]+"'");
			utils.forceExit(25);
	}
}

// try to read and parse JSON file with cookies
if( settings.cookiesJsonPath && fs.exists(settings.cookiesJsonPath) ) {
	try {
		var cookies = JSON.parse(fs.read(settings.cookiesJsonPath));
		Array.prototype.forEach.call(cookies, function (x) {
			phantom.addCookie(x);
		});
		utils.log("Loaded "+cookies.length+" cookie(s) from: " + settings.cookiesJsonPath);
	}
	catch( e ) {
		utils.logException("Error loading JSON file with cookies: " + settings.cookiesJsonPath, e);
		utils.forceExit(27);
	}
}

// read and validate configuration
var config = null;
try {
	config = crawlerUtils.readConfig(configJsPath);
}
catch(e) {
	utils.logException("Couldn't read configuration from file: " + configJsPath, e);
    utils.forceExit(40);
}

// Generate random User-Agent if rotateUserAgents is set
if (config.rotateUserAgents) {
    config.userAgent = constants.USER_AGENT_LIST[utils.getRandomInt(0, constants.USER_AGENT_LIST.length)];
    if (config.customHttpHeaders && config.customHttpHeaders['User-Agent']) delete config.customHttpHeaders['User-Agent'];
}

// helper variable to determine if crawling in a slave process or not
settings.isSlave = true;

// start the crawler
try {
	utils.log("Starting crawler using RemoteRequestManager (URL: "+masterServerUrl+", bootstrap: "+settings.isBootstrapper+")...");
	var requestManager = requests.createRemoteRequestManager(config, masterServerUrl);
	var crawler = crawlerCore.createCrawler(config, requestManager, settings);
	crawler.start(settings.isBootstrapper ? 'CONFIG_START_URLS' : 'FETCH');
}
catch (e) {
	utils.logException("Cannot start the crawler", e);
    utils.forceExit(60);
}
