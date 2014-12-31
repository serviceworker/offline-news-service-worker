importScripts('./templates.js');

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
    promise = caches.match(new Request(api))
      .then(function(response) {
        return response.json();
      }).then(function(stories) {
        return new Response(templates.list(stories), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      });
  } else if (guidMatches) {
    promise = caches.match(new Request(api))
      .then(function(response) {
        return response.json();
      }).then(function(stories) {
        var story = stories.filter(function(story) {
          return guidMatches[1] === story.guid;
        });
        var body = templates.article(story[0]);
        return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      });
  } else {
    promise = caches.match(e.request);
  }
  promise
    .catch(function(err) {
      return fetch(e.request.url);
    });
  e.respondWith(promise);
};

function isValidStatus(status) {
  if (status >= 400 && status < 600) {
    return false;
  }
  return true;
}

function updateContent() {
  return caches.open('news-content-cache').then(function(cache) {
    return fetch(api)
      .then(function(response) {
        if (!isValidStatus(response.status)) {
          throw new Error("The Server returned a bad response");
        }
        return cache.put(api, response);
      });
  });
}

function updateApplication() {
  return Promise.all([
    fetch('/styles.css'),
    fetch('/application.js'),
    caches.open('news-static-cache')
  ]).then(function(responses) {
    if (!isValidStatus(responses[0].status) || !isValidStatus(responses[1].status)) {
      throw new Error("The Server returned a bad response");
    }
    var cache = responses[2];
    return Promise.all([
      cache.put('/styles.css', responses[0]),
      cache.put('/application.js', responses[1])
    ]);
  });
}
