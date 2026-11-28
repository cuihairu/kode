# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *
from Item import Item
from cultivation import GEM_SLOTS


# Equipment 装备(DEMO-GAME-015/048):Parent=Item 的脚本镜像继承
# (同 Monster(Avatar) 惯例——引擎 checkDefMethod 要求父类 def 合并进来的
# 方法在子类脚本类上可达,脚本继承让它们经 MRO 命中)。
# 存放位=装备库名册/穿戴位(equipSlots);宝石孔上限 GEM_SLOTS。
class Equipment(Item):
	def __init__(self):
		Item.__init__(self)

	def onSocketGem(self, gemInfo):
		"""
		Base method.(Equipment.def BaseMethods,Avatar 基座转发的内部面)
		嵌宝石:孔位上限内追加 GEM_INFO 条目;成功后调用方重算 attrs 合成。
		"""
		if len(self.gems) >= GEM_SLOTS:
			WARNING_MSG("Equipment[%i].onSocketGem: slots full (%i)" % (self.id, GEM_SLOTS))
			return
		self.gems.append(dict(gemInfo))
		msg = "Equipment[%i] SOCKET gem itemId=%i level=%i attrType=%i attrValue=%i slots=%i" % (
			self.id, gemInfo.get("gemId", 0), gemInfo.get("level", 0),
			gemInfo.get("attrType", 0), gemInfo.get("attrValue", 0), len(self.gems),
		)
		evidenceLog(msg)

	def onUnsocketGem(self, gemIndex):
		"""
		Base method.(Equipment.def BaseMethods,Avatar 基座转发的内部面)
		卸宝石:按索引摘条目(demo 规模:宝石消散不回袋);成功后调用方重算。
		"""
		if gemIndex >= len(self.gems):
			WARNING_MSG("Equipment[%i].onUnsocketGem: bad index %i" % (self.id, gemIndex))
			return
		gem = self.gems[gemIndex]
		self.gems = [g for i, g in enumerate(self.gems) if i != gemIndex]
		msg = "Equipment[%i] UNSOCKET index=%i attrType=%i attrValue=%i slots=%i" % (
			self.id, gemIndex, gem.get("attrType", 0), gem.get("attrValue", 0), len(self.gems),
		)
		evidenceLog(msg)
