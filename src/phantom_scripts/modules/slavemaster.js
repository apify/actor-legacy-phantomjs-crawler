/*!
 * This module defines helper functions for the master crawling process.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2015 Apifier. All rights reserved.
 *
 */
"use strict";

/*global phantom, exports*/

require('./polyfills');
var fs           = require("fs");
var childProcess = require("child_process");
var webServer    = require('webserver');
var utils        = require('./utils');
var consts       = require('./constants');
var requests     = require('./requests');

/**
 * Returns a new instance of the Slavemaster class.
 */
exports.create = function create(config, localRequestManager, settings) {
	"use strict";
	return new Slavemaster(config, localRequestManager, settings);
};


/**
 * Generates a 'logPrefix' for a crawler process.
 */
exports.generateLogPrefix = function generateLogPrefix(slaveId) {
	if( slaveId!==undefined && slaveId!==null ) {
		var prefix = "" + slaveId;
		while( prefix.length < 5 )
			prefix = "0" + prefix;
		return "S" + prefix;
	} else {
		return "MASTER";
	}
};


/**
 * Creates and initializes a new instance of Slavemaster class.
 * @param config
 * @param localRequestManager
 * @param settings
 * @constructor
 */
function Slavemaster(config, localRequestManager, settings) {
	if( !config ) {
		throw new Error("Parameter 'config' must be provided.");
	}
	if( !localRequestManager ) {
		throw new Error ("Parameter 'localRequestManager' must be provided.");
	}

	this.config = config;
	this.localRequestManager = localRequestManager;

    // global settings from command line
    this.settings = settings || {};

	// construct path to 'crawler-slave.js' and check if it exists
	this.slaveScriptPath = utils.resolvePath('crawler-slave.js');
	if( !fs.exists(this.slaveScriptPath) )
		throw "Cannot find the 'crawler-slave.js' module at '" + slaveScriptPath + "'.";

	// maximum number of slaves
	this.maxSlaveCount = Math.min( settings.maxParallelProcesses || 0, config.maxParallelRequests || consts.DEFAULT_MAX_PARALLEL_REQUESTS );
	if( this.maxSlaveCount <= 0 ) {
		throw new Error("Master with zero slaves ain't no master (maxParallelProcesses: "+settings.maxParallelProcesses+", config.maxParallelRequests: "+config.maxParallelRequests+")");
	}

	// to generate unique slave IDs
	this.nextSlaveId = 0;

	// a dictionary where key is slave.id, value is a Slave instance
	this.slaves = {};

	// an instance of PhantomJS' web server, or null
	this.webServer = null;

	// a TCP port on which the server listens (if started)
	this.port = null;

	// indicates that bootstrapper slave process finished successfully
	this.isBootstrapFinished = false;
};


/**
 * A class representing a slave process.
 */
function Slave(id, process, isBootstrapper) {
	// a unique identifier of the slave
	this.id = id;

	// process instance (result of PhantomJS' spawn() function)
	this.process = process;

	// store PID locally, accessing it after process exit is probably causing a PhantomJS crash
	this.pid = process.pid;

	// indicates this is a bootstrapping process
	this.isBootstrapper = isBootstrapper;

	// time of last contact, used to kill non-responsive processes (TODO!)
	this.lastContact = Date.now();

	// the request that was sent back to the slave after last 'fetchNextRequest' message.
	// this fields becomes null again after slave sends 'markRequestHandled' message
	this.lastFetchedRequest = null;
}


/**
 * Start a web server on a random TCP port, which will process RemoteRequestManager messages.
 */
Slavemaster.prototype.startServer = function startServer() {

	this.webServer = webServer.create();
	var port = null;

	for( var i=0; i<consts.SLAVEMASTER_SERVER_PORT.RANDOM_ATTEMPTS; i++ ) {
		// generate a random port number...
		port = utils.getRandomInt(
			consts.SLAVEMASTER_SERVER_PORT.MIN,
			consts.SLAVEMASTER_SERVER_PORT.MAX+1 );
		// ...and try to listen on it
		if( this.webServer.listen(port, {keepAlive: true}, this._handleMessage.bind(this)) ) {
			break;
		} else {
			utils.log("Attempt to listen on TCP port " + port + " failed.");
			port = null;
		}
	}
	if( !port ) {
		throw "All "+consts.SLAVEMASTER_SERVER_PORT.RANDOM_ATTEMPTS+" attempts to start the web server failed, giving up.";
	}

	utils.log("Web server is listening on TCP port " + port);
	this.port = port;
};


/**
 * Invoked by the web server whenever there's an incoming message.
 * @param request
 * @param response
 * @private
 */
Slavemaster.prototype._handleMessage = function _handleMessage(httpRequest, httpResponse) {
	"use strict";
	var request = null;
	try {
		utils.log("Slavemaster._handleMessage(): URL="+httpRequest.url+"", "debug");

		// analyze and check the message
		var matches = /^\/(\d+)$/.exec(httpRequest.url);
		var slaveId = matches && matches.length===2 ? parseInt(matches[1]) : null;
		if( slaveId===null || !httpRequest.headers || httpRequest.headers['Content-Type']!='application/json' || !httpRequest.post ) {
			throw "The request is not valid.";
		}
		var slave = this.slaves[slaveId];
		if( !slave ) {
			throw "Cannot find the corresponding slave (slaveId: "+slaveId+")";
		}

		var message = JSON.parse(httpRequest.post);

		// check the piggybacked requests and store them to localRequestManager
		if( message.piggybackBufferedRequests ) {
			if( !utils.isArray(message.piggybackBufferedRequests) ) {
				throw "The 'piggybackBufferedRequests' field must be an array.";
			}
			for( var i=0; i<message.piggybackBufferedRequests.length; i++ ) {
				request = message.piggybackBufferedRequests[i];
				if( !request ) {
					throw "Some request in 'piggybackBufferedRequests' array is undefined (index: "+i+").";
				}
				if( !utils.isNullOrUndefined(request.id) ) {
					throw "Some request in 'piggybackBufferedRequests' defines 'id' property; that is an error (index: "+i+", id: '" + request.id + "').";
				}
				if( !utils.isNullOrUndefined(request.referrer) ) {
					throw "Some request in 'piggybackBufferedRequests' defines 'referrer' property; that is an error (index: "+i+", referrer.id: " + request.referrer.id + ").";
				}
				// if the slave is still bootstrapping...
				if( slave.isBootstrapper && !this.isBootstrapFinished ) {
					// ...then the request must be one of the bootstrap requests without any referrer
					if( slave.lastFetchedRequest ) {
						throw "Internal error (code 1)";
					}
					if( !utils.isNullOrUndefined(request.referrerId) )  {
						throw "Some request in 'piggybackBufferedRequests' from bootsrapper defines referrerId (index: "+i+", referrerId: '" + request.referrerId + "').";
					}
				} else {
					// ...otherwise the referring request must be the request last fetched by the slave!
					if( !slave.lastFetchedRequest ) {
						throw "Internal error (code 2)";
					}
					if( request.referrerId !== slave.lastFetchedRequest.id ) {
						throw "Some request in 'piggybackBufferedRequests' has invalid 'referrerId' property (index: " + i + ", referrerId: " + request.referrerId + ", lastFetchedRequest.id: " + slave.lastFetchedRequest.id + ").";
					}
					// request must have valid 'referrer' so that slaves have access to full chain of referrals
					request.referrer = slave.lastFetchedRequest;
				}
                // attach methods to the request instance, they will be used when outputting the file to JSON
				requests.localizeFromJSON(request);
				this.localRequestManager.addNewRequest(request);
			}
		}

		// process the message
		var responseMessage = {};
		switch( message.messageType ) {
			case "fetchNextRequest":
				// if bootstrapping slave sent a 'fetchNextRequest' message, it means
				// that all startUrls were already requested and thus bootstrapping is finished
				if( slave.isBootstrapper && !this.isBootstrapFinished ) {
					utils.log("Bootstrapping is finished (the bootstrapping slave process invoked 'fetchNextRequest')");
					this.isBootstrapFinished = true;
                    // spawn the slaves ASAP
					setTimeout( this._heartBeat.bind(this), 0 );
				}
				this.localRequestManager.fetchNextRequest( function handleMessageCallback(request, statusMessage) {
                    // NOTE: this callback is called immediately, hence it's okay to write to responseMessage
                    // the slave process needs the chain of referrers!
                    slave.lastFetchedRequest = request;
					// we need to keep the full chain of referring requests for the slave!
					responseMessage.request = request ? request.explicitToJSON(true) : null;
					//utils.log("FETCH NEXT REQUEST RESULT: " + JSON.stringify(responseMessage.request,null,2), "debug")
					responseMessage.statusMessage = statusMessage;
				});
				break;

			case "markRequestHandled":
				request = message.request;
				if( !request ) {
					throw "A 'markRequestHandled' message doesn't contain 'request' field.";
				}
				if( !slave.lastFetchedRequest || slave.lastFetchedRequest.id !== request.id) {
					throw "A 'markRequestHandled' message doesn't refer to the last fetched request (request.id: "+request.id+", lastFetchedRequest.id: "+(slave.lastFetchedRequest ? slave.lastFetchedRequest.id : "N/A")+").";
				}

				// WORKAROUND: in our simple implementation (see LocalRequestManager.fetchNextRequest()),
				// the request might have been already handled by another processes, so just ignore it...
				if( !this.localRequestManager.inQueue(request) ) {
					utils.log("The request was already handled by another slave, skipping it (request="+request+")", "warning");
				} else {
					// if the page load failed, don't remove it from the queue so that we
					// can try to load it again later, with a maximum retry count
					var errorInfoSuffix = "";
					if( request.loadErrorCode > 0 && this.config.maxPageRetryCount > 0 ) {
						slave.lastFetchedRequest._retryCount |= 0;
						if( slave.lastFetchedRequest._retryCount < this.config.maxPageRetryCount ) {
							utils.log("Page load failed, it will be tried again later (request.id: "+slave.lastFetchedRequest.id+", retryCount: "+slave.lastFetchedRequest._retryCount+", maxPageRetryCount: "+this.config.maxPageRetryCount+")");
							slave.lastFetchedRequest._retryCount++;
							slave.lastFetchedRequest = null;
							break;
						}
						utils.log("Page load failed too many times, giving up (request.id: "+request.id+", retryCount: "+request._retryCount+")");
						errorInfoSuffix = "\nPage load failed "+(request._retryCount+1)+" times, giving up.";
					}

					// mark the request as handled
					// only copy the request fields that can be modified by the slave
					// between 'fetchNextRequest' and 'markRequestHandled' states !
					// TODO: the RemoteRequestManager could only send these fields (+id) to improve performance
					requests.AFTER_LOAD_UPDATABLE_REQUEST_FIELDS.forEach( function(field) {
						slave.lastFetchedRequest[field] = request[field];
					});
					request = slave.lastFetchedRequest;
					request.errorInfo += errorInfoSuffix;
					this.localRequestManager.markRequestHandled(request);
				}
				slave.lastFetchedRequest = null;
				break;

			case "dummy":
				// this message type is used when only passing piggybackBufferedRequests
				break;

			default:
				throw "An unknown message type received ('"+message.messageType+"')";
		}

		slave.lastContact = Date.now();

		var responseMessageJson = JSON.stringify(responseMessage);
		var contentLength = utils.utf8ByteLength(responseMessageJson);

		httpResponse.statusCode = 200; // OK
		httpResponse.headers = {
			'Cache': 'no-cache',
			'Content-Type': 'application/json; charset=utf-8',
			'Connection': 'keep-alive',
			'Keep-Alive': 'timeout=20, max=100',
			'Content-Length': contentLength
		};
		httpResponse.write(responseMessageJson);
		httpResponse.close();
	} catch(e) {
		utils.logException("Server couldn't handle an incoming HTTP request", e);
		utils.log("Problematic HTTP request: " + JSON.stringify(httpRequest,null,2));
		utils.log("Problematic request object: " + JSON.stringify(request,null,2));
		httpResponse.statusCode = 400; // Bad Request
		httpResponse.close();
	}
};


/**
 * Starts a single slave process whose task is only to load 'startUrls' from configuration and then exit.
 */
Slavemaster.prototype.startCrawl = function startCrawl() {
	"use strict";
	utils.log("Bootstrapping parallel crawl (maxSlaveCount: "+this.maxSlaveCount+")");

	this._spawnSlave(true);

	// let the heart beat
	setInterval( this._heartBeat.bind(this), consts.MASTER_HEARTBEAT_INTERVAL_MILLIS );
};


/**
 * Spawns a new slave process and saves a reference to it into our internal records.
 * @param isBootstrapper
 * @private
 */
Slavemaster.prototype._spawnSlave = function _spawnSlave(isBootstrapper) {
	"use strict";
	utils.log("Slavemaster._spawnSlave(): isBootstrapper="+isBootstrapper+"", "debug");

	// start the slave process
	var slaveId = this.nextSlaveId++;
	var serverUrl = 'http://localhost:' + this.port + '/' + slaveId;
	var cmd = 'phantomjs';
	var args = [];

    // pick arguments for the slave PhantomJS process from the user-provided list
	if( this.settings.phantomArgsArray && this.settings.phantomArgsArray.length > 0 ) {
		var phantomArgs = this.settings.phantomArgsArray[slaveId % this.settings.phantomArgsArray.length];
		if( phantomArgs ) {
			for( var i = 0; i < phantomArgs.length; i++ ) {
				args.push(phantomArgs[i]);
			}
		}
	}
	args.push(this.slaveScriptPath, this.config.originalPath, serverUrl, exports.generateLogPrefix(slaveId));
	if( isBootstrapper ) {
		args.push('--bootstrap');
	}
	if( this.settings.cookiesJsonPath ) {
		args.push('--cookies='+this.settings.cookiesJsonPath);
	}
	if( utils.isDebugMode ) {
		args.push('--dbg');
	}
	// NOTE: Unfortunately, in PhantomJS there's no way to determine whether a  child process actually started.
	//       If it didn't and we try to access its 'pid' property, our own process will crash.
	//       The best thing we can do is to log what we were doing before the crash happens...
	var fullCmd = cmd + " " + args.join(" ");
	utils.log("Spawning slave process (slaveId: "+slaveId+", command: '"+fullCmd+"')...");
	var process = childProcess.spawn(cmd, args);

	// save the record before attaching process handlers!
	var slave = new Slave(slaveId, process, isBootstrapper);
	this.slaves[slaveId] = slave;

	// forward standard output to our log
	process.stdout.on("data", function slaveProcessStdout(message) {
		// all stdout messages should come from utils.log() and hence are prefixed with time
		if( typeof(message)==='string' ) {
			// remove trailing newlines
			message = message.trim();
			// WORKAROUND: sometimes newlines become '\r\r\n', which looks bad in log
			message = message.replace(/(\r)*(\n)(\r)*/g, '\n' );
		}
		console.log(message);
	}.bind(this) );

	// forward standard error to our log
	process.stderr.on("data", function slaveProcessStderr(message) {
		// our code doesn't produce stderr output, so surely this needs to be prefixed
		// (note sure this is useful for anything, PhantomJS crash doesn't write info to stderr...)
		if( typeof(message)==='string' ) {
			// WORKAROUND: sometimes newlines become '\r\r\n', which looks bad in log
			message = message.replace(/(\r)*(\n)(\r)*/g, function() { return '\n'} );
			var overrideLogPrefix = exports.generateLogPrefix(slaveId);
			utils.log(message, "error", overrideLogPrefix);
		}
	}.bind(this) );

	// on exit, delete the slave record
	process.on("exit", function slaveProcessExited(exitCode) {
		utils.log("Slave process exited (slaveId: "+slaveId+", pid: "+slave.pid+", exitCode: "+exitCode+").");
		delete this.slaves[slaveId];
		this._heartBeat();
	}.bind(this) );

	utils.log("Slave process spawned successfully (slaveId: "+slaveId+", pid: "+slave.pid+", command: '"+fullCmd+"')");
};


/**
 * This function is called periodically to kill unresponsive slaves and
 * spawn new slaves if there's not enough of them to handle pending requests.
 * Also, the function shuts down the PhantomJS process if all work is done.
 * @private
 */
Slavemaster.prototype._heartBeat = function _heartBeat() {
	"use strict";
	try {
		utils.log("Slavemaster._heartBeat()", "debug");

		// kill non-responsive slaves
		var now = Date.now();
		var isBootstrapperAlive = false;
		var slaveCount = 0;
		for( var slaveId in this.slaves ) {
			var slave = this.slaves[slaveId];
			if( slave.lastContact + consts.NON_RESPONSIVE_SLAVE_MIN_MILLIS < now ) {
				utils.log("Slave process is non-responsive, killing it (slaveId: "+slaveId+", pid: "+slave.process.pid+", lastContact: "+utils.dateToString(new Date(slave.lastContact))+")");
				slave.process.kill('SIGKILL');
				delete this.slaves[slaveId];
				continue;
			}
			isBootstrapperAlive = isBootstrapperAlive || slave.isBootstrapper;
			slaveCount++;
		}

		// if bootstrapper slave process died before all startUrls were added to queue, restart it
		if( !isBootstrapperAlive && !this.isBootstrapFinished ) {
			this._spawnSlave(true);
			slaveCount++;
		}

		// spawn as many new slaves as necessary (and possible)
		var queueSize = this.localRequestManager.queuedRequests.length();
		while( slaveCount < this.maxSlaveCount && slaveCount * consts.MIN_REQUESTS_PER_SLAVE < queueSize ) {
			this._spawnSlave(false);
			slaveCount++;
		}

		//utils.log("HEARTBEAT STATUS: queueSize="+queueSize+", slaveCount="+slaveCount+", maxSlaveCount="+this.maxSlaveCount, "debug");

		if( slaveCount===0 ) {
			utils.log("Our work is done, slaves are dead, shutting down...");
			this.localRequestManager.close( function() {
                utils.forceExit(0);
			});
		}
	}
	catch(e) {
		utils.logException("Slavemaster._heartBeat() threw an exception", e);
	}
};
