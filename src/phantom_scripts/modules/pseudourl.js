/*!
 * This module defines the PseudoUrl class, which represents a regex-like pattern for URLs.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014 Apifier. All rights reserved.
 *
 */
"use strict";

// TODO: IPv6 address is also enclosed in [] brackets!!! (see http://en.wikipedia.org/wiki/Uniform_resource_locator)
// TODO: "http://direct.asda.com/george/[(women|womens)/[[a-z\\-]+]/D[[A-Z0-9]+],default,sc.html" will not fail!!
//                                                    | missing bracket here!!!
// TODO: the syntax is not great, what if the regex is using '\\]' symbol ???

/**
 * A class representing a pseudo URL. 
 */
function PseudoUrl(purl) {
	"use strict";

	purl = typeof(purl)==='string' ? purl.trim() : "";
	if( purl.length===0 )
		throw new Error("Cannot parse PURL '" + purl + "': it must be an non-empty string");

	// generate a regular expression from the pseudo-URL
    // TODO: if input URL contains '[' or ']', they should be matched their URL-escaped counterparts !!!
	try {
		var regex = '^';
		var openBrackets = 0;
		for( var i=0; i<purl.length; i++ )	{
			var ch = purl.charAt(i);
			if( ch == '[' ) {
				if( ++openBrackets == 1 ) {
					// beginning of '[regex]' section
					// enclose regex in () brackets to enforce operator priority
					regex += '(';
					continue;
				}
			}
			if( ch == ']' && openBrackets > 0 ) {
				if( --openBrackets == 0 ) {
					// end of '[regex]' section
					regex += ')';
					continue;
				}
			}
			if( openBrackets > 0 ) {
				// inside '[regex]' section
				regex += ch;
			} else {
				// outside '[regex]' section, parsing the URL part
				var code = ch.charCodeAt(0);
				if( (48 <= code && code <= 57) || (65 <= code && code <= 90) || (97 <= code && code <= 122) ) {
					// alphanumeric character => copy it
					regex += ch;
				} else {
					// special character => escape it
					var hex = code < 16 ? '0' + code.toString(16) : code.toString(16);
					regex += '\\x' + hex;
				}
			}
		}
		regex += '$';
		this.regExpString = regex; // useful for debugging, prepared config is printed out including this filed
		this.regExp = new RegExp(regex); 
	} catch(e) {
		throw new Error("Cannot parse PURL '" + purl + "': " + e);
	}	
	//utils.log("PURL parsed: PURL: '"+purl+"', REGEX: '"+regex+"']", "debug");
}

/** 
  * Returns a new instance of the LinkedList class.
  */
exports.create = function create(purl) {
	"use strict";
	return new PseudoUrl(purl);
};

/** 
  * Determines whether a URL matches this pseudo-URL pattern.
  */
PseudoUrl.prototype.matches = function matches(url) {
	"use strict";
	var result = typeof(url)!=='string' ? false : (url.match(this.regExp) != null);
	//utils.log("MATCHES ["+result+"] | url: "+url+", regex: "+this.regExpString);
	return result;
};

 
