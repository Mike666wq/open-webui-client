# 验收清单

## GitHub Actions 构建

- [ ] 独立 quality job 的完整 npm tests、`npm run version:check`、Rust 格式检查和 JDK 25 临时 PKCS#12 smoke test 通过；临时测试 key 不上传或复用于发行。
- [ ] PR 和 push 中的 Windows x64、macOS Apple Silicon ARM64 构建成功并上传安装包。
- [ ] macOS artifact 为一份 ARM64 ad-hoc DMG；Windows artifact 为包含离线 WebView2 Runtime 的 x64 NSIS `setup.exe`。
- [ ] PR/push 的 Android ARM64 debug 编译检查成功；该 job 不上传 APK，也不表示 release APK 已验收。
- [ ] 只有在 `main` 手动选择 `android` 或 `all` 时才运行签名 Android release job；其它分支的手动运行不签名发行 APK。
- [ ] 缺少任一签名 secret 时，Android release job 明确失败，不会生成可交付 debug APK。
- [ ] 配齐签名 secrets 后，Android ARM64 job 生成固定密钥签名 release APK，文件名、artifact 和 job summary 含版本及 `vc<versionCode>`。
- [ ] Release versionCode 等于 `1000 + github.run_number` 且不超过 `2,100,000,000`；同一 run 重跑使用相同值，新 run 递增；源码/debug versionCode 仍是 `2`。
- [ ] Android keystore 初始化仅能从 `main` 手动运行；已有 `ANDROID_KEYSTORE_BASE64` 时拒绝重新生成。PKCS#12 artifact 密码保护、只保留一天，未把它当作私密存储。
- [ ] 手动选择 `all` 时，Android secrets 缺少不会阻止独立的桌面 jobs。
- [ ] 锁文件引导只提交 `package-lock.json` 和/或 `src-tauri/Cargo.lock` 的真实变化；PR 只读验证锁文件。
- [ ] 构建产物只作为 Actions artifacts 保存，维护者人工下载、检查和分发；不自动创建 tag、GitHub Release、商店发布或更新。

## 维护者签名密钥初始化

- [ ] 使用密码管理器生成至少 32 个随机字符的 `ANDROID_KEYSTORE_PASSWORD`，只在仓库 Actions secrets 中设置；密码不进入聊天、issue、日志或仓库。
- [ ] 从 `main` 手动运行 **Initialize Android release keystore**，确认摘要中有 SHA-256 证书指纹和一天保留提示。
- [ ] 同一初始化 run 的 rerun 会拒绝生成第二把 key；artifact 状态不明时检查并处理原 run，再创建新 run。
- [ ] 立即下载密码保护 PKCS#12 artifact，在仓库外安全位置私下备份并验证文件；然后删除 artifact 与初始化 workflow run。不要把 artifact URL 当成私有访问控制。
- [ ] 在本机 PowerShell 将备份文件编码到剪贴板，再通过仓库设置 UI 添加剩余三个 secrets。不要将 Base64 写入终端历史、文件、issue 或聊天；设置后清空剪贴板。
- [ ] 确认四个 secrets 名称和值一致：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` (`openwebui-client`)、`ANDROID_KEY_PASSWORD`（与 store password 相同）。
- [ ] 从 `main` 手动运行 **Build desktop and Android packages**，选择 `android` 或 `all`；验证签名 APK 的 SHA-256 证书指纹与初始化摘要一致。

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
