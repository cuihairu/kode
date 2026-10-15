# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def reqCastSkill(self, skillId):
		"""
		exposed.
		客户端请求施放技能
		"""
		DEBUG_MSG("Avatar[%i].reqCastSkill: %i" % (self.id, skillId))
