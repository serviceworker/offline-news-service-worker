this.oninstall = function(e) {
  var resources = caches.set('resources', new Cache(
    '/styles.css',
    '/templates.js',
    '/application.js'
  ));

  e.waitUntil(resources.ready());
};

this.onfetch = function(e) {
  event.respondWith(caches.match('resources', e.request.url)
    .catch(function() {
      return fetch(event.request);
    }));
};
