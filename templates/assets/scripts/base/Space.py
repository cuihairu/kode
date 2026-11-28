# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


class Space(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		INFO_MSG("Space[%i] created (index=%s), creating cell in a new space..." % (self.id, getattr(self, "spaceIndex", 0)))
		# 在 cellapp 上开辟新空间并把本实体的 cell 放进去;
		# 此后 Avatar 经 createCellEntity(self.cell) 加入同一空间
		self.createCellEntityInNewSpace(0)

	def onGetCell(self):
		"""
		KBEngine method.
		cell 部分创建成功:空间已可用
		"""
		INFO_MSG("Space[%i].onGetCell: space established (index=%s)" % (self.id, getattr(self, "spaceIndex", 0)))
		msg = "Space[%i].onGetCell: space established (index=%s)" % (self.id, getattr(self, "spaceIndex", 0))
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onLoseCell(self):
		"""
		KBEngine method.
		cell 部分丢失
		"""
		DEBUG_MSG("Space[%i].onLoseCell" % self.id)

	def onDestroy(self):
		"""
		KBEngine method.
		"""
		DEBUG_MSG("Space[%i].onDestroy" % self.id)
