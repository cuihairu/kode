# -*- coding: utf-8 -*-
# 组件 Inventory 的角色脚本(组件 def 的方法实现落 scripts/cell/<组件>.py)。
import KBEngine
from KBEDebug import *


class Inventory(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def onItemGained(self, itemId):
		DEBUG_MSG("Inventory::onItemGained: %i" % itemId)
