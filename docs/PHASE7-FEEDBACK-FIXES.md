# 第七阶段：任务反馈修复收口与最终构建核验

> 基线：`d8c6617`（工作树起始干净）。本阶段把三轮七项反馈修复逐条收口，并统一重建
> aarch64 release / debug 双 APK、源码包，完成权限 / 签名 / ABI / 原生库 / 图标 /
> dex 字符串证据留档与红线总自检。
>
> **环境声明**：当前执行环境无 Android 真机，亦未进行任何真机安装 / 授权 / 下载 /
> 转封装实测。下文所有 Android 运行期行为均为静态代码路径核对、清单 / 抽包核验与
> 构建产物证据；标注「待真机确认」的环节必须由用户在真机上复核。

## 1. 七项反馈修复对照表

| 序号 | 反馈问题 | 提交号 | 代码落点 | 验证证据（静态 / 构建 / 测试） | 待真机确认 |
| --- | --- | --- | --- | --- | --- |
| ④ | 线路校验过严，正常线路被误判；分类失败缺可读文案 | `bcbd94f` | `crates/hpp/src/manager.rs`、`tests/play_source.rs` | 校验规则放宽（端口 / IDN / 路径前缀 / 导航域）；分类错误文案表；`cargo test --test play_source` 5 例全绿 | 各候选线路在真机网络下的真实可用性 |
| ⑤ | 镜像线路发布页只取单条、解析不保守、分类失败无文案 | `1ee18aa` | `crates/hpp/src/manager.rs`、内置插件 `play-source.js`、`LinePicker.tsx` | 发布页多条持久化、保守 JS 数据解析；解析失败分类文案；hpp 离线套件全绿 | 上游页面结构调整时镜像列表表现 |
| ⑥ | 固定 / 自定义线路未逐条独立探测，结果与当前线路混杂 | `fff8bf5` | 插件探测逻辑、线路面板三态呈现 | 逐条独立探测、结果与当前线路分离、缓存与时间标注；`play_source.rs` 回归覆盖 | 真机探测耗时与超时阈值 |
| ② | 下载默认目录未统一：设置页 / 下载中心 / 新任务 / 回退态四条链路显示不一致 | `409a606` | `src-tauri/src/download.rs`、`src/downloadStore.tsx`、`src/download-access.ts`、`Downloads.tsx`、`ApplicationSettings.tsx` | `download_get_settings` 新口径（`effectiveDir` / `defaultDir` / `mode` / `reason`）；四条链路逐一核对（见 PHASE2 §12）；桌面单测断言 `mode=public`、`reason` 非空；Android 常量断言在位 | 未授权 / 建目录失败回退分支的真机表现 |
| ③ | 所有文件访问授权链路 / 引导可发现性不足 | `3e8db9e` | `src-tauri/src/android_storage.rs`、`src-tauri/android/StorageAccessPlugin.kt`、前端双入口横幅与设置行 | 双入口状态展示；三级 Intent 回退；返回 `focus` / `visibilitychange` 重查；授权后自动建目录切回 `public`；厂商兜底匹配表（见 PHASE2 §13）；dex 字符串与方法名编进产物（见本文 §3.5） | 三级 Intent 各 ROM 落点、授权返回刷新时机、公共目录真实写入、FFmpeg 真机转封装、文案与 ROM 层级吻合度 |
| ⑦ | 播放源板块缺统一设计语言 | `5af4838` | `src/design-tokens.css`、播放源消费组件 | vh token 层（间距 / 圆角 / 字号字重 / 表面 / 状态 / 品牌锚点）；选型与映射见 `DESIGN-LANGUAGE.md`；`pnpm build` 通过 | —（纯前端静态样式） |
| ① | 下载板块样式与「我的」不统一；状态 / 触控 / 空态 / 重试不齐 | `d8c6617` | `src/plugins/downloads.css`、`Downloads.tsx`、下载选择面板 | 复用同一套 token；六态（下载中 / 转换中 / 排队 / 完成 / 失败 / 中断）视觉与文案；44px 触控、骨架、空态、错误重试；目录横幅联动 §12 / §13 口径（见 PHASE2 §14） | —（纯前端静态样式） |
| 收尾 | Android 交叉编译目录回退三元组类型不匹配（E0308） | `95f0201` | `src-tauri/src/download.rs` | 三元组标注 `(PathBuf, String, String)`，静态文案 `.into()`，`store_root` 借用 `&mode`；桌面 `cargo check` 通过 | — |

## 2. 最终双 APK 构建核验

构建命令（沿用既有工作流；构建前 `unset` 空代理变量，内联 JDK 17，NDK `27.2.12479018`）：

- debug：`pnpm tauri android build --debug --target aarch64 --apk --ci`
- release：`pnpm tauri android build --target aarch64 --apk --ci`
- 前置：`pnpm build`（tsc 双配置 + vite）通过；`cargo check --manifest-path src-tauri/Cargo.toml` 通过。

### 2.1 产物清单

| 项 | debug | release |
| --- | --- | --- |
| APK 路径（构建输出） | `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` | `…/universal/release/app-universal-release.apk` |
| 体积 | 91,261,320 字节（约 87.0 MiB） | 24,701,996 字节（约 23.6 MiB） |
| 包名 | `com.videohub.player` | `com.videohub.player` |
| versionName / versionCode | `0.0.4` / `4` | `0.0.4` / `4` |
| minSdk / targetSdk | 24 / 36 | 24 / 36 |
| native-code | `arm64-v8a`（仅此一个 ABI） | `arm64-v8a`（仅此一个 ABI） |
| 签名 | APK Signature Scheme v2：`true`（v1/v3/v3.1/v4：false，1 个签名者） | 同左，v2：`true` |

release 签名证书：

- DN：`CN=HGhub Custom, OU=Dev, O=Local, L=Jinan, ST=Shandong, C=CN`
- 证书 SHA-256：`edfe4e8fc9e014de7ebef97733a3557d755c3220a8f8ad5c7912c0a401d18441`
- 证书 SHA-1：`a5786cf4c2f493b3af5d1efccab462d2422874b0`
- keystore 路径 / alias 见 `gen/android/app/keystore.properties`（密钥文件不入库）。

### 2.2 权限清单（aapt2 dump badging）

双 APK 权限一致：

| 权限 | 形态 | 来源 / 备注 |
| --- | --- | --- |
| `android.permission.INTERNET` | 普通权限 | 源 manifest 第 3 行；Tauri 模板既有 |
| `android.permission.MANAGE_EXTERNAL_STORAGE` | 危险权限（无 maxSdk） | 源 manifest **第 8 行**，与此前用户证据「第 8 行」对齐；由 `scripts/sync-android-network.mjs` 幂等注入 `gen/android`（`gen` 不入库） |
| `android.permission.WRITE_EXTERNAL_STORAGE` | `maxSdkVersion=28` | 源 manifest 第 9 行；同一同步脚本注入 |
| `android.permission.READ_EXTERNAL_STORAGE` | `maxSdkVersion=28` | 合并进最终 APK（aapt2 抽包可见）；低版本只读兼容 |
| `com.videohub.player.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | 应用自定义 signature 级保护权限 | 构建工具为导出接收器自动生成；非危险权限 |

> 权限体系区分（保持既已记录口径）：上述均为 **Android Manifest 系统权限**，不属于
> Tauri capability；`src-tauri/capabilities/default.json` 全程零新增。

### 2.3 原生库（`lib/arm64-v8a/`）

双 APK 内置的 9 个业务 `.so` 与源 `src-tauri/android/jniLibs/arm64-v8a/SHA256SUMS.txt`
逐一对上，sha256 一致：

| 库 | sha256 |
| --- | --- |
| `libavcodec.so` | `7ede75a9b406850ad6c174405e00b68726b6ff69d86e857cc7ea7a14f0513d6e` |
| `libavdevice.so` | `11edb6489e36ef2c1d130478af572db98962dee403c52187428dae03edae1b95` |
| `libavfilter.so` | `6bd6c2b036808f601068dbbf7a254c7f6061181befb74240bc597dcc4eae2617` |
| `libavformat.so` | `566dc0ab7fb083d2e8327df617e8cbd17d76dbdc2cda36edfe0bd7368fcd5119` |
| `libavutil.so` | `8ddfb6d5cdac2dee98fad0f9080e21f02fcd62faa3b02562b3bfd3a74846c3a7` |
| `libc++_shared.so` | `d523468d62d9b603cb3354294d70d4b2feabf2c3f1e43b0c96c9aabf32813708` |
| `libffmpeg.so` | `ac8ba3c78fa9d2a5997360a7e7b3988ca8c93bea9499d1aa600142edcf87fffb` |
| `libswresample.so` | `30b58a8c1650c09d584d3842098663f36a685f1163b9a124146ca348082e807b` |
| `libswscale.so` | `00fab529d24e5d846f5a41a0e025fff2ed94525053cd839a47985a63f22c6965` |

另有主客户端库 `libhuangguo_client_lib.so`（debug `c4834449…` / release
`508cde32…`），为本次 Rust 交叉编译产物，debug / release 体积与摘要不同属正常。

### 2.4 Launcher 图标

- debug 解包 `res/mipmap-hdpi-v4/ic_launcher.png` 目检：奶油白底、深森绿播放三角、
  浅色轨道上两枚绿色节点 + 一枚珊瑚橙节点，仍为阶段五森绿设计，未混入紫色。
- release 资源经 R8 混淆重命名为 `res/yn.png`（hdpi），与 debug 图标字节一致
  （md5 `080ae44ac8853a0f420ff02c813b8a4c`）。

### 2.5 dex 字符串与 Kotlin 桥接方法证据

对解包出的 `classes*.dex` 做字符串搜索：

| 证据串 | debug 所在 dex | release 所在 dex |
| --- | --- | --- |
| `MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` | `classes9.dex` | `classes.dex` |
| `MANAGE_ALL_FILES_ACCESS_PERMISSION` | `classes9.dex` | `classes.dex` |
| `APPLICATION_DETAILS_SETTINGS` | `classes9.dex`、`classes.dex` | `classes.dex` |
| `com.videohub.player`（含 `com/videohub/player`） | `classes8.dex`、`classes9.dex` | `classes.dex` |
| `isExternalStorageManager` | `classes9.dex` | `classes.dex` |
| 桥接方法 `isManager` | `classes9.dex` | `classes.dex` |
| 桥接方法 `openAllFilesSettings` | `classes9.dex` | `classes.dex` |
| 桥接方法 `getNativeLibraryDir` | `classes9.dex` | `classes.dex` |
| 桥接方法 `getManufacturer` | `classes9.dex` | `classes.dex` |

源码侧对应：`src-tauri/android/StorageAccessPlugin.kt`（package
`com.videohub.player`）实现上述四个桥接方法；Rust 侧 `src-tauri/src/android_storage.rs`
以 `run_mobile_plugin_async` 同名调用。

### 2.6 公共根常量与前端硬编码扫描

- 常量：`src-tauri/src/download.rs:35`
  `ANDROID_PUBLIC_ROOT = "/storage/emulated/0/1🇩𝝨/🇩短剧/HGHub"`，第 2058 行有回归
  断言同值。od 字节（UTF-8）：

```
2f 73 74 6f 72 61 67 65 2f 65 6d 75 6c 61 74 65 64 2f 30 2f 31
f0 9f 87 a9 f0 9d 9d a8 2f f0 9f 87 a9 e7 9f ad e5 89 a7 2f 48 47 48 75 62
```

- 前端扫描：`grep -rn "/storage/emulated\|/storage/sdcard\|Android/data" src/`
  无任何公共路径硬编码（命中仅为「短剧」等文案 / 分类名，非路径）；新任务目录一律由
  后端按当前生效根解析。

## 3. 源码包

- 口径：`git archive HEAD --prefix=video-hub/`，仅含被 git 跟踪的文件；`gen/`、
  `target/`、`dist/`、`node_modules/`、密钥文件按 `.gitignore` 排除。
- 输出覆盖主项目目录旧包 `video-hub-src.zip`。

## 4. 红线总自检（区间 `b930035..HEAD`）

### 4.1 六份红线文件零改动

| 红线文件 | `git diff --stat b930035..HEAD` |
| --- | --- |
| `src-tauri/tauri.conf.json`（CSP） | 空，零改动 |
| `src-tauri/capabilities/default.json` | 空，零改动 |
| `src-tauri/src/network_policy.rs` | 空，零改动 |
| `src-tauri/crates/hpp/src/network_policy.rs` | 空，零改动 |
| `src-tauri/android/network_security_config.xml` | 空，零改动 |
| `src-tauri/crates/hpp/src/prelude.js` | 空，零改动 |

### 4.2 权限与沙箱口径

- `MANAGE_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`（maxSdk 28）/
  `READ_EXTERNAL_STORAGE`（maxSdk 28）为 Android Manifest 系统权限，由同步脚本注入
  `gen/android`（不入库）；**不是** Tauri capability，`capabilities/default.json`
  保持 `core:default` + 窗口基础权限，零新增。
- 沙箱白名单：`prelude.js` `methods` 清单按空间固定（media / live / articles /
  resolver / search / home / catalog / feed / endpoints / auth / ui / library /
  progress / updates / comments / interact），二次校验在位；`lines.addPublishPage` /
  `lines.removePublishPage` 等为内置插件脚本内部线路对象方法，经既有 `call` 桥接转发，
  不属于宿主扩展方法注册，未新增白名单条目。
- 插件网络仅 `hg.http.fetch` → `host("http", params, signal)` 进入 hpp 受控
  `Network`；本阶段未新增任何裸客户端通道。

## 5. 待真机确认清单（当前环境无安卓设备）

1. 三级 Intent（本应用所有文件访问页 → 系统总列表 → 应用详情页）在各品牌 ROM 上的
   实际落点与可启动性；
2. 授权返回后 `Environment.isExternalStorageManager()` 的刷新时机，WebView
   `focus` / `visibilitychange` 回调在目标 ROM 上是否命中；
3. 公共目录真实写入权限，`create_dir_all` 在存储挂载 / 卸载 / 权限撤销等状态下的表现；
4. 内置 FFmpeg 在真机 arm64 上的解包、TS 流拷贝转封装 MP4 结果，以及「保留 TS」开关；
5. 厂商识别文案（MIUI / EMUI / HarmonyOS / ColorOS / OriginOS / One UI）与实际
   ROM 菜单层级吻合度；
6. 下载中心 / 设置页双入口在真机上的状态刷新、骨架与空态呈现。

## 6. 相关文档

- 下载目录口径与四条链路：[`PHASE2-DOWNLOAD.md`](PHASE2-DOWNLOAD.md) §12
- 授权链路 / 厂商兜底 / 真机路径：[`PHASE2-DOWNLOAD.md`](PHASE2-DOWNLOAD.md) §13
- 下载板块样式口径：[`PHASE2-DOWNLOAD.md`](PHASE2-DOWNLOAD.md) §14
- 线路 / 发布页 / 探测反馈修复：[`PHASE6-PLAYSOURCE-CATEGORIES.md`](PHASE6-PLAYSOURCE-CATEGORIES.md) §12–14
- 设计语言选型与 token 映射：[`DESIGN-LANGUAGE.md`](DESIGN-LANGUAGE.md)
