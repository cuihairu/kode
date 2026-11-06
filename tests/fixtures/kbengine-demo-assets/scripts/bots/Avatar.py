# -*- coding: utf-8 -*-
# bots 侧的 Avatar 客户端实体(无头玩家):服务端 giveClientTo 后由 bots 进程创建。
import KBEngine
from KBEDebug import *


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		INFO_MSG("bots Avatar[%s] client entity created, pos=%s" % (self.id, getattr(self, "position", None)))
		msg = "bots Avatar[%s] client entity created (entity sync), pos=%s" % (self.id, getattr(self, "position", None))
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onHPChanged(self, hp):
		"""
		Client method.(Avatar.def ClientMethods)
		"""
		DEBUG_MSG("bots Avatar.onHPChanged: %i" % hp)
