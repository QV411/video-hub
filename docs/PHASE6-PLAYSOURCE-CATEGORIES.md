# 阶段六：HGhubX 分类能力对齐上游 + 播放源线路面板通用优化

阶段三把 HGhubX 播放源移植为内置 QuickJS 插件并跑通双启动模式；本阶段收尾三期追加
需求：对照上游 zxsos/HGhubX 补齐 HGhubX 启动模式下的分类导航、筛选、分页与落地页
数据流，同时优化线路面板的健康状态、手动/自动选线、自定义线路管理、启动方式持久化
回显与加载/错误态。

## 1. 改前审计结论

阶段三结束时 HGhubX 分类视图（`src/plugins/hghubx/HghubxCategory.tsx`）只有标签分组
与点标签后的 `xcategory.list` 列表，相对上游 `features/category/Category.tsx` 与
`features/discover/Discover.tsx` 缺少：三个固定频道与原创频道目录、频道排序切换、原创
子分类、专题入口与专题详情、标签落地页双列表、吃瓜列表，以及分频道独立的预览加载/
错误/重试状态。线路面板已有线路状态、探测、自动开关、自定义新增/删除与启动方式分段，
但缺少健康分档与失败次数展示、手动选线后的回退提示、自定义线路编辑、输入校验提示，
以及全挂时的错误重试入口。

## 2. 分类差距清单（上游实现 vs 本插件落点）

| 能力 | 上游落点（文件:行号） | 本插件/前端落点 | 对齐状态 |
| --- | --- | --- | --- |
| 固定频道目录 | `src/features/category/Category.tsx:18-22` `CHANNELS`（ai-duanju / ai-manju / original） | `src/plugins/hghubx/shared.ts` `HG_CHANNELS`；`HghubxCategory.tsx` 总览频道区 | 已对齐 |
| 频道预览（每频道 8 条，独立 loading/error/retry） | `Category.tsx:45-74` `loadPreview`；`:121-146` 频道卡片 | `HghubxCategory.tsx` `usePreview` + `ChannelPreview` | 已对齐 |
| 吃瓜预览与列表 | `Category.tsx:52-55` `postCategory("remen-chigua", …)`；`:149-169` 帖子卡片；`api/posts` 见 `feed.rs:163-179` | `xdiscover.postCategory` / `xdiscover.posts`；`PostsPreview` / `PostsPage` | 已对齐（列表分页）；帖子详情播放未移植，见已知限制 |
| 频道列表 JSON 回退 | `feed.rs:101-120` `/api/videos/category/{cate}?page&size&sort` | `xcategory.list`（阶段三已有），参数补充 sort 三值 | 已对齐 |
| 频道排序切换 | `Category.tsx:186-190` `CHANNEL_SORTS`（latest / hot_window / random）；`:267-273` 切换重拉 | `shared.ts` `CHANNEL_SORTS`；`ChannelDetail` 排序 pills，切换重置分页 | 已对齐 |
| 原创频道 | `feed.rs:19-39`：all → `/api/videos?is_original=1…`；子分类 → `/api/videos/category/{cate}?is_original=1…` | `xcategory.original` | 已对齐 |
| 原创子分类 | `Category.tsx:192-199` `ORIGINAL_CATES` + `originalSort`（all→new，其余→latest） | `shared.ts` `ORIGINAL_CATES` / `originalSort`；`ChannelDetail` 子类 pills | 已对齐 |
| 专题列表 | `feed.rs:45-47` `/api/topics?size=100`；`Discover.tsx:62` | `xdiscover.topics`（阶段三已有）；`TopicsPage` 专题卡片网格 | 已对齐 |
| 专题详情（影片 + 相关专题） | `feed.rs:52-57` `/api/topics/{slug}?page&size`；`Discover.tsx:152`；`types.ts:132-136` `TopicDetail` | `xdiscover.topic`；`TopicDetail` 影片横滑 + 相关专题 | 已对齐 |
| 标签分组 | `feed.rs:61-63` `/api/tags`；`Discover.tsx:285`；`types.ts:150-156` `TagGroup` | `xdiscover.tags`（阶段三已有）；`TagsPage` | 已对齐 |
| 标签影片列表 | `feed.rs:67-82` `/api/videos/tag/{tag}?sort=latest\|hot`；`Discover.tsx:385` | `xdiscover.tagVideos`；`TagPage` 最新/最热切换 | 已对齐 |
| 标签吃瓜帖聚合 | `feed.rs:86-98` `/api/posts/tag/{name}`；`Discover.tsx:401` `postTag` | 未接入 | 已知限制：地基协议无帖子详情/播放模型，标签侧帖子列表暂不展示 |
| 频道页 SSR 直取 | `channel_page.rs:300-373` 优先解析官网 SSR 频道页，失败回退 JSON | 插件沙箱无 DOM、不能自行抓 HTML，统一走 JSON 回退口径 | 受沙箱约束的等价降级，见已知限制 |
| 排行榜独立页 | `Category.tsx:108-111` 入口；`feed.rs:122-130` `/api/ranks/{kind}` | `xhome.rank` 扩展方法阶段三已预留；任务 C 补入口与 `RankPage`（见 9.2） | 已对齐（JSON 口径；SSR 榜页回退未移植） |
| 内容偏好（屏蔽标签/隐藏无标签） | `Category.tsx:203-208` `useContentPreferences` | 未移植 | 已知限制：属上游本地偏好功能，不在本期范围 |

### 分页与防 stale 语义

- 复用阶段三 `useHghubxList`：按 id 去重、`requestSeq`/epoch 防止旧线路旧响应覆盖新
  结果、卸载 `cancelAll()`；分页游标由 `pagination.pages` 推导。
- 筛选（排序 / 原创子类 / 标签 sort）切换时重置第一页；错误态保留上次结果并提供重试，
  首屏失败展示骨架与独立重试按钮。
- 总览各频道预览互不阻塞：单频道失败不影响其他频道与帖子预览。

## 3. 协议扩展演进

新增扩展方法均在 `meta.extensions` 白名单声明，prelude 安装时按阶段三协议核对函数存在
后注册进可用清单；未声明方法不进可用表，宿主仍只做传输层校验（8 MiB 上限、可传递类型
清洗），不套用内容结构校验。

| 扩展方法 | 参数 | 上游命令 / 路径 |
| --- | --- | --- |
| `xcategory.original` | `{ cate, page, size, sort }` | `api_original_videos`，`feed.rs:19-39` |
| `xdiscover.topic` | `{ slug, page, size }` | `api_topic`，`feed.rs:52-57` |
| `xdiscover.tagVideos` | `{ tag, page, size, sort: latest\|hot }` | `api_tag_videos`，`feed.rs:67-82` |
| `xdiscover.posts` | `{ page, size, sort }` | `api_posts`，`feed.rs:163-179` |
| `xdiscover.postCategory` | `{ route, page, size, sort }` | `api_post_category`，`feed.rs:203-217` |
| `lines.updateCustom` | `{ oldUrl, newUrl }` | 线路面板编辑动作（本阶段新增） |

插件新增的失败计数存储复用既有 `ps.line.fails` 键：探测成功清零、失败累加；线路状态
`lines.state` 回传 `fails: Record<url, number>`。

## 4. 线路面板优化落点

| 优化项 | 实现 |
| --- | --- |
| 线路健康状态展示 | 每行展示最近探测结果：可达时 `可达 · {ms} ms`，失败时错误信息或 HTTP 状态；结合 `fails` 展示历史/连续失败次数；未探测保持中性状态 |
| 手动/自动选线切换与回退 | 自动开关（`lines.autoSet`）保留；手动点选线路经 `endpoint.set` 立即生效并标记"当前"；面板提供"自动优选线路"（`lines.autoPick`）可回到自动选择，结果展示优选层级与耗时；手动选择后清空上次优选结果 |
| 自定义线路增删改 + 校验 | 新增（`lines.addCustom`）、删除（`lines.removeCustom`）、编辑（`lines.updateCustom`）；前端预校验 HTTPS/域名/端口/内网 IP，提示文案；插件侧 `normalizeOrigin` 仍是权威校验；重复线路被拒绝；编辑/删除同步清理失败计数 |
| 启动方式持久化回显核验 | `startMode` 经既有 `settings.set` 保存到插件 settings；动作触发 `hpp.changed` → `HostContext` reload → `plugin.settings.startMode` 重新回读，`App.tsx` `isHghubxMode` 立即生效；刷新/重启后由索引持久化的 settings 还原。已核验往返链路完整 |
| 加载与错误态 | 首屏未返回状态时展示骨架；探测中/优选中按钮禁用；全部线路不可用展示错误横幅与"重试"入口；镜像拉取错误独立展示，不冲掉线路列表 |

## 5. 双启动模式回归

> 历史记录：本节描述阶段六早期的单值 `startMode` 双模式；任务 A（第 10 节）已将其拆为
> `homeMode` / `categoryMode` 两维并迁移旧值，当前分发逻辑以第 10.3 节为准。

- **HGhub 方式（minireel，默认）**：标准渲染器 `ImmersiveHome` / `PluginSearch` /
  `PluginCategory` 链路未改动；插件标准命名空间 `home`/`search`/`catalog`/`media`/
  `endpoints` 签名与返回模型保持不变。
- **HGhubX 方式（hghubx）**：首页 `xhome.feed`、搜索 `xsearch.search/hot` 链路未改动；
  本阶段新增/调整的分类页面与线路面板仅在该模式下渲染。
- 编译与离线测试通过（见第 7 节）；两种模式的入口判断仍只读取已启用、状态就绪的播放源
  插件，异常时回退标准渲染器。

## 6. 红线自检

| 红线 | 本阶段处理 |
| --- | --- |
| CSP 一字不改 | `src-tauri/tauri.conf.json` 未改动；未引入 eval、内联脚本、远程脚本或远程图片源；封面仍经 `assets.prepare` 取本地地址 |
| `capabilities` 一字不改 | 未新增任何 Tauri 权限；前端仍只调用既有 `hpp_manage` 动作（`call` / `endpoint.set` / `settings.set`），未新增 Rust 命令，未新增 event 权限 |
| QuickJS 沙箱白名单语义 | 新扩展方法按阶段三协议在 `meta.extensions` 声明；未声明方法不注册；插件仍无 DOM、无独立 fs、无 WebView 桥 |
| 全部网络走受控通道 | 插件内新请求全部经 `edge()`（edge 信封 / 受控 Network：策略、Cookie 罐、代理、逐跳重定向校验）；发布页镜像与热搜 SSR 抓取沿用既有 `hg.http.fetch` 受控通道；外层壳未新增裸网络客户端 |

## 7. 验证

```bash
pnpm build
# tsc --noEmit + tsc --project tsconfig.tests.json + vite build 通过（仅既有 chunk 体积提示）

export PATH="$HOME/.cargo/bin:$PATH"
cargo check --manifest-path src-tauri/Cargo.toml
# Finished，无错误无警告

cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml
# hpp 7 个 + web_login 2 个离线用例全部通过；play_source.rs 2 个用例通过
```

## 8. 已知限制

- **SSR 频道页解析未带入**：上游 `channel_page.rs` 的 DOM 解析（频道页/热播榜卡片还原、
  面板隐藏判定、分页读取）运行在宿主 Rust 侧；沙箱插件不能自行抓 HTML，频道/原创/榜单
  数据统一走 JSON 回退口径。若官网 SSR 结构调整导致 JSON 字段差异，需在插件映射层适配。
- **帖子详情与帖子标签聚合未移植**：地基协议无帖子详情/播放模型；`api_post`、
  `api_post_playback`、`api_post_tag` 未接入，吃瓜列表卡片暂不可点进帖子。
- **排行榜独立页未建**：`xhome.rank` 方法已预留，宿主分类总览未加排名入口与排名栈页面。
  （任务 C 已补齐入口与 `RankPage`，见第 9.2 节；上游 SSR 热播榜回退仍未移植。）
- **内容偏好屏蔽**：上游按标签屏蔽 / 隐藏无标签影片的本地偏好功能未移植。
- 自动选线退避/冷却仍持久化在插件存储；后台定时探测受沙箱空闲回收影响，健康检查主要
  在进入线路面板与调用选线时触发（沿用阶段三结论）。

## 9. 任务 C：分类板块三项修复（封面代理 / 排行榜 / 频道横滑）

基线 `b930035`，独立改动块；本项不重建 APK（统一在后续任务重建）。

### 9.1 封面显示异常：根因、对照与修复落点

| # | 异常表现 / 根因 | 上游对照（文件:行号） | 本工程落点 |
| --- | --- | --- | --- |
| 1 | 站点封面下发的是 AES-128-CBC 密文；此前插件 `cover` 只回纯字符串、未挂解密变换，hpp 图片代理的 aes-cbc 分支无条件解密，明文图反而会被破坏 | `media/image.rs:10-11` 固定 key/iv（原始 ASCII 字节）；`:26-55` CBC 解密 + 去 PKCS7；`:107-112` 先魔数识别，命中明文则透传，否则才解密 | 插件 `play-source.js` `coverRef()` 把封面包装成 `ResourceRef { url, headers, transform:{ type:"aes-cbc", key, iv, padding:"pkcs7" } }`（key/iv 为上游同原始字节的 Base64）；hpp `media.rs` 新增 `image_magic()` 魔数前置探测，明文透传、密文才解密；处理后按魔数补回 image content-type |
| 2 | 相对路径 / 协议相对地址未拼接绝对地址，`model::url` 只接受绝对 https | 上游 `api.ts:44-45` `cover()` 直接把原 URL 编进本地代理地址，上游 Rust 侧负责相对解析 | `coverRef()` 以当前线路 origin 为 base 拼接 `/path` 与 `//host/path`；不可解析为 https 公网地址的封面丢弃，不进入资源注册 |
| 3 | 防盗链 Referer：图片 CDN 校验来源，WebView 裸 `<img>` 无法携带 Referer | `net/edge.rs:261,278` 图片抓取带 `{base}/` Referer | `ResourceRef.headers` 携带同 origin `Referer`，经受控 Network 投递；非 credential-origin 时既有 `non_credentials` 仍剥离 cookie/authorization，语义不变 |
| 4 | 绕过受控通道的裸 `<img>`：阶段六新写的吃瓜预览 `PostsPreview` 与专题卡片 `TopicsPage` 直接把第三方图床 URL 喂给 `<img>`，WebView 直连、无法带 Referer，也受 CSP `img-src` 约束 | 上游所有封面都经 `LOCAL/img?u=` 本地协议回环 | 吃瓜预览改走 `MediaRow`（`useAssetUrls` → `assets.prepare` 本地回环地址）；专题封面经 `useAssetUrls` 批量代理；排行榜封面同路径；分类各入口不再出现裸第三方 `<img>` |
| 5 | 占位与失败处理 | 上游卡片封面缺失回退标题占位 | 无封面回退标题首两字占位；抓取/解密失败由既有骨架、错误横幅与重试入口承载，不新增裸回退地址 |

**网络通道论证（受控通道 + 不弱化红线）**：封面字节抓取仍由插件独立受控 Network
（策略白名单、Cookie 罐、代理、逐跳重定向校验）完成；`assets.prepare` 在本地回环
媒体会话中注册 resource，WebView `<img>` 只加载 `http://hg.localhost/hpp/{session}/{index}`
本地地址。该链路与既有鉴权媒体投递同一架构：本地回环投递 + 受控上游抓取；未新增裸
reqwest 客户端，未引入新的 host_fetch 封面通道，未放宽 CSP / connect-src / 白名单。

### 9.2 排行榜移植范围

| 榜单维度 | 上游接口 | 本工程落点 | 移植状态 |
| --- | --- | --- | --- |
| 热播榜 `hot` | `feed.rs:124-128`：优先 SSR `fetch_hot_rank()`，失败回退 `GET /api/ranks/hot` | `xhome.rank({ kind:"hot" })` → `/api/ranks/hot` JSON | 已接入 JSON 口径；SSR 榜页 DOM 回退未移植（沙箱无 DOM，同第 8 节限制） |
| 推荐榜 `recommend` | `feed.rs:130` `GET /api/ranks/recommend` | `xhome.rank({ kind:"recommend" })` | 已接入 |
| 潜力榜 `potential` | `feed.rs:130` `GET /api/ranks/potential` | `xhome.rank({ kind:"potential" })` | 已接入 |

- **入口**：分类总览专题/标签上方的"排行榜"条目，对齐 `Category.tsx:108-111`。
- **落地页 `RankPage`**：三档 pills 切换；按档位缓存 60s，独立 loading / error / 重试；
  排名序号（前 4 名高亮）、封面代理、标签与分类名、指标条与指标值；点击条目回传
  `video_id` 走既有详情打开链路。行结构对齐 `shared/ui/cards.tsx:152-163` `RankRow`。
- **如实说明的未移植范围**：上游 SSR 热播榜抓取（`channel_page::fetch_hot_rank`）运行在
  宿主 Rust 侧，沙箱插件不能自行抓 HTML，仅保留 JSON 回退；`metrics{collect,comment,
  like,play}` 等次级计数字段仅在有值时展示；某档位接口无数据时页面展示"榜单暂时为空"，
  不虚构条目。
- **协议白名单**：`xhome.rank` 阶段三已在 `meta.extensions` 声明；本任务未新增扩展方法，
  prelude 注册语义不变。

### 9.3 频道封面横向滑动布局

- 上游 `Category.tsx:138`：`scroll-x flex gap-3 snap-x` + 固定宽度 `RowCard`。
- 本工程：`MediaRow` 统一包裹 `.hx-row-strip`——横向 flex、`overflow-x:auto`、
  `scroll-snap-type:x mandatory`、`-webkit-overflow-scrolling:touch`、隐藏滚动条
  （`scrollbar-width:none` + WebKit 伪类）；卡片 `snap-start` 对齐分页节奏。
- 总览各频道预览、吃瓜预览、专题详情相关影片行均走该横滑条；纵向网格只保留在专题
  卡片页与详情网格，频道 / 榜单条目不出现纵向封面网格。
- 品牌：森绿 × 奶油白沿用既有 CSS 变量，未引入新色板。

### 9.4 上游实现 vs 本工程落点（逐项）

| 能力 | 上游实现 | 本工程落点 |
| --- | --- | --- |
| 封面 AES 解密 + 魔数透传 | `media/image.rs:10-11,26-55,57-74,107-112` | `play-source.js` `coverRef`；`media.rs` `image_magic` + aes-cbc 分支 |
| 封面 Referer | `net/edge.rs:261,278` | `ResourceRef.headers` 同 origin Referer |
| 封面本地代理地址 | `api.ts:44-45` `cover()` | `useAssetUrls` → `assets.prepare` 本地回环 URL |
| 排行榜入口 | `Category.tsx:108-111` | `HghubxCategory.tsx` 总览 `hx-entry-wide` |
| 排行榜接口 | `feed.rs:122-130`；`api.ts:148-149` | `xhome.rank` + `RankPage` |
| 排行榜行 | `cards.tsx:152-163` `RankRow` | `RankRow` / `.hx-rank-row` |
| 频道横滑 | `Category.tsx:138` | `.hx-row-strip` + `MediaRow` |

### 9.5 验证与红线自检

- `pnpm build` 通过（tsc 双配置 + vite，仅既有 chunk 体积提示）；`cargo check` 通过；
  hpp 离线测试全绿（lib 32 + web_login 2 + play_source 2）；新增
  `media::tests::image_magic_recognizes_plain_images_and_rejects_ciphertext` 用例覆盖
  JPEG/PNG/GIF/WEBP 魔数识别与密文/空字节判定。
- 红线：`tauri.conf.json` CSP、`capabilities/default.json`、`network_policy.rs`、
  `network_security_config.xml` 零改动；沙箱白名单无新增方法；受控网络无新增裸客户端；
  外层未新增 Tauri 命令或 event 权限。

## 10. 任务 A：启动方案模块搬迁、两维拆分与 HGsky 首页移植

### 10.1 搬迁落点与 UI

- 原播放源 `LinePicker` 面板内的"启动方式"分段控件整体移除（`src/plugins/hghubx/LinePicker.tsx`）。
- 新模块落在"我的"板块（`LibraryPage`）"插件中心"入口下方，组件 `StartSchemeModule`
  （`src/plugins/LibraryPage.tsx`），外观对齐插件中心入口卡片：图标块 + 标题/说明 +
  分段控件，样式见 `src/plugins/refined-pages.css` `.library-scheme-card` 系列。
- 模块分两组相互独立的设置：**首页启动方案**（默认方案 / HGhubX方案 / HGsky方案）、
  **分类启动方案**（默认方案 / HGhubX方案）。
- 旧启停入口去留决策：面板内不再保留只读摘要或快捷入口。理由：方案选择是全局浏览偏好，
  与线路管理无耦合；若面板与"我的"模块各放一份编辑入口，会产生两条互相覆盖的修改路径，
  与两维独立持久化的目标冲突。当前方案状态统一由"我的 → 启动方案"模块展示与修改。

### 10.2 持久化与旧值迁移映射

插件 `meta.settings` 由旧单值 `startMode`（minireel/hghubx）替换为两个独立键：

| 新键 | 类型 | 取值 | 默认 |
| --- | --- | --- | --- |
| `homeMode` | select | `default` / `hghubx` / `hgsky` | `default` |
| `categoryMode` | select | `default` / `hghubx` | `default` |
| `autoLine` | switch | 自动选线 | `true`（不变） |

迁移在 Rust 侧 `PluginManager::migrate_legacy_start_mode`
（`src-tauri/crates/hpp/src/manager.rs`）于索引加载时执行：

| 旧 `startMode` | `homeMode` | `categoryMode` |
| --- | --- | --- |
| `hghubx` | `hghubx` | `hghubx` |
| `minireel` / 缺失 / 未知值 | `default` | `default` |
| 新键已显式持久化 | 保留，不被旧值覆盖 | 保留，不被旧值覆盖 |

迁移后旧键 `startMode` 从设置中移除；已有用户的 HGhubX 选择不会丢。迁移单元测试见
`manager.rs` `legacy_migration_tests`（hghubx 双维映射、minireel/未知/缺失映射默认、
显式新键保留三组用例）。

### 10.3 渲染分发重构

`App.tsx` 旧逻辑按单值 `startMode` 同时切换首页/分类/搜索；现重构为两维分发
（`src/plugins/hghubx/shared.ts` 的 `homeScheme` / `categoryScheme`）：

| `homeMode` ＼ `categoryMode` | `default` | `hghubx` |
| --- | --- | --- |
| `default` | `ImmersiveHome` / `PluginCategory` | `ImmersiveHome` / `HghubxCategory` |
| `hghubx` | `HghubxHome` / `PluginCategory` | `HghubxHome` / `HghubxCategory` |
| `hgsky` | `HgskyHome` / `PluginCategory` | `HgskyHome` / `HghubxCategory` |

搜索页跟随**分类方案**维度（`categoryMode`）：HGhubX 搜索用 `HghubxSearch`，否则
`PluginSearch`。HGsky 无独立搜索渲染器，不单独占据搜索维度。

### 10.4 HGsky 上游调研摘要（911218sky/HGhub）

| 主题 | 上游实现 | 出处 |
| --- | --- | --- |
| 首页数据 | Rust 命令 `api_feed` → `GET /api/videos?page&size`，JSON 信封 | `src-tauri/src/api.rs:497-501`；`src/api.ts:70`；页面 `src/pages/Home.tsx:24`（每页 10） |
| 分类数据 | `api_category` → `GET /api/videos/category/{cate}?page&size`；固定频道 `ai-duanju / ai-manju / ai-huanlian / ai-mogai` | `src-tauri/src/api.rs:504-515`；`src/pages/Category.tsx:10-15,52` |
| 排行榜 | `api_rank` → `GET /api/ranks/{kind}` | `src-tauri/src/api.rs:518-524` |
| 搜索 | `api_search` → `GET /api/search?q=...&page&size` | `src-tauri/src/api.rs:527-537` |
| 数据模型 | `VideoCard` / `Paged<VideoCard>`（items + pagination） | `src/types.ts:3-28,62` |
| 首页形态 | 竖滑 `Feed`（`videoIds` + 详情/播放解析），非 SSR DOM 抓取 | `src/components/Feed.tsx:21-44`；`src/pages/Home.tsx:18-31` |
| 原生依赖 | 点赞/收藏/关注/评论为 Rust 命令；播放/图片走本地协议 `/seg` `/hls` `/img`；hls.js 播放 | `src/api.ts:110-112,26-35,211-217` |

**关键结论**：首页 feed 与既有 HGhubX 扩展同源 JSON 接口，无 SSR HTML 抓取依赖；
上游分类频道集合与 HGhubX 不完全一致（多出 `ai-huanlian` / `ai-mogai`）。

### 10.5 移植范围与降级项

落地方式与 HGhubX 同架构：插件扩展方法声明进 `meta.extensions` 白名单，prelude 按声明
注册；网络全部走 `hg.http.fetch` 受控通道；沙箱内无 DOM、无裸桥。

| 扩展方法 | 入参 | 落点 | 上游对应 |
| --- | --- | --- | --- |
| `skyhome.feed` | `{ page, size }` | 插件 `skyhome.feed` → `normalizePaged` 封装 `/api/videos?page&size` | `api_feed`（`api.rs:497-501`） |

专用渲染器 `src/plugins/hgsky/HgskyHome.tsx`：单源竖滑队列，复用既有 `PluginMediaDetail`
预览链路承载上下滑、前后预览与详情/播放。

**降级项（本阶段未移植，已记录）**：

- Feed 内联互动面板（点赞/收藏/关注/评论/下载入口）：降级为详情页既有互动能力；
  上游对应 Rust 命令未在插件沙箱内复刻。
- HGsky 分类频道（`ai-huanlian` / `ai-mogai` 等）与 HGsky 搜索：本阶段分类维度只给
  默认 / HGhubX 两选，HGsky 分类/搜索不独立渲染。
- 上游本地协议 `/seg` `/hls` `/img` 改写、观看历史软过滤、手势细节与元数据预取：沿用
  宿主既有链路，不单独移植。
- 未发现需要 SSR DOM 抓取的首页数据路径；feed 为 JSON 接口直取，无该项降级。

### 10.6 组合渲染回归

- 首页三方案 × 分类两方案共 6 种组合；`default` + `hghubx` 四组全组合由既有 HGhubX
  渲染器与原生渲染器链路回归；`hgsky` 首页冒烟走 `skyhome.feed` → `HgskyHome` 队列链路。
- 构建：`pnpm build`（tsc 双配置 + vite）、`cargo check`、`cargo test`（hpp 离线套件）通过。

### 10.7 红线自检（任务 A 增量）

| 红线 | 自检结论 |
| --- | --- |
| 前端 CSP | 未改 `tauri.conf.json`；新渲染器为宿主 React 组件，无 eval/内联脚本/远程脚本 |
| Tauri capabilities | 未改 `capabilities/default.json`；未新增权限 |
| QuickJS 沙箱白名单 | 新方法 `skyhome.feed` 已在 `meta.extensions` 声明；prelude 按声明注册；沙箱内无 DOM/裸桥 |
| 受控网络 | feed 请求经 `hg.http.fetch` 插件独立 Network（策略/Cookie 罐/代理/逐跳重定向），外层无裸 reqwest |

## 11. 任务 B：固定线路增删改、镜像线路区移植与播放源板块 taste-skill 重设计

> 基线：任务 A 提交 `d25de36`；启动方式分段控件已迁出本面板（见第 10 节），本节面板布局按迁移后状态设计。
> 设计准则：taste-skill（MIT 开源设计技能）作为设计原则与人工验收清单执行；其 `gate.mjs` / 浏览器一致性 / 截图门禁
> 面向独立落地页，Tauri 内 React 面板语境不套用，未跑该流水线。

### 11.1 线路管理交互模型

三类线路（固定 / 镜像 / 自定义）在同面板内分区并列，统一走插件存储 `ps.line.*` 键族：

| 分组 | 存储键 | 来源 | 可编辑性 |
| --- | --- | --- | --- |
| 固定线路 | `ps.line.fixed` | 内置默认 `https://huangguoai.com`，可持久化增/改/删 | 新增（URL + 可选备注名）、编辑（地址 + 备注名）、删除；空列表回落默认 |
| 镜像线路 | `ps.line.mirrors` + `ps.line.trusted` | 发布页自动发现 + 手动补充 | 发布条目只读；手动条目带 `manual` 标记、可删除；刷新发布页时手动条目保留合并 |
| 自定义线路 | `ps.line.custom` | 用户手动添加 | 沿用既有新增 / 编辑 / 删除 |

- **扩展方法（均在 `meta.extensions` 白名单声明）**：`lines.addFixed`、`lines.updateFixed`、
  `lines.removeFixed`、`lines.addMirror`、`lines.removeMirror`；既有 `lines.addCustom` /
  `lines.updateCustom` / `lines.removeCustom` / `lines.reset` / `lines.autoSet` / `lines.autoPick` /
  `lines.probe` / `lines.mirrors` / `lines.state` / `lines.list` / `lines.set` 复用。
- **校验口径**：插件侧 `validateOrigin`（旧 `normalizeOrigin` 布尔包装保留）为权威校验；规则经任务
  反馈修订，详见第 12 节；前端 `validateLineOrigin` 同口径预校验并就地提示。
- **去重**：`originTaken(origin, exceptGroup)` 跨组互斥，同一 origin 只能存在于固定 / 镜像 / 自定义之一；
  固定与自定义的编辑方法同样做跨组去重。
- **恢复出厂默认**：`lines.reset` 清空自定义 / 镜像 / 可信集合 / 失败计数，并把固定线路还原为内置默认；
  删除/编辑同步清理该 origin 的失败计数。
- **手动选线语义（对齐上游）**：点选线路前先关闭自动选线；切换失败时回滚到此前的自动选线状态，不留下
  半关闭状态；当前行以"当前"标记呈现。

### 11.2 镜像线路方案：上游对照与移植范围

上游对照：`_upstream/hghubx/src-tauri/src/lines/mirror.rs`、`src/features/settings/LinePicker.tsx`、
`src/shared/api/api.ts`。

| 上游能力 | 本工程落点 | 状态 |
| --- | --- | --- |
| 两个发布页并发拉取，单页失败不遮蔽另一页 | `fetchPublishMirrors()` 内 `Promise.all` 并发，错误逐页收集进 `errors` | 已移植 |
| 交错合并，首页列表过长不遮蔽次页 | 按索引交错合并 + `seen` 去重 | 已移植 |
| `MIRROR_MAX=20` 上限 | 同上限 20 | 已移植 |
| JS-as-data 保守解析（不执行远端 JS） | `stripComments` / `readArray` / `parsePublishJs` 解析 `urls` / `subdomains` 数组 | 已移植 |
| 可信镜像集合：仅发布页收录的 origin 入集合 | 持久化 `ps.line.trusted`；`autoPick` 仅在可信集合内优选镜像 | 已移植（持久化替代上游内存 `TRUSTED_MIRRORS`） |
| 自动发现 / 手动添加镜像地址 / 健康探测覆盖 / 失败自动降级 | 发布页自动发现；`lines.addMirror` 手动补充；`lines.probe` 逐行/全量探测；主站不可用自动退到镜像，全部不可用报错 | 已移植 |
| 512 KiB 正文上限、8 秒发布页超时、同源重定向校验、UTF-8 校验 | 走 hpp 受控网络既有通道口径（既有体积/超时策略、策略重定向校验、内部 UTF-8 解码）；插件沙箱内未复刻发布页专项 512 KiB / 8s 上限 | 受限项：见 11.5 |
| `verify_published_origin`：固定/可信放行，否则并发刷新发布页、30s 缓存、未收录报错 | 未实现独立发布来源复核入口 | 受限项：见 11.5 |
| `recommended` 当前线路置顶（仅展示） | 未置顶排序；当前行以"当前"标记呈现 | 未移植（展示排序差异） |
| `source` / `script` / `recommended_source` 元数据字段 | 未向前端透出；前端仅消费 `items` / `errors` | 未透出 |

### 11.3 改前审计清单（旧 `LinePicker` / 旧线路面板）

| # | 审计问题 | 类别 |
| --- | --- | --- |
| 1 | 顶部四个动作按钮高约 26–28px，低于 44px 触控目标；线路行主按钮无最小高度 | 触控目标 |
| 2 | 行内间距 8 / 10 / 12px 混用，未 token 化 | 间距系统 |
| 3 | 仅整板骨架，无行内探测中 / 切换中状态；探测、优选、刷新期间行与按钮无逐行禁用反馈 | 状态呈现 |
| 4 | 探测全部 / 自动优选 / 刷新镜像 / 重置四个按钮同级平铺，无主次与危险层级 | 按钮层级 |
| 5 | 健康度文字堆砌（ms / 状态 / 失败次数连写），无状态色点与语义色 | 健康状态 |
| 6 | 空线路组无空态文案；镜像错误与整板错误混用 | 空态 / 错误态 |
| 7 | 边框 `#8882` / `#8883` 硬编码，未走主题 token | 样式 token |
| 8 | 固定线路硬编码单条、不可改；镜像无手动入口；刷新镜像会清掉手动条目 | 能力缺失 |
| 9 | 面板未区分品牌 accent 作用域，默认按钮样式堆砌 | 品牌一致 |

### 11.4 taste-skill 落地清单与不适用项

**落地条目（checklist 对照）**

| 条目 | 落点 |
| --- | --- |
| 一套系统：一套按钮 / 卡片行 / 圆角 / 间距 | `.hpp-lines-panel` 作用域 token：`--line-gap-xs/sm/md`（8/12/16）、`--line-radius` / `--line-radius-sm`；按钮三档：`line-btn-primary`（accent 实心）、`line-btn-secondary`（中性面）、`line-btn-ghost-danger`（透明危险）；行卡片统一样式，嵌套不超过两层 |
| 品牌一致，禁紫色 | 森绿 `#214F3E` × 奶油白 `#FCF6EC` + 珊瑚橙 `#F07257`；深色 accent `#7FB89F` / ink `#10261D` / tint `rgba(127,184,159,.16)`，浅色 accent `#214F3E` / ink `#FCF6EC` / tint `rgba(33,79,62,.10)`；全面板无紫 / 薰衣草色 |
| 44px 触控目标 | 行主按钮 `min-height:44px`，输入框 `min-height:44px`；`@media(max-width:600px)` 下动作按钮与行内文字按钮提到 44px；桌面动作按钮 36px |
| 真实状态，不造假 | 整板骨架（未返回状态前）；健康 pill 三态：`ready`（绿）/ `failed`（红）/ `unloaded`（中性）；空组虚线空态文案；错误横幅带"重试"；镜像拉取错误独立提示，不冲掉列表；探测 / 优选 / 切换中按钮禁用 |
| 克制微交互 | hover 抬起 1px，按压 `scale(.94)`（沿用全局 `pressable`）；无倾斜、无滚动淡入、无走马灯；`prefers-reduced-motion` 下过渡与抬起关闭 |
| 键盘与可见标签 | 输入框 `aria-label` + placeholder；按钮 `aria-label`；焦点环沿用全局 `:focus-visible` 轮廓；无 `tabindex>0`；开关有可见 label 与说明小字 |
| 文本对比与真实图标 | 状态色 / 文字色取主题 token；图标复用既有应用图标集（刷新 / 加号 / 删除 / 勾选 / 关闭 / 回转），不画仿造 logo |
| 文案 | 标题命名事物，按钮为动词 + 宾语（探测全部 / 自动优选线路 / 刷新镜像 / 恢复默认）；错误就近落在字段下方 |

**不适用项与理由**

| taste-skill 条目 | 不适用理由 |
| --- | --- |
| 首屏 hero / 首屏硬事实 / dealt moments | 本面板是宿主 App 内设置子页，无独立首屏与营销分屏 |
| 一屏一段、1440/1024/768/390 截图门禁 | 面板在 App 内容区内纵向滚动，不存在整屏分段；`check.mjs` / `consistency.mjs` 浏览器流水线不适用 |
| 真实摄影 / 产品图位 / photo-chapters | 线路面板全为控件与状态，无视觉素材槽位 |
| WebGL / shader 背景 / 场景动效 | 工具面板语境，无技术场景特效需求 |
| 地址 / 联系方式 / 税号 / 电话校验（规则 9） | 不涉及；URL 校验走既有 `normalizeOrigin` |
| `copy-lint.mjs` 文案流水线 | 未跑脚本；文案人工核对（动词 + 宾语、无套话残留） |
| 320px 溢出行走、滚动视差 / 视差门禁 | 面板宽度由宿主布局决定；无滚动视差与滚动联动动画 |
| 字体加载 / 标题字阶独立体系 | 沿用宿主字体栈，不引入新字体 |
| `gate.mjs` / `perf.mjs` 落地页门禁 | 独立静态站语境；按任务要求不执行，以人工对照 checklist 验收 |

### 11.5 受限项（如实说明）

- **发布页专项上限未复刻**：上游 512 KiB 正文上限、8 秒发布页超时、脚本同源重定向校验、UTF-8 校验运行在
  宿主 Rust `net::get`；本工程插件只能经 hpp 受控网络通道请求，沿用通道既有体积 / 超时 / 重定向策略，
  未在插件内复刻发布页专项上限。
- **手动镜像的信任边界**：`verify_published_origin` 式发布来源复核未移植。手动加入的镜像可被手动探测与
  点选，但不进入 `trusted` 集合，不参与自动优选；其会话 / 登录信任仍由宿主既有逻辑处理。
- **当前线路置顶**：上游 `recommended` 把当前线路置顶展示；本工程列表按固定 / 镜像 / 自定义分组顺序呈现，
  当前行仅作标记。
- **发布页元数据**：`source` / `script` / `recommended_source` 未透出到前端 UI。

### 11.6 红线自检（任务 B 增量）

| 红线 | 自检结论 |
| --- | --- |
| 前端 CSP | 未改 `tauri.conf.json`；新 UI 为宿主 React 组件，无 eval / 内联脚本 / 远程脚本 |
| Tauri capabilities | 未改 `capabilities/default.json`；未新增权限与 Rust 命令；前端仍走既有 `hpp_manage` 动作 |
| QuickJS 沙箱白名单 | 新增 5 个线路方法均在 `meta.extensions` 声明；prelude 按声明注册；沙箱内无 DOM / 裸桥 / 远端 JS 执行 |
| 受控网络 | 发布页抓取、镜像探测仍经 `hg.http.fetch` 插件独立 Network；外层壳未新增裸 reqwest；远端发布脚本仅做文本保守解析 |

### 11.7 验证

```bash
pnpm build
# tsc --noEmit + tsc --project tsconfig.tests.json + vite build 通过（仅既有 chunk 体积提示）

export PATH="$HOME/.cargo/bin:$PATH"
cargo check --manifest-path src-tauri/Cargo.toml
# Finished，无错误

cargo test --manifest-path src-tauri/crates/hpp/Cargo.toml
# 全部离线用例通过，0 失败；play_source.rs 覆盖新方法注册与 seeded fixed 列表断言
```

## 12. 任务反馈修复 ④：线路校验规则修订与分类错误文案

> 基线：`898e73f`。用户实测固定线路无法添加；根因为插件 `normalizeOrigin` 与前端预校验同口径过度严格，
> 所有失败被吞成同一句"只接受安全 HTTPS 公网 origin"。本轮以插件侧 `validateOrigin` 为唯一权威口径，
> 前端 `lineOrigin.ts` 镜像同一套规则做内联预校验。

### 12.1 校验规则变化表

| 项 | 旧口径 | 新口径 | 安全考量 |
| --- | --- | --- | --- |
| 方案 | 仅允许 HTTPS | 不变：仍强制 HTTPS，http / 非 https 一律拒绝 | 协议未放宽 |
| `huangguoai.ai` | 硬编码无条件拒绝 | 允许添加；探测层识别为导航页并提示"该域为导航页，非线路端点" | 该域仅导航、无 API 端点，由探测健康度自然暴露 |
| 端口 | 仅 443，`:8443` 等一律拒绝 | 允许显式 1–65535 的非默认端口；省略端口按 443 | 仍强制 https，端口放宽不伴随协议放宽 |
| IDN / 中文域名 | 正则仅 `[A-Za-z0-9.-]`，中文域直接拒 | 运行时 URL 解析先转 punycode 入库；展示保留原貌 Unicode host | 入库 base 为 ASCII punycode，避免传输/存储歧义 |
| 路径前缀 | 带路径被静默截断为 origin | 保留路径作为线路 base 前缀；后续 edge / 探测请求经 `baseJoin` 拼接保留前缀 | 去重按 protocol+host+port+path 规范化后比较 |
| 账密 / 用户信息 | 含 `@` 拒绝 | 不变：URL 含 username/password 拒绝 | — |
| 内网 / IP / localhost | 拒 IPv4 字面量与 localhost | 不变并补充：IPv6 字面量、`.localhost`、`.local` / `.internal` / `.home.arpa` 后缀拒绝 | 私网边界仍由受控网络策略二次兜底 |
| 域名标签 | 非法标签 / 首尾连字符 / 空标签 / 超 63 字符拒绝 | 不变；总长度上限 253 | — |

### 12.2 错误文案分类表

| 代码 | 触发条件 | 前端 / 插件文案 |
| --- | --- | --- |
| `EMPTY` | 空输入 | 请输入线路地址 |
| `SCHEME` | 非 https（http / 其他 scheme） | 仅支持 HTTPS 线路 |
| `CREDENTIALS` | 含用户名 / 密码 | 地址不能包含账号密码 |
| `PRIVATE` | IPv4 / IPv6 字面量、localhost、保留内网后缀 | 不允许内网、IP 或 localhost 线路 |
| `HOST` | 域名标签非法 / 过长 / 非 DNS 名 | 域名不合法 |
| `PORT` | 端口非 1–65535 整数 | 端口不合法（1–65535） |
| `INVALID` | URL 无法解析等其他 | 地址不合法 |
| 同组重复 | 已在当前分组列表 | 该线路已在固定线路中 / 已在镜像线路中 / 已在自定义线路中 |
| 跨组冲突 | 已存在于其他分组 | 该线路已在固定线路中 / 已在镜像线路中 / 已在自定义线路中 |

### 12.3 回归覆盖（`tests/play_source.rs::line_origin_validation_follows_classified_rules`）

- `huangguoai.ai` 可添加；
- `https://example.com:8443/prefix/` 可添加，canonical 保留 `:8443` 与 `/prefix`；
- 中文域名 `https://例子.com` 可添加，入库 base 为 punycode，展示 host 保留原貌；
- `http://example.com` 拒绝（仅支持 HTTPS 线路）；
- `127.0.0.1` / `localhost` / `10.0.0.5` 拒绝（不允许内网、IP 或 localhost 线路）；
- 同 canonical base 重复添加拒绝（该线路已在固定线路中）。

### 12.4 红线自检（反馈修复 ④）

| 红线 | 自检结论 |
| --- | --- |
| 前端 CSP | 未改 `tauri.conf.json`；无 eval / 内联脚本 / 远程脚本 |
| Tauri capabilities | 未改 `capabilities/default.json`；未新增权限或外层 Rust 命令 |
| QuickJS 沙箱白名单 | 未新增扩展方法；校验纯函数在沙箱内执行，无 DOM / 裸桥 |
| 受控网络 | 校验不发请求；请求仍走既有 `hg.http.fetch` 受控通道 |

## 13. 任务反馈修复 ⑤：镜像线路发布页机制对标上游

> 基线：`bcbd94f`。对照 `_upstream/hghubx/src-tauri/src/lines/mirror.rs`、`src/tauri/src/publish_parser.rs`
> 与 `_upstream/fork911218/src-tauri/src/lines.rs` 的发布页机制，补齐多条发布页持久化、保守解析、
> 分类失败文案与刷新状态。本节对 §11.2 中已被本轮取代的行（上限、专项时限 / 体积、脚本同源校验）以本表为准。

### 13.1 发布页机制对照表

| 上游能力 | 本工程落点 | 状态 |
| --- | --- | --- |
| 发布页列表（内置默认页） | `DEFAULT_PUBLISH_PAGES` 两条；持久化 `ps.line.pages`；读取时逐条经 `validateOrigin` 过滤，非法条目丢弃，空列表回落内置默认页 | 已移植 |
| 用户自定义增删发布页 | 扩展方法 `lines.addPublishPage` / `lines.removePublishPage`；规范化后去重，重复抛"该发布页已在列表中"；前端"地址发布页"分组列表 + 表单 | 已移植 |
| 多页并发抓取，单页失败不遮蔽其余 | `fetchPublishMirrors(pages)` 内 `Promise.all` 并发；逐页结果收集 `{source, items, error}` | 已移植 |
| 交错合并 + 去重 | 按索引交错合并，`seen` 按 canonical origin 去重；单轮上限 `MIRROR_MAX=60`（对齐上游，旧值 20） | 已移植 |
| JS-as-data 保守解析，不执行远端 JS | `stripComments` 去注释 → `readArrayBounded` 提取 `urls` / `subdomains` 字面量字符串数组；`PUBLISH_ARRAY_MAX=256` 截断；沙箱内无 JS 求值 | 已移植 |
| 发布脚本同源 HTTPS + 精确文件名 | `resolveScript`：`new URL(src, page)` 解析，强制 https、同 origin、拒绝账密、basename 必须为 `publish.js`（query 允许、fragment 剥离） | 已移植（在插件解析层） |
| 正文 512 KiB 上限、8 秒超时 | `getPublishText` 逐请求传 `timeoutMs=8000`、`maxBytes=512*1024`；credentials omit、responseType text | 已移植（逐请求口径；上游外层单 deadline 覆盖两次请求） |
| 可信镜像集合 | 发布页收录的 origin 写入持久化 `ps.line.trusted`；`autoPick` 仅在可信集合内优选；手动加入镜像不入可信集 | 已移植（持久化替代上游内存 FIFO 256） |
| 刷新入口 / 上次刷新时间 / 刷新中状态 | 前端"刷新镜像"按钮触发 `lines.mirrors`；返回 `pages` / `pagesAt`；`pagesAt` 写 `ps.line.pagesAt`，面板展示 `toLocaleString()`；刷新期间按钮随 `busy` 禁用 | 已移植 |
| 解析失败分类文案 | 网络类（超时 / 连接 / DNS / 断开 / refused / resolve）前缀"网络失败："；其余为上游格式类文案；逐页以 `源页: 文案` 汇总进 `errors` | 已移植 |
| 发布后线路与手动镜像合并 | 刷新时保留 `manual` 条目，发布条目按 origin 去重后并入；手动条目不被覆盖 | 已移植 |
| 恢复默认 | `lines.reset` 同时把发布页还原内置默认、清空 `pagesAt` | 已移植 |
| `verify_published_origin` 发布来源复核 | 未实现独立复核入口 | 受限项：见 13.4 |
| 重定向最终 URL 同源校验 | hpp `hg.http.fetch` 响应元数据不含最终 URL；脚本地址同源校验仅在解析层做一次 | 受限项：见 13.4 |
| `source` / `script` / `recommended_source` 元数据透出 | 错误文案带源页；脚本 URL、推荐来源串未向前端透出 | 受限项：见 13.4 |
| `recommended` 当前线路置顶 | 未置顶；当前行以"当前"标记呈现 | 未移植（展示排序差异） |

### 13.2 发布页添加指南

1. 进入播放源线路面板 → "地址发布页"分组；
2. 在输入框粘贴发布页地址（必须是安全 HTTPS 公网 origin，规则与线路校验同口径，见 §12.1）；
3. "添加"后列表持久化到本机；列表为空时自动回落两条内置默认页；
4. 点击"刷新镜像"，插件依次抓取每页 HTML → 定位同源 `publish.js` → 保守解析镜像域名数组，与既有手动镜像合并去重后参与探测与自动优选；
5. 删除发布页仅移除该来源，不会删除已抓入的镜像线路。

### 13.3 解析失败分类文案

| 类别 | 触发条件 | 文案口径 |
| --- | --- | --- |
| 网络失败 | 超时 / 连接失败 / DNS / 断开 / refused / resolve | `网络失败：<原始原因>` |
| 非 2xx | 响应状态码 ≥ 400 | `HTTP <status>` |
| 脚本缺失 | HTML 中无同源 `publish.js` | 未找到同源 publish.js 发布脚本 |
| 脚本来源非法 | 非 https / 跨源 / 含账密 / 文件名非 `publish.js` | 发布脚本非同源 HTTPS，已拒绝 / 只接受发布页同源的 publish.js 脚本 |
| 格式变化 | 脚本内无 `urls` 域名数组 | 发布页格式变化：未找到镜像域名数组 |
| 无合法条目 | 数组存在但无通过校验的 origin | 发布页没有可识别的合法镜像地址 |
| 地址无效 | URL 无法解析 / 发布脚本地址无效 | 发布脚本地址无效 |

### 13.4 受限项（如实说明）

- **重定向最终 URL 校验**：上游 `net::get` 校验跟随重定向后的最终 scheme / origin / 路径；hpp `hg.http.fetch` 响应元数据不暴露最终 URL，本工程只在脚本地址解析层做一次同源与文件名校验，重定向落地目标不在插件内二次核验，仍由受控网络策略兜底。
- **外层统一 deadline**：上游用一个 8 秒超时覆盖 HTML + 脚本两次请求；本工程逐请求各自 8 秒超时，两次请求的累计耗时不设统一上限。
- **发布来源复核未移植**：上游 `verify_published_origin` 在固定 / 可信放行之外，会并发刷新发布页并按 30 秒缓存复核未收录镜像；本工程无该独立入口，手动镜像可探测 / 点选但不进可信集、不参与自动优选。
- **解析器强度**：上游 token 级词法分析对注释 / 字符串 / 模板串 / 正则 / 重复声明 / 动态表达式 fail-closed 报错；本工程为字符串级保守扫描，非法条目跳过而非整页报错；数组超 256 条截断而非拒绝。
- **来源元数据**：`source` / `script` / `recommended_source` 未透出到前端 UI；错误汇总仅携带源页 URL。

### 13.5 红线自检（反馈修复 ⑤）

| 红线 | 自检结论 |
| --- | --- |
| 前端 CSP | 未改 `tauri.conf.json`；新增 UI 为宿主 React 组件，无 eval / 内联脚本 / 远程脚本 |
| Tauri capabilities | 未改 `capabilities/default.json`；未新增权限与外层 Rust 命令；前端仍走既有 `hpp_manage` 动作 |
| QuickJS 沙箱白名单 | `lines.addPublishPage` / `lines.removePublishPage` 已加入 `meta.extensions` 声明；prelude 按声明注册；沙箱内无 DOM / 裸桥 / 远端 JS 执行 |
| 受控网络 | 发布页与脚本抓取全部走 `hg.http.fetch` 受控通道（omit credentials、文本响应、超时 / 体积上限）；外层壳未新增裸客户端；远端脚本仅文本解析 |

### 13.6 验证与回归覆盖

- 回归测试 `tests/play_source.rs::publish_pages_are_persisted_with_add_remove_and_dedup`：默认发布页 ≥ 2；添加 `https://example.pages.dev/` 规范化入库；重复添加拒绝"该发布页已在列表中"；删除后重开不残留。
- 既有 `extension_methods_passthrough_and_envelope_unwrap` 方法断言列表已补两个新方法。
- 构建口径：`cargo check --manifest-path src-tauri/Cargo.toml` 通过；`cargo test --test play_source` 4 例全绿；`pnpm build` 通过（仅既有 chunk 体积提示）。

## 14. 任务反馈修复 ⑥：固定 / 自定义线路逐条独立探测

> 基线：`1ee18aa`。每条固定线路与自定义线路提供独立"探测"按钮，沿用镜像线路既有探测口径；
> 探测结果与当前选中线路持久化分离，探测不切换线路、不写 current / lastGood 键。

### 14.1 探测口径

| 项 | 落点 |
| --- | --- |
| 探测通道 | 复用既有 `lines.probe`（接受 `urls` 数组，逐条 `probeOrigin`）；经受控网络 `edgeAt` 直接 GET 线路源站的 `PROBE_PATH=/api/videos?page=1&size=1`（上游已停用 `/api/edge/request` 中转） |
| 有效判定 | 沿用 `healthyVideos`：`items` 数组 + `pagination` 页码 / 页长 / 页数 / 总数均为有限数，条目含正整数 `id` 与非空 `title` |
| 返回字段 | `tier` / `url` / `ok` / `reachable` / `ms` / `status` / `at`（结果时间戳）/ `error`；导航域结果追加"该域为导航页，非线路端点"提示 |
| 逐行触发 | 前端 `probeOne(url)` 仅以单元素数组调用 `lines.probe`；不调用 `endpoint.set` / `lines.set` |
| 失败计数 | 探测结果仅经 `noteProbeResult` 增减 `ps.line.fails` 失败计数（成功清零、失败 +1）；不触碰 `ps.line.current`，工程内不存在 `lastGood` 键 |

### 14.2 三态呈现

| 状态 | 色点 / 样式 | 文案 |
| --- | --- | --- |
| 探测中 | `loading` 中性色，点呼吸脉冲（`prefers-reduced-motion` 下静止）；该行探测按钮禁用 | 探测中… |
| 成功 | `ready` 绿点 | `<ms> ms`（带失败次数时附"失败 N 次"），末尾附结果时间 |
| 失败 | `failed` 红点 | 失败原因 / `HTTP <status>` / 不可达，末尾附结果时间 |
| 未探测 | `unloaded` 中性点 | 未探测；有历史失败计数时显示"连续失败 N 次" |

### 14.3 结果缓存与时间标注

- 探测结果保存在前端 `probes` 映射（会话级短期缓存），每条结果带 `at` 时间戳，面板以 `toLocaleTimeString()` 附在文案末尾；
- 缓存不写入插件存储；刷新线路状态后映射保留，重测覆盖旧条目；
- 行内探测互不阻塞：`probing` 按 URL 独立标记，仅禁用当前行按钮，其余线路可继续探测；工具栏"探测全部"仍走全局 busy 口径。

### 14.4 回归覆盖

- `tests/play_source.rs::probe_is_read_only_and_stamps_result_time`：拒绝类 origin 在发请求前即返回分类失败，结果带正数 `at`；探测前后 `state.base` 不变，证明未切换当前线路。
- 既有 `lines.probe` 命令与镜像探测路径复用，未新增网络通道。

### 14.5 红线自检（反馈修复 ⑥）

| 红线 | 自检结论 |
| --- | --- |
| 前端 CSP | 未改 `tauri.conf.json`；新增 UI 为宿主 React 组件，无 eval / 内联脚本 / 远程脚本 |
| Tauri capabilities | 未改 `capabilities/default.json`；未新增权限或外层 Rust 命令；复用既有 `lines.probe` 扩展方法 |
| QuickJS 沙箱白名单 | 未新增扩展方法；探测逻辑在既有插件沙箱内执行，无 DOM / 裸桥 |
| 受控网络 | 探测仍经 `hg.http.fetch` → `edgeAt` 受控信封；未新增裸客户端；远端数据仅按既有健康度判定 |

### 14.6 验证

- `cargo check --manifest-path src-tauri/Cargo.toml` 通过；
- `cargo test --test play_source` 5 例全绿；
- `pnpm build` 通过（仅既有 chunk 体积提示）。
