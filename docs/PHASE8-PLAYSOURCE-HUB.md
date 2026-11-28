# 阶段八：播放源板块重塑为统一入口 + 自定义线路备注名

本阶段把插件中心的「播放源」分栏从"逐个线路插件平铺 LinePicker"重塑为**统一播放源板块**：
板块以入口列表聚合所有提供播放来源的插件，内置「播放源」是其中一个入口；点开任一入口
进入该来源的线路管理。同时升级自定义线路，支持可选**备注名**（与固定线路对齐）。

上游对照来自 `911218sky/HGhub`（HGsky 变体）的线路设计调研，结论见第 1 节。

## 1. 上游调研结论（911218sky/HGhub）

| 主题 | 上游实现 | 出处 |
| --- | --- | --- |
| 线路种类 | 仅 2 条固定线路（`huangguoai.com` + `huangguoai.ai`）+ 运行时镜像；**无自定义线路种类** | `src-tauri/src/lines.rs` `FIXED` |
| 活动线路 | 单一全局 `RwLock<String>` origin，持久化 `{"base": origin}` 于 `line.json`，启动 `bind_base` 还原 | `net.rs`、`lib.rs` |
| 自定义线路 | **不存在**用户增删改 UI；`line_set(url)` 接受任意 URL，经 `normalize_base` 校验 | `LinePicker.tsx`（无输入框） |
| 校验 | 仅 HTTPS 裸 origin（path `/`、无 query/fragment/userinfo）、punycode、默认端口省略；`network_policy` 严格模式拒私网/环回/保留地址 | `net::normalize_base`、`network_policy::parse_target` |
| 镜像发现 | 打开/刷新时抓发布页 → 同源 `publish.js` → JS-as-data 解析 `urls`×`subdomains`，`MIRROR_MAX=60` | `lines.rs` |
| 健康探测 | 二值 `ok=status<400`+ms，6 并发、8s 超时；**无分档、无失败计数、无自动优选/故障切换** | `lines.rs`、i18n `line.hint` |
| 凭据边界 | 镜像仅游客浏览，`edge()` 在网络前阻断向镜像发送凭据；会话按 origin 绑定，切换即清除；登录强制固定线路 1 | `net::edge`、`ensure_auth_origin` |
| 面板入口 | 设置 → 网络 → 线路行 → LinePicker 弹层；表头"线路 / 当前：{host}"，固定/镜像两组带网络性质提示 | `src/components/LinePicker.tsx` |
| 多来源统一 | **无**：单站点备用 origin，不聚合多插件 | — |

**关键结论**：video-hub 现有线路能力（固定增删改 / 镜像 / 发布页管理 / 自定义 / 自动优选 /
失败计数 / 健康分档）已是上游的超集。可借鉴的是上游**面板呈现习语**（"当前：{host}" 表头、
按网络性质分组的提示、逐行探测 chip）与**游客/凭据边界的清晰表达**；"统一播放源插件"是
video-hub（插件播放器）特有的增强，上游单站点无此结构。

## 2. 播放源板块重塑（前端）

### 2.1 改前状态

`src/pages/Plugins.tsx` 的「播放源」分栏把 `plugins.filter(p=>p.methods.includes("lines.state"))`
逐个渲染为 `<section>`（启用开关 + 内联 `LinePicker`）。实际只有内置 `play-source` 暴露
`lines.state`，因此板块只呈现单一插件，其他内容源插件的站点线路散落在各自插件详情里。

### 2.2 改后结构

新增 `src/plugins/PlaySourceSection.tsx`，两级视图：

- **入口列表（hub）**：聚合所有 `kind !== "resolver"` 的来源插件为入口卡片。每卡片显示
  图标、名称（内置插件带「内置」徽标）、当前线路 host 或"多线路 · 待选择"/"单一来源"、
  状态、启用开关与进入箭头。内置「播放源」是其中一个入口。
- **二级线路管理（detail）**：点开入口后按能力分发——
  - 暴露 `lines.state` → 既有 `LinePicker`（固定/镜像/自定义/发布页）；
  - 仅暴露 `endpoints.list` → `EndpointLines`（标准站点线路：列表/探测/刷新/切换，复用
    既有 `endpoint.list`/`endpoint.probe`/`endpoint.set` 命令）；
  - 都没有 → `SingleOrigin`（单一地址说明）。
  - 停用状态提示先启用。

`Plugins.tsx` 的「播放源」分栏改为渲染 `<PlaySourceSection plugins={sourcePlugins} reload={reload}/>`；
分栏标签统一为"播放源"。移动端进入二级视图注册返回拦截（priority 18）先回到入口列表。

### 2.3 呈现习语（对齐上游）

- `LinePicker` 与 `EndpointLines` 顶部新增"当前线路 / {host}"摘要行（`.line-current-head`）。
- 镜像组提示补充"通常直连、仅游客浏览"；自定义组提示补充"手动添加的直连地址…通常仅游客浏览"。
- 入口卡片、二级表头、线路行共用同一套 vh token（`.ps-*` 与既有 `.hpp-lines-panel`）。

## 3. 自定义线路备注名升级（内置插件）

`src-tauri/resources/builtin-plugins/play-source.js`：

- 自定义线路存储由 `string[]` 升级为 `{ url, label, host }[]`；读取时旧字符串条目自动迁移
  （`loadCustomLines`），`loadCustom()` 仍返回 URL 数组供跨组去重复用。
- `lines.addCustom({ url, label? })`、`lines.updateCustom({ oldUrl, newUrl, label? })` 接受可选
  备注名；缺省用 host 作为备注名（`cleanLabel`，上限 24 字符）。`updateCustom` 未传 label 时保留原值。
- `lines.state` 的 `custom` 字段与 `endpoints` 中的自定义条目改用存储的备注名；`removeCustom`
  按 URL 过滤并清理失败计数。去重、跨组互斥、失败计数、`lines.reset` 语义不变。
- 未新增扩展方法（`lines.addCustom`/`updateCustom`/`removeCustom` 早已在 `meta.extensions` 声明），
  prelude 注册语义不变。

前端 `LinePicker.tsx`：`LineState.custom` 改为 `{ url, label }[]`；自定义组新增/编辑表单各加
一个"备注名（可选）"输入框；行展示备注名。校验仍走 `lineOrigin.ts`（未改，备注名不参与校验）。

## 4. 红线自检

| 红线 | 自检结论 |
| --- | --- |
| 前端 CSP | 未改 `tauri.conf.json`；新增 UI 为宿主 React 组件，无 eval / 内联脚本 / 远程脚本 / 远程图片源 |
| Tauri capabilities | 未改 `capabilities/default.json`；未新增权限或外层 Rust 命令；前端仍走既有 `hpp_manage` 动作（`call` / `enable` / `endpoint.list` / `endpoint.probe` / `endpoint.set`） |
| QuickJS 沙箱白名单 | 未新增扩展方法；自定义备注名为纯数据，在既有插件沙箱内处理，无 DOM / 裸桥 / 远端 JS |
| 受控网络 | 未新增网络通道；线路探测 / 镜像 / 发布页仍经 `hg.http.fetch` 受控 Network；外层壳未新增裸客户端 |

## 5. 验证

```bash
pnpm build
# tsc --noEmit + tsc --project tsconfig.tests.json + vite build 通过（仅既有 chunk 体积提示）

export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml --test play_source
# 新增 custom_lines_carry_optional_labels 用例：备注名存取、缺省 host、就地改名、
# 重复拒绝、重启持久化；既有 5 例不受影响（custom 仍为数组）
```

## 6. 已知限制

- 板块入口聚合的是已安装的内容源插件；全新安装仅内置「播放源」一个入口，导入更多来源后
  自动出现更多入口。解析器不作为播放源入口。
- 标准站点线路（`EndpointLines`）沿用宿主 `endpoint.probe` 的二值可达性口径，不含内置线路
  面板的失败计数 / 自动优选（那是 `lines.*` 扩展独有的能力）。
- 上游的游客/凭据 origin 绑定在网络层由宿主既有 `non_credentials` 处理；本阶段仅在 UI 文案
  上明确表达，未在插件内复刻上游 `edge()` 的凭据前置阻断逻辑。