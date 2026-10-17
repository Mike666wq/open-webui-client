# 验收清单

## GitHub Actions 构建

- [x] 历史阶段四基线 push run [#45](https://github.com/Mike666wq/open-webui-client/actions/runs/38989565014)，source/output SHA `9effd627031d985395e650bf17933a38e8e56dcd`：Node tests 20/20、版本一致性、Rust 格式、JDK 25 临时 PKCS#12 生成 smoke test 通过；Windows NSIS、macOS ARM64 ad-hoc DMG/Rust tests 12/12 和 Android debug 检查通过。
- [ ] 新 main-only 发布 workflow 的 quality、两 Secrets 的 PKCS#12/alias 检查、APK 签名及 metadata 验证、三端 pinned SHA 和发布门禁通过 GitHub Actions 验证。
- [ ] main push quality 成功后，cleanup 仅删除四个列明且仍是 pinned main SHA ancestor 的旧 stage branch；未知、变化或未合入 ref 保持不动。
- [ ] 在 `main` 手动运行 **Build desktop and Android packages** 时自动 patch bump 并 non-force 提交 main；quality、Windows、macOS、Android 全部使用同一个 bump commit SHA。
- [ ] Android signed ARM64 APK 通过签名验证，package ID 为 `local.openwebui.client`、minSdk 为 29、包含 ARM64 native library、versionCode 匹配该 run 的 `1000 + github.run_number`，且不超过 `2,100,000,000`。
- [ ] Windows x64 NSIS、macOS Apple Silicon ARM64 ad-hoc DMG 和 Android ARM64 signed APK 全部成功后才创建 tag、生成 `SHA256SUMS` 并公开 GitHub Release；任何平台失败都不创建公开 Release。
- [ ] 同一 workflow run 重试复用同一 patch commit/tag/versionCode；新 run 自动递增 patch 和 versionCode；源码/debug Android versionCode 仍为 `2`。
- [ ] 两项 signing secrets 为 `ANDROID_KEYSTORE_PASSWORD` 与 `ANDROID_KEYSTORE_BASE64`；缺少或无效时在版本 bump 前失败。固定 alias 为 `openwebui-client`，key password 复用 store password。
- [ ] Keystore bootstrap 仅允许 main 手动运行；存在 `ANDROID_KEYSTORE_BASE64` 或同一 run rerun 时拒绝生成。生成的加密 PKCS#12 artifact 一天后过期，且不作为私密存储。

## 维护者签名密钥初始化

- [ ] 使用密码管理器生成至少 32 个随机字符的 `ANDROID_KEYSTORE_PASSWORD`，只在仓库 Actions secrets 中设置；密码不进入聊天、issue、日志或仓库。
- [ ] 从 `main` 手动运行 **Initialize Android release keystore**，确认摘要中有 SHA-256 证书指纹和一天保留提示。
- [ ] 同一初始化 run 的 rerun 会拒绝生成第二把 key；artifact 状态不明时检查并处理原 run，再创建新 run。
- [ ] 立即下载密码保护 PKCS#12 artifact，在仓库外安全位置私下备份并验证文件；然后删除 artifact 与初始化 workflow run。不要把 artifact URL 当成私有访问控制。
- [ ] 在本机 PowerShell 将备份文件编码到剪贴板，再通过仓库设置 UI 添加剩余的 `ANDROID_KEYSTORE_BASE64` secret。不要将 Base64 写入终端历史、文件、issue 或聊天；设置后清空剪贴板。
- [ ] 确认仅设置两个 secrets：`ANDROID_KEYSTORE_BASE64` 和 `ANDROID_KEYSTORE_PASSWORD`。固定 alias 是 `openwebui-client`，Android key password 与 store password 相同，不创建冗余 alias/password secrets。
- [ ] 在所有代码检查通过后，从 `main` 手动运行 **Build desktop and Android packages**；验证公开 Release 中三端包、`SHA256SUMS` 与签名 APK 证书指纹。

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
