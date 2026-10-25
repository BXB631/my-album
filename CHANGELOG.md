# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **代码签名**（`tools/sign.js` + `tools/sign.ps1`，用系统自带的 `Set-AuthenticodeSignature`，
  不需要 Windows SDK）：打包时给四个 exe 签名 —— 启动器、文件夹选择工具、卸载器、安装包
  —— 而且**在打进安装载荷之前**就签，装出来的副本也是签过的。
  - 证书来源：`MY_ALBUM_SIGN_PFX`（+ 密码，你买的正式证书）→ `MY_ALBUM_SIGN_THUMBPRINT`
    （证书库）→ 自动生成的开发自签证书 `.signing\dev-cert.pfx`（不提交、不进源码包）。
  - 自签证书**只证明同源**，不会消掉别人机器上的 SmartScreen；那需要 CA 签发的证书
    （EV 立刻有信誉，OV 要攒）。正式证书接进来不用改流程，只是换环境变量。
  - 签不上不会中断打包（会打印哪个文件、什么原因）；`MY_ALBUM_SIGN_REQUIRED=1` 可强制。
  - 生成的开发证书带 Code Signing EKU（不带的话 Authenticode 会拒绝：
    "not suitable for code signing"）；签名失败会自动重试 3 次（大 exe 刚编译完常被杀毒占用）。
- **`pnpm release`：整理 GitHub Release 用的发布件**（`tools/release.js`）——
  `release\v<版本>\` 里放：安装包 exe、免安装版 zip、源码 zip、`SHA256SUMS.txt`、
  直接可用的 `RELEASE-NOTES.md`，以及照抄就能上传的 `PUSH-TO-GITHUB.md`。
  免安装版的 zip 直接从**刚通过自检的 staging 树**打（不去碰 `成品\` 目录，避免文件占用），
  源码 zip 会排除 `node_modules`/`build`/`cache`/`data`/`test-runtime`/`.signing`（私钥不外传）。
- `.gitattributes` 补上媒体文件和 `.pfx` 的二进制标记、锁文件不参与 diff；
  `tools/release.js` 的 `PUSH-TO-GITHUB.md` 里给了从 `git init` 到 `gh release create` 的完整命令。
- 安装程序覆盖安装前会**先关掉正在运行的相册**（否则 exe/node 被占用写不进去）。

### Fixed

- `tools/pack.js` 重写了一遍：之前用 PowerShell 的 `Set-Content` 改它，把文件的中文
  全部写坏（编码被当成 ANSI），代码虽然还能跑但日志/注释全乱 —— 现在重新写成干净版本，
  逻辑不变（依赖闭包摊平、瘦身、自检、载荷、安装包、签名）。

- **文件夹选择改用自己的小程序 `MyAlbumPicker.exe`**（`installer/picker/MyAlbumPicker.cs`，
  编到 `app\picker\` 里）—— 界面点"选择照片文件夹"时服务端优先用它，**不再经过 PowerShell**：
  启动更快，也不用赌目标机器上的 PowerShell/.NET 版本。PowerShell 脚本只作为找不到 exe 时的退路。
  `tools/pack.js` 会编译它；`pnpm test:paths` / `pnpm pack:test` 会跑它的 `/selftest`
  （只建对象不弹窗）确认在目标机器上能正常工作。
- 安装程序在**覆盖安装前会先关掉正在运行的相册**（否则 exe/node 被占用写不进去）。

### Fixed

- **选照片文件夹还是失败：`PropertyAssignmentException: UseDescriptionForTitle`（用户实测）**。
  `FolderBrowserDialog.UseDescriptionForTitle` 这个属性**只存在于 .NET Core 5+**，
  Windows PowerShell 5.1 跑在 .NET Framework 上（实测本机 .NET 4.8.1 也没有这个属性），
  一赋值就抛异常、整个脚本当场死掉 —— 所以选择窗口永远出不来。
  现在首选路径换成了编译出来的 `MyAlbumPicker.exe`（根本不碰 PowerShell），
  退路的 ps1 里也**删掉了那行**，并加了 `-SelfTest`（打包/测试时会真的跑一遍）。
  另外我给 ps1 写的中文注释踩了"PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读"的坑（测试当场抓到），
  注释已改回纯 ASCII。

- **自己的安装程序（不用 Inno Setup 也能出安装包）**：`成品\我的相册-<版本>-安装包.exe`
  （实测 **67.5 MB**，载荷 181.5 MB 整段 deflate）。
  - 双击 → 选目录（默认 `%USERPROFILE%\AppData\Local\Programs\我的相册`）→ 装完可选立刻启动；
    勾选创建桌面快捷方式（同时建开始菜单项）。
  - 静默/自动化参数：`/silent /dir=<路径> /noshortcuts /noregistry /nolaunch /noelevate /notask`。
  - 卸载：安装目录里的 `MyAlbumUninstall.exe`（"程序和功能"里也有），
    **缓存和索引一起删**，会先关掉正在跑的相册。
  - 为什么自己写：打包机上没装 Inno Setup、也没网。源码只有一份
    `installer/setup/MyAlbumSetup.cs`，编译两次（`/define:UNINSTALL`）就得到安装器和卸载器；
    载荷是自定义格式（头 + 整段 raw deflate），打包时会**自检解压字节数**才继续。
  - `installer/my-album.iss` 保留着：装了 Inno Setup 6 可以用 `pnpm pack:installer` 出另一版。
- **以管理员身份运行，但启动不再弹 UAC**（用户要求："别每次都弹窗"）：
  安装时登记一个"以最高权限运行、没有触发器"的计划任务（`Register-ScheduledTask`，
  安装程序为此只请求**一次**管理员权限）；启动器发现自己是普通身份时用 `schtasks /Run` 触发它
  —— 于是每次启动都是管理员身份，**一次 UAC 都不弹**。
  - 触发出来的实例带 `--via-task` 参数，避免"不是管理员就再触发一次"的死循环。
  - 没装过任务（免安装版）：记一句日志，以普通身份继续运行；
    `--uac` 才走会弹窗的 `ShellExecute(runas)` 老办法，`--no-elevate` 强制不提权。
  - 卸载时会把那个计划任务一起删掉。
- **托盘新增"手动指定照片文件夹…"**：界面里那个按钮走的是"PowerShell + WinForms"，
  万一它出问题，托盘里这个是启动器进程里的原生对话框（选完直接 `PUT /api/source`），
  一定能用 —— 用户报的"选择照片文件夹点不了"有个保底出路。
- **服务端 5xx 现在会带上原因**：接口错误从"服务器读取照片时出错了"改成
  "服务器读取照片时出错了：<具体原因>"，界面 toast 直接显示 —— 这个服务只在本机跑，
  没必要藏着掖着（这次排查就是靠日志才看到 `EPERM`）。
- `pnpm pack:test`：安装包端到端测试 —— 静默装到测试目录、核对 943 个文件、
  用装出来的启动器 `--check` 真起一次服务、再卸载并确认目录（含缓存）被删干净。
- `tools/pack.js` 打完包会自检安装载荷：解压字节数必须和源文件总和一致，否则直接失败。
- **打包：安装包 + 免安装版（自包含，目标机器不用装 Node）**。按用户定的方案：
  - **按用户安装**到 `%LOCALAPPDATA%\Programs\我的相册`（安装页可以改盘符，不弹 UAC）。
  - **缓存 / 索引 / 设置全在安装目录里**（`<安装目录>\cache`、`<安装目录>\data`）——
    装到 D 盘缓存就跟着去 D 盘；**卸载时这两处直接删掉**。
    新增"安装版目录规则"（`lib/app-paths.js`）：`环境变量 > 安装目录 > 项目目录`，
    并且**先探测安装目录能不能写** —— 写不进去（比如装到了 `C:\Program Files` 又没补 ACL）
    就退到 `%LOCALAPPDATA%\我的相册`，把原因写进日志，绝不静默失败。
  - **无边框窗口**：启动器用**用户默认的那个浏览器**（Chrome/Edge）的 `--app=` 打开，
    没有地址栏和标签栏；默认浏览器找不到才依次退回 Edge / Chrome / 系统默认浏览器。
  - **附加功能只做一个桌面快捷方式**（没有开机自启）；开始菜单项 + 卸载器照常。
  - 启动器（`installer/launcher/MyAlbum.cs`，用系统自带 csc 编译成 12 KB 的 exe）：
    单实例互斥、自动挑空闲端口、`CreateNoWindow` 拉起 `runtime\node.exe app\server.js`、
    托盘菜单（打开相册 / 用普通浏览器窗口打开 / 打开缓存目录 / 退出）。
    关掉浏览器窗口不会自动退出（浏览器可能和已在运行的进程共用，判断不可靠），退出走托盘；
    再点一次快捷方式会把窗口重新打开。
  - 安装版没有控制台，所以日志落到 `<安装目录>\cache\server.log`（`lib/log-file.js`：
    给 stdout/stderr 挂一层写文件，超过 2 MB 截断重开）。
  - `tools/pack.js`（`pnpm pack` / `pnpm pack:installer`）：**不联网**打包 ——
    从现有 pnpm 布局按生产依赖闭包摊平成 `node_modules`（pnpm 是符号链接结构，
    直接复制会在目标机变死链），只带生产依赖、平台专属可选依赖自动跳过；
    再做一次保守瘦身（source map / 类型声明 / 示例 / libheif-js 用不到的两份构建），
    实测省 **11.6 MB**。打完会自己验证：用载荷的依赖真跑 sharp + HEIC 解码（含 ICC）+ ffmpeg，
    再用启动器真拉起一次服务探三个接口。
  - `installer/my-album.iss`（Inno Setup 6）：per-user、可改目录、桌面快捷方式、
    卸载删 cache/data、装到 Program Files 时给两个目录补写权限。
  - 实测：载荷 **181.4 MB**（未压缩）——`runtime\node.exe` 89.2 MB、
    `@ffmpeg-installer` 61.5 MB、sharp 的 libvips 18.1 MB、libheif-js 3.4 MB；
    打包自检 + `pnpm pack:verify` 全绿（HEIC 预览 0.82 MB / 1277 ms、
    视频封面 16 KB、缓存与索引确实落在安装目录里）。
  - `pnpm test:paths`（16 项）盯住"缓存放哪"这条规则；`test.bat` 变成 8 步。
  - 本机没装 Inno Setup，所以这里只验证到"载荷 + 免安装版 + 自检全绿"：
    装上 Inno Setup 6 后跑 `pnpm pack:installer` 即可产出安装包 exe。
- **HEVC 视频优先直出、失败再转**（顶栏新增“直出”开关，默认开）。三层实现：
  - **预判**：给 `<video>` 设源之前先问浏览器能不能解这个编码（`canPlayType`，Chromium 里
    它就是去问平台解码器；装了系统 HEVC 扩展就返回 `probably`），说不行就**一次都不试**，
    直接走转码。结论按"编码 + 容器"缓存，每个组合每次启动只问一次
    （用户中途装了解码器，下次打开程序就生效）。
  - **记忆**：会话内记住预判结论（按编码）；跨会话按**文件**记住"直出失败过"
    （`localStorage`，只留最近 500 条），下次直接转码、不再试。关掉再打开“直出”
    会清空失败记忆，等于"重新试一遍"。
  - **隐藏**：直出失败或 5 秒没出画面时，在转圈提示后面静默换成转码地址重来 ——
    不露黑屏、不出现两个播放器并排；换的时候提示写明"原始编码浏览器解不了，正在准备转码版本"。
  - 视频详情新增"播放方式"一行：`源文件直出（未经转码）` / `转码副本（H.264）`。
  - **实况照片的伴随 MOV 同样走这一套**（服务端多给一个 `liveVideoCodec`）：悬停预览和
    全屏"实况"播放也是"能直出就直出、失败静默换转码"，失败同样按文件记住。
  - 预判结论存在 `sessionStorage`（一个"编码|容器"一个键）：每个标签页一份、
    刷新页面就重新问一遍 —— 能在 Application 面板里直接看到"这台机器能不能解 HEVC"。
  - 实测（用户真实相册 `2026\202606`）：58 个视频里 **56 个是 HEVC**（共 32.1 分钟），
    2 个 H.264；转码一个 9.4 秒的 HEVC 要 **1.4 秒**、产出 6.7 MB。装了系统解码器后这些全省。
- `test:dom` 新增一节“视频：HEVC 优先直出、失败再转”：用捆绑的 ffmpeg **现生成一个真 HEVC 视频**
  （1 秒黑场、约 3 KB）当素材，配合可控的 `canPlayType` 断言 ——
  首次打开直出 `/api/file/:id` → 报错后自动换 `/api/video/:id` → 失败被记进 localStorage →
  再看同一个视频直接转码 → 详情写"转码副本"；再加上判定矩阵（h264/mpeg4/未知不预判、
  hevc 预判说不支持就转码、按"编码+容器"只预判一次、hvc1 写法同样生效）。
- `tools/bench-real-archive.js`（`pnpm bench:real`）：拿真实大相册跑冷扫描体检。
- **实况照片（Apple Live Photo）识别与合成展示**（参考 Lap 的配对规则）：
  同一文件夹里"同名的 HEIC/JPG + MOV"合并成**一个**格子，伴随的 MOV 不再单独占位。
  - 判定先按文件名（iPhone 编号在一台设备内唯一，照片和视频不会撞号），
    再用 Apple 的 Content Identifier 复核：图片头部 XMP 里的 UUID 与 MOV 里的
    `com.apple.quicktime.content.identifier` 必须一致；两边都有标识却对不上就**不合并**
    （宁可显示两个独立项目，也不错误合并）。
  - 支持 `IMG_1234_HEVC.MOV` 这种加后缀的写法；同名有多个 MOV 时只吃"名字正好对上"的那个，
    多出来的仍然是普通视频。
  - 扫描期就完成了配对：图片一进格子就带 LIVE 角标，MOV 从头到尾不占格子，
    所以不会出现"MOV 先冒出来、扫完又消失"的跳动。
  - 卡片：左下角 LIVE 角标；鼠标停住 350 ms 在原地静音播放实况视频，移开即移除节点。
  - 查看器：底部多一个"实况"按钮（快捷键 `L`），视频叠在静止图上播放，
    播完/出错自动回到静止图；详情面板显示伴随视频的名字、时长和体积。
  - 伴随视频仍然可以用 `/api/video/<id>` 播放（HEVC 会转码成 H.264，实测 3 秒的实况首播
    约 0.67 s，之后走缓存）。
  - 索引升到 **v4**（记录实况照片关系）；**v3 及以前的老索引读进来时按文件名补一次配对**
    （只读图片头部 256 KB + MOV 尾部 256 KB，不起 ffmpeg 进程），不用为了这个功能重扫几万张。
- `tools/test-live-photo.js`（`pnpm test:live`）：用 `testmedia\` 里的真实素材验证合并、标识符
  不一致不合并、`_HEVC` 变体、伴随视频可播放、分组计数、索引 v4 与 v3 迁移。
- `tools/audit-live-photos.js`（`pnpm audit:live`）：体检脚本，报告相册里有多少对候选实况照片、
  标识符是否能对上（不改任何文件）。
- `tools/bench-real-archive.js`（`pnpm bench:real`）：拿真实大相册跑冷扫描体检。
- `tools/test-cache.js`（`pnpm test:cache`）：缓存三档的边界测试 ——
  清缩略图不动预览/视频、清"打开的图片视频"不动缩略图、清全部连播放列表一起、
  缩略图清完能重新生成、不认识的 kind 返回 400 且不删东西。
- `test:dom` 里补了缓存弹窗的端到端断言：三个选项的顺序与类型、各自显示占用、
  点第一档时请求体带 `kind=thumbnails`、清完弹窗留着且该档置灰、取消能关掉。

### Changed

- **顶栏“视频直出”升级成“直出”总开关（图片 + 视频一起管）**：以前它只管视频，
  而 HEIC 的"先试原图"不受任何开关控制，用户看了会困惑。现在：
  - 开（默认）：图片（HEIC/HEIF）先试原图、视频（HEVC 等）先试播源文件，试不动自动转换/转码。
  - 关：图片一律转换、视频一律转码（回到"稳"的老行为）。
    （原生格式 JPG/PNG 之类不受影响 —— 它们本来就是源文件，不存在"转换"这回事。）
  - **点一下就是"重新试一遍"**：关掉再打开会同时清掉两类记忆 ——
    视频按文件的失败清单（`localStorage`）+ HEIC"这个浏览器能直出"的会话结论（`sessionStorage`）。
  - **悬停说明写明当前结论**（多行）：视频 HEVC 是"预判说能解"还是"答不上来（仍会试一次）"、
    HEIC 原图有没有试出来能直出。
  - 设置键从 `album-direct-video-first` 换成 `album-direct-source-first`，
    读的时候兼容老键（老用户的选择不会丢）。按钮 id 从 `#directVideoButton` 改成 `#directButton`。
  - 测试（`test:dom` 的 `[8]`）新增：关掉开关 → HEIC 直接给 `/api/preview/:id` 不再试；
    悬停说明包含状态与结论；再打开 → 又变成"试原图"且会话结论被清掉（= 重新试一遍）。
- **HEIC/HEIF 也改成"先试原图，失败再转换"**（用户点的功能；他的机器装了 HEIF 图像扩展）。
  以前 HEIC/HEIF 被写在"必须转换"那一档里，前端**永远**只给 `/api/preview/:id`，
  一次都不试源文件 —— 于是既多花一次 WASM 转换、又在 `cache\previews\` 里攒文件，
  而且转换链（`heic-convert` + `jpeg-js`）写出来的是**没有 ICC 的裸 JPEG**，
  iPhone 的 Display P3 被当成 sRGB，颜色就是偏的。
  现在（`viewerImageUrl` / `isImageSourceTrial`）：
  - HEIC/HEIF 第一下给 **`/api/file/:id`（源文件）** —— Windows 上装了
    「HEIF 图像扩展 + HEVC 视频扩展」时 `<img>` 能直接显示它，于是**真原图、零转换、
    零缓存**，色彩也交给浏览器按原图自带的配置管理（色差基本消失）。
  - 显示失败 → 立刻退回 `/api/preview/:id`（转一次），提示写明
    "这台机器显示不了 HEIC 原图，正在转换…（转一次之后就能看）"。
  - 成功一次就把"这台浏览器能直出 HEIC"记进 `sessionStorage`
    （`album-image-source-v1:HEIC`，值 `1`）：本会话后面所有 HEIC 都不再试探，
    直接源文件；连"预加载邻居"也会跟着预热源文件。
  - **试失败不记负面结论**：一张坏图不该让整个会话都放弃试原图，而试错一次的代价
    只是一次本地请求（这一点和视频的"失败记忆"不同，是刻意的取舍）。
  - 详情面板的"显示来源"改成说**实际显示的**是什么（新记一个 per-item 的显示来源），
    不再靠格式猜。
  - TIFF/RAW 这类浏览器肯定显示不了的，行为和以前一样：直接转换预览。
  - 实测（jsdom 端到端 `[8]`）：`/api/file/:id` 先行 → 报错后退回 `/api/preview/:id`
    且**不写**负面结论 → 让源文件加载成功 → 会话里记下 `1`、详情面板改口"源文件"
    → 再打开就不再是"试"。把 `viewerImageUrl` 里那个 HEIC 分支去掉复跑，这一节 **7 项**变红。
- **相册模式点视频卡片改成在应用内播放**：以前不论顶栏选的是哪种模式，点视频卡片都是丢给
  外部播放器（`handleCardOpen()` 里对视频是硬编码的）—— 所以相册模式点视频也会弹 PotPlayer。
  现在只有选"系统"时才交出去（图片 → 系统照片，视频 → PotPlayer）；
  "相册"（默认）下图片和视频一律进应用内查看器，视频直接走"HEVC 优先直出、失败再转"那条链。
  顶栏那两个按钮的悬停说明和切换时的提示也改成了"图片 / 视频"两种说法。
  `test:dom` 新增一节断言：相册模式点视频卡片 → 打开应用内查看器 + 出现 `<video>` +
  全程 **0 次** `/api/open` 请求（也就是没有启动 PotPlayer）。
- **缓存清理分成三档**（原来是"一键清全部"）：顶部栏按钮改成"清理缓存"，
  点开是一个三选项弹窗，每个选项显示自己那一档的占用，点哪个清哪个：
  - **缩略图缓存**（`cache\thumbnails\`）：照片墙小图和视频封面。清完下次浏览重新生成，
    缓存版本标记会跟着重置（`thumbnailCacheReady = null`），所以缩略图能正常重建。
  - **打开的图片 / 视频缓存**（`cache\previews\` + `cache\videos\`）：
    打开图片时生成的大图预览、视频转码结果（实况照片的 MOV 也算）。通常这才是占地方的大头。
  - **全部缓存**：整个 `cache\`，另外带上播放列表等零碎文件。
  三档都不动原始照片、索引和文件夹设置；空掉的那一档按钮自动置灰；
  清完弹窗不关，数字就地刷新成"空"，可以接着清别的。
  接口：`GET /api/cache` 多返回 `thumbnails` / `media` / `all` 三组 `{bytes, files}`
  （顶层的 `bytes` / `files` 仍然是全部，老调用方不受影响）；
  `POST /api/cache/clear` 接受 `{ kind: thumbnails|media|all }`，不传等于 `all`，
  传了不认识的 kind 返回 400 且什么都不删。
  实测一个真实缓存目录：缩略图 528 个文件 7.5 MB、打开的图片/视频 37 个文件 63.5 MB、
  全部 565 个文件 71.0 MB。
- 服务端错误处理：4xx（调用方问题，比如传错缓存类型）不再往控制台打整段堆栈，只有 5xx 才留现场。

### Fixed

- **选照片文件夹时"服务器读取照片时出错了"（用户实测）**：根因是选择窗口把临时目录建在
  `%TEMP%` 里，而**提权后**进程拿到的 `%TEMP%` 还是原用户的、令牌却是管理员的 →
  `mkdtemp` 直接 `EPERM`（服务端日志里能看到）。
  现在按"谁一定写得进去"的顺序挨个试：**① 安装目录的 `cache` → ② 安装目录 → ③ 系统临时目录
  → ④ `C:\Windows\Temp` → ⑤ `%ProgramData%`**（后两个是给"提权到另一个管理员账号"那种情况准备的：
  那时 `%TEMP%` 指向原用户、令牌是管理员，前三个都可能写不进去，而这两个一定写得进去）；
  全失败时错误信息会把试过的位置列出来，并提示用托盘的"手动指定照片文件夹…"。
  另外给对话框加了一个**置顶的隐形宿主窗口**（提权运行时窗口容易被浏览器盖住，看起来像"点了没反应"），
  并把弹窗文案改成中文。
  `folder-picker.ps1` 保持**纯 ASCII**：PowerShell 5.1 会把没有 BOM 的 UTF-8 脚本按 ANSI 读，
  中文会乱码甚至报语法错 —— 中文文案改成从命令行参数传进去（`pnpm test:paths` 里加了守卫）。
- **安装载荷曾经是坏的**：把 N 个读流依次 `pipe` 进同一个 `deflate`（`end:false`）生成的载荷，
  zlib 解到一半就 `Z_DATA_ERROR`，安装时只还原得出第一个文件。改成
  `Buffer.concat` + `deflateRawSync`（打包期自检通过才继续），简单且可验证。
- 打包时免安装版目录删不掉（上一次的相册还在跑）不再中断整个打包：
  只提示一句，安装包照常产出。
- **安装版打开是"灰的、什么都没有"（用户实测）**：启动器原来给浏览器传了
  `--user-data-dir=<cache>\browser` 开独立 profile —— 那等于让浏览器以"全新用户"启动，
  Edge 会跑首次运行/欢迎流程，**窗口长时间是空白的**。排查过程：
  服务端日志显示三次启动都正常、端口 3000；逐个探接口（`/`、`/styles.css`、`/app.js`、
  `/api/source`、`/api/library/summary` …）**全是 200**；用 jsdom 对着同一个实例渲染，
  页面内容完整（顶栏 + "文件夹不存在，请重新选择" + 空图库状态）；
  而那个自动生成的 profile 里 `Default\Sessions\Apps_*` **记着我们的地址、History 里却没有访问记录**
  —— 指向"浏览器开了但没真正加载页面"。
  现在改成：用**用户默认的那个浏览器**（读注册表 `UrlAssociations\http\UserChoice`）的
  `--app=` 开窗口（profile 早就初始化过，不会撞首次运行），依次退回 Edge / Chrome / 系统默认浏览器；
  托盘加了"用普通浏览器窗口打开"作为备用入口；启动时会**删掉老版本留下的那个 profile 目录**
  （省几十上百 MB）；打开窗口用的命令行会写进日志方便以后排查。
- **启动器的日志一行都没写出来（排查时被这个坑瞎了很久）**：启动器原来把日志追加进
  `cache\server.log`，而 node 那边正拿同一个文件做追加写 —— .NET 的 `File.AppendAllText`
  默认只共享"读"，于是每次都被拒绝、异常被 try/catch 吞掉，**启动器的所有诊断信息全部消失**。
  加上用户那次"窗口没出来"时又撞上"互斥体被上一个残留实例占着"（旧版会直接静默返回），
  于是现象看起来像"启动器什么都没做"。现在：
  - 启动器单独写 **`cache\launcher.log`**（`FileShare.ReadWrite` 打开，和 node 各写各的），
    内容包括每次启动的参数、安装目录、端口、认出来的默认浏览器、候选浏览器的存在性、
    实际发出的浏览器命令行、以及"页面到底有没有被加载"。
  - 互斥体名字**带上安装目录的哈希**，不同副本（打包自检用的 staging、用户的成品目录）不再互相挡；
    `--check` 自检模式完全不碰互斥体，任何时候都能验一次。
  - 撞上"已经有一个实例"时不再静默退出：会去问 `/api/health`，服务还在就把窗口重新打开（并记日志），
    服务已经没了就自己重新起一个。
  - **保证一定看得见东西**：无边框窗口 8 秒内没有页面请求 → 退回普通浏览器窗口（再 8 秒）
    → 还是不行就**自己弹一个小窗**，上面有地址（可复制）、"用默认浏览器打开"、"打开缓存目录"、"退出相册"，
    以及缓存目录和日志路径。判断依据是新增的 `GET /api/health`（返回 `lastPageAt`：最近一次
    有人请求首页/启动接口的时间）—— 比猜进程可靠。
  - 另外加了 `MyAlbum.exe --plain`（不用无边框窗口，直接开普通窗口）方便对比排查。
- **HEIC 照片的颜色终于对了（P3 被当成 sRGB 显示）**：转换链是
  `heic-convert`（libheif/WASM）+ `jpeg-js`，写出来的是**没有 ICC 的裸 JPEG**；
  而 libheif 解出来的是"文件里写的色彩空间"（iPhone 是 Display P3）的数值 ——
  于是浏览器只能把它当 sRGB 显示，颜色偏（实测用户相册里 12/12 张 HEIC 都带着
  **536 字节的完整 ICC**，藏在 `meta/iprp/ipco/colr` 盒里）。
  现在：新增 `lib/heic-color.js`，在 worker 里把 ICC 抠出来、
  按 JPEG 的规矩（APP2 / ICC_PROFILE，>65519 字节自动切段）**补到中间产物上**；
  下游 sharp 拿到带 ICC 的输入后会按它**正确转成 sRGB**（sharp 的默认行为，
  实测转换后的数值和"参照 sRGB 图"一致），输出就是普通 sRGB 数值、不带标签，
  任何看图工具都不会再看错。纯字节拼接，**不解码不重编码**，像素一个数都不动。
  实测（真实相册抽 12 张 HEIC，缩到 256px 对比修复前后）：逐像素平均差
  **0.86 ~ 4.31（0.34% ~ 1.69%，中位 2.94 / 1.15%）**，越饱和的照片差得越多。
  - 缓存：预览后缀 `preview-v1` → `preview-v2`（旧的不再被命中，变成可清理的孤儿）；
    缩略图版本 `3` → `4`（下次启动自动删掉旧的、按正确颜色重新生成 ——
    顺带把之前那批 528 个旧缩略图一起清掉了）。
  - 修掉一个连带踩到的坑：`heic-pool` 直接把调用方的 `ArrayBuffer` **transfer** 给 worker，
    会把调用方的 Buffer **detach**（之后再碰就报
    "Cannot perform Construct on a detached ArrayBuffer"），小文件还可能连累 Buffer 内存池。
    现在先复制一份再 transfer（几 MB 约 1 ms，比 1 秒的解码便宜得多），
    并补了 `shutdownHeicPool()` 让脚本/测试能正常退出。
  - 新测试 `pnpm test:color`（`tools/test-heic-color.js`，19 项）：自己拼一个最小 HEIF 容器
    验证 `prof`/`nclx` 两种色彩盒的读取、APP2 补 ICC 的字节正确性（含超长 ICC 切段）、
    "补 ICC 不改像素"、以及**真 sharp 跑完整效果**（带 ICC 输入必须转出和参照 sRGB 一致的数值，
    只带标签那条路必须偏）；给一个真实 `.HEIC` 路径时还会走真 worker 验证产物带 ICC +
    调用方 Buffer 没被 detach。
- **"预判答不上来"被当成了"解不了"，于是 HEVC 视频永远不试直出**：
  预判问的是 `canPlayType('video/quicktime; codecs="hevc"')` —— 而 `video/quicktime`
  不是 Chromium 声称支持的容器、裸 `hevc` 也不是标准的 RFC 6381 编码串，所以它经常回**空串**。
  空串的语义是"我不保证"，不是"肯定播不了"（Chromium 实际播放时靠内容嗅探，很多 .mov 其实能播），
  旧代码却把它当成"不能"写进缓存、**一次都不试源文件** —— 结果就是这台机器明明能解，也一律转码
  （用户的真实反馈："Media Player 能播，但相册里还是转码"）。
  现在预判**只决定提示文案，不再决定"试不试"**：
  - 结论只有 `'yes'`（`probably`/`maybe`）和 `'unsure'`（空串，存成 `?`）两档，
    **没有"肯定不行"这一档**；不确定也照样先真播一次源文件，靠第三层兜底
    （报错/超时静默换转码，并把该文件记进失败记忆）。
  - 老版本写在 `sessionStorage` 里的 `'0'` 一律按"不确定"处理，老会话不会被旧结论挡死。
  - 明确不值得试的编码（MPEG-4 / 编码未知）仍然直接转码，reason 从 `probe-no` 改成 `unsupported-codec`。
  - 打开时的转圈提示写明了这是在试："正在试播源文件…（这台机器解不解得了还不确定，不行会自动换转码版本）"。
  - 悬停预览和全屏"实况"这两条路也补上了**超时兜底**（悬停 2.5 秒、全屏 5 秒）：
    以前它们只有"报错"才能回退，卡住就一直没有画面。
  - 实测（jsdom 端到端 `[5.8]`）：真实 HEVC 素材 + `canPlayType` 回空串 → 查看器拿到的是
    `/api/file/:id`（直出）、会话里记成 `?`、提示写着"试播"；手动报错后换成 `/api/video/:id`
    并被记进失败记忆。把这条行为改回旧逻辑复跑，`[5.8]` 与判定矩阵共 **11 项**立刻变红。
- **改窗口宽度之后格子会停在旧列数上（一行 8 张放大成一行 5 张大格子）**：
  块是"原地打补丁"复用的（整块重建会让所有图片重新解码、闪一下），
  可列数只在**建块那一刻**写进了 `grid-template-columns` —— 所以宽度变过之后
  （改窗口大小、最大化、浏览器缩放、侧栏出现/消失），已经铺好的块不会重新套列数，
  格子就一直停在旧列数上，而且不会自己恢复。
  现在把"当前列数"收敛成一个 `applyGridColumns(grid)`：新建块和给旧块打补丁都调它，
  列数一变就写回旧网格（仍然是原地改，不重建 DOM）。
  另外给画廊挂了 `ResizeObserver`（只看宽度、阈值 1px，高度变化一律忽略），
  覆盖"窗口尺寸没变、但画廊自己的宽度变了"的情况（侧栏出现/消失、页面滚动条、DevTools 停靠）。
  实测（jsdom 端到端）：宽度 1200px → 7 列；改成 900px 后**屏幕上每一块**都变成 5 列；
  再改回 1200px 又都是 7 列；而且 2/2 个网格还是原来那些节点（原地改列数，没整块重建）。
  把 `applyGridColumns` 那行去掉复跑，这一节立刻报 `变窄之后… — 7,7`。
- **扫描期建出来的卡片会一直用"旧快照"**：卡片元素是在扫描期创建的，那时实况照片的
  伴随视频信息（id / 时长 / 编码）还没补上；扫描完成后虽然条目重新取过了，
  但**已渲染的卡片节点和元素池里的节点都被复用了**，闭包里还是旧条目 ——
  结果就是"悬停预览明明能直出却还是去转码"。
  现在给卡片记一个"渲染指纹"（`itemRenderKey`：id / 类型 / 实况字段 / 时长），
  `patchBlock` 和 `nodeForIndex` 都会比对指纹，不一致就把那一格重建一次（只影响变了的格子，
  不会整窗口重建）。顺带把"条目关键信息变化"这一类问题一并解决了。
- 浏览 JPG/PNG 也会在 `cache\previews` 里生成 JPEG：
  `preloadNeighbors()` 无脑预加载 `item.previewUrl`，而 `previewUrl` 对**所有**图片都存在 ——
  于是在查看器里翻页时，每翻一张就为左右邻居各转一张 2560px 的预览 JPEG，
  而这些图**根本不会被显示**（原生格式走的是源文件），纯属白转、白占盘。
  实测证据：真实相册里 15 个预览文件全部能反查回 PNG 源文件（13 张是屏幕截图）。
  现在把"显示哪张图"收敛成一个函数（`viewerImageUrl()`）：原生格式给源文件、
  只预加载真正会显示的那个地址，HEIC/TIFF 才预加载预览图。
  实测（1200 张 jsdom 端到端）：浏览 + 翻页过程中 **0 次** `/api/preview` 请求，
  `cache\previews` **连目录都没被建出来**；`/api/file/:id` 返回的字节与磁盘原文件**完全一致**
  （PNG 含透明通道也是原样返回，`content-type: image/png`）。
- 顺带修掉一个隐患：预加载改回"预热真正要显示的那份"，所以翻页是命中缓存而不是白预热；
  超过 8 MB 的原图不预加载（省一次无效读盘），反正有转圈提示兜着。
- **HEIC/TIFF 改成"只在真正打开那一张时才转"**：预加载邻居只预热原生格式（源文件），
  需要转换的格式**不再预热** —— 以前翻页时会顺手把左右邻居各转一张存下来，白花 CPU、白占盘。
  已经打开过的那些不受影响：`/api/preview` 的响应带 `immutable` 缓存，翻回来照样秒开。
  转换期间的提示也写明了"正在转换这张照片…（HEIC 需要转一次才能显示）"。
  实测（jsdom 端到端，带一张 TIFF 当"必须转换"的邻居）：停在 PNG 上时邻居里有 TIFF 但
  **没有被预热**，翻开 TIFF 时才请求 `/api/preview`，`cache\previews` **打开前 0 个 → 打开后 1 个**。

### Added

- 详情面板新增一行 **“显示来源”**：写明这张是"源文件（未经转换）"还是
  "转换预览（浏览器解不了这个格式）"—— 回答"我现在看到的到底是不是原图"。
- `tools/audit-cache.js`（`pnpm audit:cache`）：缓存体检，把 `cache\previews` /
  `cache\thumbnails` 里的文件名反查回源照片（缓存名 = `sha1(路径|大小|修改时间 + 用途后缀)`），
  用来判断"缓存里这个文件是谁产生的、是不是多余的"。只读，不改任何东西。
- `test:dom` 新增一节"源文件直出"断言：查看器给的是 `/api/file/:id`、
  服务端返回字节 = 磁盘原文件、翻到下一张 PNG 同样是源文件（含透明通道）、
  整轮浏览 0 次 `/api/preview`、`cache\previews` 目录都没被创建。
- `test:dom` 再加一节"必须转换的格式"：用 sharp 现生成一张 TIFF 排在实况照片后面当邻居，
  断言它**不会被预热**、只有翻开它时才请求转换预览、并且 `cache\previews`
  **打开前是空的、打开后才多出这一张**。选 TIFF 而不是 HEIC 是因为它没有 EXIF、
  日期完全由文件名决定（能精确控制它排在哪儿），也不依赖工作区 `testmedia\` 的素材。

## [2.0.0] - 2026-10-22

### Removed

- **彻底移除 Electron**：删除 `electron/main.js`、`electron-builder.yml`、`start-dev.bat`
  和 Electron 桌面冒烟测试；`package.json` 去掉 electron / electron-builder 依赖与 nsis 打包脚本；
  `lib/folder-picker.js` 去掉 Electron 原生对话框钩子。
  原因：本机上 Electron 起不来（受限会话里 Chromium 报 `Check failed: . : 拒绝访问 (0x5)`，
  退出码 `0x80000003`），而网页模式功能不缺。
- 依赖树缩小：`node_modules` 从约 350 MB 降到约 106 MB，lockfile 里不再有 electron 相关条目。
- 启动方式改为 `pnpm start` / 双击 `start-web.bat`（Node 服务 + 浏览器），不再有安装包。
- 数据目录从 `%APPDATA%\MyAlbum` 回到项目下的 `data\` / `cache\`。

### Changed

- 照片墙改为流式加载（参考 Lap 的加载模式）：先要总数与扫描进度，立刻铺占位格，
  只渲染可视区附近的块，按块取数据，缩略图按"离视口中心近"的优先级排队取。
- 前端不再调用整库接口 `/api/photos`；列表数据分页取，浏览器内存占用与图库大小解耦。
- 冷扫描与浏览解耦：扫描期列表持续增长，不用等整轮扫描结束才显示照片。
- 取消扫描后保留已完成的部分，可以继续浏览；再点"继续加载"才重新扫。
- 缩略图/预览/原图/打开原文件按 id 单条查询，不再等待整轮扫描。
- 按文件夹过滤改在服务端做（`folder=` 参数），前端不再全量拉取后本地筛选。
- **扫描进度提示从全屏遮罩改成内容区顶部的细条**：不再是挡住整屏的转圈浮层，
  而是一条带进度条和"停止 / 继续"按钮的窄条，照片可以照常看。

### Removed

- **扫描期按日期分组（边扫边分组）整块去掉**：它每轮都要重算分段、还要调整已经铺好的块，
  体感上"有点影响速度"，所以扫描期统一走最短路径 —— 固定大小的占位块，
  照片填到哪显示到哪，日期表头只在扫描完成后出现（精确、按拍摄时间排序）。
  服务端的 `buildScanDays/getScanDays/scanDaysToken`、`summary.scanDays/daysToken`、
  客户端的 `normalizeScanDays` 与 pending 分块全部删除。
  实测 3000 张冷扫描 5448 / 5165 ms（去掉之前 5568~6058 ms），
  1200 张端到端首张照片 521~547 ms、扫描完成 2538~2571 ms。

### Fixed

- **侧栏"时间目录"消失**：前端把"目录已经同步过了"记在会话的 `revision` 上，
  而刷新/换文件夹会新建会话、`revision` 从 1 重新数，扫完可能正好和上一轮相同，
  于是目录不再刷新，侧栏一直停在扫描期渲染的"还没有识别到年份目录"。
  现在 `revision` **跨会话单调递增**，扫描期渲染的空状态不再算"已同步"，
  目录请求失败也会撤掉标记并重试。
- **扫描期看不到时间目录**：年/月目录改为跟着 `summary` 一起回来，
  扫描期只用"已解析前缀"建树（边扫边长），扫描期也能直接按年/月过滤。
  实测用户的真实相册（34442 个文件）：**533 ms 就出现"2017 年"**，
  改之前要等整轮扫描结束才会出现。
- **滚动时疯狂闪烁**：渲染从"每次可视区变化就整窗口重建 DOM"改成
  "只增删进出窗口的块 + 原地把占位格换成卡片"，图片不再被反复重建和解码。
- **滚动时跳跃**：`resize` 只在宽度真的变化时才重算布局（此前页面滚动条出现/消失
  会导致可用宽度变化 → 重建布局 → 回滚滚动位置 → 来回跳）；`html` 常驻滚动条；
  画廊位置改为缓存（此前每帧读 `getBoundingClientRect` 并在同一帧写高度，造成布局抖动）。
- 可视区上下缓冲从 2 行加到 3 行，快速滚动时不再频繁触发同步渲染。

### Added

- 流式接口：`/api/library/summary`、`/api/library/days`、`/api/library/items`、
  `/api/library/neighbors/:id`、`/api/library/items-by-ids`。
- 查看器翻页使用服务端计算的邻居，不必把整个图库加载进内存。
- 流式加载的自动化测试：几何单测、服务端三种模式冒烟测试、jsdom 前端端到端测试。
- `tools/bench-scan.js`（`pnpm bench:scan`）：冷扫描吞吐基准（`--client` 会把前端轮询负载算进去）。
- `tools/test-folder-nav.js`（`pnpm test:nav`）：侧栏年/月目录的端到端测试 ——
  路径识别（含"根目录就是月份文件夹，年份只在绝对路径里"）、扫描期目录先出现且能点、
  刷新/换文件夹后目录不丢、散图进"未分类"。
- `test.bat`：命令行里没有 `node` 时（`pnpm test` 会报 `'node' is not recognized`），
  双击它就能按 `start-web.bat` 的方式找 node 并跑完全部检查。
- `docs/LOADING-2.0.md` 说明新的加载架构与测试方式。

## [1.11.0] - 2026-10-21

### Added

- Electron desktop application with a native Windows window.
- Native folder picker, desktop shortcut, Start Menu shortcut and uninstaller.
- Local JSON library index with incremental refresh and directory signature checks.
- FFmpeg-based fast video probing and HEIC conversion worker pool.
- Progressive timeline rendering for very large libraries.
- Photo map, EXIF details, city labels and cache management.
- GitHub-friendly build and release workflows.

### Changed

- User data moved to `%APPDATA%\MyAlbum` for installed builds.
- Thumbnails reduced to 320 px, JPEG quality 65.
- Video playback falls back to the system player when PotPlayer is unavailable.

### Fixed

- Reduced blocking when generating HEIC thumbnails.
- Avoided rebuilding the entire photo index when only opening the app.
- Improved refresh behavior while a large library is already displayed.
