# GitHub Actions 与正式发布

构建工作流位于 `.github/workflows/build.yml`，Android emulator 启动诊断位于 `.github/workflows/android-emulator-diagnose.yml`，一次性 Android keystore 初始化位于 `.github/workflows/bootstrap-android-keystore.yml`。日常开发只在 `main` 上进行。main push 运行 Node tests、版本一致性、JDK 25 临时 PKCS#12 smoke test、Rust 格式检查，以及一个仅核对并删除四个指定且已合入旧 stage 分支的清理 job；修改 app 行为文件时还会启动单独的 x86_64 emulator 诊断，但不会发布安装包。手动 build workflow 接受 `candidate` 或 `release` 模式，不接受平台选择。

在仓库 **Actions → Build desktop and Android packages → Run workflow** 中选择 `main` 和运行模式。`release` 会先验证两项 Android signing secrets，然后将 stable semver patch 递增并通过 GitHub API non-force 地提交到 `main`。这个 run 的 quality 与 Windows、macOS、Android jobs 都 checkout 同一新提交 SHA。Windows x64 生成含离线 WebView2 Runtime 的 NSIS installer；macOS ARM64 生成 ad-hoc DMG 并运行 Rust library tests；Android 生成签名 ARM64 release APK。API 29 和 36 模拟器启动检查通过后，三端构建都成功才创建不可移动的版本 tag、上传三个包和 `SHA256SUMS` 并公开 GitHub Release。未全部成功时不会公开 Release。手动 run 不会创建 PAT，也不运行自动更新。

`candidate` 模式用于先在 Android 真机验证当前 `main`。它不修改应用语义版本、不创建 tag/Release，构建受两项现有 secrets 签名的 ARM64 APK，versionCode 为 `1000 + github.run_number`，Actions artifact 保留三天。APK 构建与 emulator 检查相互独立；后置包验证失败时仍保留明确标记为 UNVERIFIED 的内部 artifact。candidate 不发布到 Release。触及 app 或构建 workflow 的 main push 会自动触发一次固定的 candidate workflow_dispatch；这是开发候选便捷触发，不会启动正式发布。也可手动运行：

1. 在 **Actions → Build desktop and Android packages → Run workflow** 选择 `main` 和 `candidate`，等待 `candidate-quality` 与 `android-candidate` 完成；emulator 检查独立运行并单独查看 API 29/36 状态。emulator 基础设施失败不会阻止 APK artifact，但不能记作模拟器或真机通过。
2. 打开这次 workflow run，查看 Android package verification 结果和 artifact 内 README，再下载名称以 `Open-WebUI-Client-candidate-` 开头的 artifact。若 README 或 run 标记 UNVERIFIED、或包验证失败，不要安装或分发。只有验证成功的固定签名 APK 才可在相同签名身份的 Redmi 上覆盖安装（例如 `adb install -r <候选APK路径>`），无需卸载旧 app。
3. 在 Redmi 上记录 Android 版本、候选源 SHA 和 APK versionCode，检查启动、前台稳定性与连接页。若系统报告签名或版本错误，停止安装并先核对 artifact，不要卸载已有 app 来绕过错误。

该候选 run 中的 emulator smoke APK 是另一份 x86_64、临时密钥签名的测试 APK，只用于 API 29/36 hosted emulator；它不是上述固定密钥 ARM64 candidate，不能覆盖安装 release。APK 构建结果、emulator 结果和真机验收是三个独立事实；模拟器检查结果只说明对应 emulator/source 的行为，不等于 Redmi 等实体设备通过。

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

正式包通过 GitHub 仓库的 **Releases** 页面下载，release 含 Windows、macOS 和 Android ARM64 安装文件及 SHA-256 校验值。Actions artifacts 是构建过程中的临时材料，不是正式发布页面。workflow 只在所有平台构建和模拟器检查成功后公开 Release；它不发布到应用商店、不启用自动更新，也不替代实体设备验收。

桌面签名状态保持不变：Windows NSIS 包包含离线 WebView2 Runtime；macOS DMG 仅 ad-hoc 签名，没有 Developer ID 签名或公证。首次打开 macOS 应用时只对该应用使用 Finder 的“按住 Control 键点按 → 打开”，不要全局关闭 Gatekeeper。Android 候选/release 构建的模拟器检查不验证 Redmi 等实体设备上的安装、连接或 SAF provider 保存清理行为；这些仍需按[验收清单](ACCEPTANCE.md)手动完成。Android 官方图标已接入构建源码，最终包图标校验等待当前 CI 运行确认。

## 固定构建环境

- Node.js `22.22.0`，通过 `npm ci` 按锁文件安装；Rust `1.94.0`，Cargo 使用仓库 `src-tauri/Cargo.lock`。
- Windows：`windows-2025`，x64 NSIS installer。
- macOS：`macos-15`，Apple Silicon ARM64 ad-hoc DMG。
- Android：Ubuntu `22.04`、Temurin JDK `25`、Android Platform `36`、Build Tools `36.0.0`、NDK `28.2.13676358` 和 Rust target `aarch64-linux-android`。Tauri CLI 2.12.2 Android 模板的 compile/target SDK 值由 `scripts/prepare-android.mjs` 定向调整到 36；应用 minSdk 仍为 29。

`prepare-lockfile` 仅确认 `package-lock.json` 和 `src-tauri/Cargo.lock` 存在，并将当前 checkout SHA 固定给后续 jobs；它不会更新锁文件、运行 formatter 或提交代码。Android manifest、明文网络配置和 Gradle release 签名配置在 CI 生成工程后由 `scripts/prepare-android.mjs` 幂等准备；源码中的 debug versionCode 保持 `2`。签名 release job 才在生成 Gradle 项目中覆盖 `defaultConfig.versionCode`，并且会验证 APK 签名证书与固定 keystore 的 SHA-256 指纹一致、package ID、minSdk、ARM64 ABI 与 versionCode。

旧 `codex/stage-1`、`codex/stage-2-connection-settings`、`codex/stage-3-downloads` 和 `codex/stage-4-signing-delivery` 分支仅在 main push 的质量检查成功后清理。job 在删除前要求 main 仍是该 push 的 SHA，并逐项确认指定 branch head 是该 SHA 的 ancestor；缺失的固定分支视为已清理，改变或未合入的分支会导致 job 安全失败。它不会枚举或删除其他分支。
