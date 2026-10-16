# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def respawn(self):
		"""
		KBEngine method.
		重生
		"""
		DEBUG_MSG("Avatar[%i].respawn" % self.id)

	def notifyMove(self):
		"""测试模型补充(组合根验收):实体调用其接口 ROLE 的回调(默认实现在 interfaces/ROLE.py)。"""
		self.onMove(None)
