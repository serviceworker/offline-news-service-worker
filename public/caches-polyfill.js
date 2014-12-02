(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
self.cachesPolyfill = require('../lib/caches.js');
},{"../lib/caches.js":4}],2:[function(require,module,exports){
var cacheDB = require('./cachedb');

function Cache() {
  this._name = '';
  this._origin = '';
}

var CacheProto = Cache.prototype;

CacheProto.match = function(request, params) {
  return cacheDB.match(this._origin, this._name, request, params);
};

CacheProto.matchAll = function(request, params) {
  return cacheDB.matchAll(this._origin, this._name, request, params);
};

CacheProto.addAll = function(requests) {
  Promise.all(
    requests.map(function(request) {
      return fetch(request);
    })
  ).then(function(responses) {
    return cacheDB.put(this._origin, this._name, responses.map(function(response, i) {
      return [requests[i], response];
    }));
  }.bind(this));
};

CacheProto.add = function(request) {
  return this.addAll([request]);
};

CacheProto.put = function(request, response) {
  if (!(response instanceof Response)) {
    throw TypeError("Incorrect response type");
  }

  return cacheDB.put(this._origin, this._name, [[request, response]]);
};

CacheProto.delete = function(request, params) {
  return cacheDB.delete(this._origin, this._name, request, params);
};

CacheProto.keys = function(request, params) {
  if (request) {
    return cacheDB.matchAllRequests(this._origin, this._name, request, params);
  }
  else {
    return cacheDB.allRequests(this._origin, this._name);
  }
};

module.exports = Cache;

},{"./cachedb":3}],3:[function(require,module,exports){
var IDBHelper = require('./idbhelper');

function matchesVary(request, entryRequest, entryResponse) {
  if (!entryResponse.headers.vary) {
    return true;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;
  var requestHeaders = {};

  for (var header of request.headers) {
    requestHeaders[header[0].toLowerCase()] = header[1];
  }

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    if (entryRequest.headers[varyHeader] != requestHeaders[varyHeader]) {
      return false;
    }
  }
  return true;
}

function createVaryID(entryRequest, entryResponse) {
  var id = '';

  if (!entryResponse.headers.vary) {
    return id;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    id += varyHeader + ': ' + (entryRequest.headers[varyHeader] || '') + '\n';
  }

  return id;
}

function flattenHeaders(headers) {
  var returnVal = {};

  for (var header of headers) {
    returnVal[header[0].toLowerCase()] = header[1];
  }

  return returnVal;
}

function entryToResponse(entry) {
  var entryResponse = entry.response;
  return new Response(entryResponse.body, {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, body) {
  return {
    body: body,
    status: response.status,
    statusText: response.statusText,
    headers: flattenHeaders(response.headers)
  };
}

function entryToRequest(entry) {
  var entryRequest = entry.request;
  return new Request(entryRequest.url, {
    mode: entryRequest.mode,
    headers: entryRequest.headers,
    credentials: entryRequest.headers
  });
}

function requestToEntry(request) {
  return {
    url: request.url,
    mode: request.mode,
    credentials: request.credentials,
    headers: flattenHeaders(request.headers)
  };
}

function castToRequest(request) {
  if (!(request instanceof Request)) {
    request = new Request(request);
  }
  return request;
}

function CacheDB() {
  this.db = new IDBHelper('cache-polyfill', 1, function(db, oldVersion) {
    switch (oldVersion) {
      case 0:
        var namesStore = db.createObjectStore('cacheNames', {
          keyPath: ['origin', 'name']
        });
        namesStore.createIndex('origin', ['origin', 'added']);

        var entryStore = db.createObjectStore('cacheEntries', {
          keyPath: ['origin', 'cacheName', 'request.url', 'varyID']
        });
        entryStore.createIndex('origin-cacheName', ['origin', 'cacheName', 'added']);
        entryStore.createIndex('origin-cacheName-urlNoSearch', ['origin', 'cacheName', 'requestUrlNoSearch', 'added']);
        entryStore.createIndex('origin-cacheName-url', ['origin', 'cacheName', 'request.url', 'added']);
    }
  });
}

var CacheDBProto = CacheDB.prototype;

CacheDBProto._eachCache = function(tx, origin, eachCallback, doneCallback, errorCallback) {
  IDBHelper.iterate(
    tx.objectStore('cacheNames').index('origin').openCursor(IDBKeyRange.bound([origin, 0], [origin, Infinity])),
    eachCallback, doneCallback, errorCallback
  );
};

CacheDBProto._eachMatch = function(tx, origin, cacheName, request, eachCallback, doneCallback, errorCallback, params) {
  params = params || {};

  var ignoreSearch = Boolean(params.ignoreSearch);
  var ignoreMethod = Boolean(params.ignoreMethod);
  var ignoreVary = Boolean(params.ignoreVary);
  var prefixMatch = Boolean(params.prefixMatch);

  if (!ignoreMethod &&
      request.method !== 'GET' &&
      request.method !== 'HEAD') {
    // we only store GET responses at the moment, so no match
    return Promise.resolve();
  }

  var cacheEntries = tx.objectStore('cacheEntries');
  var range;
  var index;
  var indexName = 'origin-cacheName-url';
  var urlToMatch = new URL(request.url);

  urlToMatch.hash = '';

  if (ignoreSearch) {
    urlToMatch.search = '';
    indexName += 'NoSearch';
  }

  // working around chrome bugs
  urlToMatch = urlToMatch.href.replace(/(\?|#|\?#)$/, '');

  index = cacheEntries.index(indexName);

  if (prefixMatch) {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch + String.fromCharCode(65535), Infinity]);
  }
  else {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch, Infinity]);
  }

  IDBHelper.iterate(index.openCursor(range), function(cursor) {
    var value = cursor.value;
    
    if (ignoreVary || matchesVary(request, cursor.value.request, cursor.value.response)) {
      eachCallback(cursor);
    }
    else {
      cursor.continue();
    }
  }, doneCallback, errorCallback);
};

CacheDBProto._hasCache = function(tx, origin, cacheName, doneCallback, errCallback) {
  var store = tx.objectStore('cacheNames');
  return IDBHelper.callbackify(store.get([origin, cacheName]), function(val) {
    doneCallback(!!val);
  }, errCallback);
};

CacheDBProto._delete = function(tx, origin, cacheName, request, doneCallback, errCallback, params) {
  var returnVal = false;

  this._eachMatch(tx, origin, cacheName, request, function(cursor) {
    returnVal = true;
    cursor.delete();
  }, function() {
    if (doneCallback) {
      doneCallback(returnVal);
    }
  }, errCallback, params);
};

CacheDBProto.matchAllRequests = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.key);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.allRequests = function(origin, cacheName) {
  var matches = [];

  return this.db.transaction('cacheEntries', function(tx) {
    var cacheEntries = tx.objectStore('cacheEntries');
    var index = cacheEntries.index('origin-cacheName');

    IDBHelper.iterate(index.openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])), function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    });
  }).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.matchAll = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToResponse);
  });
};

CacheDBProto.match = function(origin, cacheName, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      match = cursor.value;
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.matchAcrossCaches = function(origin, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      var cacheName = cursor.value.name;

      this._eachMatch(tx, origin, cacheName, request, function(cursor) {
        match = cursor.value;
        // we're done
      }, undefined, undefined, params);

      if (!match) { // continue if no match
        cursor.continue();
      }
    }.bind(this));
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.cacheNames = function(origin) {
  var names = [];

  return this.db.transaction('cacheNames', function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      names.push(cursor.value.name);
      cursor.continue();
    }.bind(this));
  }.bind(this)).then(function() {
    return names;
  });
};

CacheDBProto.delete = function(origin, cacheName, request, params) {
  var returnVal;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._delete(tx, origin, cacheName, request, params, function(v) {
      returnVal = v;
    });
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.openCache = function(origin, cacheName) {
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      if (val) { return; }
      var store = tx.objectStore('cacheNames');
      store.add({
        origin: origin,
        name: cacheName,
        added: Date.now()
      });
    });
  }.bind(this), {mode: 'readwrite'});
};

CacheDBProto.hasCache = function(origin, cacheName) {
  var returnVal;
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      returnVal = val;
    });
  }.bind(this)).then(function(val) {
    return returnVal;
  });
};

CacheDBProto.deleteCache = function(origin, cacheName) {
  var returnVal = false;

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    IDBHelper.iterate(
      tx.objectStore('cacheNames').openCursor(IDBKeyRange.only([origin, cacheName])),
      del
    );

    IDBHelper.iterate(
      tx.objectStore('cacheEntries').index('origin-cacheName').openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])),
      del
    );

    function del(cursor) {
      returnVal = true;
      cursor.delete();
      cursor.continue();
    }
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.put = function(origin, cacheName, items) {
  // items is [[request, response], [request, response], …]
  var item;

  for (var i = 0; i < items.length; i++) {
    items[i][0] = castToRequest(items[i][0]);

    if (items[i][0].method != 'GET') {
      return Promise.reject(TypeError('Only GET requests are supported'));
    }

    // ensure each entry being put won't overwrite earlier entries being put
    for (var j = 0; j < i; j++) {
      if (items[i][0].url == items[j][0].url && matchesVary(items[j][0], items[i][0], items[i][1])) {
        return Promise.reject(TypeError('Puts would overwrite eachother'));
      }
    }
  }

  return Promise.all(
    items.map(function(item) {
      return item[1].blob();
    })
  ).then(function(responseBodies) {
    return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
      this._hasCache(tx, origin, cacheName, function(hasCache) {
        if (!hasCache) {
          throw Error("Cache of that name does not exist");
        }

        items.forEach(function(item, i) {
          var request = item[0];
          var response = item[1];
          var requestEntry = requestToEntry(request);
          var responseEntry = responseToEntry(response, responseBodies[i]);

          var requestUrlNoSearch = new URL(request.url);
          requestUrlNoSearch.search = '';
          // working around Chrome bug
          requestUrlNoSearch = requestUrlNoSearch.href.replace(/\?$/, '');

          this._delete(tx, origin, cacheName, request, function() {
            tx.objectStore('cacheEntries').add({
              origin: origin,
              cacheName: cacheName,
              request: requestEntry,
              response: responseEntry,
              requestUrlNoSearch: requestUrlNoSearch,
              varyID: createVaryID(requestEntry, responseEntry),
              added: Date.now()
            });
          });

        }.bind(this));
      }.bind(this));
    }.bind(this), {mode: 'readwrite'});
  }.bind(this)).then(function() {
    return undefined;
  });
};

module.exports = new CacheDB();
},{"./idbhelper":5}],4:[function(require,module,exports){
var cacheDB = require('./cachedb');
var Cache = require('./cache');

function CacheStorage() {
  this._origin = location.origin;
}

var CacheStorageProto = CacheStorage.prototype;

CacheStorageProto._vendCache = function(name) {
  var cache = new Cache();
  cache._name = name;
  cache._origin = this._origin;
  return cache;
};

CacheStorageProto.match = function(request, params) {
  return cacheDB.matchAcrossCaches(this._origin, request, params);
};

CacheStorageProto.has = function(name) {
  return cacheDB.hasCache(this._origin, name);
};

CacheStorageProto.open = function(name) {
  return cacheDB.openCache(this._origin, name).then(function() {
    return this._vendCache(name);
  }.bind(this));
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(this._origin, name);
};

CacheStorageProto.keys = function() {
  return cacheDB.cacheNames(this._origin);
};

self.cachesPolyfill = module.exports = new CacheStorage();

},{"./cache":2,"./cachedb":3}],5:[function(require,module,exports){
function IDBHelper(name, version, upgradeCallback) {
  var request = indexedDB.open(name, version);
  this.ready = IDBHelper.promisify(request);
  request.onupgradeneeded = function(event) {
    upgradeCallback(request.result, event.oldVersion);
  };
}

IDBHelper.supported = 'indexedDB' in self;

IDBHelper.promisify = function(obj) {
  return new Promise(function(resolve, reject) {
    IDBHelper.callbackify(obj, resolve, reject);
  });
};

IDBHelper.callbackify = function(obj, doneCallback, errCallback) {
  function onsuccess(event) {
    if (doneCallback) {
      doneCallback(obj.result);
    }
    unlisten();
  }
  function onerror(event) {
    if (errCallback) {
      errCallback(obj.error);
    }
    unlisten();
  }
  function unlisten() {
    obj.removeEventListener('complete', onsuccess);
    obj.removeEventListener('success', onsuccess);
    obj.removeEventListener('error', onerror);
    obj.removeEventListener('abort', onerror);
  }
  obj.addEventListener('complete', onsuccess);
  obj.addEventListener('success', onsuccess);
  obj.addEventListener('error', onerror);
  obj.addEventListener('abort', onerror);
};

IDBHelper.iterate = function(cursorRequest, eachCallback, doneCallback, errorCallback) {
  var oldCursorContinue;

  function cursorContinue() {
    this._continuing = true;
    return oldCursorContinue.call(this);
  }

  cursorRequest.onsuccess = function() {
    var cursor = cursorRequest.result;

    if (!cursor) {
      if (doneCallback) {
        doneCallback();
      }
      return;
    }

    if (cursor.continue != cursorContinue) {
      oldCursorContinue = cursor.continue;
      cursor.continue = cursorContinue;
    }

    eachCallback(cursor);

    if (!cursor._continuing) {
      if (doneCallback) {
        doneCallback();
      }
    }
  };

  cursorRequest.onerror = function() {
    if (errorCallback) {
      errorCallback(cursorRequest.error);
    }
  };
};

var IDBHelperProto = IDBHelper.prototype;

IDBHelperProto.transaction = function(stores, callback, opts) {
  opts = opts || {};

  return this.ready.then(function(db) {
    var mode = opts.mode || 'readonly';

    var tx = db.transaction(stores, mode);
    callback(tx, db);
    return IDBHelper.promisify(tx);
  });
};

module.exports = IDBHelper;
},{}]},{},[1])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9jYWNoZS1wb2x5ZmlsbC9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3Nlci1wYWNrL19wcmVsdWRlLmpzIiwiLi9idWlsZC9pbmRleC5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9jYWNoZS1wb2x5ZmlsbC9saWIvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9jYWNoZS1wb2x5ZmlsbC9saWIvaWRiaGVscGVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7O0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3phQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJzZWxmLmNhY2hlc1BvbHlmaWxsID0gcmVxdWlyZSgnLi4vbGliL2NhY2hlcy5qcycpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG5cbmZ1bmN0aW9uIENhY2hlKCkge1xuICB0aGlzLl9uYW1lID0gJyc7XG4gIHRoaXMuX29yaWdpbiA9ICcnO1xufVxuXG52YXIgQ2FjaGVQcm90byA9IENhY2hlLnByb3RvdHlwZTtcblxuQ2FjaGVQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWxsKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkQWxsID0gZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgUHJvbWlzZS5hbGwoXG4gICAgcmVxdWVzdHMubWFwKGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0KTtcbiAgICB9KVxuICApLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VzKSB7XG4gICAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVzcG9uc2VzLm1hcChmdW5jdGlvbihyZXNwb25zZSwgaSkge1xuICAgICAgcmV0dXJuIFtyZXF1ZXN0c1tpXSwgcmVzcG9uc2VdO1xuICAgIH0pKTtcbiAgfS5iaW5kKHRoaXMpKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkID0gZnVuY3Rpb24ocmVxdWVzdCkge1xuICByZXR1cm4gdGhpcy5hZGRBbGwoW3JlcXVlc3RdKTtcbn07XG5cbkNhY2hlUHJvdG8ucHV0ID0gZnVuY3Rpb24ocmVxdWVzdCwgcmVzcG9uc2UpIHtcbiAgaWYgKCEocmVzcG9uc2UgaW5zdGFuY2VvZiBSZXNwb25zZSkpIHtcbiAgICB0aHJvdyBUeXBlRXJyb3IoXCJJbmNvcnJlY3QgcmVzcG9uc2UgdHlwZVwiKTtcbiAgfVxuXG4gIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIFtbcmVxdWVzdCwgcmVzcG9uc2VdXSk7XG59O1xuXG5DYWNoZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5kZWxldGUodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVQcm90by5rZXlzID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIGlmIChyZXF1ZXN0KSB7XG4gICAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGNhY2hlREIuYWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lKTtcbiAgfVxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBDYWNoZTtcbiIsInZhciBJREJIZWxwZXIgPSByZXF1aXJlKCcuL2lkYmhlbHBlcicpO1xuXG5mdW5jdGlvbiBtYXRjaGVzVmFyeShyZXF1ZXN0LCBlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcbiAgdmFyIHJlcXVlc3RIZWFkZXJzID0ge307XG5cbiAgZm9yICh2YXIgaGVhZGVyIG9mIHJlcXVlc3QuaGVhZGVycykge1xuICAgIHJlcXVlc3RIZWFkZXJzW2hlYWRlclswXS50b0xvd2VyQ2FzZSgpXSA9IGhlYWRlclsxXTtcbiAgfVxuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyeUhlYWRlcnMubGVuZ3RoOyBpKyspIHtcbiAgICB2YXJ5SGVhZGVyID0gdmFyeUhlYWRlcnNbaV0udHJpbSgpO1xuXG4gICAgaWYgKHZhcnlIZWFkZXIgPT0gJyonKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gIT0gcmVxdWVzdEhlYWRlcnNbdmFyeUhlYWRlcl0pIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVZhcnlJRChlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcbiAgdmFyIGlkID0gJyc7XG5cbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnRvTG93ZXJDYXNlKCkuc3BsaXQoJywnKTtcbiAgdmFyIHZhcnlIZWFkZXI7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlkICs9IHZhcnlIZWFkZXIgKyAnOiAnICsgKGVudHJ5UmVxdWVzdC5oZWFkZXJzW3ZhcnlIZWFkZXJdIHx8ICcnKSArICdcXG4nO1xuICB9XG5cbiAgcmV0dXJuIGlkO1xufVxuXG5mdW5jdGlvbiBmbGF0dGVuSGVhZGVycyhoZWFkZXJzKSB7XG4gIHZhciByZXR1cm5WYWwgPSB7fTtcblxuICBmb3IgKHZhciBoZWFkZXIgb2YgaGVhZGVycykge1xuICAgIHJldHVyblZhbFtoZWFkZXJbMF0udG9Mb3dlckNhc2UoKV0gPSBoZWFkZXJbMV07XG4gIH1cblxuICByZXR1cm4gcmV0dXJuVmFsO1xufVxuXG5mdW5jdGlvbiBlbnRyeVRvUmVzcG9uc2UoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVzcG9uc2UgPSBlbnRyeS5yZXNwb25zZTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShlbnRyeVJlc3BvbnNlLmJvZHksIHtcbiAgICBzdGF0dXM6IGVudHJ5UmVzcG9uc2Uuc3RhdHVzLFxuICAgIHN0YXR1c1RleHQ6IGVudHJ5UmVzcG9uc2Uuc3RhdHVzVGV4dCxcbiAgICBoZWFkZXJzOiBlbnRyeVJlc3BvbnNlLmhlYWRlcnNcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3BvbnNlVG9FbnRyeShyZXNwb25zZSwgYm9keSkge1xuICByZXR1cm4ge1xuICAgIGJvZHk6IGJvZHksXG4gICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXG4gICAgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCxcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXNwb25zZS5oZWFkZXJzKVxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnRyeVRvUmVxdWVzdChlbnRyeSkge1xuICB2YXIgZW50cnlSZXF1ZXN0ID0gZW50cnkucmVxdWVzdDtcbiAgcmV0dXJuIG5ldyBSZXF1ZXN0KGVudHJ5UmVxdWVzdC51cmwsIHtcbiAgICBtb2RlOiBlbnRyeVJlcXVlc3QubW9kZSxcbiAgICBoZWFkZXJzOiBlbnRyeVJlcXVlc3QuaGVhZGVycyxcbiAgICBjcmVkZW50aWFsczogZW50cnlSZXF1ZXN0LmhlYWRlcnNcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpIHtcbiAgcmV0dXJuIHtcbiAgICB1cmw6IHJlcXVlc3QudXJsLFxuICAgIG1vZGU6IHJlcXVlc3QubW9kZSxcbiAgICBjcmVkZW50aWFsczogcmVxdWVzdC5jcmVkZW50aWFscyxcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXF1ZXN0LmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNhc3RUb1JlcXVlc3QocmVxdWVzdCkge1xuICBpZiAoIShyZXF1ZXN0IGluc3RhbmNlb2YgUmVxdWVzdCkpIHtcbiAgICByZXF1ZXN0ID0gbmV3IFJlcXVlc3QocmVxdWVzdCk7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmZ1bmN0aW9uIENhY2hlREIoKSB7XG4gIHRoaXMuZGIgPSBuZXcgSURCSGVscGVyKCdjYWNoZS1wb2x5ZmlsbCcsIDEsIGZ1bmN0aW9uKGRiLCBvbGRWZXJzaW9uKSB7XG4gICAgc3dpdGNoIChvbGRWZXJzaW9uKSB7XG4gICAgICBjYXNlIDA6XG4gICAgICAgIHZhciBuYW1lc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnbmFtZSddXG4gICAgICAgIH0pO1xuICAgICAgICBuYW1lc1N0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4nLCBbJ29yaWdpbicsICdhZGRlZCddKTtcblxuICAgICAgICB2YXIgZW50cnlTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ3ZhcnlJRCddXG4gICAgICAgIH0pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybE5vU2VhcmNoJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3RVcmxOb1NlYXJjaCcsICdhZGRlZCddKTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmwnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAnYWRkZWQnXSk7XG4gICAgfVxuICB9KTtcbn1cblxudmFyIENhY2hlREJQcm90byA9IENhY2hlREIucHJvdG90eXBlO1xuXG5DYWNoZURCUHJvdG8uX2VhY2hDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XG4gIElEQkhlbHBlci5pdGVyYXRlKFxuICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ29yaWdpbicpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgMF0sIFtvcmlnaW4sIEluZmluaXR5XSkpLFxuICAgIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrXG4gICk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2VhY2hNYXRjaCA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2ssIHBhcmFtcykge1xuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XG5cbiAgdmFyIGlnbm9yZVNlYXJjaCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVNlYXJjaCk7XG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xuICB2YXIgaWdub3JlVmFyeSA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVZhcnkpO1xuICB2YXIgcHJlZml4TWF0Y2ggPSBCb29sZWFuKHBhcmFtcy5wcmVmaXhNYXRjaCk7XG5cbiAgaWYgKCFpZ25vcmVNZXRob2QgJiZcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnR0VUJyAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xuICAgIC8vIHdlIG9ubHkgc3RvcmUgR0VUIHJlc3BvbnNlcyBhdCB0aGUgbW9tZW50LCBzbyBubyBtYXRjaFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gIHZhciByYW5nZTtcbiAgdmFyIGluZGV4O1xuICB2YXIgaW5kZXhOYW1lID0gJ29yaWdpbi1jYWNoZU5hbWUtdXJsJztcbiAgdmFyIHVybFRvTWF0Y2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcblxuICB1cmxUb01hdGNoLmhhc2ggPSAnJztcblxuICBpZiAoaWdub3JlU2VhcmNoKSB7XG4gICAgdXJsVG9NYXRjaC5zZWFyY2ggPSAnJztcbiAgICBpbmRleE5hbWUgKz0gJ05vU2VhcmNoJztcbiAgfVxuXG4gIC8vIHdvcmtpbmcgYXJvdW5kIGNocm9tZSBidWdzXG4gIHVybFRvTWF0Y2ggPSB1cmxUb01hdGNoLmhyZWYucmVwbGFjZSgvKFxcP3wjfFxcPyMpJC8sICcnKTtcblxuICBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleChpbmRleE5hbWUpO1xuXG4gIGlmIChwcmVmaXhNYXRjaCkge1xuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NTUzNSksIEluZmluaXR5XSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIEluZmluaXR5XSk7XG4gIH1cblxuICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKHJhbmdlKSwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgdmFyIHZhbHVlID0gY3Vyc29yLnZhbHVlO1xuICAgIFxuICAgIGlmIChpZ25vcmVWYXJ5IHx8IG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVzcG9uc2UpKSB7XG4gICAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9XG4gIH0sIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjayk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2hhc0NhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XG4gIHJldHVybiBJREJIZWxwZXIuY2FsbGJhY2tpZnkoc3RvcmUuZ2V0KFtvcmlnaW4sIGNhY2hlTmFtZV0pLCBmdW5jdGlvbih2YWwpIHtcbiAgICBkb25lQ2FsbGJhY2soISF2YWwpO1xuICB9LCBlcnJDYWxsYmFjayk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2RlbGV0ZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaywgcGFyYW1zKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICByZXR1cm5WYWwgPSB0cnVlO1xuICAgIGN1cnNvci5kZWxldGUoKTtcbiAgfSwgZnVuY3Rpb24oKSB7XG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgZG9uZUNhbGxiYWNrKHJldHVyblZhbCk7XG4gICAgfVxuICB9LCBlcnJDYWxsYmFjaywgcGFyYW1zKTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci5rZXkpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5hbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcbiAgICB2YXIgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKTtcblxuICAgIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0pO1xuICB9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVzcG9uc2UpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFjcm9zc0NhY2hlcyA9IGZ1bmN0aW9uKG9yaWdpbiwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaDtcblxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaENhY2hlKHR4LCBvcmlnaW4sIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgdmFyIGNhY2hlTmFtZSA9IGN1cnNvci52YWx1ZS5uYW1lO1xuXG4gICAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XG4gICAgICAgIC8vIHdlJ3JlIGRvbmVcbiAgICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuXG4gICAgICBpZiAoIW1hdGNoKSB7IC8vIGNvbnRpbnVlIGlmIG5vIG1hdGNoXG4gICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgfVxuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5jYWNoZU5hbWVzID0gZnVuY3Rpb24ob3JpZ2luKSB7XG4gIHZhciBuYW1lcyA9IFtdO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBuYW1lcy5wdXNoKGN1cnNvci52YWx1ZS5uYW1lKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbmFtZXM7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbDtcblxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMsIGZ1bmN0aW9uKHYpIHtcbiAgICAgIHJldHVyblZhbCA9IHY7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5vcGVuQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcbiAgICAgIGlmICh2YWwpIHsgcmV0dXJuOyB9XG4gICAgICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xuICAgICAgc3RvcmUuYWRkKHtcbiAgICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICAgIG5hbWU6IGNhY2hlTmFtZSxcbiAgICAgICAgYWRkZWQ6IERhdGUubm93KClcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xufTtcblxuQ2FjaGVEQlByb3RvLmhhc0NhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbDtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24odmFsKSB7XG4gICAgICByZXR1cm5WYWwgPSB2YWw7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbih2YWwpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5kZWxldGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2Uub25seShbb3JpZ2luLCBjYWNoZU5hbWVdKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgZnVuY3Rpb24gZGVsKGN1cnNvcikge1xuICAgICAgcmV0dXJuVmFsID0gdHJ1ZTtcbiAgICAgIGN1cnNvci5kZWxldGUoKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLnB1dCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCBpdGVtcykge1xuICAvLyBpdGVtcyBpcyBbW3JlcXVlc3QsIHJlc3BvbnNlXSwgW3JlcXVlc3QsIHJlc3BvbnNlXSwg4oCmXVxuICB2YXIgaXRlbTtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XG4gICAgaXRlbXNbaV1bMF0gPSBjYXN0VG9SZXF1ZXN0KGl0ZW1zW2ldWzBdKTtcblxuICAgIGlmIChpdGVtc1tpXVswXS5tZXRob2QgIT0gJ0dFVCcpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoJ09ubHkgR0VUIHJlcXVlc3RzIGFyZSBzdXBwb3J0ZWQnKSk7XG4gICAgfVxuXG4gICAgLy8gZW5zdXJlIGVhY2ggZW50cnkgYmVpbmcgcHV0IHdvbid0IG92ZXJ3cml0ZSBlYXJsaWVyIGVudHJpZXMgYmVpbmcgcHV0XG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBpOyBqKyspIHtcbiAgICAgIGlmIChpdGVtc1tpXVswXS51cmwgPT0gaXRlbXNbal1bMF0udXJsICYmIG1hdGNoZXNWYXJ5KGl0ZW1zW2pdWzBdLCBpdGVtc1tpXVswXSwgaXRlbXNbaV1bMV0pKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoJ1B1dHMgd291bGQgb3ZlcndyaXRlIGVhY2hvdGhlcicpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgaXRlbXMubWFwKGZ1bmN0aW9uKGl0ZW0pIHtcbiAgICAgIHJldHVybiBpdGVtWzFdLmJsb2IoKTtcbiAgICB9KVxuICApLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VCb2RpZXMpIHtcbiAgICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKGhhc0NhY2hlKSB7XG4gICAgICAgIGlmICghaGFzQ2FjaGUpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcihcIkNhY2hlIG9mIHRoYXQgbmFtZSBkb2VzIG5vdCBleGlzdFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGl0ZW1zLmZvckVhY2goZnVuY3Rpb24oaXRlbSwgaSkge1xuICAgICAgICAgIHZhciByZXF1ZXN0ID0gaXRlbVswXTtcbiAgICAgICAgICB2YXIgcmVzcG9uc2UgPSBpdGVtWzFdO1xuICAgICAgICAgIHZhciByZXF1ZXN0RW50cnkgPSByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KTtcbiAgICAgICAgICB2YXIgcmVzcG9uc2VFbnRyeSA9IHJlc3BvbnNlVG9FbnRyeShyZXNwb25zZSwgcmVzcG9uc2VCb2RpZXNbaV0pO1xuXG4gICAgICAgICAgdmFyIHJlcXVlc3RVcmxOb1NlYXJjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaC5zZWFyY2ggPSAnJztcbiAgICAgICAgICAvLyB3b3JraW5nIGFyb3VuZCBDaHJvbWUgYnVnXG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoID0gcmVxdWVzdFVybE5vU2VhcmNoLmhyZWYucmVwbGFjZSgvXFw/JC8sICcnKTtcblxuICAgICAgICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpLmFkZCh7XG4gICAgICAgICAgICAgIG9yaWdpbjogb3JpZ2luLFxuICAgICAgICAgICAgICBjYWNoZU5hbWU6IGNhY2hlTmFtZSxcbiAgICAgICAgICAgICAgcmVxdWVzdDogcmVxdWVzdEVudHJ5LFxuICAgICAgICAgICAgICByZXNwb25zZTogcmVzcG9uc2VFbnRyeSxcbiAgICAgICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoOiByZXF1ZXN0VXJsTm9TZWFyY2gsXG4gICAgICAgICAgICAgIHZhcnlJRDogY3JlYXRlVmFyeUlEKHJlcXVlc3RFbnRyeSwgcmVzcG9uc2VFbnRyeSksXG4gICAgICAgICAgICAgIGFkZGVkOiBEYXRlLm5vdygpXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICB9LmJpbmQodGhpcykpO1xuICAgICAgfS5iaW5kKHRoaXMpKTtcbiAgICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IG5ldyBDYWNoZURCKCk7IiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcbnZhciBDYWNoZSA9IHJlcXVpcmUoJy4vY2FjaGUnKTtcblxuZnVuY3Rpb24gQ2FjaGVTdG9yYWdlKCkge1xuICB0aGlzLl9vcmlnaW4gPSBsb2NhdGlvbi5vcmlnaW47XG59XG5cbnZhciBDYWNoZVN0b3JhZ2VQcm90byA9IENhY2hlU3RvcmFnZS5wcm90b3R5cGU7XG5cbkNhY2hlU3RvcmFnZVByb3RvLl92ZW5kQ2FjaGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHZhciBjYWNoZSA9IG5ldyBDYWNoZSgpO1xuICBjYWNoZS5fbmFtZSA9IG5hbWU7XG4gIGNhY2hlLl9vcmlnaW4gPSB0aGlzLl9vcmlnaW47XG4gIHJldHVybiBjYWNoZTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWNyb3NzQ2FjaGVzKHRoaXMuX29yaWdpbiwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmhhcyA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuaGFzQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLm9wZW4gPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLm9wZW5DYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcbiAgfS5iaW5kKHRoaXMpKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmtleXMgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIGNhY2hlREIuY2FjaGVOYW1lcyh0aGlzLl9vcmlnaW4pO1xufTtcblxuc2VsZi5jYWNoZXNQb2x5ZmlsbCA9IG1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlU3RvcmFnZSgpO1xuIiwiZnVuY3Rpb24gSURCSGVscGVyKG5hbWUsIHZlcnNpb24sIHVwZ3JhZGVDYWxsYmFjaykge1xuICB2YXIgcmVxdWVzdCA9IGluZGV4ZWREQi5vcGVuKG5hbWUsIHZlcnNpb24pO1xuICB0aGlzLnJlYWR5ID0gSURCSGVscGVyLnByb21pc2lmeShyZXF1ZXN0KTtcbiAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSBmdW5jdGlvbihldmVudCkge1xuICAgIHVwZ3JhZGVDYWxsYmFjayhyZXF1ZXN0LnJlc3VsdCwgZXZlbnQub2xkVmVyc2lvbik7XG4gIH07XG59XG5cbklEQkhlbHBlci5zdXBwb3J0ZWQgPSAnaW5kZXhlZERCJyBpbiBzZWxmO1xuXG5JREJIZWxwZXIucHJvbWlzaWZ5ID0gZnVuY3Rpb24ob2JqKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICBJREJIZWxwZXIuY2FsbGJhY2tpZnkob2JqLCByZXNvbHZlLCByZWplY3QpO1xuICB9KTtcbn07XG5cbklEQkhlbHBlci5jYWxsYmFja2lmeSA9IGZ1bmN0aW9uKG9iaiwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xuICBmdW5jdGlvbiBvbnN1Y2Nlc3MoZXZlbnQpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2sob2JqLnJlc3VsdCk7XG4gICAgfVxuICAgIHVubGlzdGVuKCk7XG4gIH1cbiAgZnVuY3Rpb24gb25lcnJvcihldmVudCkge1xuICAgIGlmIChlcnJDYWxsYmFjaykge1xuICAgICAgZXJyQ2FsbGJhY2sob2JqLmVycm9yKTtcbiAgICB9XG4gICAgdW5saXN0ZW4oKTtcbiAgfVxuICBmdW5jdGlvbiB1bmxpc3RlbigpIHtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignY29tcGxldGUnLCBvbnN1Y2Nlc3MpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignZXJyb3InLCBvbmVycm9yKTtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbmVycm9yKTtcbiAgfVxuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignY29tcGxldGUnLCBvbnN1Y2Nlc3MpO1xuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignc3VjY2VzcycsIG9uc3VjY2Vzcyk7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbmVycm9yKTtcbn07XG5cbklEQkhlbHBlci5pdGVyYXRlID0gZnVuY3Rpb24oY3Vyc29yUmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcbiAgdmFyIG9sZEN1cnNvckNvbnRpbnVlO1xuXG4gIGZ1bmN0aW9uIGN1cnNvckNvbnRpbnVlKCkge1xuICAgIHRoaXMuX2NvbnRpbnVpbmcgPSB0cnVlO1xuICAgIHJldHVybiBvbGRDdXJzb3JDb250aW51ZS5jYWxsKHRoaXMpO1xuICB9XG5cbiAgY3Vyc29yUmVxdWVzdC5vbnN1Y2Nlc3MgPSBmdW5jdGlvbigpIHtcbiAgICB2YXIgY3Vyc29yID0gY3Vyc29yUmVxdWVzdC5yZXN1bHQ7XG5cbiAgICBpZiAoIWN1cnNvcikge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoY3Vyc29yLmNvbnRpbnVlICE9IGN1cnNvckNvbnRpbnVlKSB7XG4gICAgICBvbGRDdXJzb3JDb250aW51ZSA9IGN1cnNvci5jb250aW51ZTtcbiAgICAgIGN1cnNvci5jb250aW51ZSA9IGN1cnNvckNvbnRpbnVlO1xuICAgIH1cblxuICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuXG4gICAgaWYgKCFjdXJzb3IuX2NvbnRpbnVpbmcpIHtcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGN1cnNvclJlcXVlc3Qub25lcnJvciA9IGZ1bmN0aW9uKCkge1xuICAgIGlmIChlcnJvckNhbGxiYWNrKSB7XG4gICAgICBlcnJvckNhbGxiYWNrKGN1cnNvclJlcXVlc3QuZXJyb3IpO1xuICAgIH1cbiAgfTtcbn07XG5cbnZhciBJREJIZWxwZXJQcm90byA9IElEQkhlbHBlci5wcm90b3R5cGU7XG5cbklEQkhlbHBlclByb3RvLnRyYW5zYWN0aW9uID0gZnVuY3Rpb24oc3RvcmVzLCBjYWxsYmFjaywgb3B0cykge1xuICBvcHRzID0gb3B0cyB8fCB7fTtcblxuICByZXR1cm4gdGhpcy5yZWFkeS50aGVuKGZ1bmN0aW9uKGRiKSB7XG4gICAgdmFyIG1vZGUgPSBvcHRzLm1vZGUgfHwgJ3JlYWRvbmx5JztcblxuICAgIHZhciB0eCA9IGRiLnRyYW5zYWN0aW9uKHN0b3JlcywgbW9kZSk7XG4gICAgY2FsbGJhY2sodHgsIGRiKTtcbiAgICByZXR1cm4gSURCSGVscGVyLnByb21pc2lmeSh0eCk7XG4gIH0pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBJREJIZWxwZXI7Il19
