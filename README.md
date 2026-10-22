> 三仓库共同进度见 [当前进度](docs/PROJECT_STATUS.md)，操作方式见 [GitHub 构建与人工验收](docs/CLOUD_DEVELOPMENT.md)。Codespaces 当前暂停使用，尚未验收可用。

# Open WebUI Client

Open WebUI Client 是一个用 Tauri 2 打包的轻量客户端。本仓库负责客户端原生外壳和 APK；Android 内置来自独立前端仓库的已校验 DIY 网页，连接用户的兼容后端 API。前端、后端分别在各自仓库维护，APK 不包含服务端。

首版交付目标为 Windows 10/11 x64 NSIS 安装程序（包含离线 WebView2 Runtime）、macOS 12 及以上 Apple Silicon ad-hoc DMG，以及 Android 10 及以上 ARM64 release APK（固定 keystore 签名）。macOS 包没有 Developer ID 签名或公证。

GitHub Actions 在 PR 上快检，main 通过前端版本同步后由 Actions 显式派发发布、递增 patch，只构建和发布 Android ARM64 签名 APK 与 SHA-256 校验文件。发布保留源码测试、前端构建、Android 编译和单元测试、签名及产物完整性验证，不启动模拟器。请从[最新 Release](https://github.com/Mike666wq/open-webui-client/releases/latest)下载。模拟器交互和长时间冷启动观察仅作为可选诊断，不代表已完成真机验收。详见[Actions 构建说明](docs/GITHUB_ACTIONS.md)。

应用图标已统一为 Open WebUI 官方素材；最终包图标验证以当前 CI 结果为准。Redmi K70 Pro / HyperOS 3 已报告启动后约 10 秒内退出，根因尚未确认，也未标记为修复。连接页另提供用户主动触发的 Android 诊断导出：API 30+ 仅列出本应用最近的有限退出原因和数值，API 29 只记录固定生命周期标记；报告由系统文件选择器保存，不自动发送，也不包含服务 URL、token、文件 URI 或异常文本。当前 Android 发布已有编译、原生测试、签名与包验证成功记录；该退出问题的根因和真机修复结论仍未确认。

## 连接服务

应用提供本地连接设置页。默认地址为 `http://192.168.31.60:3000`，用户可以改为自己的 HTTP 或 HTTPS IP、域名、子域名、端口和根路径。首次启动时输入地址并连接；成功后应用保存该地址并在后续启动时自动连接。连接失败时最多等待 30 秒，然后回到设置页并保留本次输入；失败地址不会覆盖上次成功保存的地址。Android 连接后保留原生顶部栏；桌面连接后不显示常驻工具栏。

HTTP 是明文连接，适合可信任的局域网。Android 网络安全配置允许应用访问任意 HTTP host/IP。macOS 仅声明 `NSAllowsLocalNetworking`：Apple 将其定义为允许 IP 地址、未限定域名和 `.local` 域名；它不对任意公网 DNS 域名开放 HTTP。macOS 12+ 上，用户配置的 IP 地址可用于局域网 HTTP；公网域名的 HTTP 可能被 ATS 拒绝，需使用符合系统 ATS 与证书信任要求的 HTTPS。应用不关闭 WKWebView 的广泛 ATS 限制，也不忽略无效 HTTPS 证书。

Android 默认隐藏顶部状态栏，边缘滑动可临时显示；底部系统导航保留。服务页面使用常驻原生顶部栏，显示服务主机和连接状态；右侧设置图标打开底部面板，提供修改服务地址、重新加载和主动导出诊断。顶部栏为网页预留独立空间，跟随系统浅色、深色与字体设置。打开或取消原生地址弹层不离开聊天页面；确认切换或重载可能丢失未发送内容。Android 返回操作依次收起键盘、关闭客户端弹层、返回当前服务内上一页，无历史时退到后台。Windows 和 macOS 提供原生菜单及 `Ctrl+L` / `⌘L` 快捷键进入设置。

### 首次连接与保存

首次启动时，在连接页确认或修改默认地址，点连接；只有服务成功打开后，这个地址才会保存并用于下次启动。连接失败会回到设置页，输入内容保留，可修正地址后重试。桌面按 Windows/Linux `Ctrl+L` 或 macOS `⌘L` 随时返回设置；Android 点击顶部栏设置图标进入连接设置，取消不改变聊天现场；系统返回不再直接打开地址设置。

页面中的明确下载会交给应用保存流程处理。普通图片、媒体预览、没有下载属性的链接，以及同源内部链接继续在 WebView 中打开，不会因为预览而误弹保存对话框。Android 选择保存位置时使用系统文件选择器；文件 URI 和路径不会交给网页脚本。不同设备和文件 provider 的实际保存、取消与清理结果仍待真机验收。

首版不提供后台通知、自动更新或正式桌面付费签名。PR 只执行快速源码检查，不编译 APK；release APK 必须使用维护者管理的固定 keystore。

## 版本

每次发布时，稳定语义版本会同步写入 `package.json`、Cargo、Tauri 和两份锁文件；当前发布版本请查看[最新 Release](https://github.com/Mike666wq/open-webui-client/releases/latest)。运行 `npm run version:check` 检查一致性；准备新版本时使用 `node scripts/manage-version.mjs bump patch`（也支持 `minor`、`major` 或明确的递增 `X.Y.Z`）。源码中的 Android `versionCode` 为 debug 占位值 `2`。合并到 `main` 后自动发布（或手动恢复发布）时，CI 才将生成 Gradle 工程的 release `defaultConfig.versionCode` 设为 `100000 + android.yml 的 github.run_number`；重跑同一 workflow run 使用同一代码，任何新 run 都递增。release APK 名称和 artifact 会包含该 versionCode。

## 构建

PR 执行 **Pull request quick checks**，检查源码、前端构建、版本、工作流语法及固定截图回归，不构建 APK、不读取发布密钥。main 更新先运行 **Sync verified frontend and build**；当前前端 Release 已发布且锁定后，派发 **Android APK release**，自动递增 patch，固定源码 SHA，只构建 Android ARM64 签名 APK，执行原生单元测试、签名及包元数据校验后公开 Release。发布不构建 x86_64 测试包、不启动模拟器、不等待完整交互或冷启动观察。当前 main 更新经前端同步后触发构建。正在发布的版本不会被取消；等待中的过期提交跳过，最新 main 最终验收。需要恢复时优先使用 Actions 的 Re-run failed jobs；同一次运行保留版本、versionCode 和已构建 APK，产物及校验清单保留14天。自动候选包和独立 push 诊断已取消；手动 **Android emulator startup diagnosis** 仍可选择当前源码或基线。模拟器通过不代表 HyperOS 真机验收完成。本次安卓修改不会触发 Windows 或 macOS 构建；桌面历史版本可继续从既有 Release 下载。

首次准备 Android 签名时，先在仓库添加高熵 `ANDROID_KEYSTORE_PASSWORD` secret，再从 `main` 手动运行 **Initialize Android release keystore**。下载一天后过期的密码保护 PKCS#12 artifact，私下备份，并立即删除该 artifact 和初始化 run；该 artifact 本身不是私密的。用 Windows PowerShell 将备份 keystore 编码到剪贴板，然后只需再设置 `ANDROID_KEYSTORE_BASE64` secret。固定别名是 `openwebui-client`，key password 复用 `ANDROID_KEYSTORE_PASSWORD`，不需要另外两个冗余 secret。不要把密码或 keystore 发到聊天或提交到仓库。初始化只需运行一次；已有 Base64 keystore 时 workflow 会拒绝重生成。

密钥初始化和签名发布步骤详见[构建与签名说明](docs/GITHUB_ACTIONS.md)。

## Android 个性化外观与对话目录

连接服务后，顶部设置面板中的“外观与阅读”提供两个独立开关。新服务默认关闭，配置按服务 origin（协议、主机及非默认端口）保存在当前手机，不同步到账号。

外观支持原生蓝、青灰、暖砂和不透明阅读预设、跟随系统/浅色/深色、本地 JPEG/PNG/WebP 选图、渐变/纯色、裁切位置与缩放、静态模糊、遮罩、面板透明度、强调色、聊天字号及行距。选图上限20MB，处理后长边不超过2560px；只保存应用私有副本，不上传到服务。参数实时预览，点“应用”保存；取消恢复进入前的配置，恢复默认也需要应用确认。修改外观不会重载聊天页面。

启用对话目录后，顶部出现48dp目录入口。底部面板按当前网页已加载的用户提问排列，支持摘要查找与跳转；不会请求完整历史或切换分支，摘要仅留在内存中。

网页样式和消息定位适配器参考固定 Open WebUI 源码结构，详见[兼容样例](scripts/fixtures/personalization/README.md)。识别失败、登录或管理页面保持原网页；可随时关闭外观恢复网页样式。客户端原生外观层不提供第三方插件、任意脚本/CSS、动态壁纸或远程图库；DIY 网页自身的壁纸能力属于独立前端实现，不能混同为原生层已验收。浏览器样例验证不等于 Android/HyperOS 真机验收。
