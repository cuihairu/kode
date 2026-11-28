# -*- coding: utf-8 -*-
# 组件 Inventory 的角色脚本(组件 def 的方法实现落 scripts/cell/<组件>.py)。
import KBEngine
import cultivation
from KBEDebug import *
from DemoConsts import DEMO_BAG_CAPACITY


# 引擎约定:组件脚本基类是 KBEngine.EntityComponent(py_entitydef.cpp 暴露),
# 绝不能继承 KBEngine.Entity —— 否则创建组件时 placement-new 会把 C++ 内存
# 双重解释,tp_setattro 走 Entity 槽读被覆盖字段,cellapp 直接段错误
# (真引擎起服验证发现,DEMO-GAME-001)。
class Inventory(KBEngine.EntityComponent):
	def __init__(self):
		KBEngine.EntityComponent.__init__(self)

	def onItemGained(self, itemInfo):
		DEBUG_MSG("Inventory::onItemGained: %s" % (itemInfo,))

	def addItem(self, itemId, count):
		"""Cell 方法(Avatar.def 组件面,DEMO-GAME-013):
		堆叠入袋:cultivation.merge_stack 纯函数核(同 id 先补满 STACK_MAX,
		再开新格,容量 DEMO_BAG_CAPACITY 封顶),溢出丢弃并记 WARNING。
		杀怪掉落/任务发放在同 cellapp 直接 killer.bag.addItem(...) 调入。
		"""
		merged, added = cultivation.merge_stack(
			list(self.items), itemId, count, DEMO_BAG_CAPACITY
		)
		if added <= 0:
			WARNING_MSG("Inventory::addItem: bag full, drop itemId=%i count=%i" % (itemId, count))
			return 0
		self.items = merged
		msg = "Inventory addItem itemId=%i asked=%i added=%i slots=%i" % (
			itemId, count, added, len(self.items),
		)
		evidenceLog(msg)
		self.onItemGained({"itemId": itemId, "count": added})
		return added
