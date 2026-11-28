# 阶段二：移植下载功能与下载板块

本文记录阶段二在 video-hub（Tauri 2 + React 19 + Vite 7 + Rust 桌面应用）中移植离线下载能力的全部改动、命令清单、网络接入方式与验证结果。

## 1. 改动文件清单

### 新增文件

| 文件 | 说明 |
| --- | --- |
| `src-tauri/src/download.rs` | 下载任务模型、单 worker 串行队列、`job.json` 清单、HLS 解析/下钻、分片顺序拉取、AES-128-CBC 解密、TS 拼接与 MP4 转封装，以及全部下载相关 Tauri 命令。 |
| `src/download.ts` | 前端下载命令封装与 `DownloadJob` 类型、字节格式化工具。 |
| `src/pages/Downloads.tsx` | 「下载」板块页面：1.5s 轮询、进行中/已完成分组、进度条、剧集网格、空态、目录管理与成品打开。 |
| `docs/PHASE2-DOWNLOAD.md` | 本说明文档。 |

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `src-tauri/crates/hpp/src/manager.rs` | `PluginManager` 新增公开方法 `host_fetch(plugin_id, request) -> Result<Value>`，经插件受控 `Network` 发起请求；二进制响应以 Base64 回传并标记 `dataBinary: true`。 |
| `src-tauri/src/plugins.rs` | `PluginHost` 抽出公开的懒加载 `manager(&AppHandle)`，供下载命令复用同一已初始化的插件管理器；`hpp_manage` 改为调用该方法。 |
| `src-tauri/src/lib.rs` | 注册 `download` 模块；setup 中 `manage(Arc<DownloadHost>)`；invoke_handler 注册 8 个下载命令。 |
| `src-tauri/Cargo.toml` | 仅新增 `aes = "0.8"`、`url = "2"`、`base64 = "0.22"`；未引入 rfd、zip 等其他依赖。 |
| `src/store.tsx` | `PageInput` 联合类型新增 `{ kind: "downloads" }`。 |
| `src/App.tsx` | 栈页面映射中渲染 `DownloadsPage`。 |
| `src/components/Feed.tsx` | `PlayerPanel` 新增 `download`；更多菜单加入「下载」入口；面板标题表加入「下载」。 |
| `src/plugins/PluginMediaDetail.tsx` | 新增 `DownloadPickPanel` 选集面板与提交逻辑；播放器 `panels` 传入 `download`；提交后跳转下载页。 |
| `src/plugins/ApplicationSettings.tsx` | 「本地数据」分组加入「下载管理」入口，进入下载板块。 |

## 2. 新增 Tauri 命令

| 命令 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `download_start` | `pluginId, mediaId, episodeId?, playlistId?, ep?, mode("episode"\|"series")` | `DownloadJob` | 详情与播放地址分别经插件 `media.getDetail` / `media.resolvePlayback` 获取；入参不接受任何前端传入的播放 URL。 |
| `download_list` | — | `{ items: DownloadJob[], dir: string }` | 合并内存任务与磁盘 `job.json` 清单，回填成品路径、大小与已缓存集数。 |
| `download_delete` | `pluginId, mediaId, ep?` | `{ ok: true }` | 删除整剧目录或单集目录；路径经 canonicalize 前缀校验。 |
| `download_dir` | — | `{ dir: string }` | 当前下载根目录。 |
| `download_pick_dir` | — | `string \| null` | 经已初始化的 `tauri_plugin_dialog` 阻塞选择文件夹；移动端返回不支持错误。 |
| `download_reset_dir` | — | `{ dir: string }` | 清除自选目录配置，回到默认根目录。 |
| `download_open_dir` | — | — | 经 opener Rust API 打开下载目录。 |
| `download_open_file` | `pluginId, mediaId, ep?` | — | 经 opener Rust API 打开成品文件；路径前缀校验后打开。 |

### 任务模型要点

- 任务键：`series:<pluginId>:<mediaId>` / `ep:<pluginId>:<mediaId>:<ep>`。
- 默认下载根目录：`<app_data>/downloads`；自选目录持久化在 `<app_data>/download_dir.json`。
- 任务状态：`queued` / `running` / `done` / `error`；单 worker 串行队列，整剧任务按集顺序处理。
- 文件名与目录名过滤路径分隔符、控制字符与 `..`；所有读写/删除/打开路径先 canonicalize 并校验仍位于下载根目录之内。

## 3. 网络如何接入 hpp 受控通道

阶段二下载链路不存在任何独立的 reqwest 客户端，全部流量可追溯到 hpp 受控网络：

1. **元数据与播放地址**：外层下载命令通过 `PluginManager::call` 调用插件公开方法：
   - `media.getDetail`（入参 `{ id }`）：取标题、封面、分集列表；
   - `media.resolvePlayback`（入参 `mediaId / episodeId / playlistId? / reason`）：取播放流与流头。
2. **字节下载**：播放清单、变体清单、分片、AES-128 密钥字节全部通过新增的 `PluginManager::host_fetch` 抓取。该方法内部：
   - 经现有 `pub(crate) network()` 取出该插件自己的 `Arc<Network>`（严格策略、每插件 Cookie 罐、代理、逐跳重定向校验自动生效）；
   - 新建 `CancellationToken`；
   - 调用 `network.fetch(Transfer::from_json(request), token)`；
   - 请求体沿用受控请求形状：`method / url / headers / credentials / responseType="bytes" / maxBytes`。
3. **字节回传**：`Transfer::Bytes` 没有 JSON 形态，`host_fetch` 将其 Base64 编码到 `data` 字段并置 `dataBinary: true`；文本/JSON 响应保持原 `data` 不变。外层 `fetch_bytes` 按标记解码。

> 红线复核：`src-tauri/src/download.rs` 中没有 `reqwest::Client`、没有绕过 `network_policy` 的通道；QuickJS 运行时机制未改动，宿主侧只调用其公开 API。

## 4. capabilities 与 CSP 为何零变化

- `src-tauri/capabilities/default.json` 一字未改：本阶段命令全部由 Rust 命令层处理，目录选择使用已初始化的 `tauri_plugin_dialog`（Rust 侧阻塞调用，不经过需要权限声明的 JS 命令通道）；文件打开复用已初始化的 opener 插件；文件读写限定在应用数据目录与用户选定目录内。
- `src-tauri/tauri.conf.json` 的 CSP 未改动：封面图不允许 WebView 直连远程地址。下载板块封面优先经插件 `assets.prepare`（`src/plugins/client.ts` 既有封装）换取本地 `hg:` 地址，准备失败时用下载图标占位；页面没有新增远程脚本、内联脚本或远程图片源。

## 5. FFmpeg 裁剪决策

来源仓库的 `ffmpeg_tool.rs` 中「裸连 GitHub 自动下载便携版 FFmpeg」链路已移除，阶段二只保留本地探测：

1. 应用工具目录：`<app_data>/tools/ffmpeg/ffmpeg(.exe)`，存在则优先使用；
2. 系统 PATH 中的 `ffmpeg`：`ffmpeg -version` 探测成功后使用；
3. 探测到可用 FFmpeg 时，用固定参数数组转封装 MP4：
   `-y -hide_banner -loglevel error -i <video.ts> -c copy -bsf:a aac_adtstoasc <video.mp4>`；
4. 找不到 FFmpeg 时保留 `video.ts` 成品，任务消息注明「未检测到 FFmpeg，无法转封装 MP4」。

未引入 zip 解压、未引入 rfd 目录对话框、未在运行时下载任何二进制。

## 6. 前端交互

- **下载页**：1.5 秒轮询 `download_list`；进行中（`queued/running/error`）与已完成（`done`）分组；进度条、任务消息、成品大小；整剧任务展开分集网格，已缓存集数可直接打开文件，未缓存集数禁用；空态使用本模块内自建的轻量占位组件（未向 `ui.tsx` 回写通用组件）。
- **播放器选集面板**：`DownloadPickPanel` 移植来源仓库的交互——全选/单选、集数网格、整剧入口；整剧归并规则：勾选覆盖 `1..N` 连续全集时按整剧任务提交，否则按选中集逐集提交；提交成功后 `app.push({ kind: "downloads" })` 跳转下载页。
- 文案全部使用中文，未引入 i18n 框架。

## 7. 构建与验证

```bash
# 前端类型检查 + 生产构建（含 tsc）
pnpm build

# 外层 Rust 检查
export PATH="$HOME/.cargo/bin:$PATH"
cargo check --manifest-path src-tauri/Cargo.toml

# hpp 单测
cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml
```

阶段二执行结果：

- `pnpm build`：`tsc --noEmit`、`tsconfig.tests.json`、`vite build` 全部通过（仅有既有的 chunk 体积提示，与本阶段无关）。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过，无错误。
- `cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml`：全部通过，无失败用例，无被 ignore 的网络依赖用例。

## 8. 已知限制（留待后续阶段）

- 离线成品在播放器内的回放通道（`offline:` 资源协议、本地清单接入 hpp media 模型）不在本阶段范围；当前成品通过系统默认程序打开。
- HLS 解析覆盖标准 `#EXTM3U`、主清单下钻、`EXT-X-KEY`（AES-128，含显式 `IV` 与按序列推算 IV 两种规则）；带 BYTERANGE 的清单、插件侧资源变换（`transformResource`）链路未纳入本阶段下载器。
- 超过 8 MiB 的单片分片会被受控网络层的缓冲预算拒绝；常规 HLS TS 分片在此范围内。

## 9. 下载基础化改造（一等公民重构）

阶段二移植后下载功能呈「外围挂载」形态，本次将其夯实为核心模块：并入主导航、事件推送替代轮询、补齐重启恢复与退出收尾、设置页暴露真实可配项。合规红线（受控网络、路径前缀校验、无裸客户端、CSP/capabilities）原样保持。

### 9.1 改前审计结论

- **前端接线**：`src/pages/Downloads.tsx` 自持 `useState`，`setInterval(1500)` 轮询 `downloadList()` 与 `downloadDir()`；详情选集面板与设置入口不读取同一份任务状态。
- **导航**：下载仅是栈页 `{kind:"downloads"}`，不在桌面侧栏与移动底栏的主导航中；入口散落在设置页与详情面板。
- **持久化**：每任务一份 `job.json`，`save_manifest` 在每次状态更新时落盘；`download_dir.json` 仅存 `{dir}`。重启后磁盘上的 `queued`/`running` 不会重新入队，`running` 任务永久卡死；`done` 记录可查。
- **生命周期**：无退出钩子，worker 不 drain；分片 `std::fs::write` 直写目标文件，崩溃可能留下半写分片；`fetch_bytes` 无重试。
- **命令面**：8 个下载命令；没有读取/写入下载行为偏好的命令。
- **权限复核**：`core:default` 已捆绑 `core:event:default`（含 `allow-listen` / `allow-unlisten` / `allow-emit` / `allow-emit-to`），前端 `listen` 已在既有范围内，本阶段无需新增事件权限。

### 9.2 导航打通与共享状态源

- **主导航**：桌面侧栏新增「下载中心」栈按钮（与插件中心、设置同级）；移动底栏新增第五项「下载」，以 `push({kind:"downloads"})` 进入同一栈页。播放器/详情侧的下载入口保留，不另起状态。
- **共享 store**：新增 `src/downloadStore.tsx`，在 App 根以 Provider 挂载：启动时一次性拉取持久化清单作为初始状态，随后订阅事件做增量 upsert / remove。下载中心页、详情选集面板、设置页共用同一 `jobs` / `dir` 状态源，不存在第二份轮询副本。

### 9.3 事件模型

| 事件名 | payload | 触发时机 | 节流策略 |
| --- | --- | --- | --- |
| `download:job` | `{ action: "upsert" \| "remove", job: DownloadJob }` | 任务新增、状态迁移、分片进度更新、任务删除 | 新增、状态迁移（`queued→running/done/error/interrupted`）与删除立即推送；进度更新按任务 600 ms 内至多推送一次（`last_emit` 节流表） |
| `download:dir` | `{ dir: string }` | 下载根目录被自选或重置 | 立即推送 |

- 前端订阅后增量合并：`upsert` 按任务键替换或追加，`remove` 按任务键剔除；初始全量仍来自 `download_list`。
- Rust 侧经 `AppHandle::emit`（`emit_all`）广播到 WebView，不使用 `emit_to` 指向远端。

### 9.4 capabilities 与 CSP 变更理由

- **零新增权限**：`src-tauri/capabilities/default.json` 未改动。前端 `listen` 命中既有 `core:event:default` 的 `allow-listen`；Rust `emit` 属于宿主侧广播，不占 WebView 命令权限。未开放 `emit-to` 远端，未新增 fs / dialog 命令权限。
- **CSP 未改动**：`src-tauri/tauri.conf.json` 保持原样；事件通道不引入新的远程脚本、内联脚本或远程图片源。

### 9.5 持久化与生命周期语义

- **配置结构**：`download_dir.json` 升级为 `{ dir: Option<string>, retries: u8 }`；旧版仅含 `{dir}` 的文件按 serde 默认值兼容读取，`retries` 缺省为 1。
- **启动恢复**（`bind()` → `restore()` 扫描下载根目录下全部 `job.json`）：
  - `done` / `error` / `interrupted`：原样保留，进入历史记录可查；
  - `queued`：重建队列任务重新入队；管理器句柄延迟到 worker 运行时经 `PluginHost::manager(&app)` 解析；
  - `running`：应用退出时未完成，统一标记 `interrupted`，消息为「应用退出时下载中断，可重新下载」。不自动断点续跑——源清单与分片地址可能已过期，半成品分片由用户删除后重新下载。
- **退出收尾**：`RunEvent::ExitRequested` / `Exit` 回调中调用 `DownloadHost::shutdown()`：置 `stopping` 标志，worker 不再取新任务，`persist_all()` 遍历内存任务把清单落盘；不留未保存的内存状态。
- **原子写**：分片与本地清单先写 `name.tmp` 临时兄弟文件，再 `rename` 覆盖目标；中途崩溃不会在成品目录留下半写文件。
- **失败重试**：清单、变体清单与分片拉取按 `retries + 1` 次尝试，耗尽后置 `error`。重试为立即重试，不引入退避定时器——Cargo 中 tokio 仅启用 `sync` feature，未追加 `time` feature。

### 9.6 设置项清单

| 设置项 | 命令 | 取值 | 说明 |
| --- | --- | --- | --- |
| 下载目录 | `download_pick_dir` / `download_reset_dir` / `download_open_dir` | 绝对路径；缺省 `<app_data>/downloads` | 桌面端可选目录、打开目录、恢复默认；移动端不支持选择文件夹，UI 隐藏「更改 / 默认」按钮，仅保留打开目录（`download_get_settings` 返回 `mobile: true`）。 |
| 分片失败重试 | `download_set_retries` | `0–3`，默认 `1` | 每个分片或清单拉取失败后的额外重试次数，入参 clamp 到 `0..=3`。 |

**未暴露的偏好**（后端无对应能力，不为开关虚构实现）：

- **并发数**：后端为单 worker 串行队列，没有并行下载池；
- **自动开始**：任务按需立即入队启动，没有「加入队列后手动开始」的偏好开关。

### 9.7 命令面（本次新增 2 个，原 8 个保留）

| 命令 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `download_get_settings` | — | `{ dir, defaultDir, retries, mobile }` | 当前目录、默认目录、重试次数与是否移动端。 |
| `download_set_retries` | `retries: u8` | `{ retries }` | 写入重试次数并持久化到配置文件，clamp `0..=3`。 |

### 9.8 本次改动文件

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/download.rs` | 配置结构与持久化、`bind/restore/shutdown/persist_all`、事件 emit 与 600 ms 节流、重试、原子写、`interrupted` 状态、两个新命令；worker 停止标志与延迟管理器解析。 |
| `src-tauri/src/lib.rs` | setup 中绑定 DownloadHost 句柄；注册两个新命令；`build(...).run(callback)` 在退出事件中收尾。 |
| `src/download.ts` | `DownloadJob.status` 补 `interrupted`；事件 payload 与设置类型；两个新命令封装。 |
| `src/downloadStore.tsx` | 新增：App 级共享下载状态，初始清单 + 事件订阅增量合并。 |
| `src/pages/Downloads.tsx` | 移除 1.5 s 轮询，改读共享 store；分组改为「进行中 / 历史记录」；中断态展示；移动端目录选择按钮降级。 |
| `src/App.tsx` | 挂载 `DownloadProvider`；移动底栏新增「下载」入口。 |
| `src/components/DesktopChrome.tsx` | 桌面侧栏新增「下载中心」导航项与高亮态。 |
| `src/plugins/ApplicationSettings.tsx` | 新增「下载」分组：目录操作与重试次数选择器。 |
| `src/plugins/PluginMediaDetail.tsx` | 选集面板读取共享 store，展示当前任务状态。 |

### 9.9 验证结果

- `pnpm build`：`tsc --noEmit`、`tsconfig.tests.json`、`vite build` 全部通过（仅既有 chunk 体积提示）。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过，无错误、无新增警告。
- `cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml`：9 个单测全部通过，无回归。
- 本阶段不重建 APK，APK 留待后续阶段统一构建。

## 10. 任务 D：Android 下载路径调整与分区存储权限

### 10.1 方案概述

Android 10+ 分区存储（scoped storage）禁止应用直接向公共目录写文件；下载模块既有链路（分片直写路径、ffmpeg 子进程读写成对路径）依赖真实文件系统路径，无法用 SAF 文档树回调逐条改写。本阶段按最小可行方案落地：

1. 默认公共下载根目录改为指定的含 emoji / 数学粗体 Unicode 字符的文件夹，目录不存在时自动创建；
2. Manifest 按最小必要新增存储权限，应用内提供「授权所有文件访问」入口，跳转系统设置页；
3. 未授权时优雅回退到应用专属目录 `<app_data>/downloads`，设置页与下载中心明确标注当前生效目录与授权入口；
4. 桌面端保留既有用户自选目录逻辑，不受影响。

### 10.2 默认目录（逐码点核对）

常量定义于 `src-tauri/src/download.rs`：

```rust
#[cfg(target_os = "android")]
const ANDROID_PUBLIC_ROOT: &str = "/storage/emulated/0/1🇩𝝨/🇩短剧/HGHub";
```

逐码点（`U+` 十六进制）：

| 片段 | 码点 | 字符 | UTF-8 字节 |
| --- | --- | --- | --- |
| 🇩 | `U+1F1E9` | 区域指示字母 D | `f0 9f 87 a9` |
| 𝝨 | `U+1D768` | 数学粗体小写 Delta | `f0 9d 9d a8` |
| 🇩 | `U+1F1E9` | 区域指示字母 D | `f0 9f 87 a9` |
| 短 | `U+77ED` | — | `e7 9f ad` |
| 剧 | `U+5267` | — | `e5 89 a7` |

源文件该行 `od -An -tx1` 字节证据（节选，路径字符串部分）：

```text
2f 73 74 6f 72 61 67 65 2f 65 6d 75 6c 61 74 65 64 2f 30 2f 31
f0 9f 87 a9 f0 9d 9d a8 2f f0 9f 87 a9 e7 9f ad e5 89 a7 2f 48 47 48 75 62
```

> 说明：任务描述中的 `𝝨` 经原始消息码点核对为 `U+1D768`（MATHEMATICAL BOLD SMALL DELTA），不是 `U+1D6E8` 系列变体，也不是 `U+1DFA8`；源码与上表以实际写入字节为准。

### 10.3 权限策略（最小必要）

`src-tauri/gen/android/app/src/main/AndroidManifest.xml`（经 `scripts/sync-android-network.mjs` 幂等注入，`android init` 后重跑脚本即可恢复）：

| 权限 | 声明 | 用途 |
| --- | --- | --- |
| `android.permission.MANAGE_EXTERNAL_STORAGE` | 无 `maxSdkVersion` | Android 11（API 30+）所有文件访问；公共目录直写所需 |
| `android.permission.WRITE_EXTERNAL_STORAGE` | `android:maxSdkVersion="28"` | 仅 legacy ≤ API 28 安装使用；API 29+ 被忽略 |

- **未加 `requestLegacyExternalStorage`**：该属性只对 targetSdk ≤ 28 且 API 29 设备的旧包生效；本工程 targetSdk 为现代版本，API 29+ 不适用，声明了也无意义。
- **Play 商店政策说明**：`MANAGE_EXTERNAL_STORAGE` 在 Google Play 受特殊政策约束（需申报用途）。本项目为侧载分发，不经过 Play 上架审核；若未来上架 Play，需改为 SAF 文档树方案或提交所有文件访问用途申报。
- **Tauri capabilities 零新增**：这是 Android Manifest 系统权限，不是 Tauri capability；`src-tauri/capabilities/default.json` 与 `tauri.conf.json` 未改动。授权引导通过既有移动插件桥接（见 10.4），不新增 WebView 命令权限。

### 10.4 授权桥接、状态检测与回退

- **Kotlin 插件**：`src-tauri/android/StorageAccessPlugin.kt`（类名 `StorageAccessPlugin`，注册名 `storage-access`）：
  - `isManager`：API 30+ 返回 `Environment.isExternalStorageManager()`；≤ API 29 按 legacy 权限视为已授权；桥接失败按未授权处理；
  - `openAllFilesSettings`：`Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)` 跳转系统所有文件访问设置页。
- **Rust 桥接**：`src-tauri/src/android_storage.rs`（仅 `target_os = "android"` 编译），`AndroidStorage(PluginHandle<Wry>)`，`is_manager().await` / `open_settings().await`；非 Android 构建设备为桩。
- **根目录解析**：`DownloadHost::refresh_storage()` 每次读取设置/目录时刷新缓存的授权状态——
  - Android 已授权：公共根 `ANDROID_PUBLIC_ROOT`（`create_dir_all` 自动建目录）；
  - Android 未授权 / 桥接不可用：回退 `<app_data>/downloads`；
  - 桌面：用户自选目录，否则 `<app_data>/downloads`。
- **回退提示**：`download_get_settings` 返回 `externalDir`（公共目标目录）、`storageGranted`、`fallback`（当前是否处于专属目录回退态）；设置页在未授权时显示警示行与「授权所有文件访问」按钮，目录名后标注「应用专属目录」。

### 10.5 命令面与前端

| 命令 | 平台 | 说明 |
| --- | --- | --- |
| `download_get_settings` | 全部 | 改为异步；刷新授权状态后返回 `{ dir, defaultDir, externalDir, retries, mobile, storageGranted, fallback }`。 |
| `download_open_storage_settings` | Android 跳转 / 桌面空操作 | 打开系统所有文件访问设置页。 |
| `download_reset_dir` | 全部 | 异步；清空用户自选目录后重新走存储解析（授权态决定公共根还是专属回退）。 |
| `download_pick_dir` | 移动端 | 仍不允许任意选目录；文案更新为「移动端不支持任意选择目录；下载目录由系统授权状态决定」。 |

前端：`src/download.ts` 扩展 `DownloadSettings` 类型并封装 `downloadOpenStorageSettings()`；`src/plugins/ApplicationSettings.tsx` 新增未授权警示行与授权按钮；下载中心头部继续展示 `download:dir` 事件推送的当前生效目录。

### 10.6 桌面端不受影响

桌面（Windows / macOS / Linux）保留既有行为：`download_pick_dir` 系统目录对话框、用户自选目录持久化在 `download_dir.json`、`download_reset_dir` 恢复 `<app_data>/downloads`；`storageGranted` 恒为 `true`、`fallback` 恒为 `false`，`download_open_storage_settings` 为空操作。

### 10.7 红线自检（任务 D）

| 红线 | 自检结论 |
| --- | --- |
| CSP | `tauri.conf.json` 未改动。 |
| Tauri capabilities | `capabilities/default.json` 零新增；Manifest 权限属 Android 系统层，不走 capability 体系。 |
| QuickJS 沙箱 | 本阶段不涉及插件扩展方法；无新增沙箱桥。 |
| 受控网络 | 未新增任何网络通道；授权跳转是系统 intent，不经过网络栈。 |
| 路径前缀校验 | 回退目录仍在 `<app_data>` 内；公共根为常量前缀，用户不可通过自选目录注入（移动端不开放选目录）。 |

### 10.8 验证结果

- `pnpm build`：`tsc --noEmit`、`tsconfig.tests.json`、`vite build` 通过（仅既有 chunk 体积提示）。
- `cargo check --manifest-path src-tauri/Cargo.toml`：桌面目标通过，无错误。
- `cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml`：全部离线用例通过，0 失败。
- Android 目标编译留待任务 E 的 debug APK 抽包验证；本阶段不重建最终 APK。

## 11. 任务 E：下载板块内置 FFmpeg（TS→MP4 转封装）

### 11.1 方案概述

离线成品流水线在解密合并出 `video.ts` 之后，追加一步 **流拷贝转封装（remux，不转码）** 生成 `video.mp4`；转封装失败或检测不到 FFmpeg 时保留 TS 成品，不阻断下载任务。参数沿用任务 A 留档调研结论（`docs/handoff/mp4-ffmpeg-research.md` §3.3）：

```
ffmpeg -y -hide_banner -loglevel error -i video.ts \
  -c copy -bsf:a aac_adtstoasc video.mp4
```

- `-c copy`：音视频流拷贝，不重编码，速度快、无质量损失；
- `-bsf:a aac_adtstoasc`：把 TS 内 AAC 的 ADTS 头改写为 MP4 所需 ASC 头；
- 成功判定：进程退出码成功 **且** `video.mp4` 落盘；任一不满足回退 TS。

Android 将 FFmpeg 打包为 jniLib；桌面端按「内置优先 → PATH 兜底」探测；**两端都不做应用内运行时下载 FFmpeg**（见 11.5、11.8）。

### 11.2 来源、版本与许可合规

| 项 | 值 |
| --- | --- |
| 来源仓库 | `tqk2811/FFmpegBuild`（GitHub Release） |
| 发布标签 | `Release-Android-2026-08-06` |
| 包文件 | `ffmpeg-n6.0.1-130-g32291d4ac3-android-arm64-v8a-lgpl2-shared-full.tar.xz` |
| 下载 URL | `https://github.com/tqk2811/FFmpegBuild/releases/download/Release-Android-2026-08-06/ffmpeg-n6.0.1-130-g32291d4ac3-android-arm64-v8a-lgpl2-shared-full.tar.xz` |
| 压缩包 sha256 | `3bc13b52e6fad8712e318fa00d6e19f603e4057e470481a60332efc798b08e22` |
| FFmpeg 版本 | `n6.0.1-130-g32291d4ac`（libavcodec 60.3.100） |
| 许可 | LGPL-2.1-or-later（包内 `LICENSE.txt`；本工程副本 `src-tauri/android/licenses/ffmpeg-LGPL2.1.txt`） |

**选型与 GPL 排除审计**（逐项核对二进制，而非仅看包名）：

- Maven Central 的 `com.arthenica:ffmpeg-kit-*` 已被上游 purge（索引陈旧、磁盘 404）；ffmpeg-kit GitHub Release 不提供 Android 二进制资产，故未采用；
- 选定 `lgpl2-shared-full` 变体：配置行无 `--enable-gpl`、无 `--enable-nonfree`；
- `libavcodec.so` 等 NEEDED 依赖仅含 libav*、libsw*、libm、libz、libc++_shared、libdl、libc，**无** `libx264`/`libx265`/`libfdk-aac`；符号表中 `x264` 字符串仅为 H.264 解码器 SEI「assume this x264 version」注释，未链接 x264 编码器；
- 随包外部库为 lame/twolame（LGPL）、aom/dav1d/vpx/webp/theora/openh264（BSD）、opus/vorbis/freetype/fribidi/ass/zimg/soxr/openjpeg/xml2（LGPL/BSD 兼容）；
- 动态链接（`--enable-shared`），满足 LGPL 可替换库的义务；未静态链入任何 GPL 组件。

**LGPL 义务留档**：许可证文本随源码树留存；FFmpeg 源码可自 ffmpeg.org 获取，对应版本 `n6.0.1-130-g32291d4ac`；构建脚本与依赖清单见上述 Release 仓库。

### 11.3 二进制清单与体积

落盘目录 `src-tauri/android/jniLibs/arm64-v8a/`，逐文件 sha256 见同目录 `SHA256SUMS.txt`：

| 文件 | 解压后字节 | 约 MiB | sha256 前缀 |
| --- | ---: | ---: | --- |
| `libavcodec.so` | 24,921,864 | 23.77 | `7ede75a9…513d6e` |
| `libavfilter.so` | 6,574,384 | 6.27 | `6bd6c2b0…2617` |
| `libavformat.so` | 3,623,248 | 3.46 | `566dc0ab…119` |
| `libc++_shared.so` | 1,794,776 | 1.71 | `d523468d…08` |
| `libavutil.so` | 665,840 | 0.64 | `8ddfb6d5…c3a7` |
| `libswscale.so` | 577,088 | 0.55 | `00fab529…95` |
| `libffmpeg.so`（原包 `bin/ffmpeg`） | 273,624 | 0.26 | `ac8ba3c7…fffb` |
| `libswresample.so` | 265,880 | 0.25 | `30b58a8c…07b` |
| `libavdevice.so` | 52,400 | 0.05 | `11edb648…1b95` |
| **合计** | **38,749,104** | **36.95** | — |

- 解压后约 **37.0 MiB**；debug APK 抽包实测上述 9 个 `.so` 压缩入包约 **17.2 MiB**（deflate）。release 包剥离调试符号后体积另行预估。
- ELF64 AArch64 PIE，`note.android.ident` API 21，LOAD 对齐 16 KiB（`-Wl,-z,max-page-size=16384`），兼容现代 16 KiB 页设备。

### 11.4 Android jniLib 打包与执行机制

1. **打包形态**：原包可执行文件 `bin/ffmpeg` 重命名为 `libffmpeg.so` 放入 jniLibs；8 个依赖 `.so` 同目录。`scripts/sync-android-network.mjs` 将 `.so` 幂等复制到 `gen/android/app/src/main/jniLibs/arm64-v8a/`（`SHA256SUMS.txt` 不复制）；既有 `libhuangguo_client_lib.so` 符号链接不受覆盖。
2. **解压安装**：Manifest 注入 `android:extractNativeLibs="true"`，gradle 侧经同一脚本注入 `packaging { jniLibs.useLegacyPackaging = true }`。原因：API 29+ 禁止从应用数据目录直接 exec 二进制，APK 内未解压的库也不能直接执行；库必须在安装时解压到 `nativeLibraryDir`。
3. **运行时取路径**：Kotlin 插件 `StorageAccessPlugin` 新增 `getNativeLibraryDir` 命令，返回 `activity.applicationInfo.nativeLibraryDir`；Rust 桥 `AndroidStorage::native_lib_dir()` 取回并缓存到 `DownloadHost.native_lib_dir`。
4. **子进程环境**：`ffmpeg_bin(host)` 在 Android 下解析为 `<nativeLibraryDir>/libffmpeg.so`，`try_ffmpeg_remux` 给子进程注入 `LD_LIBRARY_PATH=<nativeLibraryDir>`，使 libav* 依赖就地解析。
5. **ABI 范围**：当前仅 `arm64-v8a`；armeabi-v7a / x86_64 未随包提供。

### 11.5 桌面端内置方案

探测顺序（`ffmpeg_bin`，桌面三平台一致）：

1. `<app_data>/tools/ffmpeg/<platform>/ffmpeg(.exe)`，平台目录：`windows-x64` / `macos-arm64` / `macos-x64` / `linux-x64`；
2. 旧扁平布局 `<app_data>/tools/ffmpeg/ffmpeg(.exe)`；
3. 系统 PATH 中的 `ffmpeg`（`-version` 探测成功才采纳）。

- **二进制不签入仓库，也不做应用内首次使用下载**：上游 `ffmpeg_tool.rs` 自建 reqwest 裸连 GitHub ffbinaries 的链路（调研笔记 §2 风险：未走 `network_policy`、无私网/环回校验、未接代理）明确不照搬。内置二进制由发布打包流程受控放置；在放置之前桌面以 PATH 兜底，行为与阶段二一致。
- 桌面目录选择、用户自选目录持久化等逻辑不受本任务影响（见 10.6）。

### 11.6 行为与配置

- **成功转封装**：默认删除合并后的 `video.ts`；任务消息 `MP4 已就绪`。
- **保留 TS**：设置页「保留 TS 源文件」开启后，TS 与 MP4 并存；消息 `MP4 已就绪（保留 TS）`。配置持久化在 `download_dir.json` 的 `keepTs` 字段，默认 `false`。
- **转封装失败**：保留 TS；消息 `TS 已就绪 · MP4 转封装失败，已保留 TS`。
- **检测不到 FFmpeg**：消息 `TS 已就绪 · 未检测到 FFmpeg，无法转封装 MP4`。

命令面（新增 1 个，其余复用任务 D/阶段二命令）：

| 命令 | 平台 | 说明 |
| --- | --- | --- |
| `download_set_keep_ts` | 全部 | 入参 `keep: bool`；写入 `keepTs` 配置并返回 `{ keepTs }`。 |
| `download_get_settings` | 全部 | 返回值追加 `keepTs`。 |

前端：`src/download.ts` 的 `DownloadSettings` 增加 `keepTs`，封装 `downloadSetKeepTs(keep)`；设置页新增「保留 TS 源文件」Toggle。

### 11.7 受限项

- 仅流拷贝转封装，不提供转码；无 `ffprobe` / `ffplay`。
- `libavdevice.so`、`libavfilter.so` 是 CLI 的链接依赖，随包带入；本应用不暴露采集设备或滤镜 UI。
- 仅 arm64-v8a 一种 Android ABI；桌面内置二进制待发布流程放置，当前靠 PATH 兜底。
- 桌面 PATH 兜底模式下，PATH 中同名 `ffmpeg` 会被执行（与既有阶段二口径一致，未提升为本任务的处置范围）。

### 11.8 红线自检（任务 E）

| 红线 | 自检结论 |
| --- | --- |
| CSP | `tauri.conf.json` 未改动。 |
| Tauri capabilities | `capabilities/default.json` 零新增；`download_set_keep_ts` 为工程自定义命令，沿用既有 invoke 模式，不占 capability 条目。 |
| QuickJS 沙箱 | 未向插件沙箱暴露文件系统、进程或 FFmpeg 能力；转封装全部在宿主 Rust 侧完成。 |
| 受控网络 | FFmpeg 二进制**不经过应用内网络获取**：Android 库签入源码树随包分发；桌面内置由发布流程放置，PATH 兜底；无运行时下载链路，未新增裸网络客户端，未绕过 `network_policy`。 |
| 路径前缀校验 | 转封装读写路径限定在当前集目录内；FFmpeg 可执行路径来自 jniLib 解析或受控内置目录，用户不可注入。 |

### 11.9 验证结果

- `pnpm build`：`tsc --noEmit`、`tsconfig.tests.json`、`vite build` 通过（仅既有 chunk 体积提示）。
- `cargo check --manifest-path src-tauri/Cargo.toml`：桌面目标通过，无错误、无警告。
- `cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml`：全部离线用例通过，0 失败。
- Android debug APK（`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`）抽包核对：
  - `lib/arm64-v8a/` 下 9 个 FFmpeg `.so` 全部存在，解压后字节数与 11.3 表一致；
  - 提取后 `sha256sum` 与 `SHA256SUMS.txt` 逐项 **HASHES_MATCH**；
  - APK 内 Manifest：`extractNativeLibs=true`；`MANAGE_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`（maxSdk 28）在位；
  - APK 仅含 `lib/arm64-v8a/` 一个 ABI 目录。
- 本 debug APK 仅作打包验证；最终 release 统一重建在下一轮。

### 11.10 构建侧附记：Android 预生成 rquickjs 绑定

本环境缺少宿主 `libclang.so`（bindgen 依赖），而 hpp 的 rquickjs 在 Android/ios 上启用 `bindgen` feature。为使 Android 目标在无宿主 LLVM 的环境可编译：

- 将此前针对同一 vendored QuickJS 头文件生成的绑定固化为 `src-tauri/vendor/rquickjs-sys/src/bindings/aarch64-linux-android.rs`；
- vendored `build.rs` 的 bindgen 分支调整为：目标存在随包绑定文件时优先复用副本，跳过 libclang 现场生成；需要刷新绑定头时启用 `update-bindings` feature 重生成。

该改动只影响构建期绑定生成，不改变 QuickJS 运行时、沙箱行为或任何 Android 权限；桌面目标仍走既有随包绑定路径。

## 12. 反馈修复 ②：下载默认目录四条展示链路统一

> 基线：`fff8bf5`。用户实测反馈"设置页、下载中心显示的目录与后端默认公共路径不一致"。
> 本节先固定取值口径，展示链路一律以后端返回的 `effectiveDir` 为准，不再由前端拼接或猜测默认路径。

### 12.1 `download_get_settings` 新返回口径

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `effectiveDir` | `string` | 当前生效下载根目录（前端唯一应展示的路径）；`dir` 为其别名，保持旧调用兼容 |
| `defaultDir` | `string` | 平台默认目录：Android = `ANDROID_PUBLIC_ROOT` 公共路径；桌面 = `<app_data>/downloads` |
| `externalDir` | `string \| null` | Android 公共目标目录；桌面为 `null` |
| `mode` | `"public" \| "fallback" \| "custom"` | `public`：平台默认公共/默认目录；`fallback`：未授权或公共目录创建失败回退应用专属目录；`custom`：桌面用户自选目录 |
| `reason` | `string` | 当前目录选择原因的可读文案（授权状态 / 自选 / 创建失败原因），非空 |
| `storageGranted` | `bool` | Android 是否持有所有文件访问授权；桌面恒 `true` |
| `fallback` | `bool` | `mode == "fallback"` 的别名，旧前端字段保留 |
| `retries` / `keepTs` / `mobile` | — | 既有偏好字段不变 |

模式判定（`refresh_storage`，每次读设置 / 目录时重查授权状态）：

- **Android 已授权**：`create_dir_all(公共根)` 成功 → `public`，文案"已获得所有文件访问授权，使用公共目录"；创建失败 → `fallback`，文案带具体错误（`公共目录创建失败（{e}），已回退应用专属目录`）；
- **Android 未授权 / 桥接不可用**：`fallback`，文案"未获得所有文件访问授权，已回退到应用专属目录"；
- **桌面自选**：`custom`，文案"使用您选择的目录"；**桌面默认**：`public`，文案"使用应用默认下载目录"。

### 12.2 四条展示链路核对结果

| 链路 | 旧行为 | 本轮修复 |
| --- | --- | --- |
| 设置页下载目录行 | `fallback` 时拼"（应用专属目录）"，否则直接显示 `dir`；未区分默认 / 自选 | 统一展示 `effectiveDir`，附模式标签（默认目录 / 应用专属目录 / 自选目录）与 `reason`；重试次数、保留 TS 开关同读一份 `dlPrefs` |
| 下载中心页头 | 仅显示事件推送的 `dir`，无来源标注 | 页头展示 `effectiveDir` + 模式标签；未授权时目录下方给出回退原因与授权入口横幅；非回退但有原因时展示原因小字 |
| 新任务默认值 | 任务入队时按后端 `root(host)` 解析 | 前端不携带、不硬编码任何目录字符串；`download_start` 一律由后端按当前生效根目录落盘；前端无公共路径常量 |
| 首次运行 / 未授权回退 | 回退分支把根目录换成 `app_data/downloads`，但旧文案仍可能写"默认" | 回退在后端标注 `mode=fallback` 且 `reason` 非空；前端横幅与设置行明示"因未授权已回退至应用专属目录"+ 授权入口，不再静默显示其他路径 |

- `download:dir` 事件载荷扩展为 `{ dir, effectiveDir, mode, reason }`；共享 store（`downloadStore.tsx`）收到事件后同步更新生效目录与模式 / 原因。
- 启动、`download:dir` 推送、WebView 重新获得焦点 / 页面重新可见时重查设置，回退状态与授权状态保持真实。

### 12.3 回归与验证口径

- 桌面单测（`download.rs` 内 `#[cfg(not(target_os = "android"))]`）：`desktop_settings_expose_effective_default_mode_and_reason` 断言 `defaultDir` / `effectiveDir` / `dir` 均为 `<app_data>/downloads`，`mode=public`，`reason` 非空，`fallback=false`，`storageGranted=true`。
- Android 分支常量断言（`#[cfg(target_os = "android")]`）：`android_default_dir_is_public_shared_root` 断言 `ANDROID_PUBLIC_ROOT` 码点路径；该用例仅在 Android 目标编译运行，当前桌面环境不执行。
- 本环境无 Android 设备，Android 未授权回退、公共目录创建失败分支为静态代码路径核对，真机表现列入第 13 节待实测清单。

### 12.4 红线自检（反馈修复 ②）

| 红线 | 自检结论 |
| --- | --- |
| CSP | `tauri.conf.json` 未改动；无新增远程脚本 / 内联脚本 |
| Tauri capabilities | `capabilities/default.json` 零新增；复用既有下载命令，未开新命令通道 |
| QuickJS 沙箱 | 未向插件沙箱暴露目录 / 授权能力；目录解析全部在宿主 Rust 侧 |
| 受控网络 | 未新增任何网络通道；目录解析不发请求 |
| 路径前缀校验 | 回退目录在 `<app_data>` 内；公共根为常量前缀；桌面自选目录仍走既有 canonicalize 前缀校验 |

## 13. 反馈修复 ③：所有文件访问权限授权链路加固

> 基线：`409a606`。Manifest 权限在上一轮已就位（aapt2 复核 `MANAGE_EXTERNAL_STORAGE` 声明、`WRITE_EXTERNAL_STORAGE` maxSdk28），本轮加固的是**授权链路与引导**：双入口可发现、三级跳转回退、返回后自动重查、授权后自动建目录切回公共模式、厂商兜底文案。

### 13.1 链路总览

| 环节 | 实现 |
| --- | --- |
| 状态来源 | `download_get_settings` 每次调用经桥接读取 `Environment.isExternalStorageManager()`（API 30+）；≤ API 29 按 legacy 权限视为已授权；桥接失败按未授权处理 |
| 入口一：设置页 | 「下载」分组内文件访问状态行：`检测中…` / `已授权所有文件访问` / `未授权`；未授权时展示引导文案与「授权所有文件访问」按钮 |
| 入口二：下载中心 | 页头下方独立横幅：未授权高亮提示 + 引导文案 + 授权按钮；检测中显示「正在检测文件访问授权状态…」 |
| 返回重查 | 前端共享 store 在启动、`download:dir` 推送、窗口 `focus` 与 `visibilitychange`（WebView 回前台）时重新拉取设置；从系统设置返回后状态自动刷新，无需手动刷新或重启 |
| 授权后建目录 | 重查判定已授权 → `refresh_storage` 对公共根 `create_dir_all`：成功切 `public` 模式；失败保留 `fallback`，`reason` 带具体错误（见 13.4） |
| 桥接命令 | Kotlin `StorageAccessPlugin`：`isManager` / `openAllFilesSettings` / `getManufacturer` / `getNativeLibraryDir`；Rust `AndroidStorage` 对应异步方法 |

### 13.2 三级跳转回退

`openAllFilesSettings` 按顺序尝试，任一 `startActivity` 成功即返回该 action；真实 `ActivityNotFoundException` 才落到下一级；全部失败才 reject：

| 顺序 | Intent | 数据 | 落点 |
| --- | --- | --- | --- |
| 1 | `ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` | `package:com.videohub.player` | 直接定位本应用的所有文件访问授权页（API 30+ 优先） |
| 2 | `ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION` | — | 系统所有文件访问总列表 |
| 3 | `ACTION_APPLICATION_DETAILS_SETTINGS` | `package:com.videohub.player` | 应用详情页，再由用户进入权限 / 特殊权限菜单 |

- 所有 Intent 带 `FLAG_ACTIVITY_NEW_TASK`；不再只依赖单一总列表 intent。
- 成功跳转的 action 通过桥接回复带回（`route` 字段），宿主可记录实际落点。

### 13.3 厂商兜底文案

`getManufacturer` 回传 `Build.MANUFACTURER`，前端 `src/download-access.ts` 按下表匹配；未识别或桥接失败时用通用路径：

| 识别关键字（小写） | 系统 | 引导路径 |
| --- | --- | --- |
| xiaomi / redmi / poco | MIUI | 设置 → 应用设置 → 应用管理 → video-hub → 权限 → 所有文件访问 |
| huawei / honor / hilink | EMUI / HarmonyOS | 设置 → 应用和服务 → 应用管理 → video-hub → 权限 → 文件 |
| oppo / oneplus / realme | ColorOS | 设置 → 权限与隐私 → 权限管理 → video-hub → 文件 |
| vivo / iqoo | OriginOS / Funtouch | 设置 → 应用与权限 → 权限管理 → video-hub → 文件 |
| samsung | One UI | 设置 → 应用程序 → video-hub → 权限 → 文件和媒体 |
| 其他 / 空 | 通用 | 设置 → 应用 → video-hub → 特殊权限 → 所有文件访问权限 |

> 各厂商 ROM 的菜单名称与层级可能随版本调整；文案为引导方向，最终以系统实际页面为准。

### 13.4 授权后行为与失败分支

- **授权成功 + 建目录成功**：模式 `public`，生效目录为 `ANDROID_PUBLIC_ROOT`，文案「已获得所有文件访问授权，使用公共目录」；新下载任务直接写入公共目录，无需重启。
- **授权成功但公共目录创建失败**（权限被撤销、存储未挂载、路径异常等）：保持 `fallback` 应用专属目录，模式 `fallback`，文案 `公共目录创建失败（{io 错误}），已回退应用专属目录`；下载不中断。
- **未授权 / 桥接不可用**：`fallback`，文案「未获得所有文件访问授权，已回退到应用专属目录」；设置页与下载中心均明示回退状态与授权入口，不静默显示公共路径。

### 13.5 重装真机全链路操作路径（待真机验证）

预期表现（静态代码路径推导，非真机实测）：

1. **安装启动**：App 首次进入；下载中心 / 设置页文件访问状态显示「检测中…」，随后落到「未授权」，目录为应用专属回退路径，横幅与设置行给出引导。
2. **发起授权**：点「授权所有文件访问」→ 优先打开本应用所有文件访问页；允许后返回 App。
3. **返回重查**：WebView 回前台触发 `focus` / `visibilitychange`，重新读取授权状态；状态翻为「已授权」，页头目录切到公共根路径。
4. **自动建目录**：首次解析根目录时 `create_dir_all` 创建 `…/HGHub`；建目录失败时停留回退目录并展示错误原因。
5. **下载成片**：详情 / 选集面板提交下载 → 清单与分片经受控网络落盘到公共根；合并 TS 后内置 FFmpeg 流拷贝转封装 MP4；保留 TS 开关按设置生效。
6. **失败分支**：拒绝授权 → 全程写入专属目录；中途撤销授权 → 下次解析回退专属目录；FFmpeg 缺失/转封装失败 → 保留 TS 并在任务消息注明。

### 13.6 静态验证 vs 待真机确认清单

**本轮静态验证（代码 / 清单 / 构建口径）**：

- Manifest：`MANAGE_EXTERNAL_STORAGE`（无 maxSdk）、`WRITE_EXTERNAL_STORAGE`（maxSdk 28）由 `scripts/sync-android-network.mjs` 幂等注入 `gen/android`，上一轮 aapt2 抽包已复核在位；本轮未改动清单。
- Kotlin 三级 Intent 代码路径、厂商匹配表、桥接方法命名与 Rust `run_mobile_plugin_async` 调用一一对应。
- `cargo check` 桌面目标通过；`pnpm build`（tsc 双配置 + vite）通过；hpp 离线单测全绿。
- 授权跳转是系统 intent，不经过应用网络栈；未新增 Tauri capability 条目。

**需真机 / Android 构建确认（当前环境无安卓设备与 NDK 构建链）**：

- 三级 Intent 在各品牌 ROM 上的实际落点与可启动性；
- 授权返回后 `Environment.isExternalStorageManager()` 的刷新时机与 WebView 生命周期回调命中情况；
- 公共目录真实写入权限、`create_dir_all` 在各存储挂载状态下的表现；
- 内置 FFmpeg 在真机 arm64 上的解包与转封装结果；
- 厂商文案与实际 ROM 菜单层级是否吻合。

### 13.7 权限体系区分（避免误记为 capability）

- `MANAGE_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` 是 **Android Manifest 系统权限**，由同步脚本注入 `gen/android`（`gen` 构建产物不入库）；不属于 Tauri capability 体系。
- `src-tauri/capabilities/default.json` 本轮零新增；授权引导复用既有移动插件桥接与既有下载命令，不开放新的 WebView 命令通道。

### 13.8 红线自检（反馈修复 ③）

| 红线 | 自检结论 |
| --- | --- |
| CSP | `tauri.conf.json` 未改动；无新增远程脚本 / 内联脚本 |
| Tauri capabilities | `capabilities/default.json` 零新增；未新增 Rust 命令，复用 `download_open_storage_settings` |
| QuickJS 沙箱 | 未向插件沙箱暴露授权 / 目录能力；授权与目录解析全部在宿主 / Kotlin 桥接层 |
| 受控网络 | 授权跳转是系统 intent，不经过网络栈；未新增任何网络通道或裸客户端 |
| 路径前缀校验 | 回退目录在 `<app_data>` 内；公共根为常量前缀；桥接不提供任意目录写入能力 |

## 14. 下载板块样式口径（统一 vh 设计 token）

### 14.1 设计依据

- 选型、候选比较与 token 映射见 [`DESIGN-LANGUAGE.md`](DESIGN-LANGUAGE.md)；token 定义在
  `src/design-tokens.css`，下载组件类在 `src/plugins/downloads.css`（`dl-*` 前缀）。
- 下载中心、设置页下载分组与"我的"设置页共用同一套卡片 / 行 / 间距 / 圆角 / 字体层级 /
  状态色；品牌色保留森绿 `#214F3E` × 奶油白 `#FCF6EC` × 珊瑚橙 `#F07257`，不引入紫色。

### 14.2 组件与类名清单

| 区域 | 类名 | 口径 |
| --- | --- | --- |
| 页头 | `.dl-header` / `.dl-header-title` / `.dl-header-dir` | 标题 + 目录行；只展示 `effectiveDir` |
| 模式徽标 | `.dl-chip`（`.is-fallback` / `.is-custom`） | 默认目录 / 应用专属目录 / 自选目录 |
| 页头操作 | `.dl-btn`（`.dl-btn-secondary`） | 打开目录、更改目录、默认目录 |
| 未授权横幅 | `.dl-banner.is-denied` / `.dl-banner-title` / `.dl-banner-guidance` / `.dl-btn-primary` | 高亮提示 + 厂商兜底文案 + 授权入口 |
| 分组 | `.dl-section` / `.dl-section-head` / `.dl-list` | 进行中 / 历史记录 |
| 任务卡 | `.dl-card` / `.dl-card-body` / `.dl-cover` / `.dl-main` / `.dl-title` / `.dl-meta` | 封面 + 标题 + 元信息 |
| 状态徽标 | `.dl-badge.is-running` / `.is-converting` / `.is-queued` / `.is-done` / `.is-error` / `.is-interrupted` | 六态视觉与文案 |
| 进度 | `.dl-progress` / `.dl-progress-track` / `.dl-progress-bar` / `.dl-progress-meta` | 进度条 + 文案 + 分片 / 集数计数 |
| 行内操作 | `.dl-actions` / `.dl-btn-primary` / `.dl-btn-secondary` / `.dl-btn-danger` / `.dl-btn-icon` | 打开文件、选集、重新下载、删除 |
| 整剧集数 | `.dl-eps` / `.dl-eps-grid` / `.dl-ep.is-ready` / `.is-pending` | 已缓存集可打开，未缓存禁用 |
| 骨架 | `.dl-skeleton` / `-card` / `-cover` / `-body` / `-line` | 列表首次加载占位 |
| 空态 | 既有 `.hpp-empty` 结构 | "还没有离线内容" |

### 14.3 状态真实呈现

| 状态 | 判定 | 视觉 | 文案 |
| --- | --- | --- | --- |
| 下载中 | `running` 且消息不含"转封装 / 合并" | 品牌强调徽标 + 进度条 | 下载中 · 分片计数 + 当前消息 |
| 转换中 | `running` 且消息含"转封装"或"合并" | 品牌强调徽标"转换中" + 进度条 | 转换中 · 当前消息（TS→MP4） |
| 排队中 | `queued` | 中性徽标，无进度条 | 排队中 + 队列消息 |
| 已完成 | `done` | 成功绿徽标"已离线" | 元信息含成品大小；剧集可打开文件 |
| 失败 | `error` | 危险红徽标"失败" | 消息即失败原因；提供"重新下载"主按钮 |
| 中断 | `interrupted` | 珊瑚徽标"已中断" | 消息即中断原因；提供"重新下载"主按钮 |

重新下载复用既有 `download_start` 命令，按任务记录的 `pluginId / mediaId / episodeId /
playlistId / ep / mode` 重新入队；未新增命令通道。

### 14.4 触控、加载、空态与错误重试

- 移动端按钮与集数按钮 `min-height: var(--vh-touch)`（44px）；桌面次级动作 36px。
- `ready === false` 时渲染骨架卡片（`shimmer` 渐变），不展示空态。
- 列表加载失败：`.dl-alert` 错误条 + "重试"按钮，调用共享状态 `refresh()`。
- 空态：`ready` 且无任务时展示既有空态文案。
- 详情页下载选择面板同步"转换中"判定，集数按钮对齐 44px 触控目标。

### 14.5 目录与横幅口径（联动 §12 / §13）

- 页头只展示 `effectiveDir`；模式徽标分别标注 默认目录 / 应用专属目录 / 自选目录。
- 未授权时横幅高亮呈现兜底引导（含厂商路径）与授权入口；授权回退原因以说明行呈现，
  不在横幅外静默替换路径。
- 设置页下载分组复用同一套 `.dl-btn` 与 refined 设置行结构，目录行展示 `effectiveDir`
  + 模式标签 + `reason`。

### 14.6 红线自检

| 红线 | 自检结论 |
| --- | --- |
| CSP | `tauri.conf.json` 未改动；纯本地 CSS 变量与类名，无远程字体 / 脚本 |
| Tauri capabilities | `capabilities/default.json` 零新增；未新增 Rust 命令，重试复用 `download_start` |
| QuickJS 沙箱 | 未向插件沙箱暴露下载 / 目录能力；状态全部来自宿主下载共享状态 |
| 受控网络 | 样式重构不涉及网络通道；未新增裸客户端或请求 |

