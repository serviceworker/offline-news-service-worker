var port = Number(process.env.PORT || 8080);
var api = 'http' + (port === 8080 ? '://localhost:3000' : 's://offline-news-api.herokuapp.com') + '/stories';
var express = require('express');
var request = require('superagent');
var templates = require('./public/templates');

var app = express();
app.use(express.static(__dirname+'/public'));

app.get('/article/:guid', function(req, res) {
  request.get(api+'/'+req.params.guid)
    .end(function(err, data) {
      if (err || !data.ok) {
        res.status(404);
        res.send(templates.article({
          title: 'Story cannot be found',
          body: '<p>Please try another</p>'
        }));
      } else {
        res.send(templates.article({
          title: data.title,
          body: templates.article(data.body)
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
        res.send(templates.list({
          stories: data.body
        }));
      }
    });
});

app.listen(port);
console.log('listening on '+port);
