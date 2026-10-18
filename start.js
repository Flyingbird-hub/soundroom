/* 听音室 · 一键启动器
 * 同时启动音乐服务（node serve.js）与公网隧道（cloudflared），
 * 自动打印公网地址；按 Ctrl+C 一次性关闭全部进程。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const PORT = 8000;

/* 依次尝试：环境变量 CLOUDFLARED → 项目旁 tools 目录 → 项目内 tools → PATH */
function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    path.join(ROOT, '..', 'tools', 'cloudflared.exe'),
    path.join(ROOT, 'tools', 'cloudflared.exe'),
    'cloudflared'
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'cloudflared') return c;
    try { fs.accessSync(c); return c; } catch (err) { /* 下一个 */ }
  }
  return null;
}

function checkPort(port) {
  return new Promise(function (resolve) {
    const sock = net.connect(port, '127.0.0.1');
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (err) { /* ignore */ }
      resolve(ok);
    }
    sock.once('connect', function () { finish(true); });
    sock.once('error', function () { finish(false); });
    sock.setTimeout(1200, function () { finish(false); });
  });
}

function box(lines) {
  const w = 60;
  const out = [];
  out.push('+' + '-'.repeat(w) + '+');
  for (const l of lines) {
    const text = String(l);
    out.push('| ' + text + ' '.repeat(Math.max(1, w - text.length - 1)) + '|');
  }
  out.push('+' + '-'.repeat(w) + '+');
  return out.join('\n');
}

const children = [];

function stopAll(reason) {
  if (reason) console.log('\n' + reason);
  for (const c of children) {
    if (c && c.exitCode === null) {
      c.__stopping = true;
      try { c.kill(); } catch (err) { /* ignore */ }
    }
  }
}

async function main() {
  console.log(box([
    '听音室 · 一键启动',
    '本机地址  http://localhost:' + PORT,
    '按 Ctrl+C 停止（同时关闭服务与隧道）'
  ]));

  const inUse = await checkPort(PORT);
  let server = null;

  if (inUse) {
    console.log('[提示] 端口 ' + PORT + ' 已有服务在运行，直接复用，不再重复启动。');
  } else {
    console.log('[1/2] 启动音乐服务（node serve.js）…');
    server = spawn(process.execPath, ['serve.js'], { cwd: ROOT, stdio: 'inherit' });
    children.push(server);
    server.on('exit', function (code) {
      if (server.__stopping) return;
      console.log('\n[提示] 音乐服务已退出（代码 ' + code + '）。若是端口被占用，请先关闭占用程序再启动。');
      stopAll('正在关闭公网隧道…');
      setTimeout(function () { process.exit(code || 0); }, 300);
    });

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 300); });
      if (await checkPort(PORT)) { ready = true; break; }
      if (server.exitCode !== null) return;
    }
    if (!ready) console.log('[警告] 音乐服务端口暂未就绪，继续尝试启动隧道…');
  }

  const cf = findCloudflared();
  if (!cf) {
    console.log('\n[错误] 未找到 cloudflared，无法提供公网地址。');
    console.log('  解决办法：把 cloudflared.exe 放到 ' + path.join(ROOT, '..', 'tools') + ' 目录，');
    console.log('  或安装到系统 PATH 后重新双击启动。（音乐服务仍在运行，本机可正常听歌）');
    return;
  }

  console.log('[2/2] 启动公网隧道（cloudflared --protocol http2）…');
  const tunnel = spawn(cf, ['tunnel', '--protocol', 'http2', '--url', 'http://localhost:' + PORT], { cwd: ROOT });
  children.push(tunnel);

  let shown = false;
  tunnel.stderr.on('data', function (d) {
    const text = d.toString('utf8');
    process.stderr.write(text);
    if (!shown) {
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        shown = true;
        console.log('\n' + box([
          '公网地址（发给任何人即可访问）',
          m[0],
          '提示：临时地址，隧道重启后会变化'
        ]) + '\n');
      }
    }
  });
  tunnel.stdout.on('data', function (d) { process.stdout.write(d); });
  tunnel.on('exit', function (code) {
    if (tunnel.__stopping) return;
    console.log('\n[提示] 公网隧道已停止（代码 ' + code + '）。');
  });

  process.on('SIGINT', function () {
    stopAll('\n[停止] 收到 Ctrl+C，正在关闭服务与隧道…');
    setTimeout(function () { process.exit(0); }, 400);
  });
  process.on('SIGTERM', function () {
    stopAll();
    process.exit(0);
  });
}

main().catch(function (err) {
  console.error('[错误] 启动器异常：' + (err && err.message ? err.message : err));
  process.exit(1);
});
