importScripts('./templates.js');
importScripts('./caches-polyfill.js');

var api = 'https://offline-news-api.herokuapp.com/stories';
var db;
var templates = this.templates;

this.oninstall = function(e) {
  e.waitUntil(Promise.all([
    updateContent(), updateApplication()
  ]));
};

this.onactivate = function() {
  setInterval(updateContent, 3*60*1000);
};

this.onfetch = function(e) {
  var url = e.request.url;
  var path = url.replace(location.origin, '');
  var guidMatches = path.match(/^\/article\/([0-9]+)\/?$/);
  var promise;

  if (path === '/') {
    promise = polyfillCaches.match(new Request(api))
      .then(function(response) {
        return response.json();
      }).then(function(stories) {
        return new Response(templates.list(stories), { headers: { "Content-Type": "text/html" } });
      });
  } else if (guidMatches) {
    promise = polyfillCaches.match(new Request(api))
      .then(function(response) {
        return response.json();
      }).then(function(stories) {
        var story = stories.filter(function(story) {
          return guidMatches[1] === story.guid;
        });
        var body = templates.article(story[0]);
        return new Response(body, { headers: { "Content-Type": "text/html" } });
      });
  } else {
    promise = polyfillCaches.match(e.request);
  }
  e.respondWith(promise);
};

function updateContent() {
  return polyfillCaches.get('news-content-cache').then(function(cache) {
    return cache || polyfillCaches.create('news-content-cache');
  }).then(function(cache) {
    return cache.addAll([api]);
  }).then(function() {
    debugger;
  }, function() {
    debugger;
  });
}

function updateApplication() {
  return polyfillCaches.get('news-static-cache').then(function(cache) {
    return cache || polyfillCaches.create('news-static-cache');
  }).then(function(cache) {
    return cache.addAll([
    '/styles.css',
    '/templates.js',
    '/application.js'
    ]);
  });
}
