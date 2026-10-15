# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


class Monster(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def onAggro(self, entityId):
		"""
		KBEngine method.
		仇恨目标变化
		"""
		DEBUG_MSG("Monster[%i].onAggro: %i" % (self.id, entityId))

	def onMove(self, position):
		"""
		interface ROLE.
		移动回调(接口混入方法,声明在 interfaces/ROLE.def)
		"""
		DEBUG_MSG("Monster[%i].onMove: %s" % (self.id, position))
