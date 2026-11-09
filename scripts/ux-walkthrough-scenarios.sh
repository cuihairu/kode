#!/usr/bin/env bash
# UX-REVIEW-009a 四种可重复走查场景生成器。
#
# 用法: scripts/ux-walkthrough-scenarios.sh <outdir>
#   生成:
#     1-empty/              空工作区(零文件)
#     2-valid-project/      有效 KBEngine 项目(demo 资产:8 def + 完整 res/server)
#     3-missing-config/     缺配置(scripts/defs 在,res/server 引擎配置整体缺席)
#     4-backend-unavailable/后端不可用(引擎配置指向 127.0.0.1:13306,无监听)
#
# 全部由 tests/fixtures 确定性装配,可重复;目录已存在则先清空重建。
# 场景 4 预期:连接检查/只读查询如实报「连接失败:ECONNREFUSED」。
set -euo pipefail

OUT="${1:?usage: ux-walkthrough-scenarios.sh <outdir>}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$SRC/tests/fixtures/kbengine-demo-assets"

if [ ! -d "$FIX" ]; then
  echo "fixture missing: $FIX" >&2
  exit 1
fi

mkdir -p "$OUT"

# 1) 空工作区
rm -rf "$OUT/1-empty"
mkdir -p "$OUT/1-empty"

# 2) 有效 KBEngine 项目(demo 资产全量拷贝)
rm -rf "$OUT/2-valid-project"
cp -R "$FIX" "$OUT/2-valid-project"

# 3) 缺配置:scripts/defs 在,res/server 引擎配置缺席(发现面如实「未找到」)
rm -rf "$OUT/3-missing-config"
cp -R "$FIX" "$OUT/3-missing-config"
rm -rf "$OUT/3-missing-config/res"

# 4) 后端不可用:引擎配置覆盖 dbInterface 指向无监听端口
rm -rf "$OUT/4-backend-unavailable"
cp -R "$FIX" "$OUT/4-backend-unavailable"
python3 - "$OUT/4-backend-unavailable/res/server/kbengine.xml" <<'PYEOF'
import pathlib, sys

target = pathlib.Path(sys.argv[1])
overlay = """<root>
\t<!-- UX-REVIEW-009a 场景 4:dbInterface 指向无监听地址(127.0.0.1:13306)。
\t\t预期连接检查/只读查询如实「连接失败:ECONNREFUSED」,不虚构可用。 -->
\t<dbmgr>
\t\t<databaseInterfaces>
\t\t\t<default>
\t\t\t\t<pure> false </pure>
\t\t\t\t<type> mysql </type>
\t\t\t\t<host> 127.0.0.1 </host>
\t\t\t\t<port> 13306 </port>
\t\t\t\t<auth>
\t\t\t\t\t<username> kbe </username>
\t\t\t\t\t<password> pwd123@db </password>
\t\t\t\t</auth>
\t\t\t</default>
\t\t</databaseInterfaces>
\t</dbmgr>
</root>
"""
target.write_text(overlay)
print(f"overlay written: {target}")
PYEOF

# 场景规模记录(可重复验证)
echo "--- scenario scale ---"
for s in 1-empty 2-valid-project 3-missing-config 4-backend-unavailable; do
  files=$(find "$OUT/$s" -type f | wc -l)
  defs=$(find "$OUT/$s" -name '*.def' | wc -l)
  echo "$s: files=$files defs=$defs"
done
echo "scenarios ready under $OUT"
