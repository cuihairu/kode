# -*- coding: utf-8 -*-
import KBEngine
import cultivation
from KBEDebug import *


# Formation 阵法(DEMO-GAME-018)基座面:时长到期自毁。cell 放置由
# Avatar 基座延迟驱动(TIMER_FORMATION_PLACE,Space 建坑位惯例);
# engine destroy() 连带销毁 cell,无需先 destroyCellEntity。
TIMER_ID_EXPIRE = 1


class Formation(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.addTimer(cultivation.FORMATION_DURATION, 0, TIMER_ID_EXPIRE)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(法阵到期:规则核 cultivation.formation_expired)
		"""
		if userArg != TIMER_ID_EXPIRE:
			return
		msg = "Formation[%i] EXPIRE kind=%s owner=%i (lifetime %.1fs)" % (
			self.id, getattr(self, "kind", "?"), getattr(self, "ownerId", 0),
			cultivation.FORMATION_DURATION,
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.destroy()

	def onDestroy(self):
		"""
		KBEngine method.
		"""
		DEBUG_MSG("Formation[%i].onDestroy" % self.id)
