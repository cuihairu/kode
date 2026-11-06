# -*- coding: utf-8 -*-
# bots 侧 TrainingAvatar 客户端实体(训练场模型占位;真引擎链路不驱动它)。
import KBEngine
from KBEDebug import *


class TrainingAvatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def onBattleResult(self, code, value):
		"""
		Client method.(TrainingAvatar.def ClientMethods)
		"""
		DEBUG_MSG("bots TrainingAvatar.onBattleResult: %i %i" % (code, value))
