# 听音室 · 音乐播放器

音乐播放器：既能像以前一样把音乐导入本机浏览器播放，也带**共享曲库**——
上传的音乐保存在项目服务器上，所有访问者都能听到同一个曲库，上传 / 删除需要管理密码。

## 打开方式

推荐用本地服务打开，这样曲库才能保存在浏览器里（直接双击 index.html 时，
部分浏览器不允许写入本地数据库）：

```powershell
cd "C:\Documents\New project\soundroom"
node serve.js
```

浏览器访问 `http://localhost:8000`。也可以换端口：`node serve.js 8080`。

**一键启动（推荐）**：双击项目里的 `一键启动听音室.bat`，会自动启动音乐服务 +
公网隧道（Cloudflare），窗口里会显示本机地址和公网临时地址，按 `Ctrl+C` 一次性全部关闭。

如果装了 Python，`python -m http.server 8000` 同样可用（但没有共享曲库上传功能）。

## 手机怎么用

1. 手机和电脑连同一个 Wi-Fi。
2. 启动 `node serve.js`，命令窗口会直接打印“手机访问”的地址（也可用 `ipconfig` 查 IPv4）。
3. 用手机浏览器打开那个地址，例如 `http://192.168.1.8:8000`。
4. 在 Chrome / Safari 里选“添加到主屏幕”，就会像 App 一样全屏打开，支持离线使用。

> 手机和电脑的曲库各自独立存放（浏览器本地存储），互不同步。

## 功能

- **共享曲库**：点「上传音乐」会把文件传到服务器（本项目 `music/` 目录），所有访问者打开都能看到并播放；上传 / 删除需要管理密码
- 添加单个音乐文件、批量添加，或整个文件夹导入（文件夹导入仍是导入到本机浏览器）；桌面端支持拖拽导入本机
- 自动读取 ID3 / MP4 / FLAC 标签里的标题、歌手、专辑和封面
- 播放列表：全部歌曲、我的收藏、最近播放，支持搜索和排序
- 底部播放栏 + 全屏播放页，带频谱动画、进度拖动、音量、播放速度
- 随机播放、列表循环、单曲循环，手机锁屏支持上一首/下一首
- 键盘快捷键：`空格` 播放/暂停、`←/→` 快退快进 5 秒、`↑/↓` 音量、`M` 静音、`F` 收藏、`/*` 搜索
- 支持 PWA：添加到主屏幕后可离线打开（共享曲库播放需要联网）

## 共享曲库（管理密码）

- 上传的音乐保存在服务器上的 `music/` 目录，清单记录在 `library.json`，**所有人共享、人人可听**
- 首次启动 `node serve.js` 时会自动生成管理密码并显示在命令窗口，同时保存到 `server-config.json`（已加入 .gitignore，不会上传到仓库）
- 想自己设置密码：删除 `server-config.json` 后重启，或启动前设置环境变量 `ADMIN_PASSWORD`
- 管理令牌有效期 24 小时；页面右上角「上传音乐」会先弹出管理密码验证
- 共享曲目的删除按钮同样需要管理密码
- 手机和电脑的共享曲库是同一份；本机导入（文件夹/拖拽）的曲库仍各自独立

## 支持的格式

取决于浏览器。Chrome / Edge 通常支持 MP3、M4A/AAC、WAV、OGG、Opus、FLAC；
Safari 支持 MP3、M4A/AAC、WAV、ALAC（FLAC 需要较新版本）。

## 说明

- 共享曲库存在服务器磁盘（`music/` + `library.json`），删除 `music/` 会清空共享曲库，请谨慎操作。
- 本机导入的曲库保存在浏览器 IndexedDB 中。清理浏览器数据会把本机曲库一起清掉，建议保留来源文件。
- 本机曲库每台设备独立；共享曲库全局一份。
- 上传有单文件 300MB 上限、仅限常见音频格式；服务器异常退出前建议先停止上传。

## 目录结构

```
soundroom/
  index.html              页面结构
  css/styles.css          全部样式（含移动端适配）
  js/id3.js               音频标签解析（ID3v1/v2、MP4、FLAC）
  js/db.js                IndexedDB 存取
  js/app.js               播放器与界面逻辑
  sw.js                   Service Worker 离线缓存
  manifest.webmanifest    PWA 清单
  icons/                  图标
  serve.js                本地静态服务器 + 共享曲库 API（node serve.js）
  music/                  共享曲库音频与封面（运行时生成，勿提交）
  library.json            共享曲库清单（运行时生成，勿提交）
  server-config.json      管理密码配置（运行时生成，勿提交）
  .github/workflows/      GitHub Pages 自动部署
```

## 让所有人都能访问（上线）

**注意**：共享曲库需要 Node 服务器运行（音乐存在本机磁盘），静态托管无法提供上传功能。

### 方式一：Cloudflare 免费隧道（临时，推荐配合共享曲库）

```powershell
# 先启动本地服务
node serve.js
# 另开一个窗口
cloudflared tunnel --url http://localhost:8000
```

命令会输出一个 `https://xxx.trycloudflare.com` 地址，发给任何人都能打开。
共享曲库完整可用（上传、播放、管理密码），但地址每次启动会变，且电脑不能关机。

### 方式二：GitHub Pages（免费、长期，仅页面，无共享曲库）

把项目部署到 GitHub Pages 后，页面本身可以打开、本机导入功能正常，
但「上传音乐」共享功能不可用（没有服务器）。如果不需要共享上传，仍可这样部署：

1. 在 GitHub 上新建一个空仓库，名字例如 `soundroom`（不要勾选 README）。
2. 在 `soundroom` 目录里执行（把地址换成你的仓库）：

```powershell
cd "C:\Documents\New project\soundroom"
git init
git add .
git commit -m "听音室：音乐播放器"
git branch -M main
git remote add origin https://github.com/你的用户名/soundroom.git
git push -u origin main
```

3. 打开仓库的 `Settings → Pages`，把 `Source` 选成 **GitHub Actions**。
4. 等一分钟，访问 `https://你的用户名.github.io/soundroom/`。

仓库里已经带了 `.github/workflows/deploy-pages.yml`，以后每次 `git push` 都会自动更新线上版本。

### 上线后要注意

- 网站本身是公开的：本机曲库在自己的浏览器里；共享曲库是服务器上的同一份，所有人都能听。
- 上传需要管理密码，但**任何知道密码的人都能上传**，密码请只告诉信任的人。
- 公开分享他人音乐可能涉及版权问题，自己听着玩没问题，公开发布要留意。
