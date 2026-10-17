# Open WebUI Client

Open WebUI Client 是一个用 Tauri 2 打包的轻量客户端。它直接连接用户现有的 Open WebUI 服务，不修改官方前后端，也不包含服务端。

首版交付目标为 Windows 10/11 x64 NSIS 安装程序（包含离线 WebView2 Runtime）、macOS 12 及以上 Apple Silicon ad-hoc DMG，以及 Android 10 及以上 ARM64 release APK（固定 keystore 签名）。macOS 包没有 Developer ID 签名或公证。

GitHub Actions 在 `main` 上执行质量检查；手动发版时先自动递增 patch 版本并提交到 `main`，再以同一源码 SHA 构建三端。API 29/36 Android 模拟器检查与三个平台构建全部成功后，才创建 tag、上传安装包和 SHA-256 校验文件并公开 GitHub Release。请从[最新 Release](https://github.com/Mike666wq/open-webui-client/releases/latest)下载当前版本。CI 与下载校验通过仍不代表真实设备验收通过。请查看[实施阶段](docs/IMPLEMENTATION_STAGES.md)、[验收清单](docs/ACCEPTANCE.md)和[Actions 构建说明](docs/GITHUB_ACTIONS.md)。

应用图标已统一为 Open WebUI 官方素材；Windows、macOS 与 Android 最终包图标验证仍待最新 CI 运行确认。已知 Redmi 设备有启动后约 10 秒内退出的报告，原因尚未确认，当前代码尚未标记为修复。

## 连接服务

应用提供本地连接设置页。默认地址为 `http://192.168.31.60:3000`，用户可以改为自己的 HTTP 或 HTTPS IP、域名、子域名、端口和根路径。首次启动时输入地址并连接；成功后应用保存该地址并在后续启动时自动连接。连接失败时最多等待 30 秒，然后回到设置页并保留本次输入；失败地址不会覆盖上次成功保存的地址。连接后不显示常驻工具栏。

HTTP 是明文连接，适合可信任的局域网。Android 网络安全配置允许应用访问任意 HTTP host/IP。macOS 仅声明 `NSAllowsLocalNetworking`：Apple 将其定义为允许 IP 地址、未限定域名和 `.local` 域名；它不对任意公网 DNS 域名开放 HTTP。macOS 12+ 上，用户配置的 IP 地址可用于局域网 HTTP；公网域名的 HTTP 可能被 ATS 拒绝，需使用符合系统 ATS 与证书信任要求的 HTTPS。应用不关闭 WKWebView 的广泛 ATS 限制，也不忽略无效 HTTPS 证书。

Android 系统返回键在服务页面时回到本地连接设置页，在设置页时退出应用。Windows 和 macOS 提供原生菜单及 `Ctrl+L` / `⌘L` 快捷键进入设置。

### 首次连接与保存

首次启动时，在连接页确认或修改默认地址，点连接；只有服务成功打开后，这个地址才会保存并用于下次启动。连接失败会回到设置页，输入内容保留，可修正地址后重试。桌面按 Windows/Linux `Ctrl+L` 或 macOS `⌘L` 随时返回设置；Android 在远程页面按系统返回键回到设置，再按一次退出应用。

页面中的明确下载会交给应用保存流程处理。普通图片、媒体预览、没有下载属性的链接，以及同源内部链接继续在 WebView 中打开，不会因为预览而误弹保存对话框。Android 选择保存位置时使用系统文件选择器；文件 URI 和路径不会交给网页脚本。不同设备和文件 provider 的实际保存、取消与清理结果仍待真机验收。

首版不提供后台通知、自动更新或正式桌面付费签名。Android push/PR 中的 debug 编译仅验证构建，不上传为交付 APK；release APK 必须使用维护者管理的固定 keystore。

## 版本

每次发布时，稳定语义版本会同步写入 `package.json`、Cargo、Tauri 和两份锁文件；当前发布版本请查看[最新 Release](https://github.com/Mike666wq/open-webui-client/releases/latest)。运行 `npm run version:check` 检查一致性；准备新版本时使用 `node scripts/manage-version.mjs bump patch`（也支持 `minor`、`major` 或明确的递增 `X.Y.Z`）。源码中的 Android `versionCode` 为 debug 占位值 `2`。只有从 `main` 手动运行 Android release 时，CI 才将生成 Gradle 工程的 release `defaultConfig.versionCode` 设为 `1000 + github.run_number`；重跑同一 workflow run 使用同一代码，任何新 run 都递增。release APK 名称和 artifact 会包含该 versionCode。

## 构建

在 GitHub Actions 的 **Build desktop and Android packages** 页面选择 `main`，手动选择 `candidate` 或 `release`。`candidate` 不递增版本、不创建 tag 或 Release；它运行 API 29/36 模拟器检查，并提供三天后过期、由现有 Android keystore 签名的 ARM64 APK artifact，可在 Redmi 上覆盖安装现有固定签名版本。`release` 会自动递增 patch 并提交 `main`，之后质量检查、Windows NSIS、macOS ARM64 DMG 和 Android ARM64 签名 APK 都使用同一提交；Android versionCode 按 `1000 + github.run_number` 生成，只有所有门禁成功后才公开 Release。模拟器通过不能替代 Redmi 真机验收。main push 运行 Node/version、JDK keystore smoke、Rust formatting 质量检查和已合入旧 stage 分支的受限清理；触及 app 行为文件的 push 还会触发独立 Android emulator 诊断，不自动发版。Windows 安装包包含离线 WebView2 Runtime；macOS ad-hoc DMG 首次打开可能需要对该应用单独使用 Finder 的“按住 Control 键点按 → 打开”，不要全局关闭 Gatekeeper。

首次准备 Android 签名时，先在仓库添加高熵 `ANDROID_KEYSTORE_PASSWORD` secret，再从 `main` 手动运行 **Initialize Android release keystore**。下载一天后过期的密码保护 PKCS#12 artifact，私下备份，并立即删除该 artifact 和初始化 run；该 artifact 本身不是私密的。用 Windows PowerShell 将备份 keystore 编码到剪贴板，然后只需再设置 `ANDROID_KEYSTORE_BASE64` secret。固定别名是 `openwebui-client`，key password 复用 `ANDROID_KEYSTORE_PASSWORD`，不需要另外两个冗余 secret。不要把密码或 keystore 发到聊天或提交到仓库。初始化只需运行一次；已有 Base64 keystore 时 workflow 会拒绝重生成。

密钥初始化和签名发布步骤详见[构建与签名说明](docs/GITHUB_ACTIONS.md)。
