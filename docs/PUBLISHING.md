# 发布到 GitHub

这份说明对应仓库根目录的源码，以及仓库外的 `release/` 安装包。

## 1. 创建空仓库

1. 登录 GitHub，点击右上角 **+ → New repository**。
2. 仓库名填 `my-album`，也可以换成你喜欢的名字。
3. **不要**勾选 “Add a README file”“Add .gitignore”“Choose a license”，避免和本地文件冲突。
4. 点击 **Create repository**。

## 2. 上传源码

推荐在本机 `my-album` 目录用 Git 上传。把下面的 `YOUR_NAME` 换成你的 GitHub 用户名：

```bash
cd my-album
git init
git add .
git commit -m "Initial release v1.11.0"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/my-album.git
git push -u origin main
```

第一次推送可能会要求登录。GitHub 不接受账号密码，推荐：

```bash
gh auth login
```

或者使用 Git Credential Manager 弹出的浏览器登录。也可以创建 Personal Access Token，把 token 当作 HTTPS 密码使用。

如果不想用命令行，也可以在 GitHub 仓库页面选择 **Add file → Upload files**，把 `my-album` 里的内容拖进去，然后提交。注意要包含 `.github`、`.gitignore`、`.gitattributes` 这些隐藏文件。

## 3. 上传安装包到 Releases

安装包不要提交进 Git 仓库。GitHub 普通文件限制约 100 MB，而安装包约 185 MB，必须放到 Releases。

### 方法 A：网页上传

1. 打开仓库页面，点击右侧 **Releases → Draft a new release**。
2. Tag 选择或输入 `v1.11.0`。
3. Release title 填 `我的相册 1.11.0`。
4. 把 `release/我的相册-1.11.0-安装包.exe` 拖到附件区域。
5. 可以把 `release/SHA256.txt` 一起上传。
6. 点击 **Publish release**。

README 里的“下载最新安装包”会指向 `releases/latest`，发布后自动生效。

### 方法 B：GitHub CLI

```bash
gh release create v1.11.0 \
  "release/我的相册-1.11.0-安装包.exe" \
  "release/SHA256.txt" \
  --title "我的相册 1.11.0" \
  --notes-file "release/RELEASE_NOTES.md"
```

### 方法 C：让 Actions 自动构建

仓库已包含 `.github/workflows/release.yml`。推送 tag 后，Windows runner 会安装依赖、执行 `pnpm dist`，并把生成的 `.exe` 自动挂到 Release：

```bash
git tag v1.11.0
git push origin v1.11.0
```

可以在仓库的 **Actions** 页面查看构建日志。如果自动构建失败，使用上面的方法 A 或 B 手动上传已经生成的安装包即可。

## 4. 发布前建议检查

- 仓库里没有 `node_modules/`、`data/`、`cache/`、`dist/`、`release/`
- 仓库里没有自己的照片或 `library-index.json`
- `package.json` 的版本和 tag 一致
- 安装包能在本机双击安装并打开
- 安装包和 `SHA256.txt` 已上传到 Release
- README 中的版本号和 Release 一致

## 5. 下个版本怎么发布

1. 修改 `package.json` 的 `version`。
2. 更新 `CHANGELOG.md`。
3. 提交并推送：

```bash
git add .
git commit -m "Release v1.12.0"
git push
git tag v1.12.0
git push origin v1.12.0
```

GitHub Actions 会自动构建新的安装包。也可以手动运行 `pnpm dist` 后上传到新的 Release。

## 常见问题

### 推送时提示 authentication failed

GitHub 不再接受账号密码。使用 `gh auth login`、Git Credential Manager，或 Personal Access Token。

### GitHub Actions 构建失败

先看 Actions 日志。常见原因：

- `pnpm-lock.yaml` 和 `package.json` 不一致
- Electron 运行时没有下载
- NSIS 下载被网络拦截

本地先执行以下命令确认能构建：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm dist
```

### 安装包提示未知发布者

安装包没有商业代码签名证书，这是正常提示。需要消除提示只能购买 Windows 代码签名证书，并在构建环境配置签名。

### 可以把安装包直接放进仓库吗

不建议。安装包约 185 MB，超过 GitHub 普通文件限制，而且会让每次 clone 都变慢。请使用 Releases。
