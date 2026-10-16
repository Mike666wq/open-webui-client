# GitHub Actions 构建

工作流位于 `.github/workflows/build.yml`。它在 `codex/stage-*` 分支 push、Pull Request 与手动 dispatch 时运行。手动参数 `targets` 可选 `desktop`（默认）、`android`、`all`。仓库无需本地 Windows 编译环境；所有编译都在 GitHub-hosted runners 上进行。

GitHub Actions 的手动 `Run workflow` 入口要求 workflow 文件已存在于默认分支。因此首次使用时，先合并包含该文件的功能 PR 到 `main`；合并前的分支推送/PR 检查用于验证 CI 构建。合并后在仓库 Actions 页面手动运行；正式 Android APK 需要在 `main` 已包含该 workflow 且四项 Android 签名 secrets 已配置后，选择 `android` 或 `all`。

## 固定构建环境

- Node.js `22.22.0`，使用 `npm ci` 严格按 `package-lock.json` 安装。
- Rust `1.94.0`，Cargo 使用仓库提交的 `src-tauri/Cargo.lock`。
- Windows：`windows-2025`，生成 x64 NSIS 安装程序。
- macOS Apple Silicon arm64：`macos-15`，生成一份 ad-hoc DMG。
- Android：`ubuntu-22.04`、Temurin JDK 25、Android SDK Platform 36、Build Tools 36.0.0、NDK 28.2.13676358，以及 Rust target `aarch64-linux-android`。Tauri CLI 2.12.2 模板默认 compile/target SDK 为 37、Gradle 9.6.1、AGP 9.3.1 和 Kotlin 2.2.10；目前 GitHub runner 的 SDK 仓库未提供 Platform 37，因此 `prepare-android.mjs` 将生成的 compileSdk/targetSdk 定向设为 36，minSdk 仍为 29。

如需升级工具版本，应选择已发布版本并在此记录。工作流将 Node、Rust、Android SDK、Build Tools 和 NDK 版本固定，避免构建环境随 runner 默认值静默变化。

## Cargo.lock 引导

`prepare-lockfile` job 负责选定构建源码 SHA。Pull Request 只验证锁文件存在并使用当前 SHA，缺锁时失败并提示先推送分支完成引导；它不会写入 PR 或 fork。push 或手动分支运行时，缺少 `package-lock.json` 才用 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` 生成；缺少 `Cargo.lock` 时生成，否则运行 `cargo update --workspace` 以让 Cargo.toml 的 workspace 依赖变更反映到锁文件。只有锁文件 diff 时才提交 `package-lock.json` 与 `src-tauri/Cargo.lock`，并将提交 SHA 传给后续构建 jobs。`git push` 是非强制推送；若远端分支已变化则引导失败，避免覆盖新提交。

只有该引导 job 获得 `contents: write`；桌面与 Android 构建 job 只有读取权限。构建 jobs checkout 锁文件所在的确切 SHA，先 `cargo fetch --locked`，再设为 Cargo 离线模式构建；构建后检查锁文件没有变化。不在 Windows 本地安装编译工具。

## Android 初始化与签名

Android job 执行 `npm run tauri -- android init --ci`，随后运行 `scripts/prepare-android.mjs`。脚本将 Android 网络安全配置限制在主机名 `mint`，关闭模板 debug build type 的全局明文流量开关，并令 release Gradle build type 在 keystore 环境变量存在时读取签名参数。PR/push 的 Android debug job 只验证构建，不上传 APK；签名 release APK 仅由手动 `android` 或 `all` 运行生成。

需要在 GitHub 仓库 Actions secrets 中配置：

- `ANDROID_KEYSTORE_BASE64`：固定 keystore 文件的 Base64 内容。
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码。
- `ANDROID_KEY_ALIAS`：密钥别名。
- `ANDROID_KEY_PASSWORD`：密钥密码。

密钥仅写入 runner 临时目录；密码通过环境变量传递，不放在命令行中。手动选择 Android release 构建时，缺少任一 secret 会让该 job 明确失败；PR/push 的 debug 编译检查不读取签名 secrets。桌面 jobs 不读取这些 secrets，仍可独立构建。不要轮换签名密钥，否则现有 Android 安装将无法通过普通升级安装新版本。

应用版本来自 `src-tauri/tauri.conf.json` 的 `version`。Android `versionCode` 使用同文件 `bundle.android.versionCode`；发布时需显式递增。

## 构建产物与边界

成功的 job 将构建文件上传为 Actions artifact，名称按系统和架构区分，内部文件名含应用版本。工作流对产物路径使用必需匹配检查；未找到预期文件时 job 失败。工作流不会创建 tag、Release 或商店发布，也不会自动更新用户安装。

Actions 成功只证明 CI runner 完成了构建。下载后仍需执行[真实设备验收](ACCEPTANCE.md)。macOS 配置 ad-hoc 身份 `-`，可能出现 Gatekeeper 首次运行提示；它不等同于 Apple Developer ID 签名或公证。

## 官方依据

- [Tauri CLI Android 命令](https://tauri.app/reference/cli/)：`android init --ci`、APK 构建和 Android target 参数。
- [Tauri Android 发布文档](https://tauri.app/distribute/google-play/)：`--apk`、按 ABI 构建及 `versionCode` 配置。
- [Tauri 系统前置条件](https://v2.tauri.app/start/prerequisites/)：Android SDK、NDK、JDK 环境变量和 Rust targets。
- [Tauri GitHub Actions 指南](https://v2.tauri.app/distribute/pipelines/github/)：多平台构建建议。
- [Tauri 2.12 发布说明](https://v2.tauri.app/blog/tauri-2.12/)：Android 模板 targetSdk 更新到 37。
- [Tauri CLI 2.12.2 Android Gradle 模板](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/templates/mobile/android/app/build.gradle.kts)：compileSdk/targetSdk 37；对应模板使用 Gradle 9.6.1、AGP 9.3.1 和 Kotlin 2.2.10。
- [Tauri macOS 签名说明](https://v2.tauri.app/distribute/sign/macos/)：ad-hoc 签名身份配置为 `-`。
- [GitHub-hosted runner images](https://github.com/actions/runner-images)：`macos-15` ARM64 runner 标签。