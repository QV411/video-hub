# 任务 E 留档：911218sky/HGhub MP4 转换方案调研（内部工作笔记，不对外发布）

> 调研对象：`_upstream/fork911218`（911218sky/HGhub，Tauri 2 + React + Rust）。
> 本笔记只服务后续任务 E（离线成品 MP4 封装），公开文档不再重复以下细节。
> 更早的全量下载链路调研见 `_research/report-fork911218-download.md` §2.1.7–2.1.9、§2.2。

## 1. 一句话结论

上游离线成品默认是 **AES-128 解密后顺序拼接的 MPEG-TS（`video.ts`）**；
FFmpeg 只做 **流拷贝转封装（remux，`-c copy`，不转码）** 为 `video.mp4`，
音频追加 `aac_adtstoasc` 比特流滤镜修正 ADTS→ASC 头。无 FFmpeg 或转封装失败时
**降级保留 TS 成品**，不阻断下载任务。

## 2. FFmpeg 二进制定位与便携安装（`ffmpeg_tool.rs`）

| 项 | 上游实现 | 出处 |
| --- | --- | --- |
| 查找顺序 | 应用工具目录内置版优先 → 系统 PATH 版兜底 | `ffmpeg_tool.rs:59-61` `resolve_bin()` |
| 内置目录 | `<app_data>/tools/ffmpeg/`；Windows `ffmpeg.exe`，其它 `ffmpeg` | `ffmpeg_tool.rs:12-32` `bind` / `bundled_bin` |
| PATH 探测 | `Command::new("ffmpeg" / "ffmpeg.exe").arg("-version")`，退出成功即采纳 | `ffmpeg_tool.rs:34-56` `path_bin` |
| 状态上报 | `available`（bundled/path/missing）、`source`、`path`、`can_install`（Android/iOS 为 false） | `ffmpeg_tool.rs:63-86` `status` |
| 自动下载源 | ffbinaries 预编译 **v6.1** zip，按平台分 URL：win-x64 / linux-x64 / macos-x64 / macos-arm64；其它平台报错 | `ffmpeg_tool.rs:88-100` `download_url` |
| 下载安全 | 仅 HTTPS；host 白名单 `github.com / objects.githubusercontent.com / release-assets.githubusercontent.com`；重定向最多 8 跳且每跳复核 host；超时 180s；UA 带应用版本；响应体 < 64KB 判异常 | `ffmpeg_tool.rs:102-146` |
| 解压 | `zip::ZipArchive` 只取 `ffmpeg(.exe)` 单文件；先写 `*.tmp` 再 rename；Unix 置 0755 | `ffmpeg_tool.rs:148-188` |
| 落地冒烟 | `ffmpeg -version` 跑通才算成功；失败删除二进制 | `ffmpeg_tool.rs:190-203,226-229` |
| 移动平台 | Android/iOS 不支持自动安装（`can_install=false`，`install` 直接报错） | `ffmpeg_tool.rs:84,207-209` |

### 上游遗留风险（移植时不要照搬）

- `ffmpeg_tool.rs:118-123` 自建 `reqwest::Client`，**未走 `net.rs` / `network_policy.rs`**：
  没有私网/环回 DNS 校验，也没接线路代理配置。
- PATH 兜底模式下若 PATH 中存在同名恶意 `ffmpeg`，会被直接执行（`ffmpeg_tool.rs:39-53`）。
- 本工程四条红线：外层不得新增裸网络客户端；FFmpeg 下载若实现，必须复用既有受控通道或
  明确的宿主能力，不能在插件沙箱内拉起外部进程。

## 3. 单集成品流水线（`download.rs`）

### 3.1 文件与命名（`download.rs:323-326, 880-888`）

- 每集目录 `offline:{video_id}/ep_{ep}/`，固定三文件：`video.mp4`、`video.ts`、`index.m3u8`。
- 分片 `seg_0000.<ext>`：扩展名取 URL 路径末段，长度 ≤5、仅字母数字，否则 `bin`。

### 3.2 解密 + 合并 + 转封装 `finalize_episode`（`download.rs:919-985`）

1. 解析本地 `index.m3u8` 的 `#EXT-X-KEY`：仅处理 `AES-128`；`METHOD=NONE`/空 视为不加密；
   密钥从同目录已下载密钥文件读前 16 字节；IV 取属性 `IV`，缺省按
   `MEDIA-SEQUENCE + 片序号` 生成序列 IV（`download.rs:999-1053`）。
2. 逐片读盘 → `aes128_cbc_decrypt`（AES-128-CBC 链式解密 + PKCS7 去填充，
   `download.rs:1055-1079`）→ 追加写入 `video.ts`；单片解密失败报
   `decrypt failed for <name>`。
3. 若解析到 FFmpeg：尝试 `try_ffmpeg_remux` 转 `video.mp4`；成功返回 mp4，
   失败/无 FFmpeg 保留 `video.ts`（`download.rs:961-984`）。

### 3.3 转封装命令 `try_ffmpeg_remux`（`download.rs:1081-1110`）

```
ffmpeg -y -hide_banner -loglevel error \
  -i video.ts \
  -c copy \
  -bsf:a aac_adtstoasc \
  video.mp4
```

- `-c copy`：音视频流拷贝，**不重编码**（速度快、无质量损失）。
- `-bsf:a aac_adtstoasc`：把 TS 内 AAC 的 ADTS 头改写为 MP4 所需的 ASC 头，否则
  MP4 内音频无法正常解封装。
- stdin/stdout/stderr 全部 `null`；Windows 加 `CREATE_NO_WINDOW` 隐藏控制台。
- 判定成功：进程退出码成功 **且** `video.mp4` 落盘；任一不满足返回 `false`，回退 TS。

### 3.4 失败处理与状态机

- 网络/解析错误以 `Result<_, String>` 冒泡；`run_job` 捕获后写 `job.status="error"`、
  `job.message=e`（`download.rs:680-695`）。
- 列表扫描修复旧版本遗留的假 `running`：磁盘已有成片（mp4/ts/m3u8 任一）即改判
  `done`（`download.rs:287-312`）。
- 下载层重试在 `net.rs`：可重试错误（408/425/429/5xx、连接类）最多 3 次、指数退避
  350ms 起；401/404/策略拒绝/重定向错误不重试。
- **断点续传只有集级跳过**：整集成片存在才跳过；单集中途失败重跑时，已下载
  `seg_xxxx` 不校验复用，整集重走流水线（旧分片被同名覆盖）。
- 整剧 `download_series`（`download.rs:710-735`）：集号 1..=n 顺序执行，已就绪集跳过；
  某集失败即整剧失败返回。

### 3.5 离线回放优先级（`download.rs:339-349`）

`video.mp4` → 本地 `index.m3u8`（分片+密钥已在盘）→ `video.ts`（仅桌面兜底）。
原因：移动端 WebView `<video>` 通常播不了裸 MPEG-TS。

## 4. 任务 E 落地提示（本工程约束下）

- 本工程下载器当前基线（阶段二）只落地清单/分片/密钥字节走插件受控网络；MP4 封装
  属于宿主原生能力，插件沙箱内**不能**拉起 ffmpeg、不能读任意 fs。
- 若任务 E 实现 MP4：转封装应在宿主 Rust 侧完成，命令参数对齐 §3.3；FFmpeg 定位/安装
  策略、平台限制、降级 TS 口径可参考 §2/§3.4。
- 不得照搬上游自建 reqwest 下载 ffmpeg 的做法；二进制获取需走既有受控通道或明确的
  宿主能力声明，并过 `network_policy` 校验。
- 封面/分片解密口径与阶段三封面代理、阶段二下载解密保持一致，避免两套 AES 实现漂移。
