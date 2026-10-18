/*
 * 听音室 本地静态服务器 + 共享曲库
 *   node serve.js            默认 8000 端口
 *   node serve.js 8080       指定端口
 *
 * 共享曲库：上传的音乐文件保存在本项目的 music/ 目录，所有访问者都能播放；
 * 上传 / 删除需要管理密码（见 server-config.json，首次启动自动生成）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

const MUSIC_DIR = path.join(ROOT, 'music');
const COVER_DIR = path.join(MUSIC_DIR, 'covers');
const LIB_FILE = path.join(ROOT, 'library.json');
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

/* ================= 共享曲库数据 ================= */

function readLibrary() {
  try { return JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); }
  catch (err) { return []; }
}

function writeLibrary(list) {
  const tmp = LIB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, LIB_FILE);
}

let library = readLibrary();

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
  '.md': 'text/plain; charset=utf-8'
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
    const songs = library.map(function (s) {
      return {
        id: s.id, file: s.file, name: s.name,
        title: s.title, artist: s.artist, album: s.album,
        duration: s.duration || 0, size: s.size || 0, addedAt: s.addedAt || 0,
        coverUrl: s.coverFile ? 'music/covers/' + s.coverFile : null
      };
    });
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
      const entry = {
        id: id, file: file,
        name: safeFileName(originalName),
        title: '', artist: '', album: '',
        duration: 0, size: body.length, addedAt: Date.now(),
        coverFile: null
      };
      library.push(entry);
      writeLibrary(library);
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

      const song = library.find(function (s) { return s.id === metaMatch[1]; });
      if (!song) { sendJSON(res, 404, { error: '歌曲不存在' }); return; }

      if (typeof data.title === 'string') song.title = data.title.slice(0, 200);
      if (typeof data.artist === 'string') song.artist = data.artist.slice(0, 200);
      if (typeof data.album === 'string') song.album = data.album.slice(0, 200);
      if (typeof data.duration === 'number' && isFinite(data.duration)) song.duration = Math.max(0, data.duration);

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
            song.coverFile = coverFile;
          }
        } catch (err) { /* 封面解析失败则保留原状 */ }
      }

      writeLibrary(library);
      sendJSON(res, 200, { ok: true });
    }).catch(function () { sendJSON(res, 500, { error: '保存失败' }); });
  }

  const delMatch = /^\/api\/songs\/([0-9a-f]+)$/.exec(pathname);
  if (req.method === 'DELETE' && delMatch) {
    if (!isAdmin(req)) { sendJSON(res, 401, { error: '需要管理权限' }); return; }
    const index = library.findIndex(function (s) { return s.id === delMatch[1]; });
    if (index === -1) { sendJSON(res, 404, { error: '歌曲不存在' }); return; }
    const song = library[index];
    try { fs.unlinkSync(path.join(MUSIC_DIR, song.file)); } catch (err) { /* 忽略 */ }
    if (song.coverFile) {
      try { fs.unlinkSync(path.join(COVER_DIR, song.coverFile)); } catch (err) { /* 忽略 */ }
    }
    library.splice(index, 1);
    writeLibrary(library);
    sendJSON(res, 200, { ok: true });
    return;
  }

  sendJSON(res, 404, { error: '接口不存在' });
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

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('听音室 已启动（共享曲库 ' + library.length + ' 首）');
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
