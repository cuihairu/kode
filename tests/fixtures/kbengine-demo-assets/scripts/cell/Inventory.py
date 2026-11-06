# -*- coding: utf-8 -*-
# 组件 Inventory 的角色脚本(组件 def 的方法实现落 scripts/cell/<组件>.py)。
import KBEngine
from KBEDebug import *


# 引擎约定:组件脚本基类是 KBEngine.EntityComponent(py_entitydef.cpp 暴露),
# 绝不能继承 KBEngine.Entity —— 否则创建组件时 placement-new 会把 C++ 内存
# 双重解释,tp_setattro 走 Entity 槽读被覆盖字段,cellapp 直接段错误
# (真引擎起服验证发现,DEMO-GAME-001)。
class Inventory(KBEngine.EntityComponent):
	def __init__(self):
		KBEngine.EntityComponent.__init__(self)

	def onItemGained(self, itemId):
		DEBUG_MSG("Inventory::onItemGained: %i" % itemId)
