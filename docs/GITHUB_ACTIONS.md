# GitHub Actions 与正式发布

构建工作流位于 `.github/workflows/build.yml`，一次性 Android keystore 初始化位于 `.github/workflows/bootstrap-android-keystore.yml`。日常开发只在 `main` 上进行。main push 运行 Node tests、版本一致性、JDK 25 临时 PKCS#12 smoke test、Rust 格式检查，以及一个仅核对并删除四个指定且已合入旧 stage 分支的清理 job；它不会启动三端构建或发布安装包。工作流不接受可选平台输入。

在仓库 **Actions → Build desktop and Android packages → Run workflow** 中选择 `main` 并手动运行，开始一次正式发布。workflow 会先验证两项 Android signing secrets，然后将 stable semver patch 递增并通过 GitHub API non-force 地提交到 `main`。这个 run 的 quality 与 Windows、macOS、Android jobs 都 checkout 同一新提交 SHA。Windows x64 生成含离线 WebView2 Runtime 的 NSIS installer；macOS ARM64 生成 ad-hoc DMG 并运行 Rust library tests；Android 生成签名 ARM64 release APK。三端都成功后才创建不可移动的版本 tag、上传三个包和 `SHA256SUMS` 并公开 GitHub Release。未全部成功时不会公开 Release。手动 run 不会创建 PAT，也不运行自动更新。

## 首次配置 Android 签名密钥

签名身份必须长期固定，否则已安装的 Android 版本不能通过普通升级更新。只生成一把 keystore 并在仓库 Secrets 保存它；不要因为丢失 Base64 或设置错误而重新生成已有签名身份。

1. 在仓库 **Settings → Secrets and variables → Actions** 添加 `ANDROID_KEYSTORE_PASSWORD`。用密码管理器生成至少 32 个随机字符，并将密码安全备份。不要将密码发给 Codex、issue、聊天或日志。
2. 在 **Actions → Initialize Android release keystore → Run workflow** 中选择 `main`。该 workflow 在 GitHub Temurin JDK 25 runner 上使用固定别名 `openwebui-client` 生成 RSA 3072 位、密码保护的 PKCS#12。它检测到 `ANDROID_KEYSTORE_BASE64` 已设置时会拒绝重生成；同一 run 的 rerun 也会拒绝。
3. 下载一日后过期的 `android-keystore-...` artifact，将 `.p12` 放到个人安全位置备份，并核对 workflow summary 中的 SHA-256 证书指纹。artifact 对仓库有访问权限的人可见，所以它不是私密存储；只有 keystore 文件由强密码保护。下载并私下备份后，立即从 Actions 删除该 artifact 和初始化 run。
4. 在 PowerShell 中将备份文件编码到剪贴板。命令不会把 Base64 写到文件或输出到终端：

   ```powershell
   $p12Path = (Resolve-Path '.\openwebui-client.p12').Path
   $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p12Path))
   Set-Clipboard -Value $base64
   $base64 = $null
   ```

5. 在同一 Secrets 设置页添加 `ANDROID_KEYSTORE_BASE64`，粘贴剪贴板内容，然后清空剪贴板。首次配置最终只需要两项 Secrets：

   - `ANDROID_KEYSTORE_PASSWORD`：PKCS#12 store 密码，也用作 Android key password；
   - `ANDROID_KEYSTORE_BASE64`：固定 `.p12` 文件的 Base64 内容。

   别名始终为 `openwebui-client`，无需 `ANDROID_KEY_ALIAS` 或 `ANDROID_KEY_PASSWORD` secrets。workflow 不读取或输出 secret 值；手动发布前会校验 Base64 格式、密码、PKCS#12 文件及固定别名。Secrets 通过仓库 Settings UI 管理；不要将其写入代码、命令行历史、日志或对话。

## 版本、发布重试与下载

应用版本同步保存在 `package.json`、`package-lock.json`、Tauri 配置和 app Cargo 元数据中。发布 workflow 自动执行 patch bump 并将版本提交到 `main`；手工版本调整可运行 `npm run version:check` 验证。Android release `versionCode` 为 `1000 + github.run_number`，并限制在 Android 支持的上限内。相同 run 重试会复用原版本提交、tag 和 versionCode；新的手动 run 会再次递增 patch 与 run number。若构建失败，版本 bump commit 会留在 main，但不会发布 Release。修复问题后启动一个新的手动 run，它会使用下一个 patch 版本。

正式包通过 GitHub 仓库的 **Releases** 页面下载，release 含 Windows、macOS 和 Android ARM64 安装文件及 SHA-256 校验值。Actions artifacts 是构建过程中的临时材料，不是正式发布页面。workflow 只在全部平台成功后公开 Release；它不发布到应用商店、不启用自动更新，也不进行公开前的设备验收。

桌面签名状态保持不变：Windows NSIS 包包含离线 WebView2 Runtime；macOS DMG 仅 ad-hoc 签名，没有 Developer ID 签名或公证。首次打开 macOS 应用时只对该应用使用 Finder 的“按住 Control 键点按 → 打开”，不要全局关闭 Gatekeeper。当前 CI 不验证真实设备安装、连接或 Android SAF 文件保存行为；这些仍需按[验收清单](ACCEPTANCE.md)手动完成。

## 固定构建环境

- Node.js `22.22.0`，通过 `npm ci` 按锁文件安装；Rust `1.94.0`，Cargo 使用仓库 `src-tauri/Cargo.lock`。
- Windows：`windows-2025`，x64 NSIS installer。
- macOS：`macos-15`，Apple Silicon ARM64 ad-hoc DMG。
- Android：Ubuntu `22.04`、Temurin JDK `25`、Android Platform `36`、Build Tools `36.0.0`、NDK `28.2.13676358` 和 Rust target `aarch64-linux-android`。Tauri CLI 2.12.2 Android 模板的 compile/target SDK 值由 `scripts/prepare-android.mjs` 定向调整到 36；应用 minSdk 仍为 29。

`prepare-lockfile` 仅确认 `package-lock.json` 和 `src-tauri/Cargo.lock` 存在，并将当前 checkout SHA 固定给后续 jobs；它不会更新锁文件、运行 formatter 或提交代码。Android manifest、明文网络配置和 Gradle release 签名配置在 CI 生成工程后由 `scripts/prepare-android.mjs` 幂等准备；源码中的 debug versionCode 保持 `2`。签名 release job 才在生成 Gradle 项目中覆盖 `defaultConfig.versionCode`，并且会验证 APK 签名证书与固定 keystore 的 SHA-256 指纹一致、package ID、minSdk、ARM64 ABI 与 versionCode。

旧 `codex/stage-1`、`codex/stage-2-connection-settings`、`codex/stage-3-downloads` 和 `codex/stage-4-signing-delivery` 分支仅在 main push 的质量检查成功后清理。job 在删除前要求 main 仍是该 push 的 SHA，并逐项确认指定 branch head 是该 SHA 的 ancestor；缺失的固定分支视为已清理，改变或未合入的分支会导致 job 安全失败。它不会枚举或删除其他分支。
