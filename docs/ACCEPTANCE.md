# 验收清单

## GitHub Actions 构建

- [ ] 官方 Open WebUI 图标已统一接入连接页、Tauri Windows/macOS 图标和 Android launcher/adaptive/splash 资源；最终包内图标内容校验待当前源码的 Windows/macOS/Android CI 结果确认。
- [ ] Redmi K70 Pro / HyperOS 3 的启动后约 10 秒内退出问题仍未定位。baseline emulator run [#8](https://github.com/Mike666wq/open-webui-client/actions/runs/39013519676) 成功构建并验证 v0.2.2 x86_64 测试 APK；API 29 首次冷启动闲置期间出现 native SIGABRT，现有 tombstone 只有未符号化的 `base.apk + 0x4f1d69`，不足以定位调用方；API 36 失败证据仍在核对。该 hosted emulator 结果不是 Redmi 实机复现。current-source run [#9](https://github.com/Mike666wq/open-webui-client/actions/runs/39013903737) 正在构建 `f0663e93e87a66a9689a3f53a8eca8a14e269eee`；main quality run [#64](https://github.com/Mike666wq/open-webui-client/actions/runs/39013904372) 仅因 Rust formatting 失败，格式修正待后续 push。根因和修复均未确认。
- [ ] 新版 `candidate` 模式的 ARM64 APK 构建与 API 29/36 emulator 检查独立；包验证失败仍会保留标记为 UNVERIFIED 的内部 Actions artifact，不能安装或分发。成功验证的固定 keystore APK 使用 `1000 + github.run_number` versionCode，保留三天，不递增 app 版本、不创建 tag/Release。emulator 结果与 Redmi 真机验收分开记录。
- [ ] 后续需记录 candidate 下载、覆盖安装和 Redmi 启动结果；若候选仍在 10 秒内退出，保留设备型号、Android 版本、候选 source SHA、versionCode 和过滤后的诊断日志，再决定修复方向。

- [x] 历史阶段四基线 push run [#45](https://github.com/Mike666wq/open-webui-client/actions/runs/38989565014)，source/output SHA `9effd627031d985395e650bf17933a38e8e56dcd`：Node tests 20/20、版本一致性、Rust 格式、JDK 25 临时 PKCS#12 生成 smoke test 通过；Windows NSIS、macOS ARM64 ad-hoc DMG/Rust tests 12/12 和 Android debug 检查通过。
- [x] main 修复 push run [#51](https://github.com/Mike666wq/open-webui-client/actions/runs/38995797837)，SHA `260acae8fe9100dfb752506118513f8f6d2712af`：Node tests 33/33、0 skipped，版本一致性、JDK 25 临时 keystore smoke test、Rust 格式和受限旧分支清理均通过。
- [x] 首次 main 手动发版 run [#52](https://github.com/Mike666wq/open-webui-client/actions/runs/38995899635)：两项 signing secrets 与 PKCS#12/alias 检查通过；自动 patch bump 到 `0.2.2`，并固定三端源码 SHA `3edd2b1191f5f7bbd56cf2d35dd401bb61489f10`，Android versionCode 为 `1052`。
- [x] Run #52 的 release quality 通过；macOS ARM64 ad-hoc DMG 与 Rust tests 12/12、Windows x64 NSIS 和 Android signed ARM64 APK 均成功。APK 签名证书、package ID `local.openwebui.client`、minSdk 29、ARM64 ABI 和 versionCode 检查通过；三个构建均来自同一 pinned SHA。
- [x] Run #52 创建并公开 [Release v0.2.2](https://github.com/Mike666wq/open-webui-client/releases/tag/v0.2.2)，含三端包及 `SHA256SUMS`；匿名 HEAD 请求对四个资产均返回 HTTP 200 和预期长度。校验文件包含且仅包含三个安装包，完整流式 SHA-256 与校验文件及 GitHub REST digest 匹配；文件未下载到本地。
- [x] 下载资产长度：Windows `Open-WebUI-Client-0.2.2-windows-x64-setup.exe` 219,464,462 bytes；macOS `Open-WebUI-Client-0.2.2-macos-arm64.dmg` 4,015,417 bytes；Android `Open-WebUI-Client-0.2.2-android-arm64-vc1052.apk` 13,986,692 bytes；`SHA256SUMS` 333 bytes。
- [x] main push quality run [#49](https://github.com/Mike666wq/open-webui-client/actions/runs/38994807152) 与修复后的 [#51](https://github.com/Mike666wq/open-webui-client/actions/runs/38995797837) 均成功；受限清理只针对固定的四个已合入旧 stage 分支，且在当前 main 上完成。
- [x] 在 `main` 手动运行 **Build desktop and Android packages** 时自动 patch bump 并 non-force 提交 main；Run #52 的质量检查及三端构建均使用同一个 bump commit SHA。
- [x] Android signed ARM64 APK 通过签名验证，package ID 为 `local.openwebui.client`、minSdk 为 29、包含 ARM64 native library、versionCode 为 `1000 + github.run_number`（Run #52 为 `1052`）。
- [x] Windows x64 NSIS、macOS Apple Silicon ARM64 ad-hoc DMG 和 Android ARM64 signed APK 全部成功后才创建 tag、生成 `SHA256SUMS` 并公开 GitHub Release；Run #52 完成该门禁。
- [x] 同一 workflow run 重试复用同一 patch commit/tag/versionCode；新 run 自动递增 patch 和 versionCode；源码/debug Android versionCode 保持 `2`。Run #52 使用 `0.2.2`、tag `v0.2.2` 与 versionCode `1052`。
- [x] 两项 signing secrets 为 `ANDROID_KEYSTORE_PASSWORD` 与 `ANDROID_KEYSTORE_BASE64`；Run #52 在版本 bump 前成功验证两项配置及 PKCS#12 alias。固定 alias 为 `openwebui-client`，key password 复用 store password。
- [ ] Keystore bootstrap 仅允许 main 手动运行；存在 `ANDROID_KEYSTORE_BASE64` 或同一 run rerun 时拒绝生成。生成的加密 PKCS#12 artifact 一天后过期，且不作为私密存储。

## 维护者签名密钥初始化

- [ ] 使用密码管理器生成至少 32 个随机字符的 `ANDROID_KEYSTORE_PASSWORD`，只在仓库 Actions secrets 中设置；密码不进入聊天、issue、日志或仓库。
- [ ] 从 `main` 手动运行 **Initialize Android release keystore**，确认摘要中有 SHA-256 证书指纹和一天保留提示。
- [ ] 同一初始化 run 的 rerun 会拒绝生成第二把 key；artifact 状态不明时检查并处理原 run，再创建新 run。
- [ ] 立即下载密码保护 PKCS#12 artifact，在仓库外安全位置私下备份并验证文件；然后删除 artifact 与初始化 workflow run。不要把 artifact URL 当成私有访问控制。
- [ ] 在本机 PowerShell 将备份文件编码到剪贴板，再通过仓库设置 UI 添加剩余的 `ANDROID_KEYSTORE_BASE64` secret。不要将 Base64 写入终端历史、文件、issue 或聊天；设置后清空剪贴板。
- [ ] 确认仅设置两个 secrets：`ANDROID_KEYSTORE_BASE64` 和 `ANDROID_KEYSTORE_PASSWORD`。固定 alias 是 `openwebui-client`，Android key password 与 store password 相同，不创建冗余 alias/password secrets。
- [x] 在所有代码检查通过后，从 `main` 手动运行 **Build desktop and Android packages**；Run #52 验证公开 Release 中三端包、`SHA256SUMS` 与签名 APK 证书指纹。

## Windows 与 macOS 真机验收

- [ ] Windows 10 与 Windows 11 x64 安装、首次启动、卸载；在未预装 WebView2 Runtime 的干净环境验证离线运行时安装。
- [ ] macOS 12+ Apple Silicon 挂载、安装并启动 DMG；记录 ad-hoc 签名首次运行提示。
- [ ] 原生菜单项和 `Ctrl+L` / `⌘L` 可随时打开本地连接设置；保存地址并重连后进入服务页面。
- [ ] Windows 10/11 离线 WebView2 安装、升级覆盖和卸载在干净 x64 设备通过；macOS 12+ ARM64 ad-hoc DMG 在目标机器安装并记录首次运行提示，仅对该应用使用 Finder 的“按住 Control 键点按 → 打开”，不全局关闭 Gatekeeper。

## Android 真机验收

- [ ] Android 10+ ARM64 安装固定密钥签名 APK、启动、卸载，并确认签名证书匹配维护者预期。
- [ ] 首次打开显示本地连接页，默认地址为 `http://192.168.31.60:3000`。
- [ ] 对 HTTP 和 HTTPS 的 IPv4/IPv6 地址、域名、子域名、不同端口及根路径进行连接验证；输入规范化正确且成功地址可持久保存。
- [ ] 无效地址、服务不可用或 30 秒内连接失败时回到设置页、保留候选输入，不覆盖上次成功地址；恢复服务后可重新连接。
- [ ] 强制结束并重启应用后自动连接到最近一次成功地址。
- [ ] 在远程服务页面按 Android 系统返回键回到 bundled 本地设置页；在本地设置页再次按系统返回键退出，不返回远程页面。
- [ ] HTTP 按明文传输显示并说明风险；HTTPS 使用系统默认证书验证，证书无效时不得忽略或绕过错误。

## 用户连接与导航

- [ ] 首次打开显示本地连接页，预填 `http://192.168.31.60:3000`；将它替换为实际服务地址后，只有连接成功才保存为最近成功地址。
- [ ] 停止服务或输入不可用地址，确认失败后回到本地设置页并保留候选输入，原有成功地址不被覆盖；恢复服务后可重新连接。
- [ ] 连接后桌面使用 Windows/Linux `Ctrl+L` 或 macOS `⌘L` 返回设置页；Android 系统返回键从远程页面回到本地设置，再按一次结束应用。
- [ ] 在服务内容中分别验证明确下载操作与普通预览链接：下载按应用保存桥执行；没有下载意图的图片/媒体预览和普通内部链接留在 WebView 中，不能因此弹出文件保存选择器。

## Android 系统文件保存验收

- [ ] 从允许的远程服务内容触发保存时，只显示 Android `ACTION_CREATE_DOCUMENT` picker；选择目标后文件内容与长度正确，JS 不收到 URI、路径或原生输出流。
- [ ] 取消 picker 返回 cancelled 状态，不创建可见文件；picker 等待期间切换连接或销毁 Activity 后，迟到的 URI 被取消清理。
- [ ] 连续块按序写入；验证 128 KiB 块上限、2 GiB transfer 上限、乱序块拒绝，以及提供 `expectedBytes` 时过短/过长均不能成功 finish。
- [ ] 写入完成后流被 flush/close；主动取消、写入失败、尚未提交的连接 generation/session 失效和 Activity 销毁均触发关闭及未完成文档删除；有效 session 下原子接受 finish 后即为提交点，之后的导航失效不把已接受的成功提交改报失败。
- [ ] 至少在 Android 内置 DocumentsUI 与一个第三方 SAF provider 上检查取消清理。若 provider 拒绝删除，应用返回清理错误并记录残留行为，不宣称该文档已删除。

## 网络策略验证

- [ ] Android 配置允许用户选择的任意 HTTP host/IP/端口，不局限于默认地址；确认网络策略同时允许 HTTP 和 HTTPS。
- [ ] macOS `Info.plist` 只声明 `NSAllowsLocalNetworking`，不设置 `NSAllowsArbitraryLoadsInWebContent` 或 `NSAllowsArbitraryLoads`。验证 HTTP IPv4/IPv6 与 `.local` 地址的实际系统行为；公开 DNS 域名 HTTP 可能由 ATS 拒绝，须记录结果，不作为任意 HTTP 域名已支持的承诺。
- [ ] Android、Windows WebView2 和 macOS WKWebView 对 HTTPS 无效证书维持平台默认拒绝行为。

每条真机检查需记录设备型号、OS 版本、应用版本、目标地址、结果及必要日志。GitHub Actions artifact 存在或 CI 成功不能替代上述设备检查。

上述真实设备验收尚未完成；特别是 Android SAF picker、不同 Documents provider 的写入与删除行为、连接切换时取消以及大文件保存均仍为待验收项。

## 当前未实现

后台通知、自动更新、macOS 公证、Apple Developer ID 正式签名、Windows 商业签名和商店发布尚未实现，也不属于当前验收通过项。


## Android native experience (post-v0.2.4)

GitHub API 29/36 gates use synthetic runner-local services, not a user's Open WebUI data.
They must prove that native settings cancellation keeps the document/draft, the native-only
plugin denies page calls, switches use the existing handshake and success persistence,
failed switches retain the previous successful service, and Back never revisits another
server. Evidence includes portrait, landscape, IME, failure and SAF screenshots.

Top status bars are hidden by default and transiently shown by edge swipe without relayout;
the bottom system navigation and camera cutout stay reserved. The draggable native menu
has a 48dp target. IME adjustment must not apply its height twice or overwrite the saved
menu fraction. Native actions are serialized; stale generations/revisions are rejected.
Chinese Android locales use Chinese client labels; other locales fall back to English.

A green emulator gate does not claim HyperOS physical-device UX acceptance. Release can
proceed after the GitHub gates, as requested, with that limitation stated in release notes.
