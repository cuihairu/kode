# -*- coding: utf-8 -*-
import sys
import KBEngine

def printMsg(args, isPrintPath):
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
