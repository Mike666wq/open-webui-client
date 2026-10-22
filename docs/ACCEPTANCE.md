# 当前验收清单

核对日期：2026-10-22。共同进度见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。勾选仅代表对应的证据，不把自动化通过等同于人工验收。

## 已验证的自动交付

- [x] [Android run 39722809500](https://github.com/Mike666wq/open-webui-client/actions/runs/39722809500) 的源码质量、版本一致性、固定签名验证、ARM64 编译、原生单元测试、证书/包元数据/产物完整性及公开发布成功，对应 [v0.2.31](https://github.com/Mike666wq/open-webui-client/releases/tag/v0.2.31)。
- [x] 已存在固定签名身份，正式发布校验证书与包内身份；当前不是“等待首次初始化密钥”的阶段。不得因重新部署环境而重生成密钥。
- [x] 后端和 APK 通过各自 frontend.lock.json 固定前端来源和摘要；历史成功基线已跑通，后续更新必须再核对两份锁和对应 run。
- [x] 当前正式流程只发 Android ARM64 APK，不默认运行模拟器，不使用旧 candidate 模式；桌面历史包与新 Android 发布分开记录。

## 尚未完成的验收

- [ ] 全部目标手机上的安装覆盖、前后台、原生面板、返回顺序、键盘与旋转。
- [ ] Redmi K70 Pro / HyperOS 3 启动后退出问题的根因和修复验证。没有足够真机证据前继续保留为未解决，不能以 CI 或模拟器通过结案。
- [ ] 真实后端账号、模型调用、长会话、上传下载和多人/多设备回归。
- [ ] SAF 真实 provider 的选择、取消、迟到回调、大文件和失败清理。
- [ ] 生产部署/迁移/恢复演练；本轮无自动生产切换。
- [ ] Codespaces Docker/Compose 与实际网页启动验收。环境仍有创建/软件源问题，当前暂停使用。

历史 v0.2.2 三端构建、旧 candidate、早期诊断和测试数量保存在 [审计前文档快照](https://github.com/Mike666wq/open-webui-client/blob/2edd1164404a4049056c6d404176ad6f28557ff4/docs/ACCEPTANCE.md)；其中“正在构建”等文字仅是当时记录，不是当前状态。

## Windows 与 macOS 历史包的真机验收（非当前发版门禁）

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
- [ ] Android 返回顺序：收起键盘、关闭客户端弹层、返回当前服务内上一页；无历史时退到后台，不误切回旧服务。
- [ ] HTTP 按明文传输显示并说明风险；HTTPS 使用系统默认证书验证，证书无效时不得忽略或绕过错误。

## 用户连接与导航

- [ ] 首次打开显示本地连接页，预填 `http://192.168.31.60:3000`；将它替换为实际服务地址后，只有连接成功才保存为最近成功地址。
- [ ] 停止服务或输入不可用地址，确认失败后回到本地设置页并保留候选输入，原有成功地址不被覆盖；恢复服务后可重新连接。
- [ ] 连接后桌面使用 Windows/Linux `Ctrl+L` 或 macOS `⌘L` 返回设置页；Android 点击原生顶部栏设置入口修改连接，系统返回按当前原生导航顺序处理。
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

Optional GitHub API 29/36 diagnostics use synthetic runner-local services, not a user's Open WebUI data. They are not part of the automatic APK release gate.
They must prove that native settings cancellation keeps the document/draft, the native-only
plugin denies page calls, switches use the existing handshake and success persistence,
failed switches retain the previous successful service, and Back never revisits another
server. Evidence includes portrait, landscape, IME, failure and SAF screenshots.

Top status bars are hidden by default and transiently shown by edge swipe without relayout;
the bottom system navigation and camera cutout stay reserved. A permanent native toolbar
reserves at least 48dp above the WebView and exposes a 48dp settings target. Its bottom
panel and address dialogs follow system colors and font scale without recreating the
WebView. IME adjustment must not apply its height twice. API 29/36 evidence includes
light/dark themes, large fonts, toolbar non-overlap and settings-panel layout. Native
actions are serialized; stale generations/revisions are rejected.
Chinese Android locales use Chinese client labels; other locales fall back to English.

A green optional emulator diagnosis does not claim HyperOS physical-device UX acceptance. Release can
proceed after the GitHub gates, as requested, with that limitation stated in release notes.


The synthetic test service reports its own current DOM bounds/draft/scroll nonce to the
runner because stock WebView accessibility may omit virtual children after navigation.
Native controls still use real UIAutomator nodes and all interaction uses actual ADB
taps/keys. Fixture reports are accepted only while a visible WebView is present and the
report is fresh; raw hierarchy, fixture state and screenshots remain separate evidence.
No production debug API or script injection into a user's service is added.
