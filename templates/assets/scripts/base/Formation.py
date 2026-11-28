# -*- coding: utf-8 -*-
import KBEngine
import cultivation
from KBEDebug import *


# Formation 阵法(DEMO-GAME-018)基座面:时长到期自毁。cell 放置由
# Avatar 基座延迟驱动(TIMER_FORMATION_PLACE,Space 建坑位惯例)。
# 023 真机判例:带 cell 实体 destroy() 会被引擎拒("has a cell, please
# destroyCellEntity() first"),须先销 cell 再延迟一拍销 base 分身。
TIMER_ID_EXPIRE = 1
TIMER_ID_DESTROY = 2


class Formation(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.addTimer(cultivation.FORMATION_DURATION, 0, TIMER_ID_EXPIRE)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(法阵到期:规则核 cultivation.formation_expired)
		"""
		if userArg == TIMER_ID_EXPIRE:
			# kind 走 cellData 通道(CELL_PUBLIC 属性 base 侧无 descriptor)。
			kind = "?"
			try:
				kind = self.cellData.get("kind", "?")
			except AttributeError:
				pass
			msg = "Formation[%i] EXPIRE kind=%s owner=%i (lifetime %.1fs)" % (
				self.id, kind, getattr(self, "ownerId", 0),
				cultivation.FORMATION_DURATION,
			)
			evidenceLog(msg)
			if self.cell is not None:
				self.destroyCellEntity()
				self.addTimer(0.5, 0, TIMER_ID_DESTROY)
				return
			self.destroy()
			return
		if userArg == TIMER_ID_DESTROY:
			if self.cell is None:
				self.destroy()

	def onDestroy(self):
		"""
		KBEngine method.
		"""
		DEBUG_MSG("Formation[%i].onDestroy" % self.id)
