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

阶段四增加固定 Android keystore、main 手动发布、自动 patch bump 和 GitHub Release 编排。维护者首次在仓库中设置 `ANDROID_KEYSTORE_PASSWORD`，从 main 运行初始化 workflow 并安全备份密码保护的 RSA 3072 位 PKCS#12，再将该文件的 Base64 设置为 `ANDROID_KEYSTORE_BASE64`。alias 固定为 `openwebui-client`，key password 复用 store password。已有 keystore 时拒绝重生成。

正式发布只接受 main 上的手动 dispatch，并提供 `candidate` 与 `release` 两种模式。release workflow 在版本 bump 前验证两项签名 secrets 和实际 PKCS#12/alias；通过后由 GitHub Actions `GITHUB_TOKEN` non-force 地将 patch bump 提交到 main，随后 quality 与 Windows x64、macOS ARM64、Android ARM64 全部 checkout 同一 SHA。Android release `versionCode` 为 `1000 + github.run_number`；源码/debug 保持 `2`。API 29/36 emulator gate 与三端构建全部成功后，workflow 才创建 tag、上传三个安装包和 `SHA256SUMS` 并公开 Release。构建失败会保留版本 bump commit，但不会公开 Release；同一 run 重试复用原 pinned 版本。没有 PAT、自动更新、商店发布或桌面正式签名。

初始化 artifact 只保留一天且不是私密存储，下载并安全备份后需立即删除 artifact 和初始化 run。手动 secret 配置与发布步骤见[构建与签名说明](GITHUB_ACTIONS.md)。main push 只运行 Node/version、JDK 25 临时 keystore smoke、Rust 格式质量检查及已合入旧 stage branch 的受限清理，不启动原生构建。

阶段四基线通过 GitHub Actions run [#45](https://github.com/Mike666wq/open-webui-client/actions/runs/38989565014)，source/output SHA 均为 `9effd627031d985395e650bf17933a38e8e56dcd`。main-only 发布流程修复 run [#51](https://github.com/Mike666wq/open-webui-client/actions/runs/38995797837) 通过：Node tests 33/33、无 skipped，版本一致性、JDK 25 临时 PKCS#12 smoke、Rust 格式及固定旧分支清理均成功。首次完整签名发布 run [#52](https://github.com/Mike666wq/open-webui-client/actions/runs/38995899635) 也已成功：signing secrets/PKCS#12 alias 校验通过，版本自动递增至 `0.2.2`，所有质量检查和 Windows、macOS ARM64、Android ARM64 构建来自 pinned SHA `3edd2b1191f5f7bbd56cf2d35dd401bb61489f10`。macOS Rust library tests 为 12/12；Android signed APK 的证书、package ID、minSdk、ARM64 ABI 和 versionCode 检查通过。Run #52 以 versionCode `1052` 创建并公开 [Release v0.2.2](https://github.com/Mike666wq/open-webui-client/releases/tag/v0.2.2)，包括 Windows NSIS、macOS ARM64 ad-hoc DMG、Android ARM64 signed APK 和 `SHA256SUMS`。匿名下载验收通过：4 个 release 资产无需登录均返回 HTTP 200 且长度匹配；`SHA256SUMS` 仅列三安装包，完整流式校验值与其内容及 GitHub REST digest 一致，未将安装包落盘。Windows/macOS/Android 真机安装、连接和升级，以及 Android SAF picker、保存与 provider 清理行为仍待验收。

## Android 启动诊断与官方图标

当前源码统一使用 Open WebUI 官方图标：连接页/favicon、Windows/macOS bundle 图标、Android 普通与 round/adaptive launcher 及 Android 12 splash 均由固定 SHA-256 的上游 PNG 派生。Android APK 验证检查包内 launcher 图像 payload 与同构建生成资源一致；Windows/macOS/Android 最终产物的图标门禁仍待当前 CI run 确认，因此暂不记为已验证。

已知 Redmi 设备在启动后约 10 秒内退出，根因仍未定位，也没有声明修复。诊断 run #1 ([39002189585](https://github.com/Mike666wq/open-webui-client/actions/runs/39002189585)) 在 apksigner 路径检查失败；run #2 ([39002664958](https://github.com/Mike666wq/open-webui-client/actions/runs/39002664958)) 因 setup-android 使用 JDK 11，在模拟器启动前失败。提交 591b8fdec0100494fb70ee9873aeffb764c4ff30 已补充 Temurin JDK 25。baseline emulator run #8 ([39013519676](https://github.com/Mike666wq/open-webui-client/actions/runs/39013519676)) 成功构建并验证 v0.2.2 x86_64 测试 APK；API 29 首次冷启动闲置期间出现 native SIGABRT，现有 tombstone 只有未符号化的 `base.apk + 0x4f1d69`，不足以定位调用方；API 36 失败证据仍在核对。current-source run #9 ([39013903737](https://github.com/Mike666wq/open-webui-client/actions/runs/39013903737)) 正在构建 `f0663e93e87a66a9689a3f53a8eca8a14e269eee`。main quality run #64 ([39013904372](https://github.com/Mike666wq/open-webui-client/actions/runs/39013904372)) 仅因 `src-tauri/src/diagnostics.rs` 一处 Rust 格式差异失败；格式修正已纳入后续提交，待 CI 重验。candidate 模式不递增版本，构建与 emulator gate 独立，包验证失败时只保留 UNVERIFIED 内部 artifact。emulator 通过仍不代表 Redmi 真机通过。

## 后续阶段

- 后续验收：完成 Windows、macOS 与 Android 真机验收，记录系统、设备、应用版本和连接结果；Android 还需验证 SAF 选择、取消、写入、连接切换与 provider 清理行为。
- 后续评估：正式桌面签名与 macOS 公证、应用商店分发、后台通知和自动更新。上述功能当前未实现。
