# 设计语言选型与 vh token 映射

本文件记录本轮设计语言落地的选型依据、候选比较、token 映射、取舍与不适用项。
token 定义见 `src/design-tokens.css`，消费方为播放源板块（线路三区 / 发布页管理 /
探测状态 / 启动方案入口卡片）与下载板块。

## 1. 参考来源

候选来自本地 `awesome-design-md` 集合（README 自述：84 份真实网站 DESIGN.md 分析，
每份覆盖 Visual Theme / Color / Typography / Component / Layout / Depth /
Do&Don't / Responsive / Prompt 九节）：

- 集合入口：`~/.doubao/agent_mode/workspace/.skills/awesome-design-md/README.md`
- 主参考：`design-md/notion/DESIGN.md`
- 次参考（仅语义色角色）：`design-md/mintlify/DESIGN.md`
- 已比较未采用：`design-md/linear.app/DESIGN.md`、`design-md/raycast/DESIGN.md`

DESIGN.md 仅为公开可见 CSS 值与规则分析；品牌色一律不照搬，只借结构、尺度、表面、
层级与状态规则。

## 2. 候选比较

| 候选 | 视觉基调 | 表面 / 边框 | 强调色 | 字体层级 | 与本工程匹配度 | 取舍 |
| --- | --- | --- | --- | --- | --- | --- |
| **Notion** | 暖调极简编辑器，卡片 + 行列表 + 设置行 | 画布 / 表面 / 发丝边框三层；1px hairline 分隔 | Notion 紫（仅主导 CTA）；语义成功绿 / 警告橙 / 错误红 | 600 标题、500 按钮与正文强调、400 正文；body-sm 14px/500、caption-bold 13px/600 | **高**：与现有"我的"设置页的卡片列表、设置行、分段控件、44px 输入高度一致 | 借间距节奏、表面层级、圆角几何、字重层级、行列表结构；**不借紫色**与营销 hero 字阶 |
| Linear | 近黑画布的产品文档式深色界面 | 炭黑面板 + hairline 边框 | 薰衣草蓝紫 `#5e6ad2` | 500–700 负字距 | 低：本工程浅色奶油主题为主，强调色蓝紫与品牌森绿冲突 | 不采用；仅保留"面板 + 发丝边框"这一已在工程内的既有做法 |
| Raycast | 纯近黑命令面板氛围，单色表面阶梯 | `#07080a → #101111`，1px `#242728` | 饱和分类色（黄 / 红 / 绿 / 蓝）仅用于插件图标 | Inter ss03，6–10px 紧圆角 | 低：整体暗色命令面板气质与下载 / 设置页不符 | 不采用 |
| Mintlify | 文档平台双模式，浅色为主 | 表面阶梯 + 边框 | 霓虹绿 `#00d4a4`、错误红 `#d45656`、警告橙 | 文档排版层级 | 中：语义状态色角色（成功 / 警告 / 错误）可对照；品牌绿为霓虹绿，与本工程深森绿不同 | 仅借"状态色分工"规则；不借霓虹绿、渐变 hero |

## 3. 选定理由

- **主参考 Notion**：本工程现有设置页已经是"卡片容器 + 行列表 + 分隔线 + 分段控件"
  的形态，Notion 的列表 / 设置类界面规则与之同构——4px 基准间距、hairline 分隔、
  8px 按钮圆角 / 12px 卡片圆角、44px 输入高度、600/500/400 三级字重，落地时不需要
  改变信息架构，只把散落的硬编码值收敛到 token。
- **次参考 Mintlify**：成功 / 警告 / 错误三档语义色角色作为状态文案与色标的对照；
  工程内既有 `--p-success / --p-danger` 继续承担实际颜色，token 层只做角色命名映射。
- **品牌锚点保留**：森绿 `#214F3E`、奶油白 `#FCF6EC`、珊瑚橙 `#F07257` 仍是品牌色；
  深色主题下品牌强调色沿用既有薄荷绿 `#7FB89F`。禁止引入任何紫色（含 Notion 紫、
  Linear 薰衣草蓝紫）。

## 4. token 映射表

token 前缀 `--vh-`（video-hub），定义于 `src/design-tokens.css`，全部解析到既有
主题变量，深色 / 浅色主题仍由 `:root` 与 `html.theme-light` 切换。

| vh token | 提炼规则（参考出处） | 工程落点 |
| --- | --- | --- |
| `--vh-space-xxs/sm/md/lg/xl/xxl` | Notion 4px 基准，8px 主增量（`spacing.xxs` 4px 起） | 行内 / 行 / 卡片 / 分组间距，替换原硬编码 4/8/12/16/20/24/32px |
| `--vh-radius-xs/sm/md/lg/full` | Notion 圆角刻度：4 chip、6 badge、8 按钮 / 输入、12 卡片、9999 胶囊 | 按钮 / 输入 / 卡片 / 徽章 / 胶囊 |
| `--vh-type-title-size/weight` | Notion heading 3 / 分组标题：13px / 600 | 分组标题、行内强调标题 |
| `--vh-type-body-size/weight` | Notion body-sm-medium：14px / 500（工程内取 13.5px 保持既有密度） | 行标签、按钮文案 |
| `--vh-type-caption-size/weight` | Notion body-sm：11.5px / 400 | 辅助说明、URL、次级状态 |
| `--vh-type-micro-size/weight` | Notion caption-bold：10px / 600 | 徽标、"当前"标记 |
| `--vh-type-btn-size/weight` | Notion button-md：12.5px / 500 | 按钮文案 |
| `--vh-surface-card/row/sunken` | Notion canvas / surface / surface-soft 三层表面 | 卡片容器、行背景、分段控件凹槽 |
| `--vh-border` | Notion hairline：1px 发丝边框 | 卡片 / 输入 / 行分隔 |
| `--vh-state-ready/failed/idle/loading` | Mintlify 语义角色 + Notion 状态点 | 探测成功 / 失败 / 未加载 / 加载中 |
| `--vh-state-disabled-opacity` | Notion disabled：静音处理 | 禁用按钮 / 控件 |
| `--vh-state-hover` | 悬浮表面（工程既有 `--p-hover`） | 行 / 按钮悬浮 |
| `--vh-brand` / `--vh-brand-ink` / `--vh-coral` | 本工程品牌锚点，不随参考站点改色 | 品牌主操作、反白文字、珊瑚强调 |
| `--vh-brand-accent` / `-ink` / `-tint` | 品牌强调及其浅底；浅色主题 = 森绿，深色主题 = 薄荷绿 | 主按钮、徽标浅底、当前线路标记 |
| `--vh-touch` / `--vh-touch-sm` | Notion text-input 44px 高度；桌面次级动作 36px | 移动端触控目标、桌面按钮高度 |
| `--vh-motion-fast` | 既有 0.15s 缓动节奏收敛为 token | 按钮 / 状态过渡 |

## 5. 取舍与不适用项

以下 Notion / Mintlify / Linear / Raycast 规则**未落地**，记录原因：

- **Notion 紫色主 CTA 与紫色徽标**：工程禁紫；主操作改用品牌森绿（浅色）/ 薄荷绿
  （深色），错误操作仍用既有 danger 色。
- **Notion 营销字阶**：80px hero、56/48/36/28px 展示标题不进入工程；界面内只保留
  13/13.5/12.5/11.5/10px 五档界面字号。
- **Notion pastel feature 卡片**（peach/rose/mint/lavender/sky 浅底）：工程不做营销
  色块卡片，分组列表统一用中性表面 + 发丝边框。
- **Notion pill-tab 全圆角胶囊导航**：工程分段控件沿用既有凹槽 + 内嵌选中块形态，
  不改成全圆角胶囊。
- **Linear / Raycast 深色面板阶梯与近黑画布**：工程以浅色奶油主题为主，深色沿用既有
  `--p-s1..s3` 表面变量，不复制其炭黑值。
- **Mintlify 霓虹绿 `#00d4a4` 与渐变 hero**：不引入；成功色继续用既有 `--p-success`。
- **Notion 文档注明 no-hover**：工程既有 `.pressable` 悬浮反馈保留，hover 表面由
  `--vh-state-hover` 提供，不照搬其无 hover 策略。

## 6. 本轮落地范围（第 7 项提交）

- `src/design-tokens.css`：vh token 层定义（新建）。
- `src/App.tsx`：token 文件先于插件样式引入。
- `src/plugins/plugins.css`：线路面板（固定 / 镜像 / 自定义 / 发布页四组）行列表、
  行、按钮、输入、徽标、状态点、分段控件、空态全部改读 vh token；行列表改为中性卡片
  容器 + 行分隔线，不再每行套独立卡片。
- `src/plugins/refined-pages.css`：启动方案入口卡片（`library-scheme-card` 及其标题 /
  辅助文案 / 行间距）对齐 vh token。

## 7. 红线自检

- 本提交为纯前端 CSS 变量 / 类名重构与文档，未改动 `tauri.conf.json`、
  `capabilities/default.json`、两份 `network_policy.rs`、`network_security_config.xml`、
  `prelude.js` 六份红线文件。
- 未新增 Tauri capability、未改 CSP、未动 QuickJS 沙箱白名单、未新增网络请求；
  token 全部为本地 CSS 变量，不引用远程字体或外部资源。
