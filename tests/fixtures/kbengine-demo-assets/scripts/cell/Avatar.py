# -*- coding: utf-8 -*-
import KBEngine
import time
from KBEDebug import *
from DemoConsts import DEMO_ATTACK_RANGE, DEMO_AVATAR_DAMAGE, DEMO_ATTACK_COOLDOWN


class Avatar(KBEngine.Entity):
	TIMER_AUTOATTACK = 1

	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.lastAttackAt = 0.0
		# 无头玩家自动战斗心跳:冷却转好即拾射程内最近存活 Monster 出手
		# (bots 进程客户端实体无 addTimer,bots 侧只在 onHPChanged 反击)
		self.addTimer(DEMO_ATTACK_COOLDOWN, DEMO_ATTACK_COOLDOWN, self.TIMER_AUTOATTACK)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(自动战斗心跳)
		"""
		if userArg != self.TIMER_AUTOATTACK:
			return
		best, bestDist = None, None
		for e in self.entitiesInRange(DEMO_ATTACK_RANGE, "Monster"):
			if getattr(e, "hp", 0) <= 0:
				continue
			d = ((self.position.x - e.position.x) ** 2
				 + (self.position.y - e.position.y) ** 2
				 + (self.position.z - e.position.z) ** 2) ** 0.5
			if bestDist is None or d < bestDist:
				best, bestDist = e, d
		if best is not None:
			self._attack(best)

	def _attack(self, target):
		"""共攻击路径:冷却校验 + 锚点日志 + 目标 receiveDamage。"""
		now = time.time()
		if now - self.lastAttackAt < DEMO_ATTACK_COOLDOWN:
			return
		self.lastAttackAt = now
		msg = "Avatar[%i].reqAttack hit %s[%i] dmg=%i" % (
			self.id, getattr(target, "className", "Entity"), target.id, DEMO_AVATAR_DAMAGE,
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		target.receiveDamage(DEMO_AVATAR_DAMAGE, self.id)

	def reqAttack(self, targetId):
		"""
		KBEngine method.(Avatar.def CellMethods,Exposed:bots 无头玩家入口)
		近身攻击:目标存活 + 攻击距离内 → 复用 _attack(内部再校冷却)
		"""
		target = KBEngine.entities.get(targetId)
		if target is None or target is self or getattr(target, "hp", 0) <= 0:
			return
		dist = ((self.position.x - target.position.x) ** 2
				+ (self.position.y - target.position.y) ** 2
				+ (self.position.z - target.position.z) ** 2) ** 0.5
		if dist > DEMO_ATTACK_RANGE:
			DEBUG_MSG("Avatar[%i].reqAttack: target(%i) out of range %.1f" % (self.id, targetId, dist))
			return
		self._attack(target)

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
		扣血;hp 到 0 即倒地:基座销 cell(destroyCellEntity 是基座面 API)+
		排重生计时,DEMO_RESPAWN_DELAY 后回出生点满血回归。
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
			msg = "%s[%i] DIED (killer=%i)%s" % (
				getattr(self, "className", "Avatar"), self.id, attackerId,
				" -> respawn pending" if hasattr(self, "base") and self.base is not None else "",
			)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)
			# 死亡结算:基座销 cell(destroyCellEntity 是基座面 API)+排重生计时。
			# Monster(纯 cell 实体)继承本实现,无 base——它的死亡奖励/自毁在其
			# receiveDamage 覆写里做,这里只在 Proxy 场景(base 非 None)走重生。
			base = getattr(self, "base", None)
			if base is not None:
				base.onAvatarDead()

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
