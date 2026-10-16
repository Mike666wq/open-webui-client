# 验收清单

## CI 构建验收

- [ ] 手动运行 workflow，选择 `desktop`，Windows x64 与 macOS Apple Silicon jobs 均成功。
- [ ] Actions 中出现 NSIS setup.exe 与一份 Apple Silicon DMG，文件名含版本和架构。
- [ ] push/Pull Request 的 Android debug 编译检查成功；该 job 不上传 APK，也不代表 release APK 已验收。
- [ ] 手动选择 `android` 运行：缺少任一签名 secret 时，Android release job 明确失败，不会产出可交付的 debug APK。
- [ ] 配齐签名 secrets 后，Android ARM64 job 生成 release APK，文件名含版本及 `android-arm64`。
- [ ] 输入 `all` 时桌面与 Android jobs 独立运行，Android secrets 缺失不会阻断桌面 jobs。
- [ ] 首次在无 `Cargo.lock` 的分支运行后，检查新增提交只包含 `src-tauri/Cargo.lock`；PR 缺锁时失败并指向该引导步骤。

## 真实设备验收

以下检查必须在目标设备上完成并记录系统版本、设备型号、应用版本和结果。CI 产物存在不能替代这些检查。

- [ ] Windows 10 与 Windows 11 x64 安装、首次启动、卸载；在没有预装 WebView2 Runtime 的干净环境检查离线运行时安装。
- [ ] macOS 12+ Apple Silicon 挂载、安装并启动 DMG；记录 ad-hoc 签名首次运行时的系统提示。
- [ ] Android 10+ ARM64 安装签名 APK、启动、卸载；确认签名证书与预期固定 keystore 一致。
- [ ] 客户端能够解析 `mint` 并访问 `http://mint:3000`，完成 Open WebUI 登录及至少一次对话。
- [ ] Android 验证 `mint` 的 HTTP 可访问，同时其他主机的 HTTP 请求不会被该明文例外放行。
- [ ] 检查断网、服务不可用时的错误反馈，以及重新连接后的恢复。

## 当前明确不验收的功能

阶段一不提供 HTTPS 或自定义 URL、后台通知、自动更新，也不提供 macOS 公证或 Windows 商业签名。相关功能不能描述为已实现或通过验收。
