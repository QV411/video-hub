#!/usr/bin/env bash
# 生成 video-hub 全套应用图标，并把 Android 图标同步进 gen/android 工程。
#
# 用法:
#   scripts/set-app-icon.sh <源图.png> [前景缩放%]
#
# 参数:
#   <源图.png>     1024×1024 或更大的正方形源图（桌面/legacy/iOS/Windows 图标直接使用）
#   [前景缩放%]    Android 自适应图标前景主体在画布内的占比，默认 80；
#                  主体先按该比例缩放到透明画布中心，收进中心约 66% 的圆形裁切安全区，
#                  避免轨道/节点被各厂商遮罩切掉。
#
# 示例（换候选图重跑）:
#   scripts/set-app-icon.sh ../appicon-video-hub.png
#   scripts/set-app-icon.sh ../appicon-video-hub-alt2-V.png 75
#
# 流程: 源图 → 派生透明前景层（内置安全区留白）+ 清单 → `tauri icon` 全套生成
#       → 回写 tracked 的 src-tauri/icons/android/ → 同步 Android 资源到 gen/。
# 中间产物落在临时目录，不写入仓库；gen/ 本就被 gitignore。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-}"
FG_SCALE="${2:-80}"

if [ -z "$SRC" ]; then
  echo "用法: $0 <源图.png> [前景缩放%]" >&2
  exit 1
fi
[ -f "$SRC" ] || { echo "找不到源图: $SRC" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 从源图派生 Android 透明前景层（去掉近奶油色背景）并按安全区比例居中缩放。
#    背景色取四角平均，写入 manifest 的 bg_color 作为自适应图标底色。
python3 - "$SRC" "$TMP" "$FG_SCALE" <<'PY'
import json, sys
import numpy as np
from PIL import Image

src, tmp, scale = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert("RGBA")
arr = np.asarray(im).astype(np.int16)
h, w, _ = arr.shape

corners = np.array([arr[2, 2], arr[2, w - 3], arr[h - 3, 2], arr[h - 3, w - 3]])
bg = corners.mean(axis=0).astype(int)[:3]

r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
# 近奶油色背景判据：高明度、暖白通道差小；命中即透明，保留深森绿与珊瑚橙主体
cream = (r > 215) & (g > 205) & (b > 185) & ((r - b) < 45) & ((g - b) < 35)
alpha = np.where(cream, 0, 255).astype(np.uint8)
fg = Image.fromarray(np.dstack([arr[..., :3].astype(np.uint8), alpha]), "RGBA")

# 裁出主体包围盒，按 factor 相对原画布缩放后贴回透明正方形中心（自适应图标安全区留白）
bbox = fg.getbbox()
if bbox:
    crop = fg.crop(bbox)
    factor = scale / 100
    crop = crop.resize((round(crop.width * factor), round(crop.height * factor)), Image.LANCZOS)
    fg = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fg.paste(crop, ((w - crop.width) // 2, (h - crop.height) // 2), crop)

fg.save(f"{tmp}/app-icon-fg.png")
im.save(f"{tmp}/app-icon-default.png")

manifest = {
    "default": "app-icon-default.png",
    "bg_color": "#%02x%02x%02x" % tuple(bg),
    "android_fg": "app-icon-fg.png",
    "android_fg_scale": scale,
}
with open(f"{tmp}/icon-manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
print(f"[icon] 背景色 {manifest['bg_color']}，前景主体占比 {scale}%")
PY

# 2) 刷新仓库根的默认输入图（tauri icon 未指定参数时的缺省来源）
cp "$SRC" "$ROOT/app-icon.png"

# 3) 生成桌面 / Android / iOS / Windows 全套图标到 src-tauri/icons/
( cd "$ROOT" && pnpm tauri icon "$TMP/icon-manifest.json" )

# 4) tauri icon 在检测到 gen/android 时会把 Android 资源直接写到 gen 工程；
#    这里把同一套图标回写 tracked 的 src-tauri/icons/android/，保证覆盖层与产物一致。
GEN_RES="$ROOT/src-tauri/gen/android/app/src/main/res"
TRACKED_ANDROID="$ROOT/src-tauri/icons/android"
if [ -d "$GEN_RES" ]; then
  for dir in "$GEN_RES"/mipmap-*; do
    name="$(basename "$dir")"
    mkdir -p "$TRACKED_ANDROID/$name"
    cp "$dir"/* "$TRACKED_ANDROID/$name/"
  done
  mkdir -p "$TRACKED_ANDROID/values"
  cp "$GEN_RES/values/ic_launcher_background.xml" "$TRACKED_ANDROID/values/"
fi

# 5) 把 tracked 的 Android 资源同步进 gen/android（android init 不会复制覆盖层图标）
node "$ROOT/scripts/sync-android-icons.mjs"

echo "[icon] 完成：桌面图标在 src-tauri/icons/，Android 资源在 src-tauri/icons/android/ 并已同步到 gen/android/app/src/main/res"
