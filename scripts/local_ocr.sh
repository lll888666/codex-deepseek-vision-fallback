#!/bin/bash
# 本地 OCR 兜底：自动探测 tesseract 语言包目录，避免 TESSDATA_PREFIX 缺失导致失败。
# 用法: bash local_ocr.sh "<图片绝对路径>"
IMG="$1"
if [ -z "$IMG" ]; then
  echo "用法: bash local_ocr.sh <图片绝对路径>" >&2
  exit 1
fi
if ! command -v tesseract >/dev/null 2>&1; then
  echo "本地 OCR 不可用: 未找到 tesseract" >&2
  exit 1
fi

TESSDATA=""
for cand in \
  "$TESSDATA_PREFIX" \
  /opt/anaconda3/share/tessdata \
  /opt/homebrew/share/tessdata \
  /usr/local/share/tessdata \
  /usr/share/tesseract-ocr/*/tessdata \
  "$(dirname "$(command -v tesseract)")/../share/tessdata"; do
  if [ -n "$cand" ] && [ -f "$cand/chi_sim.traineddata" ]; then
    TESSDATA="$cand"
    break
  fi
done

if [ -z "$TESSDATA" ]; then
  # 无中文包时退而求其次，只用默认语言
  tesseract "$IMG" stdout 2>/dev/null
  exit $?
fi

TESSDATA_PREFIX="$TESSDATA" tesseract "$IMG" stdout -l chi_sim+eng
