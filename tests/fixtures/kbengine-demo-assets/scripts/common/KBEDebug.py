# -*- coding: utf-8 -*-
import sys
import KBEngine

def _ensure_stdout_safe():
	# Engine binding defect (fork 0.1.2 embeds Python 3.12.13 via vcpkg;
	# upstream default is 3.7.3): ScriptStdOut/ScriptStdErr parse their
	# argument with a '#' format without PY_SSIZE_T_CLEAN, so every print()
	# raises SystemError back into the script and aborts it (this killed
	# onBaseAppReady before entity creation on a fresh database). The
	# engine also (re)installs ScriptStdOut later (observed right after a
	# telnet console attaches), so this guard runs per call, not just at
	# import time. Harmless on engines whose stdout bindings work.
	if type(sys.stdout).__name__ == "ScriptStdOut" or \
			type(sys.stderr).__name__ == "ScriptStdErr":
		import io
		sys.stdout = io.TextIOWrapper(
			io.FileIO(1, "w", closefd=False),
			line_buffering=True, encoding="utf-8", errors="replace")
		sys.stderr = io.TextIOWrapper(
			io.FileIO(2, "w", closefd=False),
			line_buffering=True, encoding="utf-8", errors="replace")

def printMsg(args, isPrintPath):
	_ensure_stdout_safe()
	for m in args:print (m)

def TRACE_MSG(*args): 
	KBEngine.scriptLogType(KBEngine.LOG_TYPE_NORMAL)
	printMsg(args, False)
	
def DEBUG_MSG(*args): 
	if KBEngine.publish() == 0:
		KBEngine.scriptLogType(KBEngine.LOG_TYPE_DBG)
		printMsg(args, True)
	
def INFO_MSG(*args): 
	if KBEngine.publish() <= 1:
		KBEngine.scriptLogType(KBEngine.LOG_TYPE_INFO)
		printMsg(args, False)
	
def WARNING_MSG(*args): 
	KBEngine.scriptLogType(KBEngine.LOG_TYPE_WAR)
	printMsg(args, True)

def ERROR_MSG(*args): 
	KBEngine.scriptLogType(KBEngine.LOG_TYPE_ERR)
	printMsg(args, True)

def evidenceLog(msg):
	"""迷你 ARPG 真机验收锚:把关键事件追加写入 $KBE_DEMO_EVIDENCE 指向的文件。
	引擎未编译 log4cxx 时脚本层 INFO 只进 logger 转发面(stdout 看不到),
	环境变量未设则本函数为空操作,不影响正常演示。"""
	import os
	path = os.environ.get("KBE_DEMO_EVIDENCE")
	if not path:
		return
	with open(path, "a", encoding="utf-8") as fh:
		fh.write("[demo-evidence] %s\n" % msg)
