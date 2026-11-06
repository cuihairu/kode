# -*- coding: utf-8 -*-
# bots 侧的 Avatar 客户端实体(无头玩家):服务端 giveClientTo 后由 bots 进程创建。
# 引擎取证(bots.out "assertion failed: g_pApp ... at: addTimer"):bots 进程客户端
# 实体无脚本计时器面,攻击不走实体 addTimer;改为受击反击(onHPChanged 时对射程内
# 最近存活 Monster 回击,走 cell.reqAttack exposed 入口)——与真实客户端行为同构。
import KBEngine
from KBEDebug import *
from DemoConsts import DEMO_ATTACK_RANGE


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.lastTargetId = 0
		INFO_MSG("bots Avatar[%s] client entity created, pos=%s" % (self.id, getattr(self, "position", None)))
		msg = "bots Avatar[%s] client entity created (entity sync), pos=%s" % (self.id, getattr(self, "position", None))
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def _retaliate(self):
		"""受击反击:拾视野内最近存活 Monster,射程内即回击(exposed cell 方法)。"""
		best, bestDist = None, None
		for e in KBEngine.entities.values():
			if getattr(e, "className", "") != "Monster":
				continue
			if getattr(e, "hp", 0) <= 0:
				continue
			dx = self.position.x - e.position.x
			dz = self.position.z - e.position.z
			d = (dx * dx + dz * dz) ** 0.5
			if bestDist is None or d < bestDist:
				best, bestDist = e, d
		if best is None:
			return
		if best.id != self.lastTargetId:
			msg = "bots Avatar[%s] target Monster[%s] (dist=%.1f)" % (self.id, best.id, bestDist or -1)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)
			self.lastTargetId = best.id
		if bestDist is not None and bestDist <= DEMO_ATTACK_RANGE and self.cell is not None:
			self.cell.reqAttack(best.id)

	def onLevelUp(self, newLevel):
		"""
		Client method.(Avatar.def ClientMethods)
		"""
		msg = "bots Avatar[%s] onLevelUp level=%s" % (self.id, newLevel)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onHPChanged(self, hp):
		"""
		Client method.(Avatar.def ClientMethods)
		"""
		DEBUG_MSG("bots Avatar.onHPChanged: %i" % hp)
		if hp > 0:
			self._retaliate()
