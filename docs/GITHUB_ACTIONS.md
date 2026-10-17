# GitHub Actions 构建

构建工作流位于 `.github/workflows/build.yml`，签名密钥初始化位于 `.github/workflows/bootstrap-android-keystore.yml`。构建工作流在 `codex/stage-*` 分支 push、Pull Request 与手动 dispatch 时运行。手动参数 `targets` 可选 `desktop`（默认）、`android`、`all`。只有从 `main` 手动选择 `android` 或 `all` 才运行签名 APK job；其它 push/PR 只运行 Android debug 编译检查，不上传 APK。所有构建都在 GitHub-hosted runners 上执行，维护者的 Windows 电脑无需安装编译工具或 JDK。

GitHub Actions 的手动 `Run workflow` 入口要求 workflow 已存在于默认分支。因此首次使用时，先合并包含该文件的功能 PR 到 `main`；合并前的分支推送和 PR 检查用于 CI 验证。正式 Android APK 需 workflow 已合并且四项签名 secrets 已配置，然后手动选择 `android` 或 `all`。

## 固定构建环境

- Node.js `22.22.0`，通过 `npm ci` 按锁文件安装。
- Rust `1.94.0`，Cargo 使用仓库的 `src-tauri/Cargo.lock`。
- Windows：`windows-2025`，x64 NSIS 安装程序。
- macOS Apple Silicon ARM64：`macos-15`，ad-hoc DMG。
- Android：`ubuntu-22.04`、Temurin JDK 25、Android SDK Platform 36、Build Tools 36.0.0、NDK 28.2.13676358，以及 Rust target `aarch64-linux-android`。Tauri CLI 2.12.2 模板声明 compileSdk/targetSdk 37；当前 workflow 将它们定向设为 36，应用 minSdk 仍为 29。模板生成的 Gradle wrapper、AGP 和 Kotlin 版本保持不变。

独立 `quality` job 在 Ubuntu runner 上运行 Node tests、`npm run version:check`、Rust 格式检查，并用 JDK 25 和临时随机密码生成及验证一个临时 PKCS#12 测试 keystore；临时目录会删除，测试密钥不会上传或用于发行。平台构建不依赖该 job，便于同一轮并行收集实际编译结果。macOS ARM64 DMG 构建完成后，在同一个 `aarch64-apple-darwin` release target 下运行 Rust library unit tests，复用此前构建的依赖缓存；其它平台不重复跑相同 Rust 单测。每个平台保留自己的 `npm ci` 以便执行真实前端/原生构建。

Android 工程由 CI 使用 `tauri android init --ci` 生成，随后加载本地 `connection-controls` 插件和网络配置。`scripts/prepare-android.mjs` 调整 SDK level、明文网络策略和 release 签名。源码中的 `version` 维持为 `0.2.0`，`bundle.android.versionCode` 为 debug 占位 `2`。稳定语义版本由 `scripts/manage-version.mjs` 同步维护；运行 `npm run version:check` 检查所有载体，使用 `node scripts/manage-version.mjs bump patch`（或 `minor`、`major`、明确的 `X.Y.Z`）准备递增版本。

## 锁文件引导

`prepare-lockfile` job 负责选定后续 jobs 使用的源码 SHA。PR 与非 `codex/stage-*` 分支只验证两份锁文件存在，并使用当前 SHA；缺锁时失败，不写入 PR、fork 或 `main`。受信任的 `codex/stage-*` 分支 push 或手动分支运行会在 registry 解析后更新 `package-lock.json`，运行 `cargo update --workspace`，并使用固定 Rust 1.94 `rustfmt` 格式化 app 与插件的 Rust workspace。它只提交两份锁文件以及由 formatter 修改的 tracked `src-tauri/**/*.rs` 文件，随后将新 SHA 传给所有构建 jobs。非 workspace Cargo 依赖保持其现有锁定版本，除非 manifest 需要解析新的依赖。

只有构建锁文件引导 job 获得 `contents: write`；其它构建 jobs 只有读取权限。引导只对 `codex/stage-*` ref 写入。后续 jobs checkout 确切 SHA，运行 `npm ci`、`cargo fetch --locked`，然后在 Cargo 离线模式下构建并检查 `Cargo.lock` 未变化。引导使用非强制 `git push`；若远端分支已变化则失败，避免覆盖新提交。

## 构建矩阵与 Android 签名

Windows x64 与 macOS ARM64 各自独立生成 NSIS `setup.exe` 和 ad-hoc DMG。PR/push 的 Android ARM64 job 只编译 debug APK 以验证 Gradle/Rust 集成，不上传 debug APK。只有 `main` 上的手动 `workflow_dispatch` 选择 `android` 或 `all` 才运行签名 release APK job；缺少任一签名 secret 时该 job 明确失败，桌面 jobs 不受影响。release job 通过 `versionCodeFromRunNumber(github.run_number)` 计算 `1000 + run_number`，并拒绝超过 `2,100,000,000` 的结果。相同 run 的重跑保持相同 versionCode；每次新的 run 取得更高代码。versionCode 仅作为 release 生成 Gradle `defaultConfig` 的值传入，源码 Tauri 配置的 debug 值仍是 `2`。签名 APK 文件名、artifact 名称和 job summary 都包含 `vc<versionCode>`。

GitHub Actions secrets 名称如下：

- `ANDROID_KEYSTORE_BASE64`：固定 keystore 文件的 Base64 内容。
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码。
- `ANDROID_KEY_ALIAS`：密钥别名。
- `ANDROID_KEY_PASSWORD`：密钥密码。

keystore 仅写入 runner 临时目录；密码通过所需步骤的环境变量传给 Gradle，不放在命令行中。不要轮换签名密钥，否则已有 Android 安装不能通过普通升级安装新版本。

## 首次生成与导入签名密钥

首次生成只需在仓库设置页添加 `ANDROID_KEYSTORE_PASSWORD` secret，然后在 Actions 中从 `main` 手动运行 **Initialize Android release keystore**。密码应由密码管理器生成，至少 32 个随机字符；不要将密码发到聊天、issue、日志或仓库。workflow 检查 `ANDROID_KEYSTORE_BASE64` 仍为空，否则拒绝生成，以防覆盖已有签名身份；同一次 workflow run 的 rerun 也会被拒绝，避免生成多把身份不同的 key。它在 JDK 25 runner 上通过 `scripts/generate-android-keystore.mjs` 创建 RSA 3072 位、固定 alias `openwebui-client`、密码保护的 PKCS#12 文件，并输出 SHA-256 证书指纹。keystore 密码和 key password 使用相同的 secret。

workflow 上传 p12 与指纹 artifact，保留一天。artifact 对有权访问仓库的人可见，**artifact 本身不是私密存储**；只有 p12 文件本身由强密码保护。运行成功后立即下载 p12，在个人安全位置备份，再从 Actions 删除该 artifact 和初始化 run。保留离线备份与密码；丢失签名密钥或密码后，已有 Android 安装不能通过普通升级迁移到新密钥。

在 Windows 上解压下载的 `openwebui-client.p12` 到私密目录后，用 PowerShell 将其 Base64 放入剪贴板，不要把输出贴入聊天或终端记录：

```powershell
$p12Path = (Resolve-Path '.\openwebui-client.p12').Path
$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p12Path))
Set-Clipboard -Value $base64
$base64 = $null
```

在仓库 **Settings → Secrets and variables → Actions** 新增剩余三个 repository secrets：

- `ANDROID_KEYSTORE_BASE64`：粘贴剪贴板中的 Base64；
- `ANDROID_KEY_ALIAS`：`openwebui-client`；
- `ANDROID_KEY_PASSWORD`：与已设置的 `ANDROID_KEYSTORE_PASSWORD` 相同。

设置完成后清空剪贴板。随后在 Actions 页面选择 `main` 分支，手动运行 **Build desktop and Android packages**，targets 选 `android` 或 `all`。签名 artifact 仅保存于 Actions，维护者手动下载、验证指纹并分发；workflow 不创建 Release、不自动发布或更新应用。

版本 run number 以 `.github/workflows/build.yml` 的 GitHub workflow 身份为基准。不要通过重命名或替换该 workflow 来重置计数；若未来必须换 workflow 文件路径，应先设计大于历史最高 versionCode 的新基线，并验证已安装版本仍可升级。

## 运行时设置与网络

本地连接页默认使用 `http://192.168.31.60:3000`，也允许运行时配置任意 HTTP/HTTPS IP、域名、子域名、端口和根路径。连接成功后保存为最近成功地址并在启动时自动连接；最多等待 30 秒失败后回设置页，保留候选输入且不覆盖已保存的成功地址。

Android NSC 的 base-config 允许应用发起任意 HTTP 请求，以支持用户配置的 host/IP。系统证书 trust anchors 保留；HTTPS 证书验证仍使用 Android WebView 默认平台策略。HTTP 不加密，适用于可信网络。macOS `Info.plist` 只设置 `NSAllowsLocalNetworking`，不设置 `NSAllowsArbitraryLoadsInWebContent` 或全局 arbitrary-loads 例外。Apple 将 local networking 定义为 IP 地址（IPv4/IPv6）、未限定域名及 `.local` 域名；公开的 DNS 域名不在此例外内，因此其 HTTP 加载仍可能被 ATS 拒绝。Apple 文档说明 macOS 14+ 默认不再放行 IP 地址，设置 `NSAllowsLocalNetworking` 可为这些地址声明所需访问；该键未限定私网 IP 范围，不能描述为“仅允许局域网地址”。HTTPS 仍受平台 TLS/server-trust 检查，应用不提供无效证书回退。macOS 的实际 HTTP 可用性与 ATS 规则、系统版本及地址形式有关；Android 的任意 HTTP 支持不等于 macOS 对任意 host 的 HTTP 支持。

Android 原生返回插件在远程服务页面直接导航到本地 bundled settings origin，在 settings 页直接结束 Activity；不依赖远程 JS listener 或浏览历史。Windows/macOS 通过 Tauri 原生菜单和 `CmdOrCtrl+L` 返回本地设置页。

这些源码改动的 GitHub 构建与真实设备验收仍待完成。CI 构建成功只证明 runner 产出对应构建文件，不表示连接、登录、返回键或证书策略已在目标设备验收。设备检查要求见[验收清单](ACCEPTANCE.md)。

## 产物与官方依据

每个 job 上传的 artifact 按系统与架构区分，文件名包含应用版本；没有匹配到预期产物时 job 会失败。工作流不创建 tag、Release 或商店发布，也不执行自动更新。

- [Tauri CLI Android 命令](https://tauri.app/reference/cli/)：`android init --ci` 与 Android build 参数。
- [Tauri Android 发布文档](https://tauri.app/distribute/google-play/)：APK、ABI 构建及 `versionCode`。
- [Tauri 系统前置条件](https://v2.tauri.app/start/prerequisites/)：Android SDK、NDK、JDK 与 Rust targets。
- [Tauri GitHub Actions 指南](https://v2.tauri.app/distribute/pipelines/github/)：多平台 CI 建议。
- [Tauri CLI 2.12.2 Android Gradle 模板](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/templates/mobile/android/app/build.gradle.kts)：compileSdk/targetSdk 37。
- [Tauri Android 插件开发](https://v2.tauri.app/develop/plugins/develop-mobile/)：原生 Kotlin 插件与移动端生命周期。
- [Tauri app API](https://v2.tauri.app/reference/javascript/api/namespaceapp/)：Android back-button API。
- [Tauri window menu](https://v2.tauri.app/learn/window-menu/)：原生菜单和快捷键。
- [Android Network Security Configuration](https://developer.android.com/privacy-and-security/security-config)：明文流量、域名及系统证书信任设置。
- [Apple NSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)：允许的 IP、未限定域名和 `.local` 范围及系统版本差异。
- [Apple NSAllowsArbitraryLoadsInWebContent](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloadsinwebcontent)：此键会对 WebView 请求禁用 ATS 限制，本项目不设置该例外。
- [Apple NSAppTransportSecurity](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity)：ATS 对 HTTP、TLS 和例外范围的说明。
- [GitHub-hosted runner images](https://github.com/actions/runner-images)：固定 runner 标签。
