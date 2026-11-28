# -*- coding: utf-8 -*-
import KBEngine
import cultivation
from KBEDebug import *
from DemoConsts import (
    DEMO_PET_ASSIST_RANGE,
    DEMO_PET_DAMAGE,
    DEMO_PET_FOLLOW_DIST,
    DEMO_PET_VELOCITY,
)


# Pet 宠物(DEMO-GAME-017)cell 面:跟随(owner 距离超界走向
# pet_follow_point 落点)+ 协战(拾 owner 身边存活 Monster 出手;
# 伤害记 attacker=ownerEntityId,击杀奖励按既有路径归 owner)。
TIMER_THINK = 1


class Pet(KBEngine.Entity):
	TIMER_PET_THINK = 1

	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.addTimer(0.5, 0.5, self.TIMER_PET_THINK)

	def _owner(self):
		return KBEngine.entities.get(getattr(self, "ownerEntityId", 0))

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(宠物心跳:跟随 + 协战)
		"""
		if userArg != self.TIMER_PET_THINK:
			return
		owner = self._owner()
		if owner is None:
			return
		ownerPos = (owner.position.x, owner.position.y, owner.position.z)
		myPos = (self.position.x, self.position.y, self.position.z)
		distOwner = ((ownerPos[0] - myPos[0]) ** 2
			+ (ownerPos[1] - myPos[1]) ** 2
			+ (ownerPos[2] - myPos[2]) ** 2) ** 0.5
		if distOwner > DEMO_PET_FOLLOW_DIST:
			point = cultivation.pet_follow_point(ownerPos, myPos)
			self.moveToPoint(point, DEMO_PET_VELOCITY, 0.0, None, True, False)
			return
		# 协战:owner 半径内最近存活 Monster(记 attacker=owner,奖励归主)
		best, bestDist = None, None
		for e in self.entitiesInRange(DEMO_PET_ASSIST_RANGE, "Monster"):
			if getattr(e, "className", "") != "Monster":
				continue
			if getattr(e, "hp", 0) <= 0:
				continue
			dx = self.position.x - e.position.x
			dz = self.position.z - e.position.z
			d = (dx * dx + dz * dz) ** 0.5
			if bestDist is None or d < bestDist:
				best, bestDist = e, d
		if best is not None:
			best.receiveDamage(DEMO_PET_DAMAGE, self.ownerEntityId)
			msg = "Pet[%i] ASSIST hit Monster[%i] dmg=%i for owner=%i" % (
				self.id, best.id, DEMO_PET_DAMAGE, self.ownerEntityId,
			)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)
