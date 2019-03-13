/*!
 * Configurable web crawler for PhantomJS.
 * This module contains various utility and helper functions.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014 Apifier. All rights reserved.
 *
 */
"use strict";

var system = require('system');
var fs     = require('fs');


// include PhantomJS utils from apifier-commons package (we have some code there because we have unit tests there...)
var utilsPhantom;
try {
    utilsPhantom = require( '../../commons/utilities.phantom' );
} catch(e) {
    // try to fallback to current dir, in release build it's packed there
    utilsPhantom = require('./utilities.phantom');
}
// and reuse all utility functions defined in utilities.phantom.js
for( var key in utilsPhantom )
    exports[key] = utilsPhantom[key];



/**
 * Indicates whether DEBUG mode is enabled. In this mode, log messages with "debug" level will be printed out
 * by the log() function and non-minified versions of client scripts will be injected to pages.
 */
exports.isDebugMode = false;

/**
 * Indicates whether HTTP POST data from captured requests should be printed fully to the output JSON file.
 * Note that POST data can be very large. By default this option is false, so that
 * output files are not polluted with large chunks of texts.
 */
exports.verbosePostData = false;


/**
 * Formats a string with passed parameters. Ported from nodejs `util.format()`.
 *
 * @return String
 */
exports.format = function format(f) {
	"use strict";
	var i = 1;
	var args = arguments;
	var len = args.length;
	var str = String(f).replace(/%[sdj%]/g, function _replace(x) {
		if (i >= len) {
			return x;
		}
		switch (x) {
			case '%s':
				return String(args[i++]);
			case '%d':
				return Number(args[i++]);
			case '%j':
				return JSON.stringify(args[i++]);
			case '%%':
				return '%';
			default:
				return x;
		}
	});
	for (var x = args[i]; i < len; x = args[++i]) {
		if (x === null || typeof x !== 'object') {
			str += ' ' + x;
		} else {
			str += '[obj]';
		}
	}
	return str;
};


exports.dateToString = function dateToString(date, middleT) {
	"use strict";
	if( typeof(date)!=='object' )
		return "";
	var year = date.getFullYear();
	var month = date.getMonth() + 1; // January is 0, February is 1, and so on.
	var day = date.getDate();
	var hours = date.getHours();
	var minutes = date.getMinutes();
	var seconds = date.getSeconds();
	var millis = date.getMilliseconds();

	return ""
		+ year + "-"
		+ (month < 10 ? "0" + month : month) + "-"
		+ (day   < 10 ? "0" + day   : day  )
		+ (middleT ? "T" : " ")
		+ (hours < 10 ? "0" + hours : hours) + ":"
		+ (minutes < 10 ? "0" + minutes : minutes) + ":"
		+ (seconds < 10 ? "0" + seconds : seconds) + "."
		+ (millis < 10 ? "00" + millis : (millis < 100 ? "0" + millis : millis ));
};

exports.escapeRegExp = function escapeRegExp(string) {
	"use strict";
	// based on https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Replaces all occurrences of the 'find' string in the 'str' string with 'replace' string.
 */
exports.replaceAll = function replaceAll(str, find, replace) {
	"use strict";
	if( !str ) {
		return str;
	}
	return str.replace(new RegExp(find.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1"), 'g'), replace);
};

/**
 * Generates a random number from a normal (Gaussian) distribution,
 * with a specific mean and standard deviation.
 */
exports.randomNormal = function randomNormal(mean, stdev) {
	"use strict";

	// using Polar (Box-Mueller) method; See Knuth v2, 3rd ed, p122
	// see http://www.taygeta.com/random/gaussian.html for details
	var x, y, r2;
	do
	{
		x = 2.0 * Math.random() - 1.0;
		y = 2.0 * Math.random() - 1.0;
		r2 = x * x + y * y;
	} while( r2 >= 1.0 || r2 == 0 );
	var norm = y * Math.sqrt( ( -2.0 * Math.log( r2 ) ) / r2 );
	return mean + stdev * norm;
};


/**
 * A global prefix for all log messages. This is typically used when combining
 * logs from various processes to distinguish which process the log entry comes from.
 */
exports.logPrefix = null;


/**
  * Formats and writes a message to the console, including the current time.
  */
exports.log = function log(message, level, overrideLogPrefix) {
	"use strict";

	if( typeof(message)!=='string' ) {
		console.log("WARNING: utils.log() message must be a string (was '"+message+"')");
		return;
	}

	// HOTFIX (2015-02-09): temporarily track whether there aren't two consecutive "OPEN |"
	// log messages, which means one handleNextRequest() call was lost - that's a serious problem!
	if( message.startsWith("OPEN |") ) {
		if( this.lastLogWasOpenUrl ) {
			console.log( "WARNING JAK SVINA!!!" );
		} else {
			this.lastLogWasOpenUrl = true;
		}
	} else {
		this.lastLogWasOpenUrl = false;
	}

	var logPrefix = overrideLogPrefix || this.logPrefix;

	// indent the new-lines so they start after the date part
	message = message.trim();
	// length of "[2015-02-25 15:11:26.945] "
	var spaces = "                          ";
	var filling = " ";
	if( logPrefix ) {
		filling += spaces.substr(0, logPrefix.length+2);
	}
	message = message.replace(/\n/g, function() { return "\n"+filling} );
	if( level ) {
		level = level.toUpperCase();
		if( !this.isDebugMode && level == "DEBUG" ) {
			return;
		}
		message = level + ": " + message;
	}
	console.log( (logPrefix ? ("[" + logPrefix + "] ") : "") + message );
};

exports.logException = function logException(message, exception) {
	"use strict";
	this.log(message + ": "
		+ (exception
		   ? "\n" + exception
	         + ( exception.stack ? "\n" + this.traceToString(exception.stack) : "" )
		   : ""), "error");
};

/**
 * Writes system information to utils.log().
 */
exports.logSystemInfo  = function logSystemInfo() {
	var os = system.os;
	utils.log("Operating system: " + os.name + " " + os.version + " " + os.architecture + ", "
	+ "PID: " + system.pid + ", "
	+ "Current directory: " + fs.workingDirectory + ", "
	+ "PhantomJS version: " + phantom.version.major + "." + phantom.version.minor + "." + phantom.version.patch + ", "
	+ "CasperJS version:" + (phantom.casperVersion ? phantom.casperVersion.toString() : "N/A") + "]");
};

/**
 * Forcefully exits the current PhantomJS process. Note that PhantomJS's exit() method sometimes hangs.
 * This method invokes our PhantomJS's extension that exits the process using stdio.h's exit() function instead of Qt's exit() method.
 */
exports.forceExit = function forceExit(code) {
    phantom.forceExit(code);
};


/**
  * Formats an exception trace array to a human-readable string.
  */
exports.traceToString = function traceToString(trace) {
	if( typeof trace === "string" )
		return trace;
	var msgStack = [];
	if( trace && trace.forEach ) {
		trace.forEach( function(t) {
			msgStack.push(' -> ' + (t.file || t.sourceURL) + ': ' + t.line + (t.function ? ' (in function ' + t.function +')' : ''));
		});
	}
	return msgStack.join('\n');
};

/**
  * Opens a file for writing of UTF-8 text. If the file already exists, it will be deleted.
  * The file starts with the UTF-8 byte order mask.
  */
exports.openStreamUTF8 = function openStreamUTF8(filePath) {
	// first, tuncate the file if it exists and write the UTF-8 byte order mask ...
	fs.write( filePath, "\xEF\xBB\xBF", "wb" );
	// ... and only then open an UTF-8 writer that will append to the file
	return fs.open( filePath, {mode: "a", charset: 'utf-8'} );
};


/**
  * This method ensures that an object can be converted to JSON and if not,
  * it returns at least its string representation.
  */
exports.ensureJsonStringifyable = function ensureJsonStringifyable(obj, suffix) {
	try {
		JSON.stringify(obj);
		return obj;
	}
	catch(e) {
		return "" + obj + (suffix ? suffix : "");
	}
};


/**
 * Tests equality between the two passed arguments.
 */
exports.equals = function equals(v1, v2) {
	"use strict";
	if( v1 instanceof Function ) {
		if( v2 instanceof Function ) {
			return v1.toString() === v2.toString();
		} else {
			return false;
		}
	}
	// with Gecko, instanceof is not enough to test object
	if ( v1 instanceof Object ) {
		if ( !(v2 instanceof Object ) ||
			Object.keys(v1).length !== Object.keys(v2).length) {
			return false;
		}
		for ( var k in v1 ) {
			if (!equals(v1[k], v2[k])) {
				return false;
			}
		}
		return true;
	}
	return v1 === v2;
};

/**
 * Save the initial 'libraryPath', before anyone changes it.
 * The assumption is that 'utils.js' is included early enough before this happens.
 */
phantom.initialLibraryPath = phantom.libraryPath;

/**
 * Resolves a full path to a file specified by a relative path with respect to the main script path.
 * If 'relativePath' is actually an absolute path, it is returned unchanged.
 * If 'relativePath' is empty, the method returns path to the main script directory,
 * ending with a file separator character.
 * @param path
 */
exports.resolvePath = function resolvePath(path) {

	// is the path absolute?
	if( path.startsWith('/') || path.startsWith('\\\\') || path.match(/^[a-zA-Z]:\\/i) ) {
		return path;
	}

	// get main script directory
	var mainDir;
	if( phantom.casperVersion ) {
		// when run from CasperJS, use this method from 'casperjs/bin/bootstrap.js'
		if( (phantom.casperScriptBaseDir || "").indexOf(fs.workingDirectory) === 0 ) {
			mainDir = phantom.casperScriptBaseDir;
		} else {
			mainDir = fs.absolute(fs.pathJoin(fs.workingDirectory, phantom.casperScriptBaseDir));
		}
	} else {
		mainDir = phantom.initialLibraryPath;
	}
	// NOTE: on Windows' PhantomJS, all paths use '/' anyway, so this is actually correct!
	if( !mainDir.endsWith('/') )
		mainDir += '/';

	path = mainDir + path;
	return path;
};


/**
 * Returns a random integer between min (included) and max (excluded)
 */
exports.getRandomInt = function getRandomInt(min, max) {
	// using Math.round() would give you a non-uniform distribution!
	return Math.floor(Math.random() * (max - min)) + min;
};

/**
 * Returns true if object equals null or undefined, otherwise returns false.
 * @param obj
 * @returns {boolean}
 */
exports.isNullOrUndefined = function isNullOrUndefined(obj) {
	return obj===undefined || obj===null;
};

/**
 * Returns true if object equals null or undefined or empty string, otherwise returns false.
 * @param obj
 * @returns {boolean}
 */
exports.isEmpty = function isEmpty(obj) {
	return obj===undefined || obj===null || obj==='';
};

/**
 * Converts any defined object to string, leaves null and undefined as is.
 * Returns null if object cannot be converted to String.
 */
exports.toString = function toString(obj) {
	if( obj===undefined || obj===null )
		return obj;
	var str = obj.toString();
	if( typeof(str)!=='string' )
		return null;
	return str
};

/**
 * Returns true if object is an Array, otherwise returns false.
 * @param obj
 * @returns {boolean}
 */
exports.isArray = function isArray(obj) {
	return obj!==undefined && obj!==null && obj.constructor===Array;
};

/**
 * Returns number of bytes necessary to serialize a string using the UTF-8 encoding.
 * @param str
 * @returns {*}
 */
exports.utf8ByteLength = function utf8ByteLength(str) {
	// Content-Length must be in bytes, not chars! This is a dirty trick to convert string to bytes using UTF-8
	// TODO: is there really no better/faster way???
	return unescape(encodeURI(str)).length;
};
