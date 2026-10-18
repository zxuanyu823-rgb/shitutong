#!/bin/sh
# 批量评测，结果写到 eval/ 目录
cd "$(dirname "$0")/.."
run() { node tools/eval-recon.mjs "$@" 2>/dev/null | grep -v -i "warning\|Reparsing\|eliminate\|trace-warnings"; }
{
echo "## 三视图齐全"
for cfg in "0 0" "0.005 0.02" "0.01 0.03"; do set -- $cfg; echo "### 噪声 $1 比例误差 $2"; run $1 $2 - 3; done
echo "## 只给主视图和俯视图（补画左视图）"
for cfg in "0 0" "0.005 0.02"; do set -- $cfg; echo "### 噪声 $1 比例误差 $2"; run $1 $2 left 3; done
} > eval/results.md
echo done
