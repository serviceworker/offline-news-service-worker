// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

(function(global) {
    "use strict";

    var log = console.log.bind(console);
    var err = console.error.bind(console);

    var noop = function() {};

    var DB_NAME = "cache_polyfill";
    var DB_VERSION = 5;
    // Only dealing in a single object store here for simplicity. Don't really
    // want to deal with version upgrades which would be required for putting
    // each cache in their own store (the obvious model).
    var CACHE_STORE_NAME = "cache";
    var CACHE_LIST_STORE_NAME = "cache_list";

    var opened = false;
    // I still can't believe Mark Miller was allowed to fuck this up.
    var openedResolver;
    var openedRejecter;
    var openedPromise = new Promise(function(res, rej) {
        openedResolver = res;
        openedRejecter = rej;
    });

    var resolveWithTransaction = function(trans, bag) {
        bag = bag || {};
        return new Promise(function(resolve, reject) {
            bag.resolve = trans.oncomplete = resolve;
            bag.reject = trans.onabort = trans.onerror = reject;
        });
    };

    var _makeObjectStores = function(db) {
        var cacheStore = db.createObjectStore(CACHE_STORE_NAME);
        var cacheIndex = cacheStore.createIndex("by_cache", "cache");
        // FIXME: add indexes for URL, method, etc.
        var cacheListStore = db.createObjectStore(CACHE_LIST_STORE_NAME);
        var cacheIndex = cacheListStore.createIndex("by_name", "name");
    };

    var ensureOpen = function(storeName) {
        if (opened) {
            return openedPromise;
        }
        opened = true;

        var openRequest = global.indexedDB.open(DB_NAME, DB_VERSION);
        openRequest.onupgradeneeded = function(e) {
            _makeObjectStores(e.target.result);
        };
        openRequest.onsuccess = function(e) {
            openedResolver(e.target.result);
        };
        openRequest.onfailure = openedRejecter;

        return openedPromise;
    };

    var _openStore = function(policy, storeName) {
        storeName = storeName || CACHE_STORE_NAME;
        policy = policy || "readonly";
        return ensureOpen().then(function(db) {
            return function() {
                return db.transaction([storeName], policy).
                          objectStore(storeName);
            }
        });
    };

    var addCacheToList = function(name) {
        return _openStore("readwrite", CACHE_LIST_STORE_NAME).then(
            function(store) {
                var s = store();
                var request = s.put({ name: name }, name);
                var resovler = {};
                return resolveWithTransaction(s.transaction, resovler);
                request.onsucess = resovler.resolve;
            }
        );
    };

    var removeCacheFromList = function(name) {
        return Promise.all([
            clear(name),
            _openStore("readwrite", CACHE_LIST_STORE_NAME).then(
                function(store) {
                    var s = store();
                    var request = s.delete(name);
                    return resolveWithTransaction(s.transaction);
                }
            )
        ]);
    };

    var isCacheInList = function(name) {
        return get(name, CACHE_LIST_STORE_NAME);
    };

    var getAllCacheNames = function() {
        var result = [];
        return _openStore("readonly", CACHE_LIST_STORE_NAME).then(
            function(store) {
                var s = store();
                return new Promise(function(resolve, reject) {
                    var index = s.index("by_name");
                    var request = index.openCursor();
                    request.onabort = request.onerror = reject;
                    request.onsuccess = function(e) {
                        var cursor = e.target.result;
                        if (!cursor) {
                            resolve(result);
                            return;
                        }
                        result.push(cursor.key);
                        cursor.continue();
                    };
                }
            );
        });
    };


    var writeTo = function(cacheName, key, obj) {
        return _openStore("readwrite").then(function(store) {
            obj.cache = cacheName;
            var s = store();
            var req = s.put(obj, key);
            req.onerror = err;


            return new Promise(function(resolve, reject) {
                s.transaction.oncomplete = resolve;
                s.transaction.onabort = s.transaction.onerror = reject;
            });
        });
    };

    var writeBatchTo = function(cacheName, items) {
        return _openStore("readwrite").then(function(store) {
            var s = store();
            items.forEach(function(item) {
                item.value.cache = cacheName;
                s.put(item.value, item.key);
            });
            return resolveWithTransaction(s.transaction);
        });
    };

    var get = function(key, storeName) {
        var storeName = storeName || CACHE_STORE_NAME;
        return _openStore("readonly", storeName).then(function(store) {
            return new Promise(function(resolve, reject) {
                var request = store().get(key);
                request.onabort = request.onerror = reject;
                request.onsuccess = function(e) {
                    var result = e.target.result;
                    if (result) {
                        resolve(result);
                    } else {
                        reject(e);
                    }
                };
            });
        });
    };

    var getAll = function(cacheName, key) {
        var result = [];
        return _openStore().then(function(store) {
            var s = store();
            return new Promise(function(resolve, reject) {
                var index = s.index("by_cache");
                var request = index.openCursor(IDBKeyRange.only(key));
                request.onabort = request.onerror = reject;
                request.onsuccess = function(e) {
                    var cursor = e.target.result;
                    if (!cursor) {
                        resolve(result);
                        return;
                    }
                    result.push(cursor.value);
                    cursor.continue();
                };
            });
        });
    };

    var _delete = function(key) {
        return _openStore("readwrite").then(function(store) {
            var request = store().delete(key);
            return resolveWithTransaction(request.transaction);
        });
    };

    var iterateOver = function(cacheName, func, scope, mode, value) {
        func = func || noop;
        scope = scope || global;
        mode = mode || "readonly";
        return ensureOpen().then(function(db) {
            return new Promise(function(resolve, reject) {
                var trans = db.transaction([CACHE_STORE_NAME], mode);
                trans.onabort = trans.onerror = reject;
                var store = trans.objectStore(CACHE_STORE_NAME);
                var index = store.index("by_cache");
                var iterateRequest = index.openCursor(
                                        IDBKeyRange.only(cacheName));
                iterateRequest.onerror = reject;
                iterateRequest.onsuccess = function(e) {
                    var cursor = e.target.result;
                    if (!cursor) {
                        resolve(value);
                    }
                    try {
                      func.call(scope, cursor, cursor.key, cursor.value,
                        db, store);
                    } catch(e) {
                      resolve(value);
                    }
                };
            });
        });
    };

    var clear = function(cacheName) {
        return iterateOver(
            cacheName,
            function(cursor, key, value, db, store) {
                store.delete(key);
                cursor.continue();
            },
            this,
            "readwrite"
        );
    };

    var getAllItemsInCache = function(cacheName) {
        var items = [];
        return iterateOver(
            cacheName,
            function(cursor, key, value) {
                if (value.cache != cacheName) {
                    log("getAllItemsInCache error:", value.cache, cacheName);
                }
                items.push(value);
                cursor.continue();
            },
            null,
            null,
            items
        );
    };

    var clearAll = function() {
        return getAllCacheNames().then(function(names) {
            return Promise.all(
                names.map(clear).concat(names.map(removeCacheFromList)));
        });
    };

    var clobber = function() {
        var req = indexedDB.deleteDatabase(DB_NAME);
        return resolveWithTransaction(req);
    };

    ///////////////////////////////////////////////////////////////////////////
    // Export
    global.idbCacheUtils = {
        writeTo: writeTo,
        writeBatchTo: writeBatchTo,
        get: get,
        getAll: getAll,
        getAllItemsInCache: getAllItemsInCache,
        "delete": _delete,
        clear: clear,
        clearAll: clearAll,
        clobber: clobber,
        addCacheToList: addCacheToList,
        removeCacheFromList: removeCacheFromList,
        isCacheInList: isCacheInList,
        getAllCacheNames: getAllCacheNames,
    };

    // Don't bother with Response coercion if we're in an env that can't hack
    // it.
    if (typeof Response == "undefined") { return; }

    var objToResponse = function(obj) {
        var headers = new Headers();
        Object.keys(obj.headers).forEach(function(k) {
            headers.set(k, obj.headers[k]);
        });
        var response = new Response(obj.blob, {
            status: obj.status,
            statusText: obj.statusText,
            headers: headers
        });
        // Workaround for property swallowing
        response._url = obj.url;
        response.toBlob = function() {
            return Promise.resolve(obj.blob);
        };

        return response;
    };

    var objFromResponse = function(response, extraHeaders) {
        var headers = extraHeaders || {};
        response.headers.forEach(function(v, k) {
            headers[k] = v;
        });
        if (response.body) {
          return response.body.asBlob().then(function(blob) {
            return {
              url: response.url || response._url,
              blob: blob,
              status: response.status,
              statusText: response.statusText,
              headers: headers
            };
          });
        }
    };

    var getAsResponse = function() {
        return get.apply(this, arguments).then(objToResponse);
    };

    var getAllAsResponses = function() {
        return getAll.apply(this, arguments).then(function(objs) {
            return Promise.all(objs.map(objToResponse));
        });
    };

    var getAllItemsInCacheAsResponses = function() {
        return getAllItemsInCache.apply(this, arguments).then(
            function(objs) {
                return Promise.all(objs.map(objToResponse));
            }
        );
    };

    var writeResponseTo = function(cacheName, key, response, extraHeaders) {
        return objFromResponse(response, extraHeaders).then(function(obj) {
            return writeTo(cacheName, key, obj);
        });
    };

    ///////////////////////////////////////////////////////////////////////
    // Export
    global.idbCacheUtils.objToResponse = objToResponse;
    global.idbCacheUtils.objFromResponse = objFromResponse;
    global.idbCacheUtils.getAsResponse = getAsResponse;
    global.idbCacheUtils.getAllAsResponses = getAllAsResponses;
    global.idbCacheUtils.writeResponseTo = writeResponseTo;
    global.idbCacheUtils.getAllItemsInCacheAsResponses =
                                            getAllItemsInCacheAsResponses;
})(this);
// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// A simple, incomplete implementation of the Cache API, intended to facilitate
// end to end serviceworker testing.

// See https://slightlyoff.github.io/ServiceWorker/spec/service_worker/index.html#cache-objects

// FIXME: Support AbstractResponse/OpaqueResponse correctly.
// FIXME: Serialize the cache.
// FIXME: Bind all function references.
(function(global) {
    "use strict";

    var log = console.log.bind(console);
    var err = console.error.bind(console);

    var _castToRequest = function(item) {
        if (typeof item === 'string') {
            var r = new Request({
                url: item,
            });
            // Workaround for property swallowing
            r._url = item.toString();
            return r;
        } else {
            if (item.url) {
                item._url = item.url;
            }
            return item;
        }
    };

    var _key = function(cn, request) {
        return cn + ":" + request.method + ":" + request._url;
    };

    var Cache = function() {
        this._name = "";
    };

    // FIXME: Should this be in the spec?
    Cache.prototype.keys = function() {
        // FIXME(slightlyoff): we're losing the method differentiation here = \
        return idbCacheUtils.getAllItemsInCache(this._name).then(
            function(items) {
                return items.map(function(i) {
                    return new Request(i.url);
                });
            },
            err
        );
    };

    // FIXME: Implement this.
    Cache.prototype.each = function(callback, scope) {
        var that = this;
        return idbCacheUtils.getAllItemsInCacheAsResponses(this._name).then(
            function(responses) {
                return Promise.all(responses.map(function(response) {
                    var key = new Request({ url: response._url });
                    var value = response;
                    return callback.call(scope||global, value, key, that);
                }));
            }
        );
    };

    Cache.prototype.put = function(request, response) {
        request = _castToRequest(request);

        // See https://code.google.com/p/chromium/issues/detail?id=403785
        var extraResponseHeaders = {};
        if (request.mode === 'cors') {
          extraResponseHeaders['Access-Control-Allow-Origin'] = '*';
        }

        var cache = this._name;
        return idbCacheUtils.writeResponseTo(cache, _key(cache, request), response, extraResponseHeaders);
    };

    Cache.prototype.add = function(request) {
        var put = this.put.bind(this);
        return fetch(request).then(
          function(response) { return put(request, response); },
          function(error) { throw error; }
        );
    };

    // FIXME: Add QueryParams argument.
    Cache.prototype.delete = function(request) {
        return idbCacheUtils.delete(_key(this._name, _castToRequest(request)));
    };

    // FIXME: Add QueryParams argument.
    Cache.prototype.match = function(request) {
        return idbCacheUtils.getAsResponse(
            _key(this._name, _castToRequest(request))
        );
    };

    // FIXME: Implement this.
    Cache.prototype.matchAll = Promise.reject.bind(Promise, 'Cache.prototype.matchAll not implemented.');

    if (!global.Cache ||
         global.Cache.toString().indexOf("{} [native code] }") == -1) {
        global.Cache = Cache;
    }
}(this));  // window or worker global scope.
// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// A simple, incomplete implementation of the CacheStorage API, intended to facilitate
// end to end serviceworker testing.

// See https://slightlyoff.github.io/ServiceWorker/spec/service_worker/index.html#cache-storage

(function(global) {
    "use strict";

    var log = console.log.bind(console);
    var err = console.error.bind(console);

    // FIXME(slightlyoff):
    //      Now that we're backed by IDB, we run the very real risk of
    //      the initialization code happening before we've populated the
    //      cache name list. Need to add some locking to the mutation
    //      operations to delay them until construction is really finished.
    //
    //      NOTE that because we're using the in-memory cachesByName for a few
    //      things, we're not going to work if there is more than one  client
    //      for the polyfill (e.g., a SW and a foreground window both trying to
    //      modify the set of caches). In particular, if a Cache object is
    //      removed or added in one context, it won't show up in the other
    //      today. We can fix this by going back to the DB for everything all
    //      the time, but for the sake of speed we're omitting this for now.
    //
    //      Lastly, the schema (list of caches vs. cache stores) is roughly
    //      defined in idbCacheUtils.js and not here. Probably a bug and not a
    //      feature.

    var CacheStorage = function() {
        // log("custom cache storage");
        var caches = this.cachesByName = {};
        // Fetch a listing of all the cache objects and create front
        // objects for them here.
        idbCacheUtils.getAllCacheNames().then(function(names) {
            names.forEach(function(name) {
                caches[name] = new Cache();
                caches[name]._name = name;
            });
        }, err);
    };

    CacheStorage.prototype.get = function(key) {
        // FIXME(slightlyoff):
        //      key here is a string, not a Request, which is wrong.
        if (this.cachesByName.hasOwnProperty(key)) {
            return Promise.resolve(this.cachesByName[key]);
        }
        return Promise.reject('not found');
    };

    CacheStorage.prototype.has = function(key) {
        return Promise.resolve(this.cachesByName.hasOwnProperty(key));
    };

    // FIXME: Engage standardization on removing this method from the spec.
    CacheStorage.prototype.set = Promise.reject.bind(Promise, 'CacheStorage.prototype.set() not implemented.');

    // FIXME: Engage standardization on adding this method to the spec.
    CacheStorage.prototype.create = function(key) {
        if (!this.cachesByName[key]) {
            this.cachesByName[key] = new Cache(key);
            this.cachesByName[key]._name = key;
            idbCacheUtils.addCacheToList(key);
        }

        return Promise.resolve(this.cachesByName[key]);
    };

    // FIXME: Engage standarization on adding this method to the spec.
    CacheStorage.prototype.rename = function(fromKey, toKey) {
        if (!this.cachesByName.hasOwnProperty(fromKey)) {
            return Promise.reject('not found');
        }
        this.cachesByName[toKey] = this.cachesByName[fromKey];
        delete this.cachesByName[fromKey];
        // FIXME(slightlyoff):
        //   need to rename in the stores and udpdate all records with new name
        return Promise.resolve();
    };

    CacheStorage.prototype.clear = function() {
        this.cachesByName = {};
        return idbCacheUtils.clearAll();
    };

    CacheStorage.prototype.delete = function(key) {
        delete this.cachesByName[key];
        return Promise.all([idbCacheUtils.clear(key),
                            idbCacheUtils.removeCacheFromList(key)]);
    };

    // FIXME(slightlyoff): nonsensical
    CacheStorage.prototype.forEach = function(callback, thisArg) {
        Object.keys(this.cachesByName).map(function(key) {
            thisArg.callback(this.cachesByName[key], key, this);
        });
        return Promise.resolve();
    };

    // FIXME: Implement this.
    CacheStorage.prototype.entries = Promise.reject.bind(Promise, 'CacheStorage.prototype.entries() not implemented.');

    CacheStorage.prototype.keys = function() {
        return Promise.resolve(Object.keys(this.cachesByName));
    };

    CacheStorage.prototype.values = function() {
        return Promise.resolve(Object.keys(this.cachesByName).map(function(key) {
            return this.cachesByName[key];
        }));
    };

    CacheStorage.prototype.size = function() {
        return Promise.resolve(Object.keys(this.cachesByName).length);
    };

    // FIXME: Figure out what should be done with undefined or poorly defined |cacheName| values.
    CacheStorage.prototype.match = function(url, cacheName) {
        return this.get(cacheName).then(function(cache) {
            return cache.match(url);
        });
    };

    if (!global.caches ||
        !global.caches.constructor ||
         global.caches.constructor.
            toString().indexOf("{} [native code] }") == -1) {
        global.caches = new CacheStorage();
    }
}(self));  // window or worker global scope.
