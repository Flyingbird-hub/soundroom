/* 听音室 - 本地音乐播放器 */
(function () {
  'use strict';

  var DB = window.MusicDB;
  var Tags = window.MusicTags;
  var AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mp4', 'm4b'];
  var RATES = [1, 1.25, 1.5, 2, 0.75];

  var state = {
    tracks: [],
    view: 'all',
    query: '',
    sort: 'added',
    mode: 'list',
    currentId: null,
    favoriteView: false,
    playing: false,
    shuffle: false,
    repeat: 'off',
    volume: 1,
    muted: false,
    rate: 1,
    theme: 'dark',
    idbOk: DB.isAvailable()
  };

  var localStorageFallback = {};
  var sharedState = {};            // 共享曲目的收藏/播放记录：serverId -> {favorite,lastPlayedAt,playCount}
  var adminToken = '';
  var objectUrls = { audio: null, covers: {} };
  var coverQueue = [];
  var coverLoading = 0;
  var durationQueue = [];
  var durationLoading = 0;
  var seeking = false;
  var rafId = 0;
  var audioCtx = null;
  var analyser = null;
  var freqData = null;
  var visualizerOpen = false;
  var lyricsVisible = false;
  var lyricsState = { lines: [], timed: false, index: -1 };
  var BACKGROUNDS = ['bg1', 'bg2', 'bg3', 'bg4', 'bg5', 'bg6', 'bg7', 'bg8'];
  var DEFAULT_BG = { id: 'bg1', fit: 'cover', dim: 0.55 };

  var audio = new Audio();
  audio.preload = 'metadata';

  var $ = function (sel) { return document.querySelector(sel); };
  var el = {
    tracklist: $('#tracklist'),
    listhead: $('#listhead'),
    empty: $('#empty'),
    emptyTitle: $('#emptyTitle'),
    emptyText: $('#emptyText'),
    search: $('#search'),
    searchClear: $('#searchClear'),
    sort: $('#sort'),
    fileInput: $('#fileInput'),
    folderInput: $('#folderInput'),
    uploadBtn: $('#uploadBtn'),
    folderBtn: $('#folderBtn'),
    emptyUpload: $('#emptyUpload'),
    emptyFolder: $('#emptyFolder'),
    themeBtn: $('#themeBtn'),
    viewBtn: $('#viewBtn'),
    bgBtn: $('#bgBtn'),
    bgModal: $('#bgModal'),
    bgGrid: $('#bgGrid'),
    bgFitSeg: $('#bgFitSeg'),
    bgDimSeg: $('#bgDimSeg'),
    bgOff: $('#bgOff'),
    bgDone: $('#bgDone'),
    bgClose: $('#bgClose'),
    adminModal: $('#adminModal'),
    adminPass: $('#adminPass'),
    adminOk: $('#adminOk'),
    adminCancel: $('#adminCancel'),
    adminHint: $('#adminHint'),
    storageText: $('#storageText'),
    storageFill: $('#storageFill'),
    persistHint: $('#persistHint'),
    chips: $('#chips'),
    toasts: $('#toasts'),
    dropOverlay: $('#dropOverlay'),
    player: $('#player'),
    miniArt: $('#miniArt'),
    miniTitle: $('#miniTitle'),
    miniSub: $('#miniSub'),
    miniProgress: $('#miniProgress'),
    npMini: $('#npMini'),
    curTime: $('#curTime'),
    durTime: $('#durTime'),
    seek: $('#seek'),
    playBtn: $('#playBtn'),
    prevBtn: $('#prevBtn'),
    nextBtn: $('#nextBtn'),
    shuffleBtn: $('#shuffleBtn'),
    repeatBtn: $('#repeatBtn'),
    rateBtn: $('#rateBtn'),
    muteBtn: $('#muteBtn'),
    volume: $('#volume'),
    expandBtn: $('#expandBtn'),
    nowPlaying: $('#nowPlaying'),
    npClose: $('#npClose'),
    npFav: $('#npFav'),
    npLyricsBtn: $('#npLyricsBtn'),
    lyricsPanel: $('#lyricsPanel'),
    lyricsBox: $('#lyricsBox'),
    lyricsEditBtn: $('#lyricsEditBtn'),
    lyricsModal: $('#lyricsModal'),
    lyricsText: $('#lyricsText'),
    lyricsSave: $('#lyricsSave'),
    lyricsCancel: $('#lyricsCancel'),
    lyricsClear: $('#lyricsClear'),
    npArt: $('#npArt'),
    npTitle: $('#npTitle'),
    npSub: $('#npSub'),
    npSeek: $('#npSeek'),
    npCurTime: $('#npCurTime'),
    npDurTime: $('#npDurTime'),
    npPlay: $('#npPlay'),
    npPrev: $('#npPrev'),
    npNext: $('#npNext'),
    npShuffle: $('#npShuffle'),
    npRepeat: $('#npRepeat'),
    visualizer: $('#visualizer')
  };

  /* ================= helpers ================= */

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '0:00';
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    i = Math.min(i, units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function artStyle(seed) {
    var hue = hashHue(seed);
    return 'background:linear-gradient(150deg,hsl(' + hue + ' 32% 27%),hsl(' + ((hue + 46) % 360) + ' 36% 16%),hsl(' + ((hue + 104) % 360) + ' 42% 24%))';
  }

  /* ===== 氛围背景（封面主色取色） ===== */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) { h = 0; s = 0; }
    else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function applyAura(h, s, l) {
    var root = document.documentElement.style;
    var s1 = Math.max(30, Math.min(80, s));
    var l1 = Math.max(24, Math.min(62, l));
    root.setProperty('--aura-1', 'hsl(' + h + ' ' + s1 + '% ' + Math.min(90, l1 + 10) + '% / 0.20)');
    root.setProperty('--aura-2', 'hsl(' + ((h + 42) % 360) + ' ' + Math.max(24, s1 - 12) + '% ' + Math.max(18, l1 - 4) + '% / 0.15)');
    root.setProperty('--aura-3', 'hsl(' + ((h - 36 + 360) % 360) + ' ' + Math.max(20, s1 - 18) + '% ' + Math.max(14, l1 - 10) + '% / 0.11)');
    root.setProperty('--aura-4', 'hsl(' + ((h + 160) % 360) + ' ' + Math.max(22, s1 - 10) + '% ' + Math.max(16, l1 - 6) + '% / 0.09)');
    root.setProperty('--aura-5', 'hsl(' + ((h - 140 + 360) % 360) + ' ' + Math.max(22, s1 - 14) + '% ' + Math.max(16, l1 - 8) + '% / 0.08)');
  }

  function auraFromSeed(seed) {
    applyAura(hashHue(seed), 34, 30);
  }

  function auraFromCoverUrl(url) {
    var img = new Image();
    if (url.indexOf('http') === 0) {
      try {
        var u = new URL(url, location.href);
        if (u.origin !== location.origin) img.crossOrigin = 'anonymous';
      } catch (err) { /* ignore */ }
    }
    img.onload = function () {
      try {
        var size = 32;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        var hsl = rgbToHsl(Math.round(r / n), Math.round(g / n), Math.round(b / n));
        applyAura(hsl.h, hsl.s, hsl.l);
      } catch (err) { /* 跨域等场景忽略，保留默认氛围 */ }
    };
    img.onerror = function () { applyAura(164, 45, 40); };
    img.src = url;
  }

  function byId(id) {
    for (var i = 0; i < state.tracks.length; i++) if (state.tracks[i].id === id) return state.tracks[i];
    return null;
  }

  function toast(message, options) {
    var opts = options || {};
    var node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    if (opts.id) node.dataset.toastId = opts.id;
    el.toasts.appendChild(node);
    if (opts.sticky) return node;
    setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () { node.remove(); }, 260);
    }, opts.duration || 2600);
    return node;
  }

  function updateToast(id, message) {
    var node = el.toasts.querySelector('[data-toast-id="' + id + '"]');
    if (node) node.textContent = message;
  }

  function removeToast(id) {
    var node = el.toasts.querySelector('[data-toast-id="' + id + '"]');
    if (node) {
      node.classList.add('is-out');
      setTimeout(function () { node.remove(); }, 260);
    }
  }

  function savePref(key, value) {
    localStorageFallback[key] = value;
    return DB.setSetting(key, value);
  }

  /* ================= 管理权限（共享曲库） ================= */

  function getAdminToken() {
    try { return localStorage.getItem('sr-admin-token') || ''; } catch (err) { return ''; }
  }

  function setAdminToken(token) {
    adminToken = token;
    try {
      if (token) localStorage.setItem('sr-admin-token', token);
      else localStorage.removeItem('sr-admin-token');
    } catch (err) { /* 隐私模式等场景忽略 */ }
    renderAdminHint();
  }

  function renderAdminHint() {
    if (!el.adminHint) return;
    el.adminHint.textContent = adminToken
      ? '管理权限已开启：可上传 / 删除共享音乐'
      : '上传共享音乐需管理密码，上传后所有人可听';
  }

  function openAdminModal(onOk, onCancel) {
    el.adminModal.hidden = false;
    el.adminPass.value = '';
    setTimeout(function () { el.adminPass.focus(); }, 30);
    var done = false;
    function close() {
      if (done) return;
      done = true;
      el.adminModal.hidden = true;
    }
    el.adminOk.onclick = function () { var v = el.adminPass.value; close(); onOk(v); };
    el.adminCancel.onclick = function () { close(); if (onCancel) onCancel(); };
    el.adminPass.onkeydown = function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        var v = el.adminPass.value;
        close();
        onOk(v);
      } else if (event.key === 'Escape') {
        close();
        if (onCancel) onCancel();
      }
    };
  }

  function adminLogin() {
    return new Promise(function (resolve, reject) {
      openAdminModal(function (password) {
        if (!password) { reject(new Error('cancel')); return; }
        fetch('api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password })
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
        }).then(function (r) {
          if (r.ok && r.data.token) {
            setAdminToken(r.data.token);
            resolve(r.data.token);
          } else {
            toast('管理密码错误');
            reject(new Error('auth-failed'));
          }
        }).catch(function () {
          toast('无法连接服务器');
          reject(new Error('network'));
        });
      }, function () { reject(new Error('cancel')); });
    });
  }

  function ensureAdmin() {
    if (adminToken) return Promise.resolve(adminToken);
    adminToken = getAdminToken();
    if (adminToken) return Promise.resolve(adminToken);
    return adminLogin();
  }

  /* ================= library ================= */

  function visibleTracks() {
    var query = state.query.trim().toLowerCase();
    var list = state.tracks.filter(function (t) {
      if (state.view === 'favorites' && !t.favorite) return false;
      if (state.view === 'recent' && !t.lastPlayedAt) return false;
      if (!query) return true;
      return (t.title + ' ' + t.artist + ' ' + (t.album || '')).toLowerCase().indexOf(query) > -1;
    });

    var sorters = {
      added: function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); },
      title: function (a, b) { return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'); },
      artist: function (a, b) { return String(a.artist).localeCompare(String(b.artist), 'zh-Hans-CN') || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'); },
      duration: function (a, b) { return (b.duration || 0) - (a.duration || 0); }
    };
    list.sort(sorters[state.sort] || sorters.added);
    if (state.view === 'recent') {
      list.sort(function (a, b) { return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0); });
    }
    return list;
  }

  function render() {
    var list = visibleTracks();
    var mode = state.mode;

    if (mode === 'grid') {
      var cardHtml = list.map(function (track) {
        var current = track.id === state.currentId;
        var art = track.hasCover
          ? '<div class="card-art" data-art="' + track.id + '"></div>'
          : '<div class="card-art" data-art="' + track.id + '" style="' + artStyle(track.title + track.artist) + '"><svg class="icon"><use href="#i-note"></use></svg></div>';
        var badge = current
          ? '<span class="card-badge"><span class="eq' + (state.playing ? '' : ' is-paused') + '"><i></i><i></i><i></i></span></span>'
          : '';
        return '<li class="card' + (current ? ' is-current' : '') + '" data-id="' + track.id + '" tabindex="0">' +
          '<div class="card-cover">' + art + badge +
            '<button class="icon-btn card-play" title="' + (current && state.playing ? '暂停' : '播放') + '" aria-label="播放">' +
              '<svg class="icon"><use href="#i-' + (current && state.playing ? 'pause' : 'play') + '"></use></svg></button>' +
            '<div class="card-actions">' +
              '<button class="icon-btn heart-btn' + (track.favorite ? ' is-on' : '') + '" data-act="favorite" title="' +
                (track.favorite ? '取消收藏' : '收藏') + '" aria-label="收藏"><svg class="icon"><use href="#i-heart"></use></svg></button>' +
              '<button class="icon-btn" data-act="delete" title="从曲库删除" aria-label="删除"><svg class="icon"><use href="#i-trash"></use></svg></button>' +
            '</div>' +
          '</div>' +
          '<div class="card-meta">' +
            '<span class="card-title">' + escapeHtml(track.title) + '</span>' +
            '<span class="card-sub">' + escapeHtml(track.artist) + '</span>' +
          '</div>' +
        '</li>';
      }).join('');
      el.tracklist.className = 'tracklist is-grid';
      el.tracklist.innerHTML = cardHtml;
      el.listhead.hidden = true;
      list.forEach(function (t) { if (t.hasCover) loadCover(t.id); });
    } else {
      var html = list.map(function (track, index) {
        var current = track.id === state.currentId;
        var art = track.hasCover
          ? '<div class="np-art" data-art="' + track.id + '"></div>'
          : '<div class="np-art" data-art="' + track.id + '" style="' + artStyle(track.title + track.artist) + '"><svg class="icon"><use href="#i-note"></use></svg></div>';

        var indexCell = current
          ? '<div class="eq' + (state.playing ? '' : ' is-paused') + '"><i></i><i></i><i></i></div>'
          : '<span class="row-num">' + (index + 1) + '</span>';

        return '<li class="track-row' + (current ? ' is-current' : '') + '" data-id="' + track.id + '" tabindex="0">' +
          '<div class="cell-index">' + indexCell +
            '<button class="icon-btn row-play" title="' + (current && state.playing ? '暂停' : '播放') + '" aria-label="播放">' +
              '<svg class="icon"><use href="#i-' + (current && state.playing ? 'pause' : 'play') + '"></use></svg></button>' +
          '</div>' +
          '<div class="cell-title">' + art +
            '<div class="title-text">' +
              '<span class="track-title">' + escapeHtml(track.title) + '</span>' +
              (track.source === 'shared' ? '<em class="badge-shared">共享</em>' : '') +
              '<span class="track-artist">' + escapeHtml(track.artist) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="cell-album">' + escapeHtml(track.album || '—') + '</div>' +
          '<div class="cell-like">' +
            '<button class="icon-btn heart-btn' + (track.favorite ? ' is-on' : '') + '" data-act="favorite" title="' +
              (track.favorite ? '取消收藏' : '收藏') + '" aria-label="收藏"><svg class="icon"><use href="#i-heart"></use></svg></button>' +
          '</div>' +
          '<div class="cell-time">' + (track.duration ? formatTime(track.duration) : '--:--') + '</div>' +
          '<div class="cell-actions">' +
            '<button class="icon-btn" data-act="delete" title="从曲库删除" aria-label="删除"><svg class="icon"><use href="#i-trash"></use></svg></button>' +
          '</div>' +
        '</li>';
      }).join('');
      el.tracklist.className = 'tracklist';
      el.tracklist.innerHTML = html;
      el.listhead.hidden = false;
    }

    var isEmpty = state.tracks.length === 0;
    var noResult = !isEmpty && list.length === 0;
    el.empty.hidden = list.length > 0;
    if (el.empty.hidden === false) {
      el.emptyTitle.textContent = isEmpty ? '曲库还是空的' : '没有匹配的结果';
      el.emptyText.textContent = isEmpty
        ? '把手机或电脑里的音乐加进来，就能在这里连续播放。'
        : '换个关键词试试，或者切换左侧的分类。';
      el.emptyUpload.hidden = !isEmpty;
      el.emptyFolder.hidden = !isEmpty;
    }
    document.body.classList.toggle('is-empty', isEmpty || noResult);

    updateCounts();
    renderNowPlaying();
  }

  function updateCounts() {
    var counts = { all: state.tracks.length, favorites: 0, recent: 0 };
    state.tracks.forEach(function (t) {
      if (t.favorite) counts.favorites++;
      if (t.lastPlayedAt) counts.recent++;
    });
    Object.keys(counts).forEach(function (key) {
      document.querySelectorAll('[data-count="' + key + '"]').forEach(function (node) {
        node.textContent = counts[key];
      });
    });
  }

  /* ================= cover + duration queues ================= */

  function loadCover(id) {
    var container = el.tracklist.querySelector('[data-art="' + id + '"]');
    if (!container || container.dataset.loaded === '1') return;
    container.dataset.loaded = '1';
    coverQueue.push(id);
    pumpCovers();
  }

  function pumpCovers() {
    while (coverLoading < 3 && coverQueue.length) {
      var id = coverQueue.shift();
      coverLoading++;
      (function (trackId) {
        ensureCoverUrl(trackId).then(function (url) {
          coverLoading--;
          if (url) paintCover(trackId, url);
          pumpCovers();
        }).catch(function () {
          coverLoading--;
          pumpCovers();
        });
      })(id);
    }
  }

  function ensureCoverUrl(id) {
    var track = byId(id);
    if (track && track.source === 'shared') {
      return track.coverUrl ? Promise.resolve(track.coverUrl) : Promise.resolve(null);
    }
    if (objectUrls.covers[id]) return Promise.resolve(objectUrls.covers[id]);
    if (!state.idbOk) return Promise.resolve(null);
    return DB.getAudio(id).then(function (row) {
      if (!row || !row.cover) return null;
      var url = URL.createObjectURL(row.cover);
      objectUrls.covers[id] = url;
      return url;
    }).catch(function () { return null; });
  }

  function paintCover(id, url) {
    el.tracklist.querySelectorAll('[data-art="' + id + '"]').forEach(function (node) {
      node.innerHTML = '<img src="' + url + '" alt="">';
    });
    ['miniArt', 'npArt'].forEach(function (key) {
      if (el[key].dataset.art === id) el[key].innerHTML = '<img src="' + url + '" alt="">';
    });
    if (id === state.currentId) auraFromCoverUrl(url);
  }

  function pumpDurations() {
    while (durationLoading < 2 && durationQueue.length) {
      var id = durationQueue.shift();
      durationLoading++;
      (function (trackId) {
        probeDuration(trackId).then(function () {
          durationLoading--;
          pumpDurations();
        }).catch(function () {
          durationLoading--;
          pumpDurations();
        });
      })(id);
    }
  }

  function probeDuration(id) {
    var track = byId(id);
    if (!track || track.duration) return Promise.resolve();
    if (track.source === 'shared') {
      return new Promise(function (resolve) {
        var probe = new Audio();
        var done = false;
        function finish(duration) {
          if (done) return;
          done = true;
          probe.src = '';
          if (duration && isFinite(duration)) {
            track.duration = duration;
            saveSharedMeta(track, { duration: duration });
            var cell = el.tracklist.querySelector('[data-id="' + id + '"] .cell-time');
            if (cell) cell.textContent = formatTime(duration);
          }
          resolve();
        }
        probe.addEventListener('loadedmetadata', function () { finish(probe.duration); });
        probe.addEventListener('error', function () { finish(null); });
        setTimeout(function () { finish(null); }, 12000);
        probe.preload = 'metadata';
        probe.src = track.url;
      });
    }
    if (!state.idbOk) return Promise.resolve();
    return DB.getAudio(id).then(function (row) {
      if (!row || !row.audio) return;
      return new Promise(function (resolve) {
        var url = URL.createObjectURL(row.audio);
        var probe = new Audio();
        var done = false;
        function finish(duration) {
          if (done) return;
          done = true;
          URL.revokeObjectURL(url);
          probe.src = '';
          if (duration && isFinite(duration)) {
            track.duration = duration;
            DB.patchMeta(id, { duration: duration }).catch(function () {});
            var cell = el.tracklist.querySelector('[data-id="' + id + '"] .cell-time');
            if (cell) cell.textContent = formatTime(duration);
          }
          resolve();
        }
        probe.addEventListener('loadedmetadata', function () { finish(probe.duration); });
        probe.addEventListener('error', function () { finish(null); });
        setTimeout(function () { finish(null); }, 12000);
        probe.preload = 'metadata';
        probe.src = url;
      });
    });
  }

  /* ================= import ================= */

  function isAudioFile(file) {
    if (file.type && file.type.indexOf('audio/') === 0) return true;
    var ext = String(file.name).split('.').pop().toLowerCase();
    return AUDIO_EXT.indexOf(ext) > -1;
  }

  function dedupeKey(file) {
    return file.name.toLowerCase() + '|' + file.size;
  }

  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(isAudioFile);
    if (!files.length) {
      toast('没有发现可用的音频文件');
      return;
    }
    if (!state.idbOk) {
      toast('当前打开方式无法保存曲库，请通过网址访问');
      return;
    }

    var existing = {};
    state.tracks.forEach(function (t) { existing[t.dedupeKey || ''] = true; });

    var added = 0, skipped = 0, failed = 0;
    toast('正在导入 0/' + files.length + '…', { id: 'import', sticky: true });

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var key = dedupeKey(file);
      if (existing[key]) { skipped++; continue; }

      try {
        var tags = await Tags.read(file);
        var id = uid();
        var coverBlob = tags.cover ? new Blob([tags.cover.bytes], { type: tags.cover.mime }) : null;
        var meta = {
          id: id,
          name: file.name,
          title: tags.title,
          artist: tags.artist,
          album: tags.album,
          duration: 0,
          size: file.size,
          type: file.type || '',
          addedAt: Date.now(),
          lastPlayedAt: 0,
          playCount: 0,
          favorite: false,
          hasCover: !!coverBlob,
          dedupeKey: key
        };
        await DB.putTrack(meta, { id: id, audio: file, cover: coverBlob });
        state.tracks.push(meta);
        existing[key] = true;
        durationQueue.push(id);
        added++;
      } catch (err) {
        failed++;
        console.warn('[soundroom] 导入失败', file.name, err);
      }

      updateToast('import', '正在导入 ' + (i + 1) + '/' + files.length + '…');
      if (added % 3 === 0) render();
    }

    removeToast('import');
    render();
    pumpDurations();
    refreshStorage();

    var parts = [];
    if (added) parts.push('已添加 ' + added + ' 首');
    if (skipped) parts.push('跳过重复 ' + skipped + ' 首');
    if (failed) parts.push('失败 ' + failed + ' 首');
    toast(parts.join('，') || '没有新增曲目');

    if (added && !state.currentId) {
      var first = visibleTracks()[0];
      if (first) loadTrack(first.id, false);
    }
  }

  /* ================= 共享曲库 ================= */

  function saveSharedState() {
    return savePref('sharedState', sharedState);
  }

  function saveSharedMeta(track, patch) {
    if (!track || track.source !== 'shared') return;
    sharedState[track.serverId] = Object.assign(sharedState[track.serverId] || {}, patch);
    saveSharedState();
  }

  function stripExt(name) {
    var base = String(name || '').replace(/\.[^.]+$/, '').trim();
    return base || '未命名歌曲';
  }

  async function loadSharedLibrary() {
    var res;
    try { res = await fetch('api/songs'); }
    catch (err) { return 0; }
    if (!res.ok) return 0;
    var data;
    try { data = await res.json(); }
    catch (err) { return 0; }

    var seen = {};
    state.tracks.forEach(function (t) { seen[t.id] = true; });
    var added = 0;
    (data.songs || []).forEach(function (s) {
      var id = 'shared-' + s.id;
      if (seen[id]) return;
      var st = sharedState[s.id] || {};
      state.tracks.push({
        id: id,
        serverId: s.id,
        source: 'shared',
        url: 'music/' + s.file,
        coverUrl: s.coverUrl || null,
        lyricsUrl: s.lyricsUrl || null,
        lyrics: null,
        lyricsLoaded: false,
        title: s.title || s.name || s.file,
        artist: s.artist || '未知歌手',
        album: s.album || '',
        duration: s.duration || 0,
        size: s.size || 0,
        addedAt: s.addedAt || 0,
        favorite: !!st.favorite,
        lastPlayedAt: st.lastPlayedAt || 0,
        playCount: st.playCount || 0,
        hasCover: !!s.coverUrl
      });
      seen[id] = true;
      added++;
    });

    if (added) {
      render();
      var need = state.tracks.filter(function (t) { return t.source === 'shared' && !t.duration; }).map(function (t) { return t.id; });
      durationQueue = durationQueue.concat(need);
      pumpDurations();
    }
    return added;
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  async function uploadShared(files) {
    var list = Array.prototype.slice.call(files).filter(isAudioFile);
    if (!list.length) { toast('没有发现可用的音频文件'); return; }

    var token;
    try { token = await ensureAdmin(); }
    catch (err) {
      if (err.message !== 'cancel') toast('需要管理权限才能上传');
      return;
    }

    var ok = 0, failed = 0;
    toast('正在上传 0/' + list.length + '…', { id: 'up', sticky: true });

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      try {
        var tags = await Tags.read(file);
        var meta = {
          title: tags.title || stripExt(file.name),
          artist: tags.artist || '未知歌手',
          album: tags.album || ''
        };
        if (tags.cover) {
          var coverBlob = new Blob([tags.cover.bytes], { type: tags.cover.mime });
          meta.coverDataUrl = await blobToDataURL(coverBlob);
        }

        function uploadAudio(tok) {
          return fetch('api/upload', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + tok,
              'X-File-Name': encodeURIComponent(file.name),
              'Content-Type': file.type || 'application/octet-stream'
            },
            body: file
          });
        }

        var upRes = await uploadAudio(token);
        if (upRes.status === 401) {
          setAdminToken('');
          token = await adminLogin();
          upRes = await uploadAudio(token);
        }
        if (!upRes.ok) throw new Error('HTTP ' + upRes.status);
        var up = await upRes.json();

        var metaRes = await fetch('api/songs/' + up.id + '/meta', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(meta)
        });
        if (!metaRes.ok) throw new Error('HTTP ' + metaRes.status);
        ok++;
      } catch (err) {
        if (err.message === 'cancel') break;
        failed++;
        console.warn('[soundroom] 上传失败', file.name, err);
      }
      updateToast('up', '正在上传 ' + (i + 1) + '/' + list.length + '…');
    }

    removeToast('up');
    await loadSharedLibrary();
    render();
    renderAdminHint();
    toast(ok ? '已上传 ' + ok + ' 首，所有人现在都能听到' : (failed ? '上传失败 ' + failed + ' 首' : ''));
  }

  /* ================= playback ================= */

  function ensureGraph() {
    if (analyser || !window.AudioContext) return;
    try {
      audioCtx = new window.AudioContext();
      var source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.82;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      analyser = null;
    }
  }

  function loadTrack(id, autoplay) {
    var track = byId(id);
    if (!track) return;
    if (track.source === 'shared') {
      if (objectUrls.audio) { URL.revokeObjectURL(objectUrls.audio); objectUrls.audio = null; }
      audio.src = track.url;
      audio.playbackRate = state.rate;
      audio.volume = state.muted ? 0 : state.volume;
      state.currentId = id;
      render();
      renderPlayerArt();
      updateMediaSession(track);
      ensureLyricsShown(track, id);
      if (autoplay !== false) play();
      else updatePlayButtons();
      return;
    }
    if (!state.idbOk) { toast('当前打开方式无法读取音频'); return; }

    DB.getAudio(id).then(function (row) {
      if (!row || !row.audio) {
        toast('音频数据已丢失，请重新导入');
        return;
      }
      if (objectUrls.audio) URL.revokeObjectURL(objectUrls.audio);
      objectUrls.audio = URL.createObjectURL(row.audio);
      audio.src = objectUrls.audio;
      audio.playbackRate = state.rate;
      audio.volume = state.muted ? 0 : state.volume;
      state.currentId = id;

      render();
      renderPlayerArt();
      updateMediaSession(track);
      ensureLyricsShown(track, id);
      if (autoplay !== false) play();
      else updatePlayButtons();
    }).catch(function () {
      toast('读取音频失败');
    });
  }

  function play() {
    if (!state.currentId) {
      var first = visibleTracks()[0];
      if (!first) { toast('曲库还是空的，先添加音乐吧'); return; }
      loadTrack(first.id, true);
      return;
    }
    ensureGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    var promise = audio.play();
    if (promise && promise.catch) promise.catch(function () { updatePlayButtons(); });
  }

  function pause() {
    audio.pause();
  }

  function togglePlay() {
    if (audio.paused) play(); else pause();
  }

  function step(direction, auto) {
    var list = visibleTracks();
    if (!list.length) return;
    var index = list.findIndex(function (t) { return t.id === state.currentId; });

    if (index === -1) {
      loadTrack(direction > 0 ? list[0].id : list[list.length - 1].id, true);
      return;
    }
    if (state.shuffle && direction > 0 && list.length > 1) {
      var next;
      do { next = list[Math.floor(Math.random() * list.length)]; } while (next.id === state.currentId);
      loadTrack(next.id, true);
      return;
    }
    var nextIndex = index + direction;
    if (nextIndex >= list.length) {
      if (state.repeat === 'all') nextIndex = 0;
      else { pause(); if (auto) audio.currentTime = 0; return; }
    }
    if (nextIndex < 0) nextIndex = state.repeat === 'all' ? list.length - 1 : 0;
    loadTrack(list[nextIndex].id, true);
  }

  function next(auto) { step(1, auto); }
  function prev() { if (audio.currentTime > 3) { audio.currentTime = 0; return; } step(-1, false); }

  function onEnded() {
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      play();
      return;
    }
    next(true);
  }

  function markPlayed(id) {
    var track = byId(id);
    if (!track) return;
    track.lastPlayedAt = Date.now();
    track.playCount = (track.playCount || 0) + 1;
    if (track.source === 'shared') {
      saveSharedMeta(track, { lastPlayedAt: track.lastPlayedAt, playCount: track.playCount });
    } else {
      DB.patchMeta(id, { lastPlayedAt: track.lastPlayedAt, playCount: track.playCount }).catch(function () {});
    }
  }

  /* ================= rendering: player ================= */

  function currentTrack() {
    return state.currentId ? byId(state.currentId) : null;
  }

  function renderPlayerArt() {
    var track = currentTrack();
    if (!track) return;
    [el.miniArt, el.npArt].forEach(function (node) {
      if (node.dataset.art === track.id) return;
      node.dataset.art = track.id;
      if (track.hasCover) {
        node.innerHTML = '';
        ensureCoverUrl(track.id).then(function (url) { if (url) paintCover(track.id, url); });
      } else {
        node.setAttribute('style', artStyle(track.title + track.artist));
        node.innerHTML = '<svg class="icon"><use href="#i-note"></use></svg>';
        auraFromSeed(track.title + track.artist);
      }
    });
  }

  function renderNowPlaying() {
    var track = currentTrack();
    var favorite = !!(track && track.favorite);
    el.npFav.classList.toggle('is-on', favorite);
    el.npFav.title = favorite ? '取消收藏' : '收藏';
    el.npFav.setAttribute('aria-label', el.npFav.title);

    if (!track) return;
    el.miniTitle.textContent = track.title;
    el.miniSub.textContent = track.artist + (track.album ? ' · ' + track.album : '');
    el.npTitle.textContent = track.title;
    el.npSub.textContent = track.artist + (track.album ? ' · ' + track.album : '');
    document.title = track.title + ' - ' + track.artist + ' | 听音室';
    renderPlayerArt();
  }

  function updatePlayButtons() {
    state.playing = !audio.paused;
    document.querySelectorAll('#playBtn .icon use, #npPlay .icon use').forEach(function (use) {
      use.setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    });
    document.querySelectorAll('.track-row.is-current .row-play use').forEach(function (use) {
      use.setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    });
    document.querySelectorAll('.eq').forEach(function (node) {
      node.classList.toggle('is-paused', !state.playing);
    });
    var vinyl = document.getElementById('npVinyl');
    if (vinyl) vinyl.classList.toggle('is-playing', state.playing);
  }

  function setRangeFill(range) {
    var max = Number(range.max) || 100;
    var percent = (Number(range.value) / max) * 100;
    range.style.setProperty('--p', percent + '%');
  }

  function updateProgress() {
    var duration = audio.duration || (currentTrack() ? currentTrack().duration : 0) || 0;
    var current = audio.currentTime || 0;
    if (!seeking) {
      var value = duration ? Math.round((current / duration) * 1000) : 0;
      el.seek.value = value;
      el.npSeek.value = value;
    }
    setRangeFill(el.seek);
    setRangeFill(el.npSeek);
    el.curTime.textContent = formatTime(current);
    el.npCurTime.textContent = formatTime(current);
    el.durTime.textContent = formatTime(duration);
    el.npDurTime.textContent = formatTime(duration);
    var percent = duration ? (current / duration) * 100 : 0;
    el.miniProgress.style.width = percent + '%';
    updateLyricsHighlight();
  }

  function setSeekFrom(ratio) {
    var duration = audio.duration || 0;
    if (!duration) return;
    audio.currentTime = ratio * duration;
    updateProgress();
  }

  function applyVolume() {
    audio.volume = state.muted ? 0 : state.volume;
    var icon = state.muted || state.volume === 0 ? '#i-volume-x' : state.volume < 0.5 ? '#i-volume-1' : '#i-volume';
    el.muteBtn.querySelector('use').setAttribute('href', icon);
    el.volume.value = Math.round(state.volume * 100);
    setRangeFill(el.volume);
  }

  function cycleRate() {
    var index = RATES.indexOf(state.rate);
    state.rate = RATES[(index + 1) % RATES.length];
    audio.playbackRate = state.rate;
    el.rateBtn.textContent = state.rate.toFixed(2).replace(/0$/, '') + 'x';
    savePref('rate', state.rate);
    toast('播放速度 ' + state.rate + 'x');
  }

  function applyModes() {
    el.shuffleBtn.classList.toggle('is-on', state.shuffle);
    el.npShuffle.classList.toggle('is-on', state.shuffle);
    var repeatIcon = state.repeat === 'one' ? '#i-repeat-one' : '#i-repeat';
    el.repeatBtn.querySelector('use').setAttribute('href', repeatIcon);
    el.npRepeat.querySelector('use').setAttribute('href', repeatIcon);
    el.repeatBtn.classList.toggle('is-on', state.repeat !== 'off');
    el.npRepeat.classList.toggle('is-on', state.repeat !== 'off');
    el.repeatBtn.title = state.repeat === 'off' ? '循环：关闭' : state.repeat === 'all' ? '循环：列表' : '循环：单曲';
    el.npRepeat.title = el.repeatBtn.title;
  }

  function refreshStorage() {
    var total = state.tracks.reduce(function (sum, t) {
      return sum + (t.source === 'shared' ? 0 : (t.size || 0));
    }, 0);
    el.storageText.textContent = formatBytes(total);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        if (!est || !est.quota) return;
        var percent = Math.min(100, (est.usage / est.quota) * 100);
        el.storageFill.style.width = Math.max(2, percent) + '%';
      }).catch(function () {});
    } else {
      el.storageFill.style.width = '18%';
    }
  }

  async function setupPersistence() {
    if (!state.idbOk) {
      el.persistHint.textContent = '当前以本地文件方式打开，无法保存曲库。请用网址访问（如 http://localhost:8000）。';
      return;
    }
    el.persistHint.textContent = '共享曲库存在服务器（本项目目录），所有人可见；本机导入的音乐只存在这台设备。';
    try {
      if (navigator.storage && navigator.storage.persist) {
        var persisted = await navigator.storage.persisted();
        if (!persisted) persisted = await navigator.storage.persist();
        if (persisted) el.persistHint.textContent = '音乐保存在这台设备的浏览器里，已开启持久化，不会被自动清理。';
      }
    } catch (err) { /* ignore */ }
  }

  /* ================= visualizer ================= */

  function resizeCanvas() {
    var canvas = el.visualizer;
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function hexToRgb(hex) {
    var v = String(hex || '').replace('#', '');
    if (v.length === 3) v = v.split('').map(function (c) { return c + c; }).join('');
    if (v.length !== 6) return [47, 214, 165];
    return [parseInt(v.substr(0, 2), 16), parseInt(v.substr(2, 2), 16), parseInt(v.substr(4, 2), 16)];
  }
  function mixColor(a, b, t) {
    var A = hexToRgb(a), B = hexToRgb(b);
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * t) + ',' + Math.round(A[1] + (B[1] - A[1]) * t) + ',' + Math.round(A[2] + (B[2] - A[2]) * t) + ')';
  }

  function drawVisualizer() {
    rafId = 0;
    var canvas = el.visualizer;
    if (!visualizerOpen || !analyser || !freqData) return;
    var ctx = canvas.getContext('2d');
    analyser.getByteFrequencyData(freqData);

    var rootStyle = getComputedStyle(document.documentElement);
    var accent1 = rootStyle.getPropertyValue('--accent').trim() || '#2fd6a5';
    var accent2 = rootStyle.getPropertyValue('--accent-2').trim() || '#38b6ff';
    var accent3 = rootStyle.getPropertyValue('--accent-3').trim() || '#a78bfa';
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    var bars = 40;
    var gap = w / bars * 0.32;
    var barWidth = w / bars - gap;
    for (var i = 0; i < bars; i++) {
      var value = freqData[Math.floor(i * (freqData.length * 0.72) / bars)] / 255;
      var barHeight = Math.max(2 * (window.devicePixelRatio || 1), value * h);
      var x = i * (barWidth + gap) + gap / 2;
      var ratio = bars <= 1 ? 0 : i / (bars - 1);
      ctx.fillStyle = ratio < 0.5
        ? mixColor(accent1, accent2, ratio * 2)
        : mixColor(accent2, accent3, (ratio - 0.5) * 2);
      ctx.globalAlpha = 0.35 + value * 0.65;
      ctx.fillRect(x, h - barHeight, barWidth, barHeight);
    }
    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(drawVisualizer);
  }

  function startVisualizer() {
    if (!rafId && visualizerOpen) {
      ensureGraph();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
      resizeCanvas();
      rafId = requestAnimationFrame(drawVisualizer);
    }
  }

  function stopVisualizer() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    var ctx = el.visualizer.getContext('2d');
    ctx.clearRect(0, 0, el.visualizer.width, el.visualizer.height);
  }

  /* ================= lyrics ================= */

  function parseLyrics(text) {
    var lines = [];
    var timed = false;
    if (text && text.trim()) {
      var re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
      text.split(/\r?\n/).forEach(function (raw) {
        var line = String(raw).trim();
        if (!line) return;
        var matches = [];
        var m;
        re.lastIndex = 0;
        while ((m = re.exec(line))) matches.push(m);
        if (!matches.length) {
          lines.push({ time: null, text: line });
          return;
        }
        timed = true;
        var lastTag = matches[matches.length - 1];
        var content = line.slice(lastTag.index + lastTag[0].length).trim();
        matches.forEach(function (mm) {
          var min = parseInt(mm[1], 10);
          var sec = parseInt(mm[2], 10);
          var frac = mm[3] ? parseInt(mm[3], 10) / Math.pow(10, mm[3].length) : 0;
          lines.push({ time: min * 60 + sec + frac, text: content || '' });
        });
      });
      lines.sort(function (a, b) {
        if (a.time == null && b.time == null) return 0;
        if (a.time == null) return 1;
        if (b.time == null) return -1;
        return a.time - b.time;
      });
    }
    return { lines: lines, timed: timed };
  }

  function loadLyricsFor(track) {
    if (!track) return Promise.resolve();
    if (track.lyricsLoaded) return Promise.resolve();
    if (track.source === 'shared' && track.lyricsUrl) {
      track.lyricsLoaded = true;
      return fetch(track.lyricsUrl).then(function (res) {
        if (!res.ok) return '';
        return res.text();
      }).then(function (text) {
        track.lyrics = text || '';
        if (lyricsVisible && state.currentId === track.id) renderLyrics();
      }).catch(function () { track.lyrics = ''; });
    }
    track.lyricsLoaded = true;
    return Promise.resolve();
  }

  /* 播放歌曲时：有歌词就自动在播放页显示（内嵌画面效果），无歌词则显示占位 */
  function ensureLyricsShown(track, id) {
    return loadLyricsFor(track).then(function () {
      if (state.currentId !== id) return;
      var text = track.lyrics || '';
      if (text.trim()) {
        if (!lyricsVisible) {
          lyricsVisible = true;
          el.lyricsPanel.hidden = false;
          el.visualizer.style.display = 'none';
          stopVisualizer();
        }
        renderLyrics();
      } else if (lyricsVisible) {
        renderLyrics();
      }
    });
  }

  function renderLyrics() {
    var track = currentTrack();
    if (!track) {
      el.lyricsBox.innerHTML = '<p class="lyrics-empty">还没有播放任何歌曲</p>';
      return;
    }
    var parsed = parseLyrics(track.lyrics);
    lyricsState = { lines: parsed.lines, timed: parsed.timed, index: -1 };
    el.lyricsBox.innerHTML = '';
    if (!parsed.lines.length) {
      el.lyricsBox.innerHTML = '<p class="lyrics-empty">这首歌还没有歌词<br>点下方「编辑歌词」粘贴进来</p>';
      return;
    }
    parsed.lines.forEach(function (line, i) {
      var node = document.createElement('div');
      node.className = 'lyric-line';
      node.dataset.index = i;
      node.textContent = line.text || '\u00A0';
      el.lyricsBox.appendChild(node);
    });
    updateLyricsHighlight();
  }

  function updateLyricsHighlight() {
    if (!lyricsVisible || !lyricsState.timed) return;
    var lines = lyricsState.lines;
    if (!lines.length) return;
    var t = audio.currentTime || 0;
    var index = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].time != null && t >= lines[i].time) index = i;
      else break;
    }
    if (index === lyricsState.index) return;
    lyricsState.index = index;
    var active = index >= 0 ? index : (lines.length && lines[0].time == null ? 0 : -1);
    Array.prototype.forEach.call(el.lyricsBox.children, function (node) {
      var i = Number(node.dataset.index);
      node.classList.toggle('is-active', i === active);
      node.classList.toggle('is-past', active >= 0 && i < active);
    });
    var target = el.lyricsBox.querySelector('.lyric-line.is-active');
    if (target) {
      try {
        var box = el.lyricsBox;
        var top = target.offsetTop - box.clientHeight / 2 + target.clientHeight / 2;
        if (top < 0) top = 0;
        box.scrollTo({ top: top, behavior: 'smooth' });
      } catch (err) { /* 忽略 */ }
    }
  }

  function toggleLyrics(force) {
    var show = force != null ? force : !lyricsVisible;
    if (show) {
      lyricsVisible = true;
      el.lyricsPanel.hidden = false;
      el.visualizer.style.display = 'none';
      stopVisualizer();
      loadLyricsFor(currentTrack()).then(function () { renderLyrics(); });
    } else {
      lyricsVisible = false;
      el.lyricsPanel.hidden = true;
      el.visualizer.style.display = '';
      if (visualizerOpen) startVisualizer();
    }
  }

  function openLyricsModal() {
    var track = currentTrack();
    if (!track) return;
    el.lyricsModal.hidden = false;
    el.lyricsText.value = track.lyrics || '';
    setTimeout(function () { el.lyricsText.focus(); }, 30);
  }

  function closeLyricsModal() {
    el.lyricsModal.hidden = true;
  }

  function saveLyrics(text) {
    var track = currentTrack();
    if (!track) return;
    var value = String(text || '');
    function afterSave() {
      track.lyrics = value;
      track.lyricsLoaded = true;
      if (lyricsVisible && state.currentId === track.id) renderLyrics();
      toast(value.trim() ? '歌词已保存' : '歌词已清空');
      closeLyricsModal();
    }
    if (track.source === 'shared') {
      ensureAdmin().then(function (token) {
        return fetch('api/songs/' + track.serverId + '/meta', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ lyrics: value })
        });
      }).then(function (res) {
        if (res.ok) afterSave();
        else toast('保存失败');
      }).catch(function (err) {
        if (err && err.message === 'cancel') return;
        toast('保存失败，请重试');
      });
    } else {
      DB.patchMeta(track.id, { lyrics: value }).then(afterSave).catch(function () { toast('保存失败，请重试'); });
    }
  }

  /* ================= 背景 ================= */

  function applyBackground() {
    var bg = state.background;
    var root = document.documentElement.style;
    if (bg && bg.id) {
      root.setProperty('--bgimg', 'url("/backgrounds/' + bg.id + '.jpg")');
      root.setProperty('--bgimg-size', bg.fit === 'contain' ? 'contain' : 'cover');
      root.setProperty('--bgimg-dim', String(typeof bg.dim === 'number' ? bg.dim : 0.55));
    } else {
      root.setProperty('--bgimg', 'none');
      root.setProperty('--bgimg-size', 'cover');
      root.setProperty('--bgimg-dim', '0.55');
    }
    if (!el.bgModal.hidden) renderBgModal();
  }

  function renderBgModal() {
    if (!el.bgGrid) return;
    var bg = state.background;
    el.bgGrid.innerHTML = '';
    BACKGROUNDS.forEach(function (id) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'bg-card' + (bg && bg.id === id ? ' is-on' : '');
      card.dataset.bg = id;
      var img = document.createElement('img');
      img.src = 'backgrounds/' + id + '.jpg';
      img.alt = '背景 ' + id;
      img.loading = 'lazy';
      var tag = document.createElement('span');
      tag.className = 'bg-card-tag';
      tag.textContent = id === 'bg1' ? '默认' : id.replace('bg', '');
      card.appendChild(img);
      card.appendChild(tag);
      el.bgGrid.appendChild(card);
    });
    var fit = bg && bg.fit ? bg.fit : 'cover';
    var dim = bg && typeof bg.dim === 'number' ? bg.dim : 0.55;
    Array.prototype.forEach.call(el.bgFitSeg.querySelectorAll('button'), function (b) {
      b.classList.toggle('is-on', b.dataset.fit === fit);
    });
    Array.prototype.forEach.call(el.bgDimSeg.querySelectorAll('button'), function (b) {
      b.classList.toggle('is-on', Math.abs(Number(b.dataset.dim) - dim) < 0.01);
    });
  }

  function openBgModal() {
    el.bgModal.hidden = false;
    renderBgModal();
  }

  function closeBgModal() { el.bgModal.hidden = true; }

  function persistBackground() {
    DB.setSetting('background', state.background || null);
  }

  /* ================= media session ================= */

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return;
    var artwork = [];
    var cover = objectUrls.covers[track.id];
    if (cover) artwork.push({ src: cover, sizes: '512x512', type: 'image/jpeg' });
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || '听音室',
        artwork: artwork
      });
    } catch (err) { /* ignore */ }
  }

  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var actions = {
      play: function () { play(); },
      pause: function () { pause(); },
      previoustrack: function () { prev(); },
      nexttrack: function () { next(false); },
      seekbackward: function () { audio.currentTime = Math.max(0, audio.currentTime - 10); },
      seekforward: function () { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); }
    };
    Object.keys(actions).forEach(function (name) {
      try { navigator.mediaSession.setActionHandler(name, actions[name]); } catch (err) { /* unsupported */ }
    });
  }

  /* ================= theme ================= */

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', state.theme === 'dark' ? '#0e1012' : '#f4f5f6');
    el.themeBtn.querySelector('use').setAttribute('href', state.theme === 'dark' ? '#i-sun' : '#i-moon');
    el.themeBtn.title = state.theme === 'dark' ? '切换到浅色' : '切换到深色';
  }

  /* ================= events ================= */

  function bindEvents() {
    el.uploadBtn.addEventListener('click', function () { el.fileInput.click(); });
    el.emptyUpload.addEventListener('click', function () { el.fileInput.click(); });
    el.folderBtn.addEventListener('click', function () { el.folderInput.click(); });
    el.emptyFolder.addEventListener('click', function () { el.folderInput.click(); });
    el.fileInput.addEventListener('change', function () { uploadShared(el.fileInput.files); el.fileInput.value = ''; });
    el.folderInput.addEventListener('change', function () { importFiles(el.folderInput.files); el.folderInput.value = ''; });

    document.querySelectorAll('.nav-item').forEach(function (btn) {
      btn.addEventListener('click', function () { setView(btn.dataset.view); });
    });
    el.chips.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (chip) setView(chip.dataset.view);
    });

    el.search.addEventListener('input', function () {
      state.query = el.search.value;
      el.searchClear.hidden = !state.query;
      render();
    });
    el.searchClear.addEventListener('click', function () {
      el.search.value = '';
      state.query = '';
      el.searchClear.hidden = true;
      render();
      el.search.focus();
    });
    el.sort.addEventListener('change', function () {
      state.sort = el.sort.value;
      savePref('sort', state.sort);
      render();
    });

    el.themeBtn.addEventListener('click', function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      savePref('theme', state.theme);
    });

    el.viewBtn.addEventListener('click', function () {
      state.mode = state.mode === 'grid' ? 'list' : 'grid';
      el.viewBtn.querySelector('use').setAttribute('href', state.mode === 'grid' ? '#i-list' : '#i-grid');
      savePref('mode', state.mode);
      render();
    });

    el.tracklist.addEventListener('click', function (event) {
      var row = event.target.closest('.track-row') || event.target.closest('.card');
      if (!row) return;
      var id = row.dataset.id;
      var action = event.target.closest('[data-act]');
      if (action) {
        event.stopPropagation();
        if (action.dataset.act === 'favorite') toggleFavorite(id);
        else if (action.dataset.act === 'delete') removeTrack(id);
        return;
      }
      if (id === state.currentId) togglePlay();
      else loadTrack(id, true);
    });
    el.tracklist.addEventListener('dblclick', function (event) {
      var row = event.target.closest('.track-row') || event.target.closest('.card');
      if (row) loadTrack(row.dataset.id, true);
    });
    el.tracklist.addEventListener('keydown', function (event) {
      var row = event.target.closest('.track-row') || event.target.closest('.card');
      if (!row) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (row.dataset.id === state.currentId) togglePlay();
        else loadTrack(row.dataset.id, true);
      }
    });
    el.tracklist.addEventListener('mouseover', function (event) {
      var row = event.target.closest('.track-row');
      var track = row && byId(row.dataset.id);
      if (track && track.hasCover) loadCover(track.id);
    });

    el.playBtn.addEventListener('click', togglePlay);
    el.npPlay.addEventListener('click', togglePlay);
    el.prevBtn.addEventListener('click', prev);
    el.npPrev.addEventListener('click', prev);
    el.nextBtn.addEventListener('click', function () { next(false); });
    el.npNext.addEventListener('click', function () { next(false); });

    [el.shuffleBtn, el.npShuffle].forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.shuffle = !state.shuffle;
        applyModes();
        savePref('shuffle', state.shuffle);
        toast(state.shuffle ? '随机播放已开启' : '随机播放已关闭');
      });
    });
    [el.repeatBtn, el.npRepeat].forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
        applyModes();
        savePref('repeat', state.repeat);
      });
    });

    el.rateBtn.addEventListener('click', cycleRate);

    el.muteBtn.addEventListener('click', function () {
      state.muted = !state.muted;
      applyVolume();
      savePref('muted', state.muted);
    });
    el.volume.addEventListener('input', function () {
      state.volume = Number(el.volume.value) / 100;
      state.muted = state.volume === 0;
      applyVolume();
      savePref('volume', state.volume);
    });

    [el.seek, el.npSeek].forEach(function (range) {
      range.addEventListener('input', function () {
        seeking = true;
        var ratio = Number(range.value) / 1000;
        var duration = audio.duration || 0;
        el.curTime.textContent = formatTime(ratio * duration);
        el.npCurTime.textContent = formatTime(ratio * duration);
        setRangeFill(range);
        if (range === el.seek) setRangeFill(el.npSeek); else setRangeFill(el.seek);
      });
      range.addEventListener('change', function () {
        setSeekFrom(Number(range.value) / 1000);
        seeking = false;
      });
    });

    el.npMini.addEventListener('click', openNowPlaying);
    el.npMini.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openNowPlaying(); }
    });
    el.expandBtn.addEventListener('click', openNowPlaying);
    el.npClose.addEventListener('click', closeNowPlaying);
    el.npFav.addEventListener('click', function () {
      if (state.currentId) toggleFavorite(state.currentId);
    });
    el.npLyricsBtn.addEventListener('click', function () { toggleLyrics(); });
    el.lyricsEditBtn.addEventListener('click', openLyricsModal);
    el.lyricsSave.addEventListener('click', function () { saveLyrics(el.lyricsText.value); });
    el.lyricsCancel.addEventListener('click', closeLyricsModal);
    el.lyricsClear.addEventListener('click', function () { el.lyricsText.value = ''; el.lyricsText.focus(); });
    el.bgBtn.addEventListener('click', openBgModal);
    el.bgClose.addEventListener('click', closeBgModal);
    el.bgDone.addEventListener('click', closeBgModal);
    el.bgOff.addEventListener('click', function () {
      state.background = { id: null, fit: 'cover', dim: 0.55 };
      applyBackground();
      persistBackground();
      toast('已关闭背景');
    });
    el.bgGrid.addEventListener('click', function (e) {
      var card = e.target && e.target.closest ? e.target.closest('.bg-card') : null;
      if (!card || !card.dataset.bg) return;
      var prev = state.background || {};
      state.background = { id: card.dataset.bg, fit: prev.fit === 'contain' ? 'contain' : 'cover', dim: typeof prev.dim === 'number' ? prev.dim : 0.55 };
      applyBackground();
      persistBackground();
    });
    el.bgFitSeg.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-fit]') : null;
      if (!btn) return;
      var prev = state.background || {};
      state.background = { id: prev.id || 'bg1', fit: btn.dataset.fit, dim: typeof prev.dim === 'number' ? prev.dim : 0.55 };
      applyBackground();
      persistBackground();
    });
    el.bgDimSeg.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-dim]') : null;
      if (!btn) return;
      var prev = state.background || {};
      state.background = { id: prev.id || 'bg1', fit: prev.fit === 'contain' ? 'contain' : 'cover', dim: Number(btn.dataset.dim) };
      applyBackground();
      persistBackground();
    });

    audio.addEventListener('play', function () {
      updatePlayButtons();
      markPlayed(state.currentId);
      if (visualizerOpen) startVisualizer();
    });
    audio.addEventListener('pause', function () { updatePlayButtons(); });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', function () {
      var track = currentTrack();
      if (track && (!track.duration || Math.abs(track.duration - audio.duration) > 1) && isFinite(audio.duration)) {
        track.duration = audio.duration;
        DB.patchMeta(track.id, { duration: audio.duration }).catch(function () {});
      }
      updateProgress();
    });
    audio.addEventListener('error', function () {
      if (state.currentId) toast('这个格式可能无法播放：' + (currentTrack() ? currentTrack().title : ''));
    });

    document.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable;
      if (event.key === '/' && !typing) { event.preventDefault(); el.search.focus(); return; }
      if (typing) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
      else if (event.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); state.volume = Math.min(1, state.volume + 0.05); state.muted = false; applyVolume(); savePref('volume', state.volume); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); state.volume = Math.max(0, state.volume - 0.05); applyVolume(); savePref('volume', state.volume); }
      else if (event.key.toLowerCase() === 'm') { state.muted = !state.muted; applyVolume(); }
      else if (event.key.toLowerCase() === 'f' && state.currentId) { toggleFavorite(state.currentId); }
      else if (event.key.toLowerCase() === 'n') { next(false); }
      else if (event.key === 'Escape') { closeNowPlaying(); }
    });

    // drag & drop import
    var dragDepth = 0;
    window.addEventListener('dragenter', function (event) {
      if (!event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types || [], 'Files') === -1) return;
      event.preventDefault();
      dragDepth++;
      el.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', function (event) { event.preventDefault(); });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', function (event) {
      event.preventDefault();
      dragDepth = 0;
      el.dropOverlay.hidden = true;
      if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
        importFiles(event.dataTransfer.files);
      }
    });

    window.addEventListener('resize', function () { if (visualizerOpen) resizeCanvas(); });

    let touchTimer = null;
    el.tracklist.addEventListener('touchstart', function (event) {
      var row = event.target.closest('.track-row') || event.target.closest('.card');
      if (!row) return;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(function () { row.classList.add('is-touching'); }, 220);
    }, { passive: true });
    ['touchend', 'touchcancel', 'scroll'].forEach(function (name) {
      el.tracklist.addEventListener(name, function () {
        clearTimeout(touchTimer);
        el.tracklist.querySelectorAll('.is-touching').forEach(function (node) { node.classList.remove('is-touching'); });
      }, { passive: true });
    });
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.view === view);
    });
    document.querySelectorAll('.chip').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.view === view);
    });
    savePref('view', view);
    render();
    document.querySelector('.listwrap').scrollTop = 0;
  }

  function toggleFavorite(id) {
    var track = byId(id);
    if (!track) return;
    track.favorite = !track.favorite;
    if (track.source === 'shared') {
      saveSharedMeta(track, { favorite: track.favorite });
    } else {
      DB.patchMeta(id, { favorite: track.favorite }).catch(function () {});
    }
    renderNowPlaying();
    render();
    toast(track.favorite ? '已加入收藏' : '已取消收藏');
  }

  function clearCurrentTrackUI() {
    pause();
    audio.removeAttribute('src');
    state.currentId = null;
    el.miniTitle.textContent = '还没有播放';
    el.miniSub.textContent = '添加本地音乐后即可播放';
    el.npTitle.textContent = '还没有播放';
    el.npSub.textContent = '添加本地音乐后即可播放';
    el.miniArt.dataset.art = '';
    el.npArt.dataset.art = '';
    el.miniArt.removeAttribute('style');
    el.npArt.removeAttribute('style');
    el.miniArt.innerHTML = '<svg class="icon"><use href="#i-note"></use></svg>';
    el.npArt.innerHTML = '<svg class="icon"><use href="#i-note"></use></svg>';
    ['--aura-1', '--aura-2', '--aura-3'].forEach(function (prop) {
      document.documentElement.style.removeProperty(prop);
    });
    updateProgress();
  }

  function deleteSharedTrack(track) {
    ensureAdmin().then(function (token) {
      return fetch('api/songs/' + track.serverId, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
    }).then(function (res) {
      if (res.status === 401) {
        setAdminToken('');
        return adminLogin().then(function (token2) {
          return fetch('api/songs/' + track.serverId, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token2 } });
        });
      }
      return res;
    }).then(function (res) {
      if (!res.ok) { toast('删除失败'); return; }
      state.tracks = state.tracks.filter(function (t) { return t.id !== track.id; });
      delete sharedState[track.serverId];
      saveSharedState();
      if (objectUrls.covers[track.id]) {
        URL.revokeObjectURL(objectUrls.covers[track.id]);
        delete objectUrls.covers[track.id];
      }
      if (state.currentId === track.id) clearCurrentTrackUI();
      render();
      refreshStorage();
      toast('已从共享曲库删除');
    }).catch(function (err) {
      if (err && err.message === 'cancel') return;
      toast('删除失败');
    });
  }

  function removeTrack(id) {
    var track = byId(id);
    if (!track) return;
    if (track.source === 'shared') {
      deleteSharedTrack(track);
      return;
    }
    DB.removeTrack(id).then(function () {
      state.tracks = state.tracks.filter(function (t) { return t.id !== id; });
      if (objectUrls.covers[id]) {
        URL.revokeObjectURL(objectUrls.covers[id]);
        delete objectUrls.covers[id];
      }
      if (state.currentId === id) clearCurrentTrackUI();
      render();
      refreshStorage();
      toast('已从曲库删除');
    }).catch(function () {
      toast('删除失败，请重试');
    });
  }

  function openNowPlaying() {
    visualizerOpen = true;
    el.nowPlaying.hidden = false;
    resizeCanvas();
    startVisualizer();
  }

  function closeNowPlaying() {
    visualizerOpen = false;
    lyricsVisible = false;
    el.lyricsPanel.hidden = true;
    el.visualizer.style.display = '';
    el.nowPlaying.hidden = true;
    stopVisualizer();
  }

  /* ================= boot ================= */

  async function boot() {
    var prefs = {};
    try {
      prefs = await DB.getSettings();
    } catch (err) { prefs = {}; }

    state.theme = prefs.theme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    state.view = prefs.view || 'all';
    state.mode = prefs.mode === 'grid' ? 'grid' : 'list';
    state.sort = prefs.sort || 'added';
    state.shuffle = !!prefs.shuffle;
    state.repeat = prefs.repeat || 'off';
    state.rate = Number(prefs.rate) || 1;
    state.volume = typeof prefs.volume === 'number' ? prefs.volume : 1;
    state.muted = !!prefs.muted;
    adminToken = getAdminToken();
    if (prefs.sharedState && typeof prefs.sharedState === 'object') sharedState = prefs.sharedState;
    if (prefs.background && typeof prefs.background === 'object' && typeof prefs.background.id === 'string') {
      state.background = {
        id: prefs.background.id,
        fit: prefs.background.fit === 'contain' ? 'contain' : 'cover',
        dim: typeof prefs.background.dim === 'number' ? prefs.background.dim : 0.55
      };
    } else {
      state.background = { id: 'bg1', fit: 'cover', dim: 0.55 };
    }

    applyTheme();
    applyModes();
    applyBackground();
    applyVolume();
    el.sort.value = state.sort;
    el.rateBtn.textContent = state.rate.toFixed(2).replace(/0$/, '') + 'x';
    el.viewBtn.querySelector('use').setAttribute('href', state.mode === 'grid' ? '#i-list' : '#i-grid');
    audio.playbackRate = state.rate;
    setView(state.view);

    bindEvents();
    bindMediaSession();
    setupPersistence();
    renderAdminHint();

    if (state.idbOk) {
      try {
        state.tracks = await DB.allMeta();
        state.tracks.sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
        render();
        durationQueue = state.tracks.filter(function (t) { return !t.duration; }).map(function (t) { return t.id; });
        pumpDurations();
        var last = state.tracks.filter(function (t) { return t.lastPlayedAt; }).sort(function (a, b) { return b.lastPlayedAt - a.lastPlayedAt; })[0];
        if (last) loadTrack(last.id, false);
      } catch (err) {
        toast('读取曲库失败：' + (err && err.message ? err.message : '未知错误'));
      }
    }

    refreshStorage();
    updateProgress();

    loadSharedLibrary();

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  window.addEventListener('beforeunload', function () {
    if (objectUrls.audio) URL.revokeObjectURL(objectUrls.audio);
    Object.keys(objectUrls.covers).forEach(function (id) { URL.revokeObjectURL(objectUrls.covers[id]); });
  });

  boot();
})();
