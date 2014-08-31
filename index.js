var port = Number(process.env.PORT || 8080);
var api = 'http' + (port === 8080 ? '://localhost:3000' : 's://offline-news-api.herokuapp.com') + '/stories';
var express = require('express');
var request = require('superagent');
var templates = require('./public/templates');

var app = express();
app.use(cookieParser());
app.use(express.static(__dirname+'/public'));

app.get('/tech-blog', function(req, res) {
  request.get(api+req.originalUrl)
    .end(function(err, data) {
      if (err || !data.ok) {
        res.status(404);
        res.send(layoutShell({
          main: templates.article({
            title: 'Story cannot be found',
            body: '<p>Please try another</p>'
          })
        }));
      } else {
        res.send(layoutShell({
          main: templates.article(data.body)
        }));
      }
    });
});

app.get('/', function(req, res) {
  request.get(api)
    .end(function(err, data) {
      if (err) {
        res.status(404).end();
      } else {
        res.send(layoutShell({
          main: templates.list(data.body)
        }));
      }
    });
});

app.listen(port);
console.log('listening on '+port);

function layoutShell(data) {
  data = {
    title: data && data.title || 'FT Tech News',
    main: data && data.main || ''
  };
  return '<!DOCTYPE html>'
    + '<html>'
    + '  <head>'
    + '    <title>'+data.title+'</title>'
    + '    <link rel="stylesheet" href="/styles.css" type="text/css" media="all" />'
    + '  </head>'
    + '  <body>'
    + '    <div class="brandrews"><a href="https://mattandre.ws">mattandre.ws</a> | <a href="https://twitter.com/andrewsmatt">@andrewsmatt</a></div>'
    + '    <main>'+data.main+'</main>'
    + '    <script src="/indexeddb.shim.min.js"></script>'
    + '    <script src="/superagent.js"></script>'
    + '    <script src="/promise.js"></script>'
    + '    <script src="/templates.js"></script>'
    + '    <script src="/application.js"></script>'
    + '    <script src="/appcache.js"></script>'
    + '    <script>'
    + '      (function(i,s,o,g,r,a,m){i[\'GoogleAnalyticsObject\']=r;i[r]=i[r]||function(){'
    + '      (i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),'
    + '      m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)'
    + '      })(window,document,\'script\',\'//www.google-analytics.com/analytics.js\',\'ga\');'
    + '      ga(\'create\', \'UA-34192510-7\', \'auto\');'
    + '      ga(\'send\', \'pageview\');'
    + '    </script>'
    + '  </body>'
    + '</html>';
}
