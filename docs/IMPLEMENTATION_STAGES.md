# 实施阶段

## 阶段一：远端构建与交付骨架

阶段一建立了 Tauri 2 客户端的 GitHub Actions 三目标构建流程。受支持目标为 Windows x64、macOS Apple Silicon ARM64 和 Android ARM64。工作流在 `codex/stage-*` 分支推送、Pull Request 和手动 dispatch 时运行；手动目标可选 `desktop`（默认）、`android`、`all`。构建结果作为带版本、系统和架构名称的 GitHub Actions artifacts 保存，不自动发布 Release 或公开发行页。

交付目标为 Windows 10/11 x64 离线 WebView2 NSIS 安装程序、macOS 12+ Apple Silicon ad-hoc DMG，以及 Android 10+ ARM64 固定密钥签名 release APK。push/PR 运行 Android debug 编译检查但不上传 debug APK。手动 Android release 缺少任一签名 secret 时会明确失败。

## 阶段二：运行时连接设置

阶段二在源码中实现本地连接设置页：初始地址为 `http://192.168.31.60:3000`，可配置任意 HTTP/HTTPS IP 或域名、子域名、端口及根路径。首次连接成功后保存为最近成功地址，并在下次启动自动连接；失败候选最多等待 30 秒，随后回到设置页并保留候选值，不覆盖成功地址。连接后不显示常驻工具栏。

Android 原生系统返回在远程服务页面直接返回本地设置页，在本地设置页结束应用，不依赖远程页面中的 Tauri JS listener 或 WebView 历史。Windows/macOS 原生菜单与 `Ctrl+L` / `⌘L` 进入设置。用户可在设置页修改服务地址。

Android 允许应用连接任意明文 HTTP 服务，因此网络安全配置的 cleartext base policy 覆盖所有 host；HTTPS 仍按系统 WebView 的默认信任验证。macOS 只配置 `NSAllowsLocalNetworking`，不关闭 WKWebView 的广泛 ATS 限制。按 Apple 文档，该键覆盖 IP 地址、未限定域名和 `.local` 域名，但不放行任意公网 DNS 域名的 HTTP；macOS 14+ 默认限制 IP 直连，设置此键后仍可连接 IP 地址。该系统例外未按私网地址段作限制，故不能承诺只允许私网 IP。公网域名 HTTP 可能被 ATS 拒绝，HTTPS 需符合 ATS/TLS 与平台证书信任要求。HTTP 明文流量应限制在可信网络中。

阶段二的源码已通过 GitHub Actions quality、Windows x64、macOS ARM64（含 5 项 Rust library tests）和 Android ARM64 debug 编译检查。阶段三保存桥也已通过 GitHub Actions quality、Windows/macOS/Android 构建及 macOS runner 上的 Rust library tests（Stage 3 gate：push run [#42](https://github.com/Mike666wq/open-webui-client/actions/runs/38987982681)，head `5b3c0441dc222ed754f42786e0700bb47b758ed9`）。CI 通过不替代 Windows/macOS/Android 真机验收；下载、安装、连接和文件保存仍待在真实设备上完成。

## 阶段三：Android 文档保存桥

阶段三将 Android 系统保存选择器接入 app-owned Rust 保存命令。远程 WebView 只能调用受限的 Rust 命令；它不能直接调用 native plugin 的 picker、传入 URI 或访问 Kotlin stream。Rust 在每个保存阶段检查当前连接 generation 和 session token，状态失效时取消尚未提交的 transfer。finish 在有效 session 下原子接受 `Finishing` 状态时就是提交点；提交点之后导航失效不会把成功的 native finish 改报失败，已接受的提交允许完成。Kotlin 只接收文件名、MIME type、可选预期字节数、transfer ID、块序号和 Base64 数据；SAF URI 与输出流只留在 native plugin 内。

保存通过 `ACTION_CREATE_DOCUMENT` 让用户选择目标 provider。文件按顺序写入，单块解码后最多 128 KiB，单次 transfer 最多 2 GiB；若提供 `expectedBytes`，完成前必须精确匹配。Picker 等待 10 分钟后标记为过期；之后返回的 URI 会按 stale transfer 清理。Picker 取消返回明确的 cancelled 状态。finish 会校验、flush 并关闭；cancel、写入失败、尚未提交的连接失效和 Activity 销毁会关闭流并尝试删除未完成文档。系统 provider 可能拒绝删除，native 层会返回清理错误；设备与 provider 的实际行为需记录，不承诺每种 provider 都能删除已创建的空文档。

本阶段源码实现与 CI gate 已通过；GitHub Actions Android debug 编译只证明代码可构建，不证明 SAF picker、URI provider、取消竞态或大文件写入已在设备上验收。各 Android provider 的部分文件清理行为也仍需实机记录。

## 阶段四：签名 APK 与交付说明

阶段四增加 Android 固定 keystore 的一次性初始化流程和 main 分支手动签名构建。初始化 workflow 生成 RSA 3072 位、密码保护的 PKCS#12；APK 只在 `main` 上通过手动 `workflow_dispatch` 并选择 `android` 或 `all` 时签名。release `versionCode` 为 `1000 + github.run_number`，相同 run 重试保持相同值，新 run 递增；源码/debug 保持 `2`。语义版本需通过版本管理脚本同步递增。

初始化 artifact 是 Actions 仓库中的临时文件，不是私密存储；下载后应立即私下备份并删除 artifact 和初始化 run。Actions artifacts 供维护者手动审核和分发，不会自动创建 GitHub Release、公开发布或启用自动更新。用户首次配置、生成和导入 secrets 的步骤见[构建与签名说明](GITHUB_ACTIONS.md)。

阶段四的 workflow、脚本和文档仍需通过新的 GitHub Actions 检查。Windows、macOS、Android 安装启动、连接以及 Android SAF 保存的实机验收均未完成，不应将 CI 结果表述为设备验收通过。

## 后续阶段

- 后续验收：完成 Windows、macOS 与 Android 真机验收，记录系统、设备、应用版本和连接结果；Android 还需验证 SAF 选择、取消、写入、连接切换与 provider 清理行为。
- 后续评估：正式桌面签名与 macOS 公证、应用商店分发、后台通知和自动更新。上述功能当前未实现。
