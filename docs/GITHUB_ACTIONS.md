# GitHub Actions 与 Android 发布

共同进度见 [PROJECT_STATUS.md](PROJECT_STATUS.md)，跨仓库步骤见 [CLOUD_DEVELOPMENT.md](CLOUD_DEVELOPMENT.md)。本文仅描述当前配置；旧 build.yml、candidate/release 二选一、三端同步发版和自动模拟器流程均已退出当前主线。

## 当前入口

| 工作流 | 触发与用途 |
|---|---|
| Pull request quick checks / quality.yml | PR 源码、Node/Python 回归、版本、Rust 格式和工作流语法；不使用正式签名密钥，不编译 APK |
| Sync verified frontend and build / frontend-sync.yml | main push、定时或手动；等待前端 Release，校验/提交版本锁，显式派发 android.yml |
| Android APK release / android.yml | main 的 workflow_dispatch；自动 patch bump、固定源码、ARM64 编译与签名发布 |
| Android emulator startup diagnosis | 可选手动启动诊断；不属于正式 APK 发布门禁 |
| Android layout and bundled frontend diagnosis | 可选布局/内置前端诊断，按其工作流允许的来源执行；不宣称等同真机 |
| Initialize Android release keystore | 仅首次准备固定签名身份；已有密钥禁止重新生成 |

日常只需本地编辑/推送；前端仓库先发布成功，后端和 APK 再各自构建。PR 是检查和审查载体，真正连接仓库的是前端 Release、frontend.lock.json 和 Actions。Codespaces 不参与这条主线，当前暂停使用。

## 正式 APK 门禁

1. 第一次运行检查当前前端发布与锁文件一致；同 run 重试保留原已准备版本。
2. 验证已有 PKCS#12、别名和密码，才允许版本准备。
3. 自动递增 patch，同步 package、Cargo、Tauri 和锁文件，通过 non-force 更新 main；后续质量检查和构建固定到这份源码。
4. 下载并校验锁定前端；构建 Android ARM64 签名 APK，运行 connection-controls 原生单元测试。
5. 检查证书指纹、package ID、minSdk、ABI、版本/versionCode、源码身份与产物 SHA256。
6. 所有门禁成功后，按成功 artifact ID 收集包，创建 tag、APK 和 SHA256SUMS 的公开 Release。

不构建当前版本 Windows/macOS，不默认启动模拟器。网页浏览器检查、模拟器结果和真实手机验收各自独立。产物未经验证时只可保留为明确标记的 UNVERIFIED 内部诊断材料，不能当作正式包安装分发。

## 版本与重试

- 版本一致性命令：`npm run version:check`。CI 在实际发布时递增 patch。
- Android release versionCode 为 `100000 + android.yml 的 github.run_number`；debug 源码占位值为2。旧历史版本使用过不同基数，不再用旧公式解释新 APK。
- 相同 run 的重试复用原版本、版本提交和 versionCode。新 run 递增；不要通过新建 run 反复替代原失败 job 重试。
- 公开 Release 的 tag 和资产不可被重跑替换；源码变更应走新版本。
- main 发布串行，运行中版本不取消；未准备版本且已过期的来源可能跳过。定时同步去重，不反复重试同一失败 run。
- 当前同步器未普遍排除文档提交，不能再承诺“文档 main push 只快检、绝不发版”。
- 通过验证的正式内部 artifact 及清单保留14天；临时 artifact 不是长期下载入口。下载见 [最新 Release](https://github.com/Mike666wq/open-webui-client/releases/latest)。

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


## 构建环境

Android 使用 Ubuntu 22.04、Node 22.22.0、Rust 1.94.0、Temurin JDK25、Android Platform36、Build Tools36.0.0、NDK28.2.13676358、aarch64-linux-android。依赖按 npm/Cargo 锁文件安装；minSdk29。实际升级应以 android.yml 和版本锁为准，不把文档当作自动升级配置。

## 验收与历史

[run 39722809500](https://github.com/Mike666wq/open-webui-client/actions/runs/39722809500) 成功发布 [v0.2.31](https://github.com/Mike666wq/open-webui-client/releases/tag/v0.2.31)，证明对应提交通过构建、原生测试、签名和包完整性门禁。它不证明 Redmi/HyperOS 启动、真实服务、多设备或所有 SAF provider 已验收。

Windows/macOS 既有历史包继续保留；当前流程不重建它们，也没有正式桌面签名、公证或商店分发。历史三端流程可在 [旧文档快照](https://github.com/Mike666wq/open-webui-client/blob/2edd1164404a4049056c6d404176ad6f28557ff4/docs/GITHUB_ACTIONS.md) 查阅，不能作为当前运行步骤。人工验收见 [ACCEPTANCE.md](ACCEPTANCE.md)。
