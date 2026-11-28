# 阶段三：播放源模块移植插件中心（双启动模式）

本阶段把上游 HGhubX（zxsos/HGhubX）的"播放源（线路）"实现改造为 hpp 运行时内置的
QuickJS 插件，并在插件中心提供独立的"播放源线路"分段；宿主 React 按插件启动模式在
标准 HGhub 渲染器与 HGhubX 渲染器之间切换。

## 1. 改动清单

### Rust（hpp crate）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/crates/hpp/src/model.rs` | `Meta` 新增 `extensions: Vec<String>`（`#[serde(default)]`），并校验 `space.name` 命名段；其余元信息校验不变 |
| `src-tauri/crates/hpp/src/manager.rs` | 内置插件播种：`include_str!` 嵌入 `play-source.js`，首次打开时若索引中不存在则落盘并写入索引；`IndexEntry`/`PluginInfo` 新增 `built_in` 标记；`PluginInfo` 回传当前 `settings`；内置插件 `remove` 被拒绝；声明为扩展方法的调用跳过结构化内容校验，仍受传输 8 MiB 上限与可传递类型清洗约束；`open_seeded` 作为生产入口，`open`/`with_mode` 不播种（既有测试基线不变） |
| `src-tauri/crates/hpp/src/prelude.js` | 安装阶段读取 `meta.extensions` 与插件对象上的 `extensions` 清单，对声明且存在的函数注册进 `available`；注册、预算、中断、校验语义与协议方法一致 |
| `src-tauri/crates/hpp/tests/play_source.rs` | 新增离线测试：扩展方法透传、edge 信封解包、健康数据判据、错误信封、内置播种与不可移除 |

### 内置插件

| 文件 | 说明 |
| --- | --- |
| `src-tauri/resources/builtin-plugins/play-source.js` | 内置播放源插件。线路模型（固定线路 / 发布页镜像 / 自定义线路）、edge 信封、探测判据、自动选线状态；标准命名空间 `home`/`search`/`catalog`/`media`/`endpoints` 映射到地基协议模型；扩展命名空间 `lines`/`xhome`/`xsearch`/`xcategory`/`xdiscover`/`xvideo` 提供 HGhubX 视图模型 |

### 外层壳

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/plugins.rs` | 懒加载管理器改用 `PluginManager::open_seeded`；其余命令、文档读取适配器不变 |

### 前端

| 文件 | 改动 |
| --- | --- |
| `src/plugins/client.ts` | `InstalledPlugin` 补充 `builtIn` 与 `settings` 字段 |
| `src/pages/Plugins.tsx` | 插件中心第三个分段"播放源线路"；内置插件隐藏"移除插件"按钮；分段内复用既有 enable/disable 动作 |
| `src/plugins/hghubx/shared.ts` | 播放源定位、HGhubX 模式判断、上游卡片/分页到 `MediaItem` 的映射 |
| `src/plugins/hghubx/useHghubxList.ts` | HGhubX 扩展方法通用分页加载 Hook（去重、错误、加载更多、取消） |
| `src/plugins/hghubx/HghubxHome.tsx` | HGhubX 模式首页网格（`xhome.feed`） |
| `src/plugins/hghubx/HghubxSearch.tsx` | HGhubX 模式搜索（`xsearch.search` + `xsearch.hot` 热门词） |
| `src/plugins/hghubx/HghubxCategory.tsx` | HGhubX 模式分类（`xcategory.categories` + `xcategory.list`） |
| `src/plugins/hghubx/LinePicker.tsx` | 线路管理：面板顶部内置"启动方式"分段控件（HGhub 方式 / HGhubX 方式），其后为当前线路、镜像/自定义列表与探测结果、自动选线开关、手动探测、刷新镜像、自定义增删、重置 |
| `src/App.tsx` | 依据播放源 `startMode` 在标准渲染器与 HGhubX 渲染器之间切换首页 / 搜索 / 分类 |
| `src/plugins/plugins.css` | 线路面板、探测行与启动方式分段控件的最小样式 |

## 2. 内置插件与沙箱接入

- 插件源码以 `include_str!` 在编译期嵌入 hpp crate；播种只写一次：索引中已存在
  `play-source` 时不覆盖插件代码、设置、存储、Cookie 或端点状态。
- 播种入口为 `PluginManager::open_seeded`（外层壳 `PluginHost::manager` 调用）；
  `open` / `with_mode` 保持不播种，使既有单元测试的空索引基线不变。
- 插件与其他导入插件走完全相同的 hpp 生命周期：独立 QuickJS Runtime/Context、独立线程、
  调用预算、超时、中断、存储隔离、独立 Cookie 罐。插件不获得 DOM、文件系统或 WebView 桥。
- 内置标记 `built_in` 仅影响 UI（移除按钮隐藏）与 `remove` 命令拒绝；插件仍可被停用。

## 3. 扩展协议演进

- 协议内容面（`media`/`home`/`search`/`catalog`/`feed`/…）的结构化校验保持原样。
- 插件可在 `meta.extensions`（或插件对象 `extensions`）声明 `space.name` 扩展方法清单：
  - prelude 安装时核对函数存在后注册进可用方法表；
  - 调用仍走同一沙箱、同一预算与中断路径；
  - 宿主侧只做传输层校验（8 MiB 上限、非可传递类型剥离），不套用内容结构校验；
  - 未声明的方法不会出现在可用清单，也无法通过校验。

## 4. 两种启动模式

播放源插件设置 `startMode`（持久化在插件 settings，经既有 `settings.set` 动作保存）：

- `minireel`（默认）：标准 HGhub 渲染器（`ImmersiveHome` / `PluginSearch` /
  `PluginCategory`），插件以标准命名空间返回协议模型。
- `hghubx`：HGhubX 渲染器（`HghubxHome` / `HghubxSearch` / `HghubxCategory`），
  数据经 `hpp_manage` 的 `call` 动作调用扩展方法；卡片在宿主侧映射为 `MediaItem`。

模式判断只读取已启用、状态就绪的播放源插件；未启用或状态异常时回退标准渲染器。

"启动方式"分段控件位于插件中心"播放源"分段的线路面板顶部（自动选择线路开关之前），
两个选项对应上述两种模式；当前值读取 `plugin.settings.startMode`（默认 `minireel`），
点击后经既有 `settings.set` 动作保存并 `reload`，`App.tsx` 的 `isHghubxMode` 立即生效；
请求进行中（busy）控件禁用。

## 5. 下载适配

- 作品详情页与下载入口在两种模式下复用同一套组件；`download_start` 命令内部仍通过
  `media.getDetail` / `media.resolvePlayback` 取详情与播放地址，经 `host_fetch`
  走插件受控网络拉取清单、分片与密钥。
- HGhubX 渲染器点击作品同样进入标准详情页，`DownloadPickPanel` 与阶段二下载链路不变。

## 6. 红线自证

| 红线 | 本阶段处理 |
| --- | --- |
| CSP 一字不改 | `src-tauri/tauri.conf.json` 未改动；未引入 eval、内联脚本、远程脚本或远程图片源；封面仍经 `assets.prepare` 取本地地址 |
| `capabilities/default.json` 一字不改 | 未新增任何 Tauri 权限；线路管理全部走既有 `hpp_manage` 动作（`call` / `endpoint.set` / `settings.set` / `enable`），未新增 Rust 命令 |
| QuickJS 运行时机制不改 | 新代码只在宿主侧调用既有公开 API（`call`、`endpoints.list`、`settings.get/set`）；运行时线程、上下文、预算、中断、存储隔离机制未改 |
| 全部网络走 hpp 受控通道 | 插件内所有请求经 `hg.http.fetch` 落到插件独立的受控 `Network`（策略、Cookie 罐、代理、重定向逐跳校验）；插件侧无裸 `reqwest`、无独立客户端；外层壳本阶段未新增网络依赖 |

## 7. 验证

```bash
pnpm build
# tsc --noEmit + tsc --project tsconfig.tests.json + vite build 通过（仅既有 chunk 体积提示）

export PATH="$HOME/.cargo/bin:$PATH"
cargo check --manifest-path src-tauri/Cargo.toml
# Finished，无错误无警告

cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml
# 全部通过；新增 play_source.rs 2 个离线用例
# 既有 resolver.rs 的 persistent_runtime_fault_requires_explicit_retry 为计时敏感用例，
# 整跑偶发 FAILED，隔离重跑通过；属既有 flaky，非本阶段回归
```

## 8. 已知限制

- 发布页镜像解析在沙箱内以保守的 JS 数据解析完成（只提取 `urls` / `subdomains` 数组中的
  字符串字面量），不执行发布页 JS；上游页面结构调整时镜像列表可能为空。
- 自动选线的退避/冷却状态持久化在插件存储；后台定时探测受沙箱空闲回收影响，
  健康检查主要在进入线路面板与调用选线时触发。
- HGhubX 渲染器覆盖首页、搜索、分类；榜单、话题、SSR 分类等扩展方法已在插件侧预留，
  宿主暂未提供对应独立页面。
- 离线成品在播放器内回放的 `offline:` 协议通道仍属后续阶段；BYTERANGE 清单与插件
  `transformResource` 密钥变换链路未纳入下载器。
