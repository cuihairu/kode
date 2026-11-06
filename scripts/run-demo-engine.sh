#!/bin/sh
# 迷你 ARPG demo 真引擎起服验证(DEMO-GAME-001..005)。
#
# 纪律:不直跑仓库夹具——先把 tests/fixtures/kbengine-demo-assets 复制到独立运行
# 目录,再对 res/server/kbengine.xml 做数据库/网卡覆盖,引擎从运行目录起服。
#
# 用法:
#   scripts/run-demo-engine.sh start [KBE_ROOT]   # 复制夹具→起 9 进程
#   scripts/run-demo-engine.sh bots               # 起无头玩家 bots(已起服后)
#   scripts/run-demo-engine.sh stop               # 杀掉本脚本起的全部引擎进程
#   scripts/run-demo-engine.sh clean              # stop + 删运行目录
#
# 环境变量:
#   KBE_ROOT        引擎仓根(默认 ~/workspaces/kbengine;二进制在 kbe/bin/server)
#   KBE_DEMO_RUN    运行目录(默认 ~/.cache/kode-demo-engine-run)
#   KBE_DEMO_DB     MySQL 主机(默认 192.168.5.5:3306,库 kode_demo)
#   KBE_DEMO_NIC    引擎 internalInterface(默认本机 192.168.5.x 首地址)
#
# 验收锚(起服后 grep 运行目录 logs/):
#   "Spaces[?] created"                Spaces 空间管理器建立
#   "Space[?] created (index=1)"       Space 基实体建立
#   "Space cell[?].onGetCell" 或 "space established"  cell 空间就绪
#   "spawn done: [id, id, id]"         刷怪表生成 3 只 Monster
#   "Avatar[?].onEnterSpace"           角色进世界(bots 登录建角后)
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURE="$REPO_ROOT/tests/fixtures/kbengine-demo-assets"
KBE_ROOT=${KBE_ROOT:-"$HOME/workspaces/kbengine"}
RUN_DIR=${KBE_DEMO_RUN:-"$HOME/.cache/kode-demo-engine-run"}
DB_HOST_PORT=${KBE_DEMO_DB:-192.168.5.5:3306}
DB_NAME=kode_demo
DB_USER=root
DB_PASS=${KBE_DEMO_DB_PASS:-kbengine_root_pw_2026}

DB_HOST=${DB_HOST_PORT%%:*}
DB_PORT=${DB_HOST_PORT##*:}

detect_nic() {
	if [ -n "${KBE_DEMO_NIC:-}" ]; then printf '%s\n' "$KBE_DEMO_NIC"; return; fi
	# 192.168.x 段优先(与既有验证环境一致),回落 lo 不可用时报错退出
	addr=$(ip -4 -o addr show scope global 2>/dev/null | awk '$4 ~ /^192\.168\./ {print $4; exit}' | cut -d/ -f1)
	[ -n "$addr" ] || addr=$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{print $4; exit}' | cut -d/ -f1)
	[ -n "$addr" ] || { echo "run-demo-engine: 未找到可用网卡地址,请设 KBE_DEMO_NIC" >&2; exit 1; }
	printf '%s\n' "$addr"
}

write_kbengine_xml() {
	nic=$1
	cat > "$RUN_DIR/res/server/kbengine.xml" <<EOF
<root>
	<trace_packet><debug_type> 0 </debug_type></trace_packet>
	<publish><state> 0 </state><script_version> 0.1.0 </script_version></publish>
	<dbmgr>
		<InterfacesServiceAddr><enable> false </enable></InterfacesServiceAddr>
		<account_system>
			<account_resetPassword><enable> true </enable></account_resetPassword>
			<account_registration><enable> true </enable><loginAutoCreate> true </loginAutoCreate></account_registration>
		</account_system>
		<databaseInterfaces>
			<default>
				<type> mysql </type>
				<host> $DB_HOST </host>
				<port> $DB_PORT </port>
				<auth><username> $DB_USER </username><password> $DB_PASS </password><encrypt> false </encrypt></auth>
				<databaseName> $DB_NAME </databaseName>
			</default>
		</databaseInterfaces>
	</dbmgr>
	<machine><internalInterface> $nic </internalInterface></machine>
	<logger><internalInterface> $nic </internalInterface></logger>
	<interfaces><internalInterface> $nic </internalInterface></interfaces>
	<baseappmgr><internalInterface> $nic </internalInterface></baseappmgr>
	<cellappmgr><internalInterface> $nic </internalInterface></cellappmgr>
	<cellapp><internalInterface> $nic </internalInterface></cellapp>
	<loginapp><internalInterface> $nic </internalInterface></loginapp>
	<bots><internalInterface> $nic </internalInterface></bots>
	<baseapp><backupPeriod> 500 </backupPeriod><internalInterface> $nic </internalInterface></baseapp>
</root>
EOF
}

prepare_run_dir() {
	nic=$(detect_nic)
	rm -rf "$RUN_DIR"
	mkdir -p "$RUN_DIR"
	cp -r "$FIXTURE/." "$RUN_DIR/"
	# 清掉仓库夹具里的 IDE 配置残影,保持运行目录纯净
	rm -rf "$RUN_DIR/.vscode"
	write_kbengine_xml "$nic"
	echo "run dir: $RUN_DIR (nic=$nic db=$DB_HOST:$DB_PORT/$DB_NAME)"
}

engine_env() {
	cat <<EOF
KBE_ROOT='$KBE_ROOT'
KBE_RES_PATH='$KBE_ROOT/kbe/res/:$RUN_DIR:$RUN_DIR/res:$RUN_DIR/scripts/'
KBE_BIN_PATH='$KBE_ROOT/kbe/bin/server/'
KBE_DEMO_LOG_DIR='$RUN_DIR/logs-proc'
KBE_DEMO_EVIDENCE='$RUN_DIR/evidence.log'
EOF
}

do_start() {
	prepare_run_dir
	eval "$(engine_env)"
	export KBE_ROOT KBE_RES_PATH KBE_BIN_PATH KBE_DEMO_LOG_DIR KBE_DEMO_EVIDENCE
	mkdir -p "$KBE_DEMO_LOG_DIR"
	cd "$RUN_DIR"
	# log4cxx 的 DailyRollingFileAppender 不会创建父目录:logs/ 必须先于进程存在,
	# 否则脚本层 INFO 日志(空间建立/刷怪/进世界验收锚)整批静默丢失。
	mkdir -p "$RUN_DIR/logs"
	# stdbuf 行缓冲:引擎嵌入的 Python 输出/日志写 stdout 是块缓冲,重定向文件时
	# 进程活着期间看不到任何行;行缓冲后验收锚(Spaces/Space/进世界)实时可见。
	RUN() { stdbuf -oL -eL "$@"; }
	RUN "$KBE_BIN_PATH/machine" --cid=2129652375332859700 --gus=1 >"$KBE_DEMO_LOG_DIR/machine.out" 2>&1 &
	RUN "$KBE_BIN_PATH/logger" --cid=1129653375331859700 --gus=2 >"$KBE_DEMO_LOG_DIR/logger.out" 2>&1 &
	RUN "$KBE_BIN_PATH/interfaces" --cid=1129652375332859700 --gus=3 >"$KBE_DEMO_LOG_DIR/interfaces.out" 2>&1 &
	RUN "$KBE_BIN_PATH/dbmgr" --cid=3129652375332859700 --gus=4 >"$KBE_DEMO_LOG_DIR/dbmgr.out" 2>&1 &
	RUN "$KBE_BIN_PATH/baseappmgr" --cid=4129652375332859700 --gus=5 >"$KBE_DEMO_LOG_DIR/baseappmgr.out" 2>&1 &
	RUN "$KBE_BIN_PATH/cellappmgr" --cid=5129652375332859700 --gus=6 >"$KBE_DEMO_LOG_DIR/cellappmgr.out" 2>&1 &
	RUN "$KBE_BIN_PATH/baseapp" --cid=6129652375332859700 --gus=7 >"$KBE_DEMO_LOG_DIR/baseapp.out" 2>&1 &
	RUN "$KBE_BIN_PATH/cellapp" --cid=7129652375332859700 --gus=8 >"$KBE_DEMO_LOG_DIR/cellapp.out" 2>&1 &
	RUN "$KBE_BIN_PATH/loginapp" --cid=8129652375332859700 --gus=9 >"$KBE_DEMO_LOG_DIR/loginapp.out" 2>&1 &
	echo "9 processes starting; logs: $KBE_DEMO_LOG_DIR/, script log: $RUN_DIR/logs/"
}

do_bots() {
	eval "$(engine_env)"
	export KBE_ROOT KBE_RES_PATH KBE_BIN_PATH KBE_DEMO_LOG_DIR KBE_DEMO_EVIDENCE
	cd "$RUN_DIR"
	stdbuf -oL -eL "$KBE_BIN_PATH/bots" >"$KBE_DEMO_LOG_DIR/bots.out" 2>&1 &
	echo "bots started (headless players; see $RUN_DIR/logs/ for onEnterSpace)"
}

do_stop() {
	pkill -f "$KBE_ROOT/kbe/bin/server/" 2>/dev/null || true
	echo "engine processes stopped"
}

case "${1:-}" in
	start) do_start ;;
	bots) do_bots ;;
	stop) do_stop ;;
	clean) do_stop; rm -rf "$RUN_DIR"; echo "cleaned $RUN_DIR" ;;
	*) sed -n '2,20p' "$0"; exit 2 ;;
esac
