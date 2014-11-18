# Offline News - Service Worker [ ![Codeship Status for serviceworker/offline-news-service-worker](https://codeship.io/projects/79b6e690-1c8d-0132-6e81-2a20d8b06a7a/status)](https://codeship.io/projects/35219)

https://offline-news-service-worker.herokuapp.com

Warning: I've only tested this in [Google Chrome Canary](https://www.google.co.uk/intl/en/chrome/browser/canary.html)

### Prerequisites for runing locally

UNIX-like computer running node (would happily accept pull requests to fix it for Windows but I don't have the means to test that here).

Ironically, as this app relies on the live API of **[offline-news-api](https://github.com/matthew-andrews/offline-news-api)**, the server running this application cannot run without a good connection to the internet.

### Install and run

```
git clone git@github.com:matthew-andrews/offline-news-service-worker.git
npm install
node index.js
```
