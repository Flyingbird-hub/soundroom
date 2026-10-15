# 听音室 · 本地音乐播放器

纯前端音乐播放器：把手机或电脑里的音乐加进浏览器，随时播放，不需要后端，
音乐文件只存在这台设备的浏览器里，不会上传到任何服务器。

## 打开方式

推荐用本地服务打开，这样曲库才能保存在浏览器里（直接双击 index.html 时，
部分浏览器不允许写入本地数据库）：

```powershell
cd "C:\Documents\New project\soundroom"
node serve.js
```

浏览器访问 `http://localhost:8000`。也可以换端口：`node serve.js 8080`。

如果装了 Python，`python -m http.server 8000` 同样可用。

## 手机怎么用

1. 手机和电脑连同一个 Wi-Fi。
2. 启动 `node serve.js`，命令窗口会直接打印“手机访问”的地址（也可用 `ipconfig` 查 IPv4）。
3. 用手机浏览器打开那个地址，例如 `http://192.168.1.8:8000`。
4. 在 Chrome / Safari 里选“添加到主屏幕”，就会像 App 一样全屏打开，支持离线使用。

> 手机和电脑的曲库各自独立存放（浏览器本地存储），互不同步。

## 功能

- 添加单个音乐文件、批量添加，或整个文件夹导入；桌面端支持拖拽导入
- 自动读取 ID3 / MP4 / FLAC 标签里的标题、歌手、专辑和封面
- 播放列表：全部歌曲、我的收藏、最近播放，支持搜索和排序
- 底部播放栏 + 全屏播放页，带频谱动画、进度拖动、音量、播放速度
- 随机播放、列表循环、单曲循环，手机锁屏支持上一首/下一首
- 键盘快捷键：`空格` 播放/暂停、`←/→` 快退快进 5 秒、`↑/↓` 音量、`M` 静音、`F` 收藏、`/*` 搜索
- 支持 PWA：添加到主屏幕后可离线打开

## 支持的格式

取决于浏览器。Chrome / Edge 通常支持 MP3、M4A/AAC、WAV、OGG、Opus、FLAC；
Safari 支持 MP3、M4A/AAC、WAV、ALAC（FLAC 需要较新版本）。

## 说明

- 曲库保存在浏览器 IndexedDB 中。清理浏览器数据会把曲库一起清掉，建议保留来源文件。
- 如果存储空间不足，导入会提示失败；可以先删掉一些曲目再试。
- 每个浏览器、每台设备的曲库是独立的；换浏览器或换设备需要重新导入。

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
  serve.js                本地静态服务器（node serve.js）
  .github/workflows/      GitHub Pages 自动部署
```

## 让所有人都能访问（上线）

这个项目是纯静态站点，任意静态托管都能直接跑，不需要服务器和数据库。

### 方式一：GitHub Pages（免费、长期，推荐）

1. 在 GitHub 上新建一个空仓库，名字例如 `soundroom`（不要勾选 README）。
2. 在 `soundroom` 目录里执行（把地址换成你的仓库）：

```powershell
cd "C:\Documents\New project\soundroom"
git init
git add .
git commit -m "听音室：本地音乐播放器"
git branch -M main
git remote add origin https://github.com/你的用户名/soundroom.git
git push -u origin main
```

3. 打开仓库的 `Settings → Pages`，把 `Source` 选成 **GitHub Actions**。
4. 等一分钟，访问 `https://你的用户名.github.io/soundroom/`。

仓库里已经带了 `.github/workflows/deploy-pages.yml`，以后每次 `git push` 都会自动更新线上版本。

### 方式二：临时给别人看

没有账号也能用 Cloudflare 的免费隧道，把本机服务临时暴露到公网：

```powershell
# 先启动本地服务
node serve.js
# 另开一个窗口
cloudflared tunnel --url http://localhost:8000
```

命令会输出一个 `https://xxx.trycloudflare.com` 地址，发给任何人都能打开。缺点是地址每次都不一样，而且必须保持这台电脑开机。

### 上线后要注意

- 网站本身是公开的，但每个人的曲库在自己的浏览器里，别人打开看到的是空列表，需要自己导入音乐。
- 如果你想让所有人打开就能听同一批歌，那需要额外的后端或对象存储（音乐文件放在服务器上），这部分本项目没有包含。
- 公开分享他人音乐可能涉及版权问题，自己听着玩没问题，公开发布要留意。
