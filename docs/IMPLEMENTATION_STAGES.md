# 实施阶段

## 阶段一：远端构建与交付骨架

阶段一建立了 Tauri 2 客户端的 GitHub Actions 三目标构建流程。受支持目标为 Windows x64、macOS Apple Silicon ARM64 和 Android ARM64。工作流在 `codex/stage-*` 分支推送、Pull Request 和手动 dispatch 时运行；手动目标可选 `desktop`（默认）、`android`、`all`。构建结果作为带版本、系统和架构名称的 Actions artifacts 保存，不自动发布 Release。

交付目标为 Windows 10/11 x64 离线 WebView2 NSIS 安装程序、macOS 12+ Apple Silicon ad-hoc DMG，以及 Android 10+ ARM64 固定密钥签名 release APK。push/PR 运行 Android debug 编译检查但不上传 debug APK。手动 Android release 缺少任一签名 secret 时会明确失败。

## 阶段二：运行时连接设置

阶段二在源码中实现本地连接设置页：初始地址为 `http://192.168.31.60:3000`，可配置任意 HTTP/HTTPS IP 或域名、子域名、端口及根路径。首次连接成功后保存为最近成功地址，并在下次启动自动连接；失败候选最多等待 30 秒，随后回到设置页并保留候选值，不覆盖成功地址。连接后不显示常驻工具栏。

Android 原生系统返回在远程服务页面直接返回本地设置页，在本地设置页结束应用，不依赖远程页面中的 Tauri JS listener 或 WebView 历史。Windows/macOS 原生菜单与 `Ctrl+L` / `⌘L` 进入设置。用户可在设置页修改服务地址。

Android 允许应用连接任意明文 HTTP 服务，因此网络安全配置的 cleartext base policy 覆盖所有 host；HTTPS 仍按系统 WebView 的默认信任验证。macOS 只配置 `NSAllowsLocalNetworking`，不关闭 WKWebView 的广泛 ATS 限制。按 Apple 文档，该键覆盖 IP 地址、未限定域名和 `.local` 域名，但不放行任意公网 DNS 域名的 HTTP；macOS 14+ 默认限制 IP 直连，设置此键后仍可连接 IP 地址。该系统例外未按私网地址段作限制，故不能承诺只允许私网 IP。公网域名 HTTP 可能被 ATS 拒绝，HTTPS 需符合 ATS/TLS 与平台证书信任要求。HTTP 明文流量应限制在可信网络中。

阶段二代码已进入实现，但本次修改后的 GitHub Actions 构建和真实设备验收仍待完成。源码实现、CI 构建成功和设备验收是三个不同状态，不相互替代。

## 后续阶段

- 阶段三：完成 Windows、macOS 与 Android 真机验收，记录系统、设备、应用版本和连接结果；据此修复兼容性问题。
- 后续评估：正式桌面签名与 macOS 公证、应用商店分发、后台通知和自动更新。上述功能当前未实现。
