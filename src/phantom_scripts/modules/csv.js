/*!
 * This module defines the functions for writing a CSV file.
 * The CSV file uses Excel-style CSV files in UTF-8 encoding, with a byte order mask in the beginning of file.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014 Apifier. All rights reserved.
 *
 */
"use strict";

var fs    = require('fs');
var utils = require('./utils');


function CsvWriter(stream) {
	this.stream = stream;
}

/** 
  * Returns a new instance of the CsvWriter class.
  */
exports.createWriter = function(csvPath) {
	"use strict";
	
	// first, tuncate the file if it exists and write the UTF-8 byte order mask
	fs.write(csvPath, "\xEF\xBB\xBF", "wb");
	
	// open file stream for writing in UTF-8 encoding
	var stream = fs.open(csvPath, {
		mode: "a",
		charset: 'utf-8'
	});
	
	return new CsvWriter(stream);
};

/**
  * Writes an array of string as a row to the CSV file.
  */
CsvWriter.prototype.writeRow = function(columns) {
	"use strict";
	
	for( var i=0; i<columns.length; i++ ) {		
		var col = columns[i];
		if( i>0 ) {
			this.stream.write(',');
		}
		if( col != null ) {
			this.stream.write('"');
			col = utils.replaceAll(col.toString(), '"', '""');
			this.stream.write(col);
			this.stream.write('"');
		}
	}
	// write CRLF
	this.stream.write('\r\n');
};

/**
  * Flushes the CSV file stream to the disk.
  */
CsvWriter.prototype.flush = function() {
	this.stream.flush();
}

/**
  * Closes the CSV file stream.
  */
CsvWriter.prototype.close = function() {
	this.stream.close();
}





 
