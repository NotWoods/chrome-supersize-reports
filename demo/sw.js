// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// @ts-check
'use strict';

const cacheName = 'supersize-2018-07-20';
const filesToCache = [
  './',
  'favicon.ico',
  'index.html',
  'infocard-ui.js',
  'infocard.css',
  'manifest.json',
  'options.css',
  'shared.js',
  'start-worker.js',
  'state.js',
  'tree-ui.js',
  'tree-worker.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(cacheName).then(cache => cache.addAll(filesToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keyList =>
      Promise.all(
        keyList.map(key => {
          if (key !== cacheName) {
            console.log('[ServiceWorker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      )
    )
  );
  return self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches
      .match(event.request, {ignoreSearch: true})
      .then(response => response || fetch(event.request))
  );
});
