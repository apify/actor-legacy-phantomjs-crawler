/*!
 * This module defines the ListDictionary class, a data structure
 * that combines a linked list and a dictionary.
 *
 * NOTE: This is an exact copy of file from apifier-commons package.
 * It's here because we want the crawler to be self-contained.
 *
 * Author: Jan Curn (jan@apifier.com)
 * Copyright(c) 2015 Apifier. All rights reserved.
 *
 */
"use strict";

// TODO: create unit test!!!

var linkedList = require('./linkedlist');

/** Returns a new instance of the ListDictionary class. */
exports.create = function create() {
    "use strict";
    return new ListDictionary();
};


/**
 * The main ListDictionary class.
 */
function ListDictionary() {
    "use strict";
    this.linkedList = linkedList.create();
    this.dictionary = {};
}


/**
 * Gets the number of item in the list.
 */
ListDictionary.prototype.length = function length() {
    "use strict";
    return this.linkedList.length;
};


/**
 * Adds an item to the list. If there is already an item with same key, the function
 * returns false and doesn't make any changes. Otherwise, it returns true.
 */
ListDictionary.prototype.add = function add(key, item) {
    "use strict";
    if( !key ) {
        throw new Error("Parameter 'key' cannot be empty.");
    }
    if( !item ) {
        throw new Error("Parameter 'item' cannot be empty.");
    }
    if( key in this.dictionary )
        return false;
    var linkedListNode = this.linkedList.add(item);
    linkedListNode.dictKey = key;
    this.dictionary[key] = linkedListNode;
    return true;
};


/**
 * Gets the first page request from the queue. The function
 * returns the Request object or null if the queue is empty.
 */
ListDictionary.prototype.getFirst = function getFirst() {
    "use strict";
    var head = this.linkedList.head;
    if( head ) {
        return head.data;
    }
    return null;
};

/**
 * Gets the first page request from the queue and moves it to the end of the queue.
 * The function returns the Request object or null if the queue is empty.
 */
ListDictionary.prototype.moveFirstToEnd = function moveFirstToEnd() {
    "use strict";
    var node = this.linkedList.head;
    if( !node ) {
        return null;
    }
    this.linkedList.removeNode(node);
    this.linkedList.addNode(node);
    return node.data;
};


/**
 * Removes the first item from the list. The function
 * returns the item object or null if the list is empty.
 */
ListDictionary.prototype.removeFirst = function removeFirst() {
    "use strict";
    var head = this.linkedList.head;
    if( !head ) {
        return null;
    }
    this.linkedList.removeNode(head);
    delete this.dictionary[head.dictKey];
    return head.data;
};


/**
 * Removes an item identified by a key. The function returns the
 * object if it was found or null if it wasn't.
 */
ListDictionary.prototype.remove = function remove(key) {
    "use strict";
    if( !key ) {
        throw new Error("Parameter 'key' cannot be empty.");
    }
    var linkedListNode = this.dictionary[key];
    if( !linkedListNode ) {
        return null;
    }
    delete this.dictionary[key];
    this.linkedList.removeNode(linkedListNode);
    return linkedListNode.data;
};


/**
 * Finds a request based on the URL.
 */
ListDictionary.prototype.get = function get(key) {
    "use strict";
    if( !key ) {
        throw new Error("The parameter 'key' cannot be empty.");
    }
    if( key in this.dictionary ) {
        return this.dictionary[key];
    }
    return null;
};


/**
 * Removes all items from the list.
 */
ListDictionary.prototype.clear = function clear() {
    "use strict";
    this.linkedList = linkedList.create();
    this.dictionary = {};
};