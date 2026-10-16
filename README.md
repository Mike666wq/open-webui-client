# Open WebUI Client

Open WebUI Client 是一个用 Tauri 2 打包的轻量客户端。它直接连接用户现有的 Open WebUI 服务，不修改官方前后端，也不包含服务端。

首版交付目标为 Windows 10/11 x64 NSIS 安装程序（包含离线 WebView2 Runtime）、macOS 12 及以上 Apple Silicon ad-hoc DMG，以及 Android 10 及以上 ARM64 release APK（固定 keystore 签名）。macOS 包没有 Developer ID 签名或公证。

GitHub Actions 负责构建并保存 artifacts，不自动发布 GitHub Release。CI 成功表示 runner 完成了构建，不代表已在真实设备完成安装、连接或交互验收。请查看[实施阶段](docs/IMPLEMENTATION_STAGES.md)、[验收清单](docs/ACCEPTANCE.md)和[Actions 构建说明](docs/GITHUB_ACTIONS.md)。

## 连接服务

应用提供本地连接设置页。默认地址为 `http://192.168.31.60:3000`，用户可以改为自己的 HTTP 或 HTTPS IP、域名、子域名、端口和根路径。首次启动时输入地址并连接；成功后应用保存该地址并在后续启动时自动连接。连接失败时最多等待 30 秒，然后回到设置页并保留本次输入；失败地址不会覆盖上次成功保存的地址。连接后不显示常驻工具栏。

HTTP 是明文连接，适合可信任的局域网。Android 网络安全配置允许应用访问任意 HTTP host/IP。macOS 仅声明 `NSAllowsLocalNetworking`：Apple 将其定义为允许 IP 地址、未限定域名和 `.local` 域名；它不对任意公网 DNS 域名开放 HTTP。macOS 12+ 上，用户配置的 IP 地址可用于局域网 HTTP；公网域名的 HTTP 可能被 ATS 拒绝，需使用符合系统 ATS 与证书信任要求的 HTTPS。应用不关闭 WKWebView 的广泛 ATS 限制，也不忽略无效 HTTPS 证书。

Android 系统返回键在服务页面时回到本地连接设置页，在设置页时退出应用。Windows 和 macOS 提供原生菜单及 `Ctrl+L` / `⌘L` 快捷键进入设置。

首版不提供后台通知、自动更新或正式桌面付费签名。Android push/PR 中的 debug 编译仅验证构建，不上传为交付 APK；release APK 必须使用维护者管理的固定 keystore。

## 版本

应用版本在 `src-tauri/tauri.conf.json` 中维护，Android `versionCode` 使用同文件 `bundle.android.versionCode`。阶段二版本为 `0.2.0`、`versionCode` 为 `2`。每次发布 Android 更新时必须显式递增 `versionCode`，保证已有安装可以正常升级。

## 构建

构建在 GitHub Actions 的 **Build desktop and Android packages** 中运行。手动触发默认选择 `desktop`，无需 Android 签名 secrets；选择 `android` 或 `all` 时需要仓库配置完整签名 secrets。产物保留为 Actions artifacts，由维护者手动下载、审核和分发。

首次使用前，需先将包含该 workflow 的功能 PR 合并到默认分支 `main`；合并前的分支推送和 PR 用于 CI 验证。workflow 合并到 `main` 后，才能从 Actions 页面手动选择目标并运行。正式 Android APK 应在 workflow 已合并且签名 secrets 已配置后手动选择 `android` 或 `all`。
