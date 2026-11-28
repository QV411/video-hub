# 阶段四：Android APK 构建说明

本阶段在桌面三阶段成果（移除更新检查 / 下载功能 / 播放源插件）之上，把同一套 Tauri 工程交叉编译为可安装的 Android APK。桌面端四项安全红线在移动端原样生效，未为移动端弱化任何一项。

## 1. 可行性评估结论：可行

### 1.1 Tauri 移动端支持

- Tauri CLI 2.10.1、Rust 侧 `tauri = "2"`（实际解析 2.12.5）完整支持 Android 移动端，官方提供 `tauri android init / build` 工作流。
- 四个 Rust Android target 均已在工具链中就绪：`aarch64-linux-android`、`armv7-linux-androideabi`、`i686-linux-android`、`x86_64-linux-android`。本阶段交付包按真机主流架构构建 **aarch64（arm64-v8a）**。
- 上游工程本就为 Android 做了准备，并非临时改造：
  - `src-tauri/crates/hpp/Cargo.toml` 已声明 Android 专属依赖 `jni 0.21`、`ndk-context 0.1`；
  - 对 `android/ios` 启用 `rquickjs` 的 `bindgen` feature（rquickjs 不发布移动端预生成绑定，需 libclang 针对 NDK 现场生成）；
  - 代码中已有大量 Android 分支：系统代理经 JNI 读取（`proxy.rs`）、`android_login.rs`、`android_documents.rs`、`lib.rs` 注册三个 Android 原生插件、下载模块移动端目录选择返回"不支持"等。

### 1.2 关键依赖交叉编译情况（aarch64-linux-android）

| 依赖 / 模块 | Android 情况 | 处理方式 |
| --- | --- | --- |
| hpp 运行时（含 QuickJS 沙箱） | 可编译；`rquickjs 0.12.2` 移动端需 bindgen | 安装 NDK + libclang，构建时针对 NDK 生成绑定；`rquickjs-sys` 使用工程内 vendored 副本（`src-tauri/vendor/`） |
| 下载模块 `download.rs` | 可编译，Rust 侧逻辑（任务队列、HLS 下钻、AES-128-CBC 解密、TS 拼接）平台无关 | 仅目录选择命令在移动端返回不支持；无 ffmpeg 时成品保留 TS |
| `reqwest`（受控网络底层） | 可编译，使用 rustls，不依赖系统 OpenSSL | 无需额外处理 |
| 文件系统 / 路径处理（`canonicalize` 前缀校验、`app_data` 目录） | 可编译，Tauri 在 Android 提供应用专属数据目录 | 下载根落在应用专属目录，经 FileProvider 共享，不申请存储权限 |
| ffmpeg 检测与 MP4 转封装 | 不自动下载 ffmpeg（桌面阶段已裁掉裸连下载链路）；仅检测 `<app_data>/tools/ffmpeg` 与系统 PATH | Android 无 ffmpeg 时下载成品保留 TS，不报错、不阻塞 |
| `aes 0.8` / `url 2` / `base64 0.22` | 纯 Rust，可编译 | 无需处理 |
| `jni 0.21` / `ndk-context 0.1` | Android 专属依赖，仅在 `target_os = "android"` 引入 | 桌面构建不受影响 |

结论：**不存在阻断 Android 构建的原生依赖**，debug 与 release 构建均一次通过（仅非致命的弃用 API 警告）。

## 2. 工具链安装

### 2.1 版本基线

| 组件 | 版本 |
| --- | --- |
| JDK | OpenJDK 17（Tauri 2 要求 17；环境原带 JDK 11 不满足） |
| Android SDK | cmdline-tools 11076708、platform-tools、platforms android-35 / android-36（模板 compileSdk/targetSdk = 36，Gradle 构建时自动补装 android-36） |
| build-tools | 35.0.0 |
| NDK | 27.2.12479018（r27c） |
| libclang | LLVM 14（`/usr/lib/llvm-14/lib/libclang.so`） |
| Gradle / Kotlin | 8.14.3 / 2.0.21（由 Tauri 工程 wrapper 管理） |

### 2.2 安装步骤

```bash
# JDK 17 与 libclang（Ubuntu/Debian）
sudo apt install openjdk-17-jdk-headless libclang-dev

# Android cmdline-tools（dl.google.com 可达时）
mkdir -p ~/Android/Sdk/cmdline-tools
cd ~/Android/Sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-11076708_latest.zip
mv cmdline-tools latest
cd ~/Android/Sdk/cmdline-tools/latest/bin
./sdkmanager --licensing          # 接受全部许可
./sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
             "ndk;27.2.12479018"
```

### 2.3 环境变量

写入 `~/android-env.sh` 并在 `~/.bashrc` 中 source：

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
export LIBCLANG_PATH=/usr/lib/llvm-14/lib
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
```

### 2.4 已踩过的坑（复现时直接规避）

1. **空代理变量**：环境中 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 可能存在但为空字符串，Java 工具（sdkmanager、Gradle）会抛 `MalformedURLException`。每条构建命令前需显式 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy`。
2. **apt 源不可用**：默认 Ubuntu 源经本地代理返回 503 时，可将 `/etc/apt/sources.list` 换为 `https://mirrors.aliyun.com/ubuntu/` 镜像后再 `apt update`。
3. **init 不复制覆盖层**：Tauri 2.10.1 的 `tauri android init` 只生成模板工程，不会自动把 `src-tauri/android/` 覆盖层同步进去，必须手动执行 sync 脚本（见下节）。

## 3. 工程初始化与覆盖层同步

```bash
cd video-hub
pnpm install

# 1) 生成 gen/android 工程（已生成可跳过）
pnpm tauri android init

# 2) 同步原生覆盖层（Kotlin 插件、网络安全配置、Manifest 注入、图标）
node scripts/sync-android-network.mjs
node scripts/sync-android-icons.mjs
```

`sync-android-network.mjs` 完成的关键工作：

- 把 `src-tauri/android/` 下 6 个 Kotlin 文件复制到 `gen/android/app/src/main/java/com/videohub/player/`（阶段五已由 `com.hghub.player` 迁移到 `com.videohub.player`；登录 WebView 独立进程、文档路径、屏幕方向等原生插件）；
- 复制 `network_security_config.xml` 并 patch `AndroidManifest.xml`（注入 `networkSecurityConfig` 与 `LoginWebViewActivity`，登录页运行在独立 `:hpp_login` 进程）；
- 测试文件分别落到 androidTest / test / debug 对应目录。

## 4. 构建命令

```bash
source ~/android-env.sh
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
export LIBCLANG_PATH=/usr/lib/llvm-14/lib

# Debug APK（带未剥离符号，体积大，可直接安装）
pnpm tauri android build --debug --target aarch64 --apk --ci

# Release APK（优化 + 剥离 + 签名，见第 5 节）
pnpm tauri android build --target aarch64 --apk --ci
```

产物目录：

- debug：`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- release：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

> 文件名虽含 universal，但本构建只指定 `--target aarch64`，jniLibs 中仅含 `arm64-v8a`。需要其他 ABI 时追加 target（如 `--target armv7`）或省略 target 构建全 ABI 包。

## 5. Release 签名

Tauri 生成的 release buildType 默认无签名配置，不配置会产出未签名、不可安装的包。本工程采用"本地属性文件 + Gradle 签名配置"方式，密钥不进入仓库。

### 5.1 生成自签密钥

```bash
keytool -genkeypair -v \
  -keystore ~/Android/hghub-release.keystore \
  -alias hghub -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass hghub123 -keypass hghub123 \
  -dname "CN=HGhub Custom, OU=Dev, O=Local, L=Jinan, ST=Shandong, C=CN"
```

### 5.2 本地属性文件

`src-tauri/gen/android/app/keystore.properties`（位于 `gen/` 目录内，根 `.gitignore` 已整体忽略 `src-tauri/gen/`，不会提交）：

```properties
storeFile=/home/user/Android/hghub-release.keystore
storePassword=hghub123
keyAlias=hghub
keyPassword=hghub123
```

### 5.3 Gradle 配置

`app/build.gradle.kts` 读取上述属性文件并创建 `release` signingConfig，release buildType 引用之；**属性文件缺失时自动回退为未签名配置，构建不会报错**，便于在没有密钥的 CI 环境复用同一份脚本。

### 5.4 签名核验

```bash
~/Android/Sdk/build-tools/35.0.0/apksigner verify -v app-universal-release.apk
# Verified using v2 scheme (APK Signature Scheme v2): true
```

## 6. 交付产物与核验结果

已复制到主项目目录 `/home/user/Doubao/chats/38455805805577218/`（阶段五更名后产物名为 `video-hub-aarch64-*.apk`）：

| 文件 | 体积 | 说明 |
| --- | --- | --- |
| `video-hub-aarch64-release.apk` | 已签名（v2）、已优化剥离，推荐安装 |
| `video-hub-aarch64-debug.apk` | debug 未剥离符号，便于排查 |

包信息（aapt2 实测，阶段五更名后）：

- 包名 `com.videohub.player`，versionName `0.0.4` / versionCode `4`
- minSdk 24，targetSdk 36，native-code `arm64-v8a`
- 权限：仅 `android.permission.INTERNET`（另含构建工具自动生成的 `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`，属正常的接收器保护权限，非危险权限）

安装方式（真机开启 USB 调试后）：

```bash
adb install video-hub-aarch64-release.apk
# 或直接在手机上点击 APK 安装（需允许"安装未知来源应用"）
```

## 7. 移动端红线核验

| 红线 | 移动端落实情况 |
| --- | --- |
| **CSP 不弱化** | `src-tauri/tauri.conf.json` 自阶段一以来 git 零改动；生产 CSP 仍为 `script-src 'self'`、`connect-src` 仅 IPC/回环/hg.localhost，无公网条目。Android 不引入额外 CSP 配置 |
| **capabilities 最小化** | 桌面 `src-tauri/capabilities/default.json` git 零改动；Android 侧仅声明 **INTERNET** 一项权限。不申请存储权限的理由：下载与数据均写入应用专属目录（`app_data`，沙箱内可见、无需授权），对外共享通过 `exported=false` 的 FileProvider 临时授权；登录 WebView 的 Activity 同样 `exported=false` 且运行在独立进程 |
| **播放源独立 QuickJS 沙箱** | 内置播放源插件 `play-source.js` 仍由 hpp 运行时加载，移动端 rquickjs 经 bindgen 针对 NDK 生成绑定并成功编译，沙箱隔离模型与桌面完全一致；远端发布页仍按 JS-as-data 保守解析，不执行远端 JS |
| **网络走 hpp 受控通道** | 所有插件/下载流量仍经 hpp 受控 Network（network_policy、Cookie 罐、代理、重定向校验）；`network_security_config.xml` 全局禁明文，仅 `127.0.0.1/localhost` 允许 cleartext，供 HPP 应用本地媒体服务器投递鉴权资源，无任何外部直连 |

## 8. 移动端已知限制（与桌面基线一致，无新增）

- 无 ffmpeg 时下载成品保留 TS，不做 MP4 转封装；
- 移动端下载目录选择返回"不支持"（`download.rs` 中 `download_pick_dir` 的移动端分支），使用应用专属默认目录；
- 单片分片超 8 MiB 会被受控网络策略拒绝；
- `offline:` 离线回放通道、BYTERANGE 清单、`transformResource` 密钥变换链路留待后续阶段；
- HGhubX 渲染器仅覆盖首页 / 搜索 / 分类视图。
