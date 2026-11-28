# -*- coding: utf-8 -*-
import KBEngine
import KodeHotReload
from KBEDebug import *


# 迷你 ARPG 刷怪表:(实体类型, 出生点偏移);AI 状态机见 Monster(DEMO-GAME-002 扩展)
DEMO_SPAWNS = (
	("Monster", (10.0, 0.0, 10.0)),
	("Monster", (-10.0, 0.0, 10.0)),
	("Monster", (0.0, 0.0, -15.0)),
	("Monster", (14.0, 0.0, -6.0)),
	("Monster", (-14.0, 0.0, -4.0)),
	("Monster", (18.0, 0.0, 2.0)),
	("Monster", (-18.0, 0.0, 0.0)),
	("Monster", (4.0, 0.0, -20.0)),
)

TIMER_ID_SPAWN = 1
# DEMO-GAME-023: monster top-up heartbeat -- killed monsters respawn at
# their table slot so the combat loop (and the bots cultivation pump that
# rides radar pushes) keeps flowing instead of stalling at last kill.
TIMER_ID_TOPUP = 2
SPAWN_TOPUP_SECS = 15.0


class Space(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		INFO_MSG("Space cell[%i] created in spaceID=%i, spawn deferred to timer..." % (self.id, self.spaceID))
		# 引擎坑:在空间型实体 initializeScript 流程内(onCreateCellEntityInNewSpace
		# → initializeScript → __init__)直接嵌套 KBEngine.createEntity 会段错误
		# cellapp(EntityDef context 状态被嵌套创建破坏);故延迟到 onTimer 再刷怪。
		self.monsterIds = []
		self.addTimer(0.1, 0, TIMER_ID_SPAWN)
		self.addTimer(SPAWN_TOPUP_SECS, SPAWN_TOPUP_SECS, TIMER_ID_TOPUP)
		# 热更接收器心跳:怪物全灭后 cellapp 无 Python 活动,主循环握 GIL
		# 会饿死 HTTP 守护线程;常驻 Space 实体提供周期性窗口(KodeHotReload 契约)
		KodeHotReload.ensure_heartbeat(self)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.
		"""
		if userArg == KodeHotReload.HEARTBEAT_TIMER_ARG:
			KodeHotReload.on_entity_timer(self, timerID, userArg)
			return
		if userArg == TIMER_ID_TOPUP:
			self._topupMonsters()
			return
		if userArg != TIMER_ID_SPAWN:
			return
		spawned = []
		for entityType, offset in DEMO_SPAWNS:
			m = KBEngine.createEntity(entityType, self.spaceID, offset, (0.0, 0.0, 0.0), {})
			spawned.append(m.id if m is not None else 0)
		self.monsterIds = spawned
		INFO_MSG("Space cell[%i] spawn done: %s" % (self.id, spawned))
		msg = "Space cell[%i] spawn done: %s (spaceID=%i)" % (self.id, spawned, self.spaceID)
		evidenceLog(msg)

	def _topupMonsters(self):
		"""刷怪表差集补怪:槽位实体已销毁即原点重生(023 战斗回路保活)。"""
		respawned = []
		for idx, (entityType, offset) in enumerate(DEMO_SPAWNS):
			mid = self.monsterIds[idx] if idx < len(self.monsterIds) else 0
			if mid and KBEngine.entities.get(mid) is not None:
				continue
			m = KBEngine.createEntity(entityType, self.spaceID, offset, (0.0, 0.0, 0.0), {})
			if m is not None:
				respawned.append(m.id)
			while len(self.monsterIds) <= idx:
				self.monsterIds.append(0)
			self.monsterIds[idx] = m.id if m is not None else 0
		if respawned:
			msg = "Space cell[%i] monsters respawned: %s" % (self.id, respawned)
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
