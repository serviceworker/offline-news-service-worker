var db;

this.oninstall = function(e) {
  e.waitUntil(openDatabase().then(function() {
      return Promise.all([
        synchronizeContent(), updateApplication()
      ]);
    });
};

this.onfetch = function(e) {
  e.respondWith(fetch(e.request));
};

function openDatabase() {
  return new Promise(function(resolve, reject) {
    var version = 1;
    var request = indexedDB.open('news', version);
    request.onupgradeneeded = function(e) {
      db = e.target.result;
      e.target.transaction.onerror = reject;
      db.createObjectStore('stories', { keyPath: 'guid' });
      db.createObjectStore('cache', { keyPath: 'path' });
    };
    request.onsuccess = function(e) {
      db = e.target.result;
      resolve();
    };
    request.onerror = reject;
  });
}

function synchronizeContent() {
  Promise.all([databaseGet('stories'),
    fetch('https://offline-news-api.herokuapp.com/stories')
      .then(function(res) { return res.body.asJSON(); })])
    .then(function(results) {
      var promises = [];
      var localStories = results[0];
      var remoteStories = results[1];

      // Add new stories downloaded from server to the database
      promises = promises.concat(remoteStories.map(function(story) {
        if (!arrayContainsStory(localStories, story)) {
          return databasePut('stories', story);
        }
      }));

      // Delete stories that are no longer on the server from the database
      promises = promises.concat(localStories.map(function(story) {
        if (!arrayContainsStory(remoteStories, story)) {
          return databaseDelete('stories', story);
        }
      }));

      return promises;
    });
}

function updateApplication() {
  var precachePaths = [
    '/styles.css',
    '/templates.js',
    '/application.js'
  ];

  Promise.all(precachePaths.map(function(path) {
    return fetch(path).then(function(res) {
      return { path: path, body: res.body.asText() };
    });
  }))
    .then(function(results) {
      return Promise.all(results.map(function(result) {
        return databasePut('cache', result);
      }));
    });
}

function databasePut(type, item) {
  return new Promise(function(resolve, reject) {
    var transaction = db.transaction([type], 'readwrite');
    var store = transaction.objectStore(type);
    var request = store.put(item);
    request.onsuccess = resolve;
    request.onerror = reject;
  });
}

function databaseDelete(type, id) {
  return new Promise(function(resolve, reject) {
    var transaction = db.transaction([type], 'readwrite');
    var store = transaction.objectStore(type);
    var request = store.delete(id);
    request.onsuccess = resolve;
    request.onerror = reject;
  });
}

function databaseGet(type) {
  return new Promise(function(resolve, reject) {
    var transaction = db.transaction([type], 'readonly');
    var store = transaction.objectStore(type);

    var keyRange = IDBKeyRange.lowerBound(0);

    // Using reverse direction because the index being sorted on
    // ends with a numerical incrementing ID so to get newest news
    // first you need to sort by largest first.
    var cursorRequest = store.openCursor(keyRange, 'prev');

    var data = [];
    cursorRequest.onsuccess = function(e) {
      var result = e.target.result;
      if (result) {
        data.push(result.value);
        result.continue();
      } else {
        resolve(data);
      }
    };
  });
}
