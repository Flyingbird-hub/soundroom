/*
 * IndexedDB storage.
 * "meta" keeps the searchable library, "blobs" keeps the audio bytes and
 * cover art. They are split so the track list never has to pull megabytes
 * of audio into memory just to render.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'soundroom';
  var DB_VERSION = 1;
  var META = 'meta';
  var BLOBS = 'blobs';
  var SETTINGS = 'settings';

  var dbPromise = null;
  var available = typeof indexedDB !== 'undefined';

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!available) {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(META)) {
          var meta = db.createObjectStore(META, { keyPath: 'id' });
          meta.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('无法打开本地数据库')); };
      request.onblocked = function () { reject(new Error('数据库被其他标签页占用，请关闭后重试')); };
    });
    return dbPromise;
  }

  function run(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var result;
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('写入被中断')); };
        result = fn(store);
      });
    });
  }

  function request(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function allMeta() {
    return run(META, 'readonly', function (store) { return request(store.getAll()); })
      .then(function (rows) { return rows || []; });
  }

  function getAudio(id) {
    return run(BLOBS, 'readonly', function (store) { return request(store.get(id)); });
  }

  function putTrack(meta, payload) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([META, BLOBS], 'readwrite');
        tx.oncomplete = function () { resolve(meta); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('写入被中断，可能是存储空间已满')); };
        tx.objectStore(META).put(meta);
        if (payload) tx.objectStore(BLOBS).put(payload);
      });
    });
  }

  function patchMeta(id, patch) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(META, 'readwrite');
        var store = tx.objectStore(META);
        var req = store.get(id);
        req.onsuccess = function () {
          var row = req.result;
          if (!row) { tx.abort(); return; }
          Object.assign(row, patch);
          store.put(row);
        };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('更新失败')); };
      });
    });
  }

  function putCover(id, coverBlob) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(BLOBS, 'readwrite');
        var store = tx.objectStore(BLOBS);
        var req = store.get(id);
        req.onsuccess = function () {
          var row = req.result;
          if (!row) return;
          row.cover = coverBlob;
          store.put(row);
        };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function removeTrack(id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([META, BLOBS], 'readwrite');
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.objectStore(META).delete(id);
        tx.objectStore(BLOBS).delete(id);
      });
    });
  }

  function getSettings() {
    return run(SETTINGS, 'readonly', function (store) { return request(store.getAll()); })
      .then(function (rows) {
        var out = {};
        (rows || []).forEach(function (row) { out[row.key] = row.value; });
        return out;
      })
      .catch(function () { return {}; });
  }

  function setSetting(key, value) {
    return run(SETTINGS, 'readwrite', function (store) { store.put({ key: key, value: value }); })
      .catch(function () { /* preferences are best-effort */ });
  }

  function isAvailable() {
    return available;
  }

  global.MusicDB = {
    allMeta: allMeta,
    getAudio: getAudio,
    putTrack: putTrack,
    patchMeta: patchMeta,
    putCover: putCover,
    removeTrack: removeTrack,
    getSettings: getSettings,
    setSetting: setSetting,
    isAvailable: isAvailable
  };
})(window);
