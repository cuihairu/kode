# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


# 迷你 ARPG 刷怪表:(实体类型, 出生点偏移);AI 状态机见 Monster(DEMO-GAME-002 扩展)
DEMO_SPAWNS = (
	("Monster", (10.0, 0.0, 10.0)),
	("Monster", (-10.0, 0.0, 10.0)),
	("Monster", (0.0, 0.0, -15.0)),
)

TIMER_ID_SPAWN = 1


class Space(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		INFO_MSG("Space cell[%i] created in spaceID=%i, spawn deferred to timer..." % (self.id, self.spaceID))
		# 引擎坑:在空间型实体 initializeScript 流程内(onCreateCellEntityInNewSpace
		# → initializeScript → __init__)直接嵌套 KBEngine.createEntity 会段错误
		# cellapp(EntityDef context 状态被嵌套创建破坏);故延迟到 onTimer 再刷怪。
		self.addTimer(0.1, 0, TIMER_ID_SPAWN)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.
		"""
		if userArg != TIMER_ID_SPAWN:
			return
		spawned = []
		for entityType, offset in DEMO_SPAWNS:
			m = KBEngine.createEntity(entityType, self.spaceID, offset, (0.0, 0.0, 0.0), {})
			spawned.append(m.id if m is not None else 0)
		INFO_MSG("Space cell[%i] spawn done: %s" % (self.id, spawned))
		msg = "Space cell[%i] spawn done: %s (spaceID=%i)" % (self.id, spawned, self.spaceID)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onEnterSpace(self):
		"""
		KBEngine method.
		进入空间(空间型实体的 cell 建立即进入;钩子无参)
		"""
		DEBUG_MSG("Space cell[%i].onEnterSpace: spaceID=%i" % (self.id, self.spaceID))

	def onLeaveSpace(self):
		"""
		KBEngine method.
		离开空间(钩子无参)
		"""
		DEBUG_MSG("Space cell[%i].onLeaveSpace" % self.id)
