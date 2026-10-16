# 实施阶段

## 阶段一：远端构建与交付骨架

当前阶段建立 Tauri 2 客户端的三端 GitHub Actions 构建流程和交付说明。工作流在 `codex/stage-*` 分支推送、Pull Request 和手动 dispatch 时运行。手动参数可选 `desktop`（默认）、`android`、`all`。构建结果上传为带版本、平台和架构名称的 Actions artifacts，不自动发布 Release。

阶段一目标产物：

- Windows 10/11 x64 NSIS 安装程序，携带离线 WebView2 Runtime。
- macOS 12+ Intel 与 Apple Silicon 两份 ad-hoc DMG。
- Android 10+ ARM64 release APK，必须由固定 keystore 签名。

push 与 Pull Request 会运行 Android debug 编译检查，但不会上传 debug APK；签名 release APK 只在手动选择 `android` 或 `all` 且已配置完整签名 secrets 时构建。debug 编译检查不代表已生成或验收可分发的安装包。

应用固定访问 `http://mint:3000`，Android 网络安全配置只对主机名 `mint` 开放明文流量。Android 工程由 CI 执行 `tauri android init --ci` 生成，再由 `scripts/prepare-android.mjs` 修改 manifest 与 Gradle 签名配置。Android `versionCode` 明确放在 `src-tauri/tauri.conf.json` 的 `bundle.android.versionCode`，当前从 `1` 开始。

依赖锁文件按以下方式引导：已有 `package-lock.json` 与 `src-tauri/Cargo.lock` 时直接使用，不改写；推送分支或手动运行时若有缺失，只生成并提交缺少的锁文件，后续 jobs checkout 该提交 SHA。缺锁的 Pull Request 会失败并提示先推送分支触发引导，不会向 PR 或 fork 写入。各构建 job 先用锁文件安装 npm 依赖和 `cargo fetch --locked` 获取 Rust 依赖，再以 Cargo 离线模式构建，避免解析新的版本。桌面构建不受 Android secrets 影响。

**CI 成功只表示对应 runner 完成构建并产生产物。** 它不证明安装、网络解析、登录、升级或设备兼容性已经通过真实机器验收。验收项见[验收清单](ACCEPTANCE.md)。

## 后续阶段

以下均未纳入阶段一：

- 阶段二：Windows、macOS 与 Android 实机安装、网络和主要交互验收，按验收结果修正兼容性问题。
- 阶段三：完善版本发布流程与手动分发材料；Android versionCode 在每次版本升级时显式递增。
- 后续评估：HTTPS、自定义服务地址、后台通知与自动更新。启动这些工作前需单独定义服务端及安全要求。
- 后续评估：Windows/macOS 正式商业签名。阶段一不购买或配置 Apple Developer ID、公证或 Windows 付费代码签名证书。
