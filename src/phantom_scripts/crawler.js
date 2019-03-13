/*!
 * Configurable web crawler for PhantomJS.
 *
 * This file represents the main PhantomJS script that exectures the crawl.
 * Run "phantomjs crawler.js" to display command-line options.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014-2015 Apifier. All rights reserved.
 *
 */
"use strict";

/*global phantom*/

require('./modules/polyfills'); // always include polyfills first!

var system        = require('system');
var fs            = require('fs');
var utils         = require('./modules/utils');
var crawlerUtils  = require('./modules/crawlerutils');
var crawlerCore   = require('./modules/crawlercore');
var requests      = require('./modules/requests');
var masterModule  = require("./modules/slavemaster")


console.log("Configurable web crawler for PhantomJS.");
console.log("Copyright(c) 2015 Apifier. All rights reserved.");
console.log("");

// attach a fatal error handler
phantom.onError = function(msg, trace) {
	utils.log("FATAL ERROR: " + msg + "\n" + utils.traceToString(trace));
    utils.forceExit(999);
};

// print help
var args = system.args;
if( args.length <= 1 || ['-h', '-help', '--help', '-?', '--?'].indexOf(args[1].toLowerCase()) >= 0 ) {
	console.log("Usage: phantomjs crawler.js CONFIG_JS_FILE [--out=JSON_FILE] [--single=URL]");
	console.log("                            [--parallel=N [--phantom-args=JSON_FILE]] ");
	console.log("                            [--cookies=JSON_FILE] [--verbosePostData] [--dbg]");
	console.log("");
	console.log(" CONFIG_JS_FILE           Path to a JavaScript or JSON configuration file.");
	console.log(" --out=JSON_FILE          Saves crawling output to a JSON file.");
	console.log(" --single=URL             Crawls a single page specified by an URL.");
	console.log(" --parallel=N             Performs crawling in parallel, using at most ");
	console.log("                          N processes.");
	console.log(" --phantom-args=JSON_FILE JSON file specifying phantomjs command line args that");
	console.log("                          are passed to slave processes. The JSON must contain ");
	console.log("                          an array of arrays of strings. First slave takes args");
	console.log("                          from the first array, second from the second, etc.");
	console.log("                          When the end is reached, the cycle starts again.");
	console.log(" --cookies=JSON_FILE      JSON file with cookies. If it exists cookies will be");
	console.log("                          loaded from it. If config option saveCookies is set,");
	console.log("                          cookies will be saved to this file on every page load.");
	console.log(" --verbosePostData        Prints full HTTP POST data to the output JSON file.");
	console.log(" --dbg                    Runs the crawler in DEBUG mode.");
    utils.forceExit(10);
}

// parse command-line args
var configJsPath = args[1];
var outputJsonPath = undefined;
var singlePageUrl = undefined;
var phantomArgsJsonPath = undefined;
var settings = {
    maxParallelProcesses: null,
	cookiesJsonPath: null,
    phantomArgsArray: null
};
if( args.length < 2 || args.length > 6 ) {
	console.log("ERROR: Wrong number of arguments provided");
    utils.forceExit(20);
}
for( var i=2; i<args.length; i++ ) {
	var matches = /^--([a-zA-Z\-]+)(=(.*))?$/.exec(args[i]);
    //console.log("'"+args[i]+"': "+JSON.stringify(matches));
	switch( matches ? matches[1].toLowerCase() : null ) {
		case 'out': outputJsonPath = matches[3]; break;
		case 'single': singlePageUrl = matches[3]; break;
		case 'parallel': settings.maxParallelProcesses = matches[3]; break;
		case 'cookies': settings.cookiesJsonPath = matches[3]; break;
		case 'phantom-args': phantomArgsJsonPath = matches[3]; break;
		case 'verbosepostdata': utils.verbosePostData = true; break;
        case 'dbg': utils.isDebugMode = true; break;
		default:
			console.log("ERROR: Invalid command-line option '"+args[i]+"'");
            utils.forceExit(25);
	}
}

// checks for the '--parallel' option
if( settings.maxParallelProcesses!==null ) {
    settings.maxParallelProcesses = parseInt(settings.maxParallelProcesses, 10);
	if( isNaN(settings.maxParallelProcesses) || settings.maxParallelProcesses <= 0 ) {
		console.log("ERROR: The number in '--parallel=MAX_N' option must be a positive integer.");
        utils.forceExit(27);
	}
	if( singlePageUrl!==undefined ) {
		console.log("ERROR: Options '--single' and '--parallel' cannot be used together.");
        utils.forceExit(28);
	}
	// prefix local log messages to distinguish them from slave processes
	utils.logPrefix = masterModule.generateLogPrefix();
}
else {
	if( phantomArgsJsonPath ) {
		console.log("ERROR: Option '--phantom-args' can only be used together with '--parallel'.");
        utils.forceExit(29);
	}
}

// print system information
utils.logSystemInfo();

// read and validate configuration
var config = null;
try {
	config = crawlerUtils.readConfig(configJsPath);
}
catch(e) {
	utils.logException("Couldn't read configuration from file: " + configJsPath, e);
    utils.forceExit(40);
}

// open the output JSON file for writing
var outputJsonStream = null;
if( outputJsonPath!==undefined ) {
	try {
		outputJsonPath = fs.absolute(outputJsonPath);
		utils.log("Opening JSON output file: " + outputJsonPath);
		outputJsonStream = utils.openStreamUTF8( outputJsonPath );
	}
	catch(e) {
		utils.logException("Cannot write to file: " + outputJsonPath, e);
        utils.forceExit(50);
	}
}

// read the JSON file with PhantomJS args and check it
try {
    settings.phantomArgsArray = crawlerUtils.readPhantomArgsJsonFile(phantomArgsJsonPath);
}
catch(e) {
	utils.logException("Error loading JSON file with PhantomJS args: " + phantomArgsJsonPath, e);
    utils.forceExit(55);
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
		utils.forceExit(57);
	}
}

// helper variable to determine if crawling in a slave process or not
settings.isSlave = false;

// start crawling
try {
	//utils.log("Initializing LocalRequestManager...");
	var localRequestManager = requests.createLocalRequestManager(config, outputJsonStream);

	if( !settings.maxParallelProcesses ) {
		// single process mode
		var crawler = crawlerCore.createCrawler(config, localRequestManager, settings);
		if( singlePageUrl!==undefined ) {
			utils.log("Starting crawler in single-process mode, on a single page (" + singlePageUrl + ")...");
			crawler.start('SINGLE_URL', singlePageUrl);
		}
		else {
			utils.log("Starting crawler in single-process mode, on 'startUrls' from configuration...");
			crawler.start('CONFIG_START_URLS');
		}
	}
	else {
		// multi-process mode
		utils.log("Starting crawler in multi-process mode, using at most "+settings.maxParallelProcesses+" process(es)...");
		var master = masterModule.create(config, localRequestManager, settings);
		master.startServer();
		master.startCrawl();
	}

	// note that the execution falls through here and continues in callbacks
}
catch (e) {
	utils.logException("Cannot start the crawler", e);
    utils.forceExit(60);
}
