var db;

this.oninstall = function(e) {
  e.waitUntil(openDatabase()
    .then(Promise.all([synchronizeContent, updateApplication])));
};

this.onfetch = function(e) {
  event.respondWith(caches.match('resources', e.request.url)
    .catch(function() {
      return fetch(event.request);
    }));
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
  Promise.all([databaseStoriesGet(),
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
  var precacheUrls = [
    '/styles.css',
    '/templates.js',
    '/application.js'
  ];

  // todo add logic to download+store those files in IndexedDB
}

function databasePut(store, item) {
  return new Promise(function(resolve, reject) {
    var transaction = db.transaction([store], 'readwrite');
    var store = transaction.objectStore(store);
    var request = store.put(item);
    request.onsuccess = resolve;
    request.onerror = reject;
  });
}
