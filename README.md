# Open WebUI Client

Open WebUI Client 是一个以 Tauri 2 打包的轻量客户端，初版通过固定地址 `http://mint:3000` 访问现有 Open WebUI 服务。它不修改 Open WebUI 官方前端或后端，也不包含服务端。

## 首版支持

- Windows 10/11 x64：NSIS `setup.exe`，安装包包含离线 WebView2 Runtime。
- macOS 12 及以上 Apple Silicon：生成 ad-hoc 签名 DMG。
- Android 10 及以上 ARM64：使用仓库固定 keystore 签名的 release APK。

Windows 和 macOS 构建不依赖 Android 签名 secrets。CI 只在 Actions 中构建并保存 artifacts，不创建 GitHub Release，也不代表安装包已在真实设备上验收。详见[阶段说明](docs/IMPLEMENTATION_STAGES.md)、[验收清单](docs/ACCEPTANCE.md)和[Actions 配置](docs/GITHUB_ACTIONS.md)。

## 服务连接

首版只连接 `http://mint:3000`。设备必须能解析主机名 `mint` 并访问其 3000 端口。Android 通过网络安全配置只允许域名 `mint` 使用明文 HTTP；桌面版也固定为该地址。

首版不支持 HTTPS 配置、后台通知或自动更新。macOS 包没有 Apple Developer ID 签名与公证；首次打开可能需要用户在系统安全设置中允许。push/Pull Request 中的 Android debug APK 只用于编译检查，不上传为交付产物；Android release 包必须使用项目维护者管理的固定签名密钥。

## 版本

应用版本以 `src-tauri/tauri.conf.json` 中的 `version` 为准；Android `versionCode` 使用同一配置中的 `bundle.android.versionCode`，初始值为 `1`。每次发布新 Android 版本时必须显式递增 versionCode。Actions artifact 文件名包含应用版本和平台架构。

## 构建

构建通过 GitHub Actions 的 **Build desktop and Android packages** 运行。手动触发默认选择 `desktop`，无需 Android secrets；选择 `android` 或 `all` 时，仓库必须已配置固定 keystore 的签名 secrets。产物只保留为 Actions artifacts，需由维护者手动下载、审核和分发。

首次使用前，需先将包含该 workflow 的功能 PR 合并到默认分支 `main`；合并前的分支推送/检查用于验证 CI 构建。workflow 合并到 `main` 后，才能从 Actions 页面手动选择并运行。正式 Android APK 应在 workflow 已合并且签名 secrets 已配置后手动选择 `android` 或 `all`。
