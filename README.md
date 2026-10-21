<p align="center">
  <img src="assets/icon.png" width="112" alt="我的相册">
</p>

<h1 align="center">我的相册</h1>

<p align="center">
  一个 iOS 风格暗黑界面的 Windows 桌面相册。照片只在本机读取，不上传、不联网同步。
</p>

<p align="center">
  <a href="../../releases/latest"><strong>下载最新安装包</strong></a>
  ·
  <a href="#源码运行">源码运行</a>
  ·
  <a href="#打包安装包">打包安装包</a>
  ·
  <a href="docs/PUBLISHING.md">发布到 GitHub</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?logo=windows" alt="Windows 10/11">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/version-1.11.0-blue" alt="Version 1.11.0">
</p>

## 功能

- 选择任意本地文件夹，递归扫描照片和视频
- 按年份、年月显示目录，时间轴从旧到新排列
- HEIC / HEIF 自动转成缩略图和预览图
- 视频自动截取封面，优先用 PotPlayer 播放，也可回退到系统播放器
- 全屏查看照片，滚轮缩放、拖动、左右切换
- 详情面板显示文件名、大小、格式、分辨率、拍摄时间、设备和 GPS
- 高德地图照片地图，位置相同的照片自动聚合
- 日期标题显示当天主要城市
- 显示缓存占用，一键清除缓存
- 大文件夹使用 JSON 索引、增量扫描和分天渐进加载

## 下载安装

1. 打开 [Releases](../../releases/latest)。
2. 下载最新的 `我的相册-1.11.0-安装包.exe`。
3. 双击安装，选择安装位置。
4. 打开“我的相册”，点击“选择照片文件夹”。

支持 Windows 10 / 11 64 位。安装版不需要 Node.js，也不需要浏览器。

> 当前安装包没有购买商业代码签名证书。Windows SmartScreen 可能提示“未知发布者”，点击“更多信息 → 仍要运行”即可。应用不会上传照片或索引。

安装版数据保存在：

```text
%APPDATA%\MyAlbum\
  data\
    settings.json          当前照片文件夹
    library-index.json     图库索引
  cache\
    thumbnails\            缩略图
    previews\              预览图
    videos\                视频转码缓存
    playlists\             PotPlayer 播放列表
  app.log                  启动日志
```

卸载默认保留这个目录，重新安装后仍可继续使用原来的设置和索引。需要彻底清理时手动删除 `%APPDATA%\MyAlbum`。

## 打开方式

顶部栏有“相册 / 系统”切换，默认是 **相册**：

- 点击图片：进入应用内全屏浏览，可用左右方向键翻同文件夹照片
- JPG、PNG、WebP、GIF、BMP、AVIF 直接显示原始文件
- HEIC 等格式使用转换后的预览图
- 全屏预览右下角“原图”：用 Windows 默认照片工具打开原始文件
- 切到“系统”：点击图片直接用 Windows 照片工具打开
- 点击视频：优先用 PotPlayer 打开，并生成同文件夹播放列表；没安装 PotPlayer 时自动使用系统默认播放器

## 性能设计

第一次打开一个新的超大文件夹时，程序会完整读取一次目录和拍摄信息；之后会复用索引：

- 图库索引保存在 `data/library-index.json`
- 重启后直接读取索引，不重新读取 EXIF
- 目录没有新增、删除或改名时，刷新只比对目录签名
- 新增文件时只读取新增或变化的项目
- 视频信息用 FFmpeg 只读文件头，不再整段载入
- HEIC 解码放在 4 个 worker 线程中，不阻塞主界面
- 缩略图为 320px，JPEG 质量 65
- 首屏只渲染前 3 天，向下滚动再分批追加

索引损坏或需要强制重建时，退出应用，删除 `%APPDATA%\MyAlbum\data\library-index.json`，再打开应用。

“清除缓存”只删除缩略图、预览图和视频缓存，不会删除原始照片，也不会删除索引和文件夹设置。

## 支持的格式

图片：JPG、JPEG、PNG、HEIC、HEIF、WebP、GIF、AVIF、TIFF、BMP

视频：MP4、MOV、M4V、WebM、AVI、MKV

## 目录识别

推荐按下面的结构存放：

```text
D:\Photos\
  2026\
    202608\
      IMG_0001.HEIC
      IMG_0002.MOV
    202607\
      IMG_0003.JPG
  2025\
    202512\
      IMG_0004.JPG
```

支持这些写法：

- `2026/202608`
- `2026/08`
- `2026/2026-08`
- `202608`
- 只有年份、没有月份：显示在对应年份下
- 没有年份的散图：显示在“未分类”

## 源码运行

需要 Node.js 20.8 或更高版本，以及 pnpm。

```bash
pnpm install --node-linker=hoisted
pnpm check
pnpm start
```

Windows 下也可以双击 `start-dev.bat`。

如果 Electron 运行时没有自动下载：

```bash
node node_modules/electron/install.js
```

旧的浏览器调试模式仍然保留：

```bash
pnpm start:web
```

## 打包安装包

```bash
pnpm dist
```

生成文件在 `dist/`。GitHub Actions 也会在推送 `v*` 标签时自动构建安装包并创建 Release。

发布流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 项目结构

```text
electron/main.js        Electron 主进程、窗口、原生文件夹选择、安全策略
server.js               仅监听 127.0.0.1 的本地 Express 服务
lib/app-paths.js        桌面版和开发版的数据、缓存、默认照片目录
lib/media.js            扫描、EXIF、视频探测、缩略图、索引
lib/heic-pool.js        HEIC 后台转换线程池
lib/settings.js         保存当前照片文件夹
lib/launcher.js         系统照片、PotPlayer 或系统播放器打开原文件
lib/city-lookup.js      根据 GPS 匹配最近城市
public/                 相册界面、预览器、地图
assets/icon.ico         应用和安装包图标
docs/PUBLISHING.md      上传到 GitHub 和发布 Release 的步骤
```

桌面版窗口加载本机回环地址 `127.0.0.1` 上的服务，该服务只监听本机，不对外开放端口。渲染进程关闭了 Node.js 访问，照片读取和文件打开都由主进程完成。

## 隐私

- 照片、视频、EXIF 和索引完全在本机读取
- 不包含账号、统计、遥测或云同步
- 只有高德地图瓦片需要联网加载
- 清理缓存不会删除原始照片

## 常见问题

**提示照片文件夹不存在**

原文件夹可能被移动、重命名，或磁盘没有连接。点击“选择照片文件夹”重新选择即可。索引和缓存不会因此丢失。

**首次打开很慢**

第一次读取超大文件夹需要完整扫描一次。以后启动会使用 JSON 索引。

**视频没有用 PotPlayer 打开**

程序会自动查找常见安装位置。也可以设置环境变量 `POTPLAYER_PATH` 指向 `PotPlayerMini64.exe`。没有 PotPlayer 时会使用系统默认播放器。

**地图是空白**

地图瓦片需要联网。照片和索引本身完全在本地读取。

**安装时出现未知发布者**

当前安装包未做商业代码签名，这是 Windows 的正常提示。介意的话可以自行购买证书后重新签名。

## License

[MIT](LICENSE)
