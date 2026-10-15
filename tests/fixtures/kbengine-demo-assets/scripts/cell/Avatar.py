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
