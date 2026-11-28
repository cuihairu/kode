# -*- coding: utf-8 -*-
import KBEngine
import cultivation
from KBEDebug import *


# Formation 阵法(DEMO-GAME-018)cell 面:静态法阵心跳。
# gather(聚灵阵):每 tick 给圈内修士回血(数值=FORMATION_TYPES[1]);
# bind(缚灵阵):被动法阵,减速因子由 Monster think 扫描消费(此处不动)。
# 治疗不设上限:attrs 是 BASE 面(maxHp 在基座),cell 侧只做小口回血。
TIMER_RING = 1


class Formation(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.addTimer(1.0, 1.0, TIMER_RING)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(法阵心跳:gather 回血环)
		"""
		if userArg != TIMER_RING:
			return
		kind = getattr(self, "kind", "gather")
		spec = cultivation.FORMATION_TYPES.get(kind)
		if spec is None or kind != "gather":
			return
		radius, heal = spec
		healed = []
		# entitiesInRange 按 utype 匹配:Monster 经 <Parent> Avatar 同族命中,
		# 必须 className 过滤(真机判例:同族互拾自相残杀)。
		for e in self.entitiesInRange(radius, "Avatar"):
			if getattr(e, "className", "") != "Avatar":
				continue
			if getattr(e, "hp", 0) <= 0:
				continue
			e.hp = e.hp + heal
			healed.append(e.id)
		if healed:
			msg = "Formation[%i] GATHER ring heal hp+%i targets=%s radius=%.1f" % (
				self.id, heal, healed, radius,
			)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)
