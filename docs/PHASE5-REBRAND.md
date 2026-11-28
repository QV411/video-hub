# 阶段五：项目更名 video-hub、更换应用图标并重建 APK

本阶段在阶段一~四成果之上，完成对外身份更名（HGhub → video-hub）、全套应用图标更换，
并用新标识重建 Android 交付包（aarch64 的 debug / release 双 APK）；桌面与移动端图标随全套图标一并生成。
四项安全红线（CSP、capabilities、QuickJS 沙箱、hpp 受控网络）**原样保留，未做任何弱化或新增**；
本阶段改动范围仅限命名、标识、图标与文档。

## 1. 变更概览

| 维度 | 旧 | 新 |
| --- | --- | --- |
| 产品名 / 窗口标题 / 应用名 | HGhub | video-hub |
| 桌面 identifier | `com.hghub.player` | `com.videohub.player` |
| Android applicationId / namespace | `com.hghub.player` | `com.videohub.player` |
| 应用图标 | 深蓝渐变发光网络播放标（v1） | 森绿 × 奶油白简化播放标（见第 5 节） |
| 交付 APK | `HGhub-Custom-aarch64-{debug,release}.apk` | `video-hub-aarch64-{debug,release}.apk` |

工程目录由 `HGhub-Custom/` 改名为 `video-hub/`，`.git` 随目录迁移，提交历史保持完整。

## 2. 标识对照（实际生效位置）

| 位置 | 字段 | 值 |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | `productName` | `video-hub` |
| `src-tauri/tauri.conf.json` | `identifier` | `com.videohub.player` |
| `src-tauri/tauri.conf.json` | 主窗口 `title` | `video-hub` |
| `src-tauri/tauri.macos.conf.json` | 窗口 `title` | `video-hub` |
| `index.html` | `<title>` | `video-hub · 插件视频播放器` |
| Android `app/build.gradle.kts` | `namespace` / `applicationId` | `com.videohub.player` |
| Android `strings.xml` | `app_name` / `main_activity_title` | `video-hub` |

## 3. 更名改动清单

### 3.1 配置与前端可见文案

- `src-tauri/tauri.conf.json`：`productName`、窗口 `title`、`identifier` 更名；**CSP 与
  devCsp 字符串逐字未动**（红线，见第 8 节）。
- `src-tauri/tauri.macos.conf.json`：macOS 窗口标题更名。
- `index.html`：页面标题更名。
- 前端可见文案：
  - `src/components/DesktopChrome.tsx`：侧栏版本串 `video-hub for …`；
  - `src/plugins/ApplicationSettings.tsx`：设置页"关于"标题 `video-hub <版本>`；
  - `src/plugins/ProxySettings.tsx`：代理设置说明文案；
  - `src/plugins/mockHost.ts`：测试桩环境 `app.name`。

### 3.2 Rust 插件注册与 Android 覆盖层

- `src-tauri/src/lib.rs`：三处 `register_android_plugin(...)` 的包名参数由
  `com.hghub.player` 改为 `com.videohub.player`（LoginWebViewPlugin /
  PluginDocumentsPlugin / OrientationPlugin）；启动失败 panic 文案改为 `video-hub`。
- `src-tauri/android/` tracked 覆盖层：6 个 main Kotlin 文件、3 个测试 Kotlin 文件、
  `ProcessIsolationFixture.kt`、两处测试 `AndroidManifest.xml` 的包声明 / `targetPackage` /
  `setClassName` 字符串批量迁移到 `com.videohub.player`。
- `scripts/sync-android-network.mjs`：4 处硬编码 Java 路径
  `com/hghub/player` → `com/videohub/player`。

### 3.3 gen 工程快照（`src-tauri/gen/`，gitignore，不入库）

- `gen/android` 内源码目录树 `com/hghub/player` 物理迁移到 `com/videohub/player`
  （main / androidTest / test / debug），kt 包声明与 `app/build.gradle.kts` 的
  namespace、applicationId 同步更名；`strings.xml` 应用名更名。
- `gen/android/app/src/main/assets/tauri.conf.json` 快照的 productName / identifier /
  title 同步刷新（CSP 段落照旧）。
- `generated/proguard-wry.pro` 的 keep 规则包名同步为 `com.videohub.player`。
- 重建前已清理 `app/build/` 旧包名缓存与 `jniLibs/` 旧预编译 `.so`，避免 stale 产物混入新包。

### 3.4 文档与脚本清扫

- README 改为五阶段索引，阶段五条目指向本文档；品牌名与图标引用同步更新。
- `docs/PHASE2-DOWNLOAD.md`、`docs/PHASE4-ANDROID.md`、`docs/plugin-protocol/IMPLEMENTATION.md`、
  `docs/developers/index.md`、`docs/developers/agent.md`、`AGENTS.md` 中的目录名、包路径、
  APK 表名与 identifier 更正。
- `scripts/build-docs.mjs`、`scripts/build-ios-unsigned.sh`、`tools/plugin-dev/SKILL.md`、
  `tools/plugin-dev/install.py` 内可见产物名 / 描述更名。

## 4. 保留不改的内部标识与品牌痕迹

更名只面向**对外身份**；以下内部名、历史品牌词与既有约定保持不动，避免无谓的破坏性改动：

| 类别 | 保留项 | 说明 |
| --- | --- | --- |
| Rust crate / lib 名 | crate `huangguo-client`、lib `huangguo_client_lib`、hpp crate `hghub-hpp` | 库名仅影响构建产物与内部引用，不对外可见；改名会牵动 `main.rs`、jniLibs `.so` 名与全部 hpp `use`，本阶段不做 |
| Android 主题资源 | `Theme.huangguo_client`（Manifest + 两处 themes.xml） | 与保留的 lib 名一致，纯内部样式引用 |
| 存储键前缀 | `.hghub_write_test`、`hghub-login-`、`hghub-debug-log-`、`hghubx-proxy-`、`hghub-security-` | 既有持久化键前缀，改名会让旧安装的数据 / Cookie 读不到，保留 |
| 签名密钥 | keystore 文件名 `hghub-release.keystore`、别名 `hghub` | 复用阶段四既有自签密钥；密钥不进入仓库 |
| 上游引用 | git remote `https://github.com/Minireel/HGhub.git`、文档 Pages base 路径 `/HGhub/`、上游站点 URL | 指向上游仓库与部署地址，不属于本产品身份 |
| 插件目录 / 组件 | `src/plugins/hghubx/` 目录与 `Hghubx*` 组件名、`hghubx` 启动模式值 | 对应上游 HGhubX 渲染器与既有 `startMode=hghubx` 设置键 |
| 启动方式按钮 | "HGhub 方式" / "HGhubX 方式" | 描述上游两种解析模式，不是产品名 |
| 插件开发技能 id | `hghub-plugin-dev` | 既有技能标识 |
| 内部日志 / 窗口类 | Android Log tag `HGhub`；Win32 登录窗口类名 `HGhub.HppLogin` | 内部标识，用户不可见 |
| 测试夹具与注释 | 夹具合成标题、CSS / 源码注释内的历史称谓 | 不影响产品身份 |

## 5. 图标方案

### 5.1 最终方案：森绿 × 奶油白简化版

- 底色：奶油白 `#FCF6EC`（自适应图标背景色 `#fcf6eb`）；
- 主体：深森绿 `#214F3E` 扁平圆角播放键（内三角为底色镂空），外圈单圈细轨道；
- 节点：轨道上 3 个节点，2 个森绿、1 个珊瑚橙 `#F07257`；
- 无光晕、无渐变、无网格连线。

### 5.2 候选与历史版本（同目录源图）

| 文件 | 状态 | 描述 |
| --- | --- | --- |
| `appicon-video-hub.png` | **当前生效** | 森绿 × 奶油白简化版（本阶段图标来源） |
| `appicon-video-hub-v1-backup.png` | 历史备份 | 深蓝圆角底、青蓝渐变发光播放键、多节点轨道网络，珊瑚橙节点；已停用 |
| `appicon-video-hub-alt2-V.png` | 未采用 | 黑底青蓝渐变 V 字母 + 橙圆点 |
| `appicon-video-hub-alt3-screen.png` | 未采用 | 蓝夜场景显示器 + 橙色播放键 + 青色流光 |

### 5.3 生成脚本与自适应安全区

- 可重复脚本：`scripts/set-app-icon.sh <源图.png> [前景缩放%]`（默认前景占比 80）。
- 流程：Python 裁去近奶油背景派生透明前景层 → 按比例居中收进中心约 66% 的圆形裁切安全区，
  避免轨道 / 节点被各厂商启动器遮罩切掉 → `pnpm tauri icon` 生成桌面 / Android / iOS /
  Windows 全套位图 → 回写 tracked `src-tauri/icons/android/` → `sync-android-icons.mjs`
  同步到 `gen/android/app/src/main/res`。
- 换候选图重跑：`scripts/set-app-icon.sh ../appicon-video-hub-alt2-V.png 75`。
- 桌面与 legacy 启动器保留奶油圆角底；自适应图标前景为透明抠图层，背景由
  `values/ic_launcher_background.xml` 提供奶油底色。

## 6. 更名后果与数据迁移

### 6.1 桌面数据目录切换

Tauri 按 identifier 决定应用专属数据目录，identifier 由 `com.hghub.player` 改为
`com.videohub.player` 后，桌面端首次启动会使用新目录，**不会自动读取旧目录数据**：

- Linux：`~/.local/share/com.hghub.player` → `~/.local/share/com.videohub.player`
- macOS：`~/Library/Application Support/com.hghub.player` →
  `~/Library/Application Support/com.videohub.player`
- Windows：`%APPDATA%\com.hghub.player` → `%APPDATA%\com.videohub.player`

需要保留旧安装的收藏、历史、插件与 Cookie 时，**在首启前**把旧目录整体复制到新目录即可。
本构建环境为全新环境，不存在旧 identifier 的数据目录，故未实现一次性自动迁移代码。

### 6.2 Android 安装

Android `applicationId` 变更后，旧包（`com.hghub.player`）与新包（`com.videohub.player`）
被系统视为两个不同应用，**无法覆盖安装**；需先卸载旧 APK 再安装新包。应用数据同样落在新
包名下的应用专属目录，卸载旧包前如需保留，请在旧版本内导出 / 备份。

## 7. APK 重建与核验

工具链与构建命令沿用阶段四（JDK 17、NDK 27.2.12479018、libclang 14、aarch64）：

```bash
source ~/android-env.sh
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
export LIBCLANG_PATH=/usr/lib/llvm-14/lib

pnpm tauri android build --debug --target aarch64 --apk --ci   # debug
pnpm tauri android build --target aarch64 --apk --ci          # release（本地 keystore 签名）
```

产物已复制到主项目目录 `/home/user/Doubao/chats/38455805805577218/`：

| 文件 | 体积 | 说明 |
| --- | --- | --- |
| `video-hub-aarch64-release.apk` | 13.3 MiB（13,974,324 字节） | 已签名（v2）、优化剥离，推荐安装 |
| `video-hub-aarch64-debug.apk` | 228.7 MiB（239,782,112 字节） | debug 未剥离符号，便于排查 |

核验结果（`aapt2 dump badging` / `apksigner verify -v` 实测）：

- 包名 `com.videohub.player`，versionName `0.0.4` / versionCode `4`；
- minSdk 24，targetSdk 36，native-code `arm64-v8a`；
- 应用名 / 启动器标题 `video-hub`（zh-CN / zh-HK / zh-TW 一致），启动 Activity
  `com.videohub.player.MainActivity`；
- 权限：仅 `android.permission.INTERNET`（另含构建工具自动生成的
  `com.videohub.player.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`，属正常的接收器保护权限，非危险权限）；
- release 包 `apksigner` 校验：**Verified using v2 scheme: true**，v1/v3 未启用，单签名者；
  签名证书沿用阶段四既有 keystore，证书 DN 仍为 `CN=HGhub Custom, OU=Dev, O=Local, L=Jinan,
  ST=Shandong, C=CN`（密钥与别名保留，见第 4 节；证书主体 DN 不属于应用对外身份）；
- APK 内 `mipmap-*/ic_launcher.png` / 前景层已解包目检，为森绿 × 奶油白新设计。

安装方式（真机开启 USB 调试后）：

```bash
adb install video-hub-aarch64-release.apk
# 或直接在手机上点击 APK 安装（需允许"安装未知来源应用"）
# 旧包 com.hghub.player 需先卸载，不能覆盖安装（见 6.2）
```

## 8. 红线自检

| 红线 | 本阶段落实 |
| --- | --- |
| **CSP 不弱化** | `src-tauri/tauri.conf.json` 的 `security.csp` / `devCsp` 逐字未动；diff 仅涉及 productName / identifier / title |
| **capabilities 不新增 / 不改** | `src-tauri/capabilities/default.json` git 零改动；未新增任何 Tauri 命令或权限 |
| **QuickJS 沙箱不动** | hpp 运行时、插件 Runtime/Context 隔离模型与预算 / 超时 / 中断语义未改 |
| **hpp 受控网络配置不动** | network_policy、Cookie 罐、代理与重定向校验、`network_security_config.xml` 未改；插件 / 下载流量仍走受控通道 |

构建回归：`pnpm build`（tsc 双配置 + vite）通过；`cargo check --manifest-path src-tauri/Cargo.toml`
无警告通过；Rust 侧仅改插件注册包名与 panic 文案。

## 9. 已知限制

- 内部 crate / lib / 主题名 / 存储键前缀保留旧称谓（见第 4 节），后续如要彻底统一需另立
  迁移阶段，并配合桌面 / Android 旧数据的自动迁移。
- 桌面 identifier 与 Android applicationId 变更属于破坏性安装变更，旧安装需手工迁移数据、
  Android 需卸载重装（见第 6 节）。
- 阶段四既有限制在本阶段原样继承；其中 Android 公共下载目录与分区存储权限（任务 D）、
  内置 FFmpeg TS→MP4 转封装（任务 E）已在后续阶段闭合，见 [`PHASE2-DOWNLOAD.md`](PHASE2-DOWNLOAD.md)
  §10、§11。截至本阶段仍遗留：单片 8 MiB 上限、`offline:` 回放通道、BYTERANGE /
  `transformResource` 链路待补。
