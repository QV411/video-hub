<p align="center">
  <img src="app-icon.png" width="88" height="88" alt="video-hub 图标" />
</p>

<h1 align="center">video-hub</h1>

<p align="center">一个通过插件连接内容的通用视频播放器。</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="https://minireel.github.io/HGhub/">在线文档</a> ·
  <a href="docs/developers/index.md">插件开发</a> ·
  <a href="docs/DEVELOPMENT.md">参与开发</a> ·
  <a href="https://github.com/Minireel/HGhub/issues">反馈问题</a>
</p>

video-hub 将浏览、搜索、播放和个人片库放在同一个应用中。通过导入 JavaScript 插件，你可以接入不同内容来源，并使用统一的界面观看与管理内容。

**应用不内置内容源，不分发第三方插件，也不提供官方源列表。** 首次使用需自行导入插件，无需注册 video-hub 账号；来源要求登录时，由对应插件提供登录入口。

## 核心体验

- **沉浸式播放**：桌面与移动端界面，配合手势和播放控制，在面板中查看详情、选集与评论。
- **多来源浏览与搜索**：推荐、分类筛选和聚合搜索，支持按来源查看结果，并保留本地搜索历史。
- **灵活的播放选择**：支持 HLS 与普通视频，切换线路、清晰度和解析器，也可搜索其他来源继续观看。
- **自己的片库**：管理本地收藏、观看历史与续播进度；支持追更，以及将插件提供的云端列表导入本地收藏。
- **按需扩展**：通过文件、网址或插件列表导入内容源与解析器，检查更新，并在更新失败时恢复上一可用版本。
- **更多内容形式**：除点播外，还可通过插件接入直播、信息流和图文内容。

具体内容、账号、评论与互动能力取决于所安装的插件。

## 开始使用

插件版处于早期开发阶段，目前可[从源码运行或构建](docs/DEVELOPMENT.md)。当前重点完善 Windows 与 Android，其他平台仍在适配和验证；详见[支持状态](docs/developers/status.md)。

1. 打开 **插件中心 → 导入与订阅**。移动端从“我的”进入插件中心。
2. 选择插件文件、粘贴代码，或输入插件／列表网址；确认安装并启用。
3. 从首页、搜索或分类找到内容，开始播放。需要切换首页来源时，可在设置中选择。

video-hub 维护播放器与插件接口，第三方内容的可用性由相应来源决定。

## 工程现状（七阶段改造）

本仓库在 HPP 插件架构之上完成了七个阶段的落地改造，详见对应维护文档：

- **阶段一**：移除应用内的自动更新检查链路。
- **阶段二**：移植离线下载功能与下载板块，并基础化为核心模块：下载中心并入主导航，事件推送替代前端轮询，
  补齐重启恢复与退出收尾；任务经插件公开 API 获取详情与播放地址，清单、分片、密钥字节全部走插件受控网络；
  Android 公共下载目录与所有文件访问授权（未授权回退应用专属目录）；内置 arm64 FFmpeg
  将 TS 流拷贝转封装为 MP4（可配置保留 TS），桌面内置优先、PATH 兜底，不做运行时下载；
  见 [`docs/PHASE2-DOWNLOAD.md`](docs/PHASE2-DOWNLOAD.md)。
- **阶段三**：把 HGhubX 播放源改造为内置 QuickJS 插件，支持 HGhub 方式与 HGhubX 方式双启动
  模式，并在插件中心提供线路管理分段；见 [`docs/PHASE3-PLAYSOURCE.md`](docs/PHASE3-PLAYSOURCE.md)。
- **阶段四**：交叉编译构建可安装的 Android APK（arm64-v8a，debug 与已签名 release），
  基础清单仅声明 INTERNET 权限，四项安全红线原样生效；见 [`docs/PHASE4-ANDROID.md`](docs/PHASE4-ANDROID.md)。
- **阶段五**：项目更名 video-hub、更换应用图标并重建 aarch64 的 debug / release 双 APK；桌面 identifier 与
  Android applicationId 同步迁移，内部 Rust crate 名保持不动；见 [`docs/PHASE5-REBRAND.md`](docs/PHASE5-REBRAND.md)。
- **阶段六**：对照上游补齐 HGhubX 模式分类能力（固定频道、排序/原创子分类筛选、专题与标签落地页、
  吃瓜列表），优化线路面板健康状态、手动/自动选线、自定义线路编辑与加载/错误态；并补齐封面
  受控代理解密、排行榜入口与频道封面横滑布局；启动方式搬迁至"我的 → 启动方案"并拆为首页/分类
  两个独立方案维度（旧 `startMode` 自动迁移），新增 HGsky 首页专用渲染器与 `skyhome.feed`
  扩展方法；固定线路支持增/删/改与一键恢复默认，镜像线路区支持自动发现与手动补充，播放源面板
  按统一设计系统重设计；见
  [`docs/PHASE6-PLAYSOURCE-CATEGORIES.md`](docs/PHASE6-PLAYSOURCE-CATEGORIES.md)。
- **阶段七**：任务反馈修复收口——线路校验放宽与分类文案、发布页多条持久化、线路逐条独立
  探测、下载目录口径统一、所有文件访问授权链路加固、播放源与下载板块统一 vh 设计 token；
  并重建 aarch64 release / debug 双 APK 与源码包，完成权限 / 签名 / 原生库 / dex 证据留档；
  见 [`docs/PHASE7-FEEDBACK-FIXES.md`](docs/PHASE7-FEEDBACK-FIXES.md)。
- **阶段八**：对照 `911218sky/HGhub` 线路设计调研，把插件中心「播放源」分栏重塑为统一播放源板块——
  以入口列表聚合所有来源插件，内置「播放源」作为其中一个入口，点开按能力进入固定/镜像/自定义
  线路面板或标准站点线路；升级自定义线路支持可选备注名（与固定线路对齐，旧数据自动迁移）；
  线路面板补齐"当前：{host}"表头与游客/直连分组提示；见 [`docs/PHASE8-PLAYSOURCE-HUB.md`](docs/PHASE8-PLAYSOURCE-HUB.md)。

### 设计语言

- 界面基于统一 vh 设计 token（间距 / 圆角 / 字号字重 / 表面 / 状态 / 品牌锚点），播放源与下载板块共用同一套卡片、行与状态样式；候选比较、选定理由、token 映射与取舍见
  [`docs/DESIGN-LANGUAGE.md`](docs/DESIGN-LANGUAGE.md)。

### QuickJS 沙箱与受控网络

- 每个内容源是独立的 QuickJS 插件：独立 Runtime/Context、独立线程、调用预算、超时、
  中断、持久存储与 Cookie 罐；插件只返回结构化数据，宿主 React 负责渲染。
- 插件网络只能通过 `hg.http.fetch` 进入 hpp 受控 `Network`：严格 `network_policy`、
  每插件独立 Cookie 罐、代理与重定向逐跳校验；不存在绕过策略的裸客户端通道。
- 插件不获得 DOM、文件系统或 WebView 桥；扩展方法在声明清单内注册，复用同一套沙箱、
  预算与中断语义。

### 权限清单与零新增理由

- Tauri 能力清单固定在 [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json)，
  仅保留 `core:default` 与窗口基础操作权限；各阶段改造均**未新增任何 Tauri 权限**。
- 下载目录选择、文件打开等能力复用已初始化的 dialog / fs / opener 插件；线路管理与
  插件调用全部经既有 `hpp_manage` 命令通道，未新增外层 Rust 命令。
- CSP 配置在 `src-tauri/tauri.conf.json` 中保持不变；不引入 eval、内联脚本、远程脚本
  或远程图片源，封面经插件 `assets.prepare` 取本地地址。
- Android Manifest 中的 `MANAGE_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`（maxSdk 28）
  属系统 manifest 权限（下载目录访问，用户显式要求），不是 Tauri capability；未计入上述能力清单。

### 构建与运行

基础环境：Node.js 22、pnpm 10、Rust 1.90 或更高版本，以及目标平台 Tauri 开发环境。

```bash
pnpm install --frozen-lockfile
pnpm dev          # 前端开发
pnpm app:dev      # 桌面应用开发
pnpm build        # 前端类型检查与构建（tsc 双配置 + vite）
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml
```

### 已知限制

- 离线成品在播放器内回放的 `offline:` 协议通道留待后续阶段。
- 下载器未覆盖 BYTERANGE 清单与插件 `transformResource` 密钥变换链路。
- HGhubX 渲染器覆盖首页、搜索、分类与排行榜独立页；话题等其余扩展方法已在插件侧预留，宿主暂未提供独立页面。
- HGsky 本阶段仅移植首页竖滑视图（`skyhome.feed` + `HgskyHome`）；内联互动面板、HGsky 分类频道与搜索未独立渲染，分类/搜索跟随分类方案维度。
- 发布页镜像在沙箱内以保守的 JS 数据解析提取，不执行远端 JS；上游页面结构调整时镜像列表可能为空。
- Android 仅打包 `arm64-v8a` 一个 ABI；armeabi-v7a / x86_64 未随包提供。
- 当前开发环境无 Android 真机：所有文件访问授权三级跳转、返回后状态刷新、公共目录写入与
  内置 FFmpeg TS→MP4 转封装均为静态代码路径核对与构建产物证据，真机表现待安装后复核
  （清单见 [`docs/PHASE7-FEEDBACK-FIXES.md`](docs/PHASE7-FEEDBACK-FIXES.md) 第 5 节）。
- 桌面端内置 FFmpeg 二进制尚未由发布打包流程放置到应用目录；当前以系统 PATH 中的 `ffmpeg` 兜底，未检测到时保留 TS，不做运行时下载。
- 上游 SSR 频道页 / 热播榜的 DOM 抓取运行在宿主 Rust 侧，插件沙箱无 DOM、不能自行抓 HTML，频道/榜单数据统一走 JSON 回退口径；帖子详情与标签聚合未移植（详见 [`docs/PHASE6-PLAYSOURCE-CATEGORIES.md`](docs/PHASE6-PLAYSOURCE-CATEGORIES.md) 第 8 节）。

## 文档

**[打开在线文档站 →](https://minireel.github.io/HGhub/)**

| 我想…… | 从这里开始 |
| --- | --- |
| 制作一个内容源或解析器插件 | [插件开发教程](docs/developers/index.md) |
| 了解插件文件、宿主 API 与内容模型 | [HPP 插件协议](docs/plugin-protocol/README.md) |
| 让 Agent 协助开发插件 | [Agent 开发指南](docs/developers/agent.md) |
| 修改客户端或自行构建 | [客户端开发指南](docs/DEVELOPMENT.md) |
| 查看已支持与待完善的能力 | [支持状态](docs/developers/status.md) |

客户端使用 **Rust · Tauri 2 · React · TypeScript** 构建。HPP 插件协议仍在演进，编写插件前请阅读当前支持状态。

## 参与、交流、贡献

欢迎通过 [Issues](https://github.com/Minireel/HGhub/issues) 反馈问题、提出想法，或提交 [Pull Request](https://github.com/Minireel/HGhub/pulls) 参与改进。报告问题时，请附上应用版本、操作系统和复现步骤。

项目本身由我独立维护，维护者会根据时间与精力处理反馈，不承诺第三方插件或站点持续可用。维护范围与权益反馈方式见[项目声明](docs/PROJECT_POLICY.md)。

video-hub 欢迎您的贡献，任何一个协议都需要大量、长久的踩坑、试错、经验总结，使它变的越来越完善。您的任何 Issues 与 PR 都对 video-hub 帮助良多！

社区交流：[Linux.DO](https://linux.do/)。

## 许可证与非商业立场

本项目源码公开，采用 [PolyForm Noncommercial 1.0.0](LICENSE)。**禁止商业用途**，包括销售、广告变现、卡密、VIP、付费解锁，以及作为收费产品或服务的一部分使用；具体以许可证全文为准。

维护者**不提供商业授权，不接受广告、推广或商务合作**，也未授权任何人以本项目名义收费。社区技术贡献与问题反馈不属于商务合作。

项目不运营内容托管服务，与外部内容提供者无官方隶属或背书关系。完整责任边界、维护政策与权益反馈说明见[项目声明](docs/PROJECT_POLICY.md)。
