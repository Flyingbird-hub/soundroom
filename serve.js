/*
 * 听音室 本地静态服务器 + 共享曲库（SQLite 版）
 *   node serve.js            默认 8000 端口
 *   node serve.js 8080       指定端口
 *
 * 数据存储：
 *   - 音乐文件保存在 music/ 目录（流式播放需要 Range，文件不进数据库）
 *   - 歌曲元数据与歌词正文存放在 SQLite 数据库 soundroom.db（表 songs）
 *   - 首次启动自动从旧的 library.json + lyrics/*.lrc 迁移
 * 上传 / 删除需要管理密码（见 server-config.json，首次启动自动生成）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

const MUSIC_DIR = path.join(ROOT, 'music');
const COVER_DIR = path.join(MUSIC_DIR, 'covers');
const LYRICS_DIR = path.join(ROOT, 'lyrics');
const LIB_FILE = path.join(ROOT, 'library.json');     // 仅用于首次迁移
const DB_FILE = path.join(ROOT, 'soundroom.db');
const CONFIG_FILE = path.join(ROOT, 'server-config.json');
const MAX_UPLOAD = 300 * 1024 * 1024;          // 单文件 300MB
const TOKEN_TTL = 24 * 60 * 60 * 1000;         // 管理令牌有效期 24 小时
const ALLOWED_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.oga',
  '.opus', '.wma', '.aiff', '.aif', '.mp4', '.m4b'
]);
const COVER_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(COVER_DIR, { recursive: true });
fs.mkdirSync(LYRICS_DIR, { recursive: true });

/* ================= SQLite 数据库 ================= */

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id        TEXT PRIMARY KEY,
  file      TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL DEFAULT '',
  artist    TEXT NOT NULL DEFAULT '',
  album     TEXT NOT NULL DEFAULT '',
  duration  REAL NOT NULL DEFAULT 0,
  size      INTEGER NOT NULL DEFAULT 0,
  addedAt   INTEGER NOT NULL DEFAULT 0,
  coverFile TEXT,
  lyrics    TEXT
);
CREATE INDEX IF NOT EXISTS idx_songs_addedAt ON songs(addedAt);
`);

const stmt = {
  all:    db.prepare('SELECT * FROM songs ORDER BY addedAt, id'),
  get:    db.prepare('SELECT * FROM songs WHERE id = ?'),
  count:  db.prepare('SELECT COUNT(*) AS n FROM songs'),
  insert: db.prepare('INSERT INTO songs (id, file, name, title, artist, album, duration, size, addedAt, coverFile, lyrics) VALUES (@id, @file, @name, @title, @artist, @album, @duration, @size, @addedAt, @coverFile, @lyrics)'),
  meta:   db.prepare('UPDATE songs SET title = @title, artist = @artist, album = @album, duration = @duration WHERE id = @id'),
  lyrics: db.prepare('UPDATE songs SET lyrics = ? WHERE id = ?'),
  cover:  db.prepare('UPDATE songs SET coverFile = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM songs WHERE id = ?')
};

/* 首次启动：把旧的 library.json + lyrics/*.lrc 迁移进数据库，
 * 并扫描 music/ 目录补录不在清单里的音频文件。 */
function migrateFromLegacy() {
  if (stmt.count.get().n > 0) return;   // 数据库已有数据，跳过

  let items = [];
  try { items = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch (err) { items = []; }

  const insertAll = db.transaction(function (list) {
    for (const s of list) {
      if (!s || !s.id || !s.file) continue;
      // 修正历史数据中 title/artist 反置的问题（文件名形如 "歌名 - 歌手"）
      const nm = /^(.*?)\s*-\s*(.*?)(?:\.\w+)?$/.exec(String(s.name || ''));
      if (nm && s.title === nm[2].trim() && s.artist === nm[1].trim()) {
        s.title = nm[1].trim();
        s.artist = nm[2].trim();
      }
      let lyrics = null;
      if (s.lyricsFile) {
        try { lyrics = fs.readFileSync(path.join(LYRICS_DIR, s.lyricsFile), 'utf8'); } catch (err) { /* 无歌词文件 */ }
      }
      stmt.insert.run({
        id: s.id, file: s.file, name: s.name || '',
        title: s.title || '', artist: s.artist || '', album: s.album || '',
        duration: Number(s.duration) || 0, size: Number(s.size) || 0,
        addedAt: Number(s.addedAt) || 0, coverFile: s.coverFile || null,
        lyrics: lyrics
      });
    }
  });
  insertAll(items);

  // 补录 music/ 目录中未登记的文件（形如 12 位 hex 的自动命名音频）
  const known = new Set(items.map(function (s) { return s.file; }));
  const scanned = [];
  try {
    for (const fn of fs.readdirSync(MUSIC_DIR)) {
      const ext = path.extname(fn).toLowerCase();
      if (!ALLOWED_EXT.has(ext) || known.has(fn)) continue;
      const id = path.basename(fn, ext);
      if (!/^[0-9a-f]{12}$/.test(id)) continue;
      const stat = fs.statSync(path.join(MUSIC_DIR, fn));
      stmt.insert.run({
        id: id, file: fn, name: fn, title: '', artist: '', album: '',
        duration: 0, size: stat.size,
        addedAt: Math.round(stat.mtimeMs || Date.now()),
        coverFile: null, lyrics: null
      });
      scanned.push(fn);
    }
  } catch (err) { /* 目录不存在则跳过 */ }

  const count = stmt.count.get().n;
  console.log('[数据库] 已就绪 soundroom.db（' + count + ' 首）'
    + (items.length ? '，从旧清单迁移 ' + items.length + ' 首' : '')
    + (scanned.length ? '，补录 ' + scanned.length + ' 个文件' : ''));
}

migrateFromLegacy();

/* 补丁：lyrics/ 目录下与歌曲 id 同名的 .lrc，自动补入数据库（仅当该歌歌词缺省时）。
 * 兼容旧版清单里没有 lyricsFile 字段、但歌词文件已随项目同步到服务器的情况。 */
function patchLyricsFromFiles() {
  let files = [];
  try { files = fs.readdirSync(LYRICS_DIR); } catch (err) { return; }
  let rows = [];
  try { rows = db.prepare('SELECT id, lyrics FROM songs WHERE lyrics IS NULL OR lyrics = ?').all(''); } catch (err) { return; }
  let n = 0;
  for (const row of rows) {
    const lf = row.id + '.lrc';
    if (!files.includes(lf)) continue;
    try {
      const txt = fs.readFileSync(path.join(LYRICS_DIR, lf), 'utf8');
      if (txt && txt.trim()) { stmt.lyrics.run(txt, row.id); n++; }
    } catch (err) { /* 忽略 */ }
  }
  if (n) console.log('[数据库] 自动补录歌词 ' + n + ' 首');
}
patchLyricsFromFiles();

function rowToSong(s) {
  return {
    id: s.id, file: s.file, name: s.name,
    title: s.title, artist: s.artist, album: s.album,
    duration: s.duration || 0, size: s.size || 0, addedAt: s.addedAt || 0,
    coverUrl: s.coverFile ? 'music/covers/' + s.coverFile : null,
    lyricsUrl: s.lyrics ? 'lyrics/' + s.id + '.lrc' : null
  };
}

/* ================= 管理配置 ================= */

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.salt && cfg.hash) return cfg;
  } catch (err) { /* 缺失或损坏则重新生成 */ }

  const salt = crypto.randomBytes(12).toString('hex');
  const generated = process.env.ADMIN_PASSWORD || ('SR-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6) + '-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6));
  const cfg = { salt: salt, hash: sha256(salt + generated), createdAt: Date.now() };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('无法写入管理配置 ' + CONFIG_FILE + '：' + err.message);
    process.exit(1);
  }
  console.log('==============================================');
  console.log('  首次启动：已生成管理密码（上传/删除共享音乐用）');
  console.log('  管理密码: ' + generated);
  console.log('  已保存到 server-config.json，请妥善保管。');
  console.log('==============================================');
  return cfg;
}

const CONFIG = loadConfig();
const sessions = new Map(); // token -> 过期时间戳

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TOKEN_TTL);
  if (sessions.size > 200) {
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
  }
  return token;
}

function isAdmin(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) {
    if (exp) sessions.delete(m[1]);
    return false;
  }
  return true;
}

function safeFileName(name) {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (base || 'untitled').slice(0, 120);
}

/* ================= 通用响应 ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.lrc': 'text/plain; charset=utf-8'
};

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }, headers));
  if (body) res.end(body); else res.end();
}

function sendJSON(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('文件超过大小限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/* ================= API 路由 ================= */

function handleApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/login') {
    return readBody(req, 1024 * 64).then(function (body) {
      let password = '';
      try { password = String((JSON.parse(body.toString('utf8') || '{}').password) || ''); }
      catch (err) { password = ''; }
      if (!password || sha256(CONFIG.salt + password) !== CONFIG.hash) {
        sendJSON(res, 401, { error: '管理密码错误' });
        return;
      }
      sendJSON(res, 200, { token: issueToken(), expiresIn: TOKEN_TTL });
    }).catch(function () { sendJSON(res, 400, { error: '请求格式错误' }); });
  }

  if (req.method === 'GET' && pathname === '/api/songs') {
    const songs = stmt.all.all().map(rowToSong);
    sendJSON(res, 200, { songs: songs });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/upload') {
    if (!isAdmin(req)) { sendJSON(res, 401, { error: '需要管理权限' }); return; }
    const ext = path.extname(String(req.headers['x-file-name'] || '')).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) { sendJSON(res, 400, { error: '不支持的音频格式：' + (ext || '未知') }); return; }

    return readBody(req, MAX_UPLOAD).then(function (body) {
      if (!body.length) { sendJSON(res, 400, { error: '空文件' }); return; }
      const id = crypto.randomBytes(6).toString('hex');
      const file = id + ext;
      fs.writeFileSync(path.join(MUSIC_DIR, file), body);
      let originalName = String(req.headers['x-file-name'] || '');
      try { originalName = decodeURIComponent(originalName); } catch (err) { /* 非法转义则保留原样 */ }
      stmt.insert.run({
        id: id, file: file,
        name: safeFileName(originalName),
        title: '', artist: '', album: '',
        duration: 0, size: body.length, addedAt: Date.now(),
        coverFile: null, lyrics: null
      });
      sendJSON(res, 200, { id: id, file: file });
    }).catch(function (err) {
      sendJSON(res, err && err.message === '文件超过大小限制' ? 413 : 500, { error: err && err.message || '上传失败' });
    });
  }

  const metaMatch = /^\/api\/songs\/([0-9a-f]+)\/meta$/.exec(pathname);
  if (req.method === 'POST' && metaMatch) {
    if (!isAdmin(req)) { sendJSON(res, 401, { error: '需要管理权限' }); return; }
    return readBody(req, 1024 * 1024).then(function (body) {
      let data;
      try { data = JSON.parse(body.toString('utf8') || '{}'); }
      catch (err) { sendJSON(res, 400, { error: '元数据格式错误' }); return; }

      const song = stmt.get.get(metaMatch[1]);
      if (!song) { sendJSON(res, 404, { error: '歌曲不存在' }); return; }

      const next = {
        id: song.id,
        title: typeof data.title === 'string' ? data.title.slice(0, 200) : song.title,
        artist: typeof data.artist === 'string' ? data.artist.slice(0, 200) : song.artist,
        album: typeof data.album === 'string' ? data.album.slice(0, 200) : song.album,
        duration: typeof data.duration === 'number' && isFinite(data.duration) ? Math.max(0, data.duration) : song.duration
      };
      stmt.meta.run(next);

      if (typeof data.lyrics === 'string') {
        const value = data.lyrics.trim() ? data.lyrics : null;
        stmt.lyrics.run(value, song.id);
      }

      if (typeof data.coverDataUrl === 'string' && data.coverDataUrl.indexOf('data:') === 0) {
        try {
          const m = /^data:([^;]+);base64,(.+)$/.exec(data.coverDataUrl);
          if (m) {
            const coverExt = COVER_MIME[m[1].toLowerCase()] || '.jpg';
            const coverFile = song.id + '-cover' + coverExt;
            fs.writeFileSync(path.join(COVER_DIR, coverFile), Buffer.from(m[2], 'base64'));
            if (song.coverFile) {
              try { fs.unlinkSync(path.join(COVER_DIR, song.coverFile)); } catch (err) { /* 忽略 */ }
            }
            stmt.cover.run(coverFile, song.id);
          }
        } catch (err) { /* 封面解析失败则保留原状 */ }
      }

      sendJSON(res, 200, { ok: true });
    }).catch(function () { sendJSON(res, 500, { error: '保存失败' }); });
  }

  const delMatch = /^\/api\/songs\/([0-9a-f]+)$/.exec(pathname);
  if (req.method === 'DELETE' && delMatch) {
    if (!isAdmin(req)) { sendJSON(res, 401, { error: '需要管理权限' }); return; }
    const song = stmt.get.get(delMatch[1]);
    if (!song) { sendJSON(res, 404, { error: '歌曲不存在' }); return; }
    try { fs.unlinkSync(path.join(MUSIC_DIR, song.file)); } catch (err) { /* 忽略 */ }
    if (song.coverFile) {
      try { fs.unlinkSync(path.join(COVER_DIR, song.coverFile)); } catch (err) { /* 忽略 */ }
    }
    stmt.remove.run(song.id);
    sendJSON(res, 200, { ok: true });
    return;
  }

  sendJSON(res, 404, { error: '接口不存在' });
}

/* ================= 歌词（数据库存储） ================= */

function serveLyrics(req, res, id) {
  const song = stmt.get.get(id);
  if (song && song.lyrics) {
    send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, song.lyrics);
  } else {
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, '404 没有歌词');
  }
}

/* ================= 静态文件 ================= */

function serveStatic(req, res, pathname) {
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '禁止访问');
    return;
  }

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, '404 找不到该文件');
      return;
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          send(res, 416, { 'Content-Range': 'bytes */' + stat.size });
          return;
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ================= 启动 ================= */

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    });
  });
  return out;
}

const server = http.createServer(function (req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (err) {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, '错误的请求路径');
    return;
  }

  if (pathname.indexOf('/api/') === 0) {
    Promise.resolve().then(function () { return handleApi(req, res, pathname); }).catch(function (err) {
      sendJSON(res, 500, { error: '服务器内部错误' });
    });
    return;
  }

  const lyricsMatch = /^\/lyrics\/([0-9a-f]+)\.lrc$/.exec(pathname);
  if (lyricsMatch) {
    serveLyrics(req, res, lyricsMatch[1]);
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('听音室 已启动（共享曲库 ' + stmt.count.get().n + ' 首，数据库 soundroom.db）');
  console.log('  本机访问: http://localhost:' + PORT);
  localAddresses().forEach(function (ip) {
    console.log('  手机访问: http://' + ip + ':' + PORT + '  (需同一个 Wi-Fi)');
  });
  console.log('按 Ctrl+C 停止服务');
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，换个端口试试：node serve.js 8080');
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
