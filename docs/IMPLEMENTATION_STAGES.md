# 当前实施阶段与历史边界

核对日期：2026-10-22。三仓库共同状态见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。本文件不再把历史三端/candidate 规则当作当前流程。

## 已建立的代码与交付能力

| 领域 | 当前已有实现/验证 | 剩余边界 |
|---|---|---|
| 客户端基础 | Tauri2、连接设置、原生 Android 顶部栏/面板、受限保存桥、内置 DIY 前端 | 真实服务与所有设备人工验收 |
| 前端 | 外观/壁纸/目录/资源页面源码及单元、构建、移动 Chromium 检查 | 全站覆盖与真实交互验收不能仅凭模块存在判定完成 |
| 后端 | 资源 API、模型、迁移、生命周期用例、SQLite/PostgreSQL 检查及 GHCR 多架构镜像 | 真实多人并发、生产副本、迁移与磁盘回收 |
| 串联发布 | 前端 Release → 下游版本锁 → 后端镜像与 Android APK 并行，已有完整成功记录 | 每次新前端仍需等待对应下游成功；同步绿灯不等于构建完成 |
| 原生外观与目录 | 可选设备本地配置、已加载问题目录、相关原生/脚本测试 | 不等于全部网页重构或 HyperOS 真机验收 |
| Codespaces | 保留轻量环境配置尝试 | 创建曾磁盘不足，后续软件源签名阻断 Docker；暂停，未验收可用 |

## 当前正式发布规则

PR 快检；main push 先同步已发布前端，再显式 dispatch Android-only 发布。发布校验固定 keystore，自动递增 patch，固定源码 SHA，运行编译/原生测试/签名与包完整性检查，最后创建 Release。release versionCode 为100000加 android.yml 的 run_number，同一 run 重试保持不变。桌面和模拟器不属于当前默认发布任务。

已完成证据包括 [Android run 39722809500](https://github.com/Mike666wq/open-webui-client/actions/runs/39722809500)、[后端 run 39722585622](https://github.com/Mike666wq/open-webui-backend/actions/runs/39722585622)、[前端 run 39721953479](https://github.com/Mike666wq/open-webui-frontend/actions/runs/39721953479)。这些是对应源码的历史基线，不覆盖未来提交。

## 当前开发与人工验收

本地编辑和推送，GitHub 承担重型构建和自动检查；人工在独立测试服务查看网页，手机安装正式 APK。可选本地热更新不是交付前提。生产服务器不会自动切换，Codespaces 当前不作为入口。

下一步仍需记录：HyperOS 退出问题、手机升级/连接/返回/键盘/旋转、SAF provider、真实模型、长会话和多人多设备、生产副本迁移与恢复。验收标准见 [ACCEPTANCE.md](ACCEPTANCE.md)。

后台通知、自动更新、正式桌面签名、公证、商店分发和全部生产迁移尚未完成。Windows/macOS 曾有成功历史包，不因此宣称当前版本桌面已重新编译或真机通过。

## 历史实施记录

原阶段一至四、v0.2.2 三端发布与早期诊断记录保留在 [原文件快照](https://github.com/Mike666wq/open-webui-client/blob/2edd1164404a4049056c6d404176ad6f28557ff4/docs/IMPLEMENTATION_STAGES.md)。旧 build.yml、candidate 模式、1000加 run_number、系统返回直接回设置页及“正在构建”的记录仅对应历史阶段，不再是当前操作要求。

当前签名与发布操作见 [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)；运行机制见 [CLOUD_DEVELOPMENT.md](CLOUD_DEVELOPMENT.md)。
