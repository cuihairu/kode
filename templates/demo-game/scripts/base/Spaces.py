# -*- coding: utf-8 -*-
import KBEngine
import KodeHotReload
from KBEDebug import *


# 空间注册表(模块级):baseapp 内 Account.reqCreateAvatar 据此取 Space 基实体。
# 同一 baseapp 进程的实体共享本模块,进程存活期间有效。
spaceByIndex = {}
__reload_preserve__ = ("spaceByIndex",)


class Spaces(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		INFO_MSG("Spaces[%i] created, building demo spaces..." % self.id)
		msg = "Spaces[%i] created (baseapp)" % self.id
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		# 迷你 ARPG:单一世界空间(索引 1);多空间扩展时往这里加号即可
		self.createSpace(1)
		# 热更接收器心跳:空闲 baseapp 主循环握 GIL,HTTP 守护线程会饿死;
		# 常驻实体计时器给主循环周期性 Python 窗口(契约见 KodeHotReload)
		KodeHotReload.ensure_heartbeat(self)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(热更接收器心跳委托,见 KodeHotReload.ensure_heartbeat)
		"""
		KodeHotReload.on_entity_timer(self, timerID, userArg)

	def createSpace(self, spaceIndex):
		"""
		KBEngine method.
		创建空间:本地建 Space 基实体,其 __init__ 内 createCellEntityInNewSpace
		在 cellapp 上开辟新空间;空间就绪后登记进模块注册表。
		"""
		space = KBEngine.createEntityLocally("Space", {"spaceIndex": spaceIndex})
		if space is None:
			ERROR_MSG("Spaces[%i].createSpace: create Space(%i) failed" % (self.id, spaceIndex))
			return None
		spaceByIndex[spaceIndex] = space
		INFO_MSG("Spaces[%i].createSpace: index=%i -> Space[%i] registered" % (self.id, spaceIndex, space.id))
		return space

	def onDestroy(self):
		"""
		KBEngine method.
		"""
		DEBUG_MSG("Spaces[%i].onDestroy" % self.id)
		KodeHotReload.stop_heartbeat(self)
		spaceByIndex.clear()
