# 发布与打包

2.0 是纯网页版（Node 服务 + 浏览器）。源码可以直接跑（见 README），
也可以用 `tools/pack.js` 打成**安装包**或**免安装版**（自包含 Node 运行时，目标机器不用装 Node）。

## 1. 打包（安装包 / 免安装版 / 发布件）

```powershell
cd 2.0
pnpm pack                 # 编译 + 自检 + 签名 → 安装包 + 免安装版（不需要 Inno Setup）
pnpm release              # 整理成 GitHub Release 用的 release\v<版本>\
pnpm pack:test            # 安装包端到端：静默装 → 用装出来的启动器自检 → 卸载
pnpm pack:verify          # 深度验证：用打包好的载荷真解一张 HEIC + 生成一张视频封面
pnpm sign <文件...>        # 单独给某些 exe 签名（一般不用，pack 里已经带了）
pnpm pack:installer       # 可选：装了 Inno Setup 6 时，另外出一版 Inno 安装包
```

产出：

```text
成品\我的相册-<版本>-安装包.exe            自己的安装程序（约 67 MB，已签名）
成品\我的相册-<版本>-免安装版\              拷走就能用（双击 MyAlbum.exe）
release\v<版本>\                          传 GitHub 用的三个附件 + 校验和 + 说明
   我的相册-<版本>-安装包.exe
   我的相册-<版本>-免安装版.zip
   我的相册-<版本>-源码.zip
   SHA256SUMS.txt / RELEASE-NOTES.md / PUSH-TO-GITHUB.md
```

`pnpm pack` 会自己做完这几件自检，任何一步失败就中断：

1. 用载荷里的依赖真跑一遍：sharp / HEIC 解码（含 ICC 色彩修复）/ mp4box / exifr / ffmpeg
2. 用打包好的启动器真的拉起一次服务，探测 `/api/cache`、`/api/source`、`/api/library/summary`、`/api/health`
3. 安装载荷解压自检：解出来的字节数必须和源文件总和一致（否则安装出来的东西是残缺的）
4. 给四个 exe 做代码签名（启动器、文件夹选择工具、卸载器、安装包）

## 2. 代码签名

`tools/sign.js` + `tools/sign.ps1`（用系统自带的 `Set-AuthenticodeSignature`，不需要 Windows SDK 的 signtool）。

证书按这个顺序找：

| 来源 | 怎么用 |
| --- | --- |
| `MY_ALBUM_SIGN_PFX` + `MY_ALBUM_SIGN_PASSWORD` | 你买的代码签名证书（.pfx）。**只有 CA 签发的证书才能消掉别人机器上的 SmartScreen 警告** |
| `MY_ALBUM_SIGN_THUMBPRINT` | 证书已经装在证书库里，按指纹找 |
| `build` 外的 `.signing\dev-cert.pfx`（默认） | 自动生成的自签证书，用来把签名流程跑通；只能证明"同源"，不受他人信任 |

```powershell
# 用正式证书打包
$env:MY_ALBUM_SIGN_PFX = "D:\certs\my-album.pfx"
$env:MY_ALBUM_SIGN_PASSWORD = "……"
$env:MY_ALBUM_SIGN_TIMESTAMP = "http://timestamp.digicert.com"   # 加时间戳，需要联网
pnpm pack
```

签名失败**不会**让打包中断（会打印是哪个文件、什么原因）；想强制成功就设
`MY_ALBUM_SIGN_REQUIRED=1` 或者用 `pnpm sign --required <文件>`。

怎么确认签上了（用户侧也能这么做）：

```powershell
Get-AuthenticodeSignature .\我的相册-2.0.0-安装包.exe | Format-List Status,SignerCertificate
```

`Status` 是 `Valid` 说明证书受信任；自签证书会显示 `UnknownError` +
"terminated in a root certificate which is not trusted"（签名在，但链不受信任 —— 正常）。

## 3. 安装程序是怎么做的

打包机器上不一定有 Inno Setup（也可能没网），所以安装程序是**自己写的**：

- 源码一份：`installer/setup/MyAlbumSetup.cs`，编译两次就得到两个 exe ——
  安装器（`安装包.exe`）和卸载器（`MyAlbumUninstall.exe`，`/define:UNINSTALL`），
  都只用 .NET Framework + 系统自带的 csc。
- 载荷格式（`tools/pack.js` 生成）：`MYALBUM1\n<条目数>\n<路径>\t<字节数>\n…\n\n`
  ＋「所有文件按顺序首尾相接、整段 raw deflate」。C# 那边顺序读一遍即可，只用一个 `DeflateStream`。
- 安装：选目录（默认 `%USERPROFILE%\AppData\Local\Programs\我的相册`）、可选桌面快捷方式、
  可选装完启动；建开始菜单项；写"程序和功能"里的卸载项（HKLM，需要管理员时写不进去会提示）。
- 卸载：先关掉正在跑的相册（按路径匹配进程），删快捷方式、删注册表项，
  最后用一个延时 `cmd rmdir` 把安装目录（含 `cache` / `data`）整个删掉
  —— 卸载器自己就在那个目录里，删不掉自己。
- 自动化参数：`/silent /dir=<路径> /noshortcuts /noregistry /nolaunch`，
  另外 `/noelevate`（安装时不提权）、`/notask`（不登记启动任务），卸载器有 `/noelevate`。
- **免 UAC 的管理员启动**：安装时登记一个"最高权限、没有触发器"的计划任务
  （登记需要管理员，所以安装程序会请求一次 UAC）；启动器不是管理员时用
  `schtasks /Run` 触发它 → 每次启动都是管理员身份，且**不再弹 UAC**。
  触发出来的实例带 `--via-task` 参数防止死循环；卸载时会删掉这个任务。

`installer/my-album.iss` 也保留着：装了 Inno Setup 6 之后 `pnpm pack:installer`
可以再产出一个 Inno 版安装包（两版并存，用来对比或分发）。

### 依赖树怎么来的（`pnpm pack` 的细节）

打包**不联网**：从现有 pnpm 布局按"生产依赖闭包"摊平成 `node_modules`（pnpm 的
`node_modules` 是符号链接结构，直接复制会在目标机上变成死链，所以这里按 realpath 搬真目录）。
只带生产依赖，平台专属的可选依赖（别的平台的 sharp 二进制等）解析不到就自动跳过。
之后还会做一次保守瘦身：删掉 source map、类型声明、示例目录，以及 libheif-js 里
我们用不到的两份构建（省约 11.6 MB）。

### Inno Setup 是可选的另一条路

我们自己的安装包已经够用；`installer/my-album.iss` 只是备选：装了 Inno Setup 6 之后
`pnpm pack:installer` 可以再产出一个 Inno 版安装包（两版并存，用来对比或分发）。
本机没装 ISCC 时会跳过并提示，也可以把 `ISCC_PATH` 指向 `ISCC.exe`。

### 安装包的设计（按用户要求定的）

- **按用户安装**：默认 `%LOCALAPPDATA%\Programs\我的相册`，不弹 UAC。
- **缓存 / 索引 / 设置全在安装目录里**：`<安装目录>\cache`、`<安装目录>\data`。
  装到 D 盘，缓存就跟着去 D 盘。前提是那个目录当前用户可写 ——
  如果用户手动改成 `C:\Program Files`，安装脚本会给这两个目录补写权限，
  服务端也还有一道兜底：**不可写就退到 `%LOCALAPPDATA%\我的相册` 并把这件事写进日志**。
- **附加功能只做一件事**：桌面快捷方式（没有开机自启）。
- **卸载时直接删掉 `cache\` 和 `data\`**。
- 无边框窗口：启动器用**你默认的那个浏览器**（Chrome 或 Edge）的 `--app=` 打开，
  没有地址栏和标签栏；默认浏览器不在候选里才依次退回 Edge / Chrome / 系统默认浏览器。
  **故意不用 `--user-data-dir` 开独立 profile** —— 那等于让浏览器以"全新用户"启动，
  Edge 会跑首次运行流程，窗口会长时间是空白的（用户实测撞上过这个坑）。
- **窗口一定会出现**：打开浏览器后启动器会问服务端 `/api/health`（`lastPageAt`）确认
  "页面真的被加载了"；没加载出来就退回普通浏览器窗口，再不行就**自己弹一个小窗**把地址摆出来
  （带"用默认浏览器打开 / 复制地址 / 打开缓存目录 / 退出"）。所以哪怕浏览器抽风，
  用户也不会面对"什么都没有"。
- 启动器：单实例（互斥体名字带安装目录哈希，不同副本互不干扰）、自动挑空闲端口、
  无控制台窗口，托盘菜单里有
  "打开相册（无边框窗口） / 用普通浏览器窗口打开 / 打开缓存目录 / 退出"。
  关掉浏览器窗口**不会**自动退出（浏览器可能和已经在跑的 Edge/Chrome 共用一个进程，
  没法可靠判断"我们那个窗口"关没关）—— 退出点托盘；再点一次快捷方式会把窗口重新打开。
- 排查问题看两个日志：`<安装目录>\cache\launcher.log`（启动器：参数、端口、浏览器命令行、
  页面有没有加载）和 `cache\server.log`（服务端）。
  **注意**：启动器必须写自己的日志文件 —— 它往 `server.log` 里写会被 node 那边的追加写拒绝
  （.NET 的 `File.AppendAllText` 默认只共享读），异常一吞就什么都看不到（踩过这个坑）。
- 命令行参数：`--check`（自检）、`--no-browser`（只起服务）、`--plain`（不开无边框窗口）。

## 4. 发布到 GitHub

### 4.1 创建空仓库

1. 登录 GitHub，点击右上角 **+ → New repository**。
2. 仓库名填 `my-album`，也可以换成你喜欢的名字。
3. **不要**勾选 “Add a README file”“Add .gitignore”“Choose a license”，避免和本地文件冲突。
4. 点击 **Create repository**。

### 4.2 上传源码

仓库根目录就是本地的 `2.0\` 目录（它已经干净：`node_modules`、`build`、`cache`、`data`、
`test-runtime`、`成品`、`release`、`.signing` 都在 `.gitignore` 里）。
把下面的 `YOUR_NAME` 换成你的 GitHub 用户名：

```bash
cd 2.0
git init
git add .
git commit -m "我的相册 2.0.0"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/my-album.git
git push -u origin main
```

第一次推送可能会要求登录。GitHub 不接受账号密码，推荐 `gh auth login`，
或使用 Git Credential Manager 弹出的浏览器登录。

不想用命令行也可以在仓库页面选 **Add file → Upload files**，
注意要包含 `.github`、`.gitignore`、`.gitattributes` 这些隐藏文件。

### 4.3 打 tag 与 Release（发布件是三个附件）

发布件在本机生成（`pnpm pack` + `pnpm release`），产物全在 `release\v<版本>\`：

| 文件 | 是什么 |
| --- | --- |
| `我的相册-<版本>-安装包.exe` | 安装程序（已签名，67 MB 左右） |
| `我的相册-<版本>-免安装版.zip` | 解压即用 |
| `我的相册-<版本>-源码.zip` | 源码（不含依赖和构建产物） |
| `SHA256SUMS.txt` | 三个附件的校验和 |
| `RELEASE-NOTES.md` | 直接当 Release 正文 |
| `PUSH-TO-GITHUB.md` | 照抄就能用的上传命令 |

用 GitHub CLI（推荐）：

```bash
git tag v2.0.0
git push origin v2.0.0

gh release create v2.0.0 \
  --title "我的相册 2.0.0" \
  --notes-file release/v2.0.0/RELEASE-NOTES.md \
  release/v2.0.0/我的相册-2.0.0-安装包.exe \
  release/v2.0.0/我的相册-2.0.0-免安装版.zip \
  release/v2.0.0/我的相册-2.0.0-源码.zip \
  release/v2.0.0/SHA256SUMS.txt
```

没有 gh 就手动：仓库页面 → Releases → Draft a new release → 选 tag → 贴 Release 说明 →
把上面几个文件拖进附件区 → Publish。

`.github/workflows/release.yml` 在推 `v*` tag 时还会跑一遍构建，并把一个源码压缩包
作为 workflow 产物留下（它**不会**自己建 Release，附件以上面手动上传的为准）。

### 4.4 发布前建议检查

- 仓库里没有 `node_modules/`、`data/`、`cache/`、`test-runtime/`、`build/`、`.signing/`
  （尤其 `.signing\dev-cert.pfx` **带私钥**，绝不能提交）
- 仓库里没有自己的照片或 `library-index.json`（`data/settings.json` 会暴露照片目录路径）
- `package.json` 的版本和 tag 一致（`pnpm release` 就是按这个版本号命名的）
- 本地 `pnpm check`、`pnpm test`、`pnpm pack:test` 都通过
- 附件里的安装包能装上、能启动（`pnpm pack:test` 会验一遍）
- README 里的版本号与 Release 一致

### 4.5 下个版本怎么发布

1. 改 `package.json` 的 `version`
2. 更新 `CHANGELOG.md`
3. `pnpm pack`（编译 + 自检 + 签名）→ `pnpm release`（整理附件）
4. 重复 4.2/4.3：提交推送、打 tag、建 Release

## 常见问题

### 推送时提示 authentication failed

GitHub 不再接受账号密码。使用 `gh auth login`、Git Credential Manager，或 Personal Access Token。

### GitHub Actions 失败

先看 Actions 日志。常见原因是 `pnpm-lock.yaml` 和 `package.json` 不一致，本地先确认：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:geometry
pnpm test:stream
```

（`pnpm test:dom` 需要先在 `test-runtime/` 里装 jsdom，CI 里默认不跑。）

### 别人怎么用我发布的东西

两种都行：

- **安装包**：双击 `我的相册-<版本>-安装包.exe`，按提示装到
  `%LOCALAPPDATA%\Programs\我的相册`（可以改盘符），装完双击桌面快捷方式即可。
  目标机器**不需要装 Node**（包里自带）。
- **源码**：需要有 Node.js 20.8+，下载源码后执行一次
  `pnpm install --node-linker=hoisted`，然后双击 `start-web.bat`（或 `pnpm start`），
  浏览器打开 `http://localhost:3000`。

### 独立程序是怎么做的（不再用 Electron）

2.0 不走 Electron，改成一个**自带的 Node 运行时 + 一个 C# 小启动器**：
启动器（`installer\launcher\MyAlbum.cs`，用 .NET Framework 自带的 csc 编译）负责
单实例、挑空闲端口、无控制台拉起 `runtime\node.exe app\server.js`，再用 Edge/Chrome 的
`--app=` 开一个无边框窗口，并带托盘图标。这样目标机器什么都不用预装
（Win10/11 自带 Edge 和 .NET Framework）。安装包用 Inno Setup 做，见上面第 1 节。