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

	def onEnterSpace(self):
		"""
		KBEngine method.
		进入空间(cell 侧钩子,无参):角色正式进世界
		"""
		INFO_MSG("Avatar[%i].onEnterSpace: spaceID=%s, position=%s" % (self.id, self.spaceID, self.position))
		msg = "Avatar[%i].onEnterSpace: ENTERED WORLD spaceID=%s pos=%s" % (self.id, self.spaceID, self.position)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def receiveDamage(self, damage, attackerId):
		"""
		KBEngine method.(Avatar.def CellMethods,Monster 近身攻击入口)
		扣血;hp 到 0 即倒地(DEMO-GAME-003 接死亡重生)
		"""
		if self.hp <= 0:
			return
		self.hp = max(0, self.hp - damage)
		msg = "Avatar[%i].receiveDamage dmg=%i attacker=%i hp=%i" % (
			self.id, damage, attackerId, self.hp,
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		if self.hp == 0:
			msg = "Avatar[%i] DIED (killer=%i)" % (self.id, attackerId)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)

	def onLeaveSpace(self):
		"""
		KBEngine method.
		离开空间(cell 侧钩子,无参)
		"""
		DEBUG_MSG("Avatar[%i].onLeaveSpace" % self.id)

	def onMove(self, position, userData=None):
		"""
		interface ROLE.
		移动回调(接口方法声明在 interfaces/ROLE.def,双参口径):
		引擎移动控制器逐 tick 回调同名 onMove(controllerId, userData)
		(entity.cpp:2936),checkDefMethod 要求脚本参数个数与 def 一致,
		故 def 与脚本统一双参——一份签名同时兼容接口形态与引擎回调形态。
		"""
		DEBUG_MSG("Avatar[%i].onMove: %s" % (self.id, (position, userData)))

	def notifyMove(self):
		"""测试模型补充(组合根验收):实体调用其接口 ROLE 的回调(默认实现在 interfaces/ROLE.py)。"""
		self.onMove(None, None)
