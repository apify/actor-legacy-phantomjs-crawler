/*!
 * This module defines the LinkedList class, which represents a doubly-linked list data structure.
 *
 * NOTE: This is an exact copy of file from apifier-commons package.
 * It's here because we want the crawler to be self-contained.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2014 Apifier. All rights reserved.
 *
 */
"use strict";

/*global exports*/

// TODO: create unit test!!!

function LinkedListNode(data) {    
	this.prev = null;
	this.next = null;
	this.data = data;
}  
  
/**
 * A class representing a doubly-linked list. 
 */
function LinkedList() {
	"use strict";
	this.head = null;
	this.tail = null;
	this.length = 0;
}

/** 
  * Returns a new instance of the LinkedList class.
  */
exports.create = function create() {
	"use strict";
	return new LinkedList();
};

/**
  * Appends a new node with specific data to the end of the linked list. 
  */
LinkedList.prototype.add = function add(data) {
	"use strict";
	var node = new LinkedListNode(data);
	this.addNode(node);
	return node;
};

/**
 * Appends a new node to the end of the linked list.
 */
LinkedList.prototype.addNode = function addNode(node) {
	"use strict";
	if( this.length == 0 ) {
		this.tail = node;
		this.head = node;
	} else {
		node.prev = this.tail;
		this.tail.next = node;
		this.tail = node;
	}
	this.length++;
	return node;
};

/** 
  * A helper function to determine whether two data objects are equal.
  * The function attempts to do so using data1's function 'equal(data)' if there is one,
  * otherwise it uses '==' operator.
  */
LinkedList.prototype.dataEqual = function dataEqual(data1, data2) {
	"use strict";
	if( data1==null ) {	
		return data2==null;
	} else {
		if( data1.equals ) {
			return data1.equals(data2);
		} else {
			return data1 == data2;
		}
	}
};

/**
  * Finds a first node that holds a specific data object. See 'dataEqual' function for a description
  * how the object equality is tested. Function returns null if the data cannot be found.
  */
LinkedList.prototype.find = function find(data) {
	"use strict";
	var node = this.head;
	while( node != null ) {
		if( this.dataEqual(node.data, data) )
			return node;
		node = node.next;
	}
	return null;
};

LinkedList.prototype.removeNode = function removeNode(node) {
	if( node.prev != null )
	{
		// some predecessor
		if( node.next != null )
		{
			// some successor
			node.prev.next = node.next;
			node.next.prev = node.prev;
			node.prev = null;
			node.next = null;
		}
		else
		{
			// no successor
			this.tail = node.prev;
			node.prev.next = null;
			node.prev = null;
		}
	}
	else
	{
		// no predecessor
		if( node.next != null )
		{
			// some successor
			this.head = node.next;
			node.next.prev = null;
			node.next = null;
		}
		else
		{
			// no successor
			this.head = null;
			this.tail = null;
			node.next = null;
			node.prev = null;
		}
	}

	this.length--;
};






 
