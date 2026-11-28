# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


# Pet 宠物(DEMO-GAME-017)基座面:写库锚 + 召唤承载。
# cell 面(跟随/协战)在 cell/Pet.py;召唤流程由 Avatar 基座驱动
# (createEntityFromDB 回调里设 ownerEntityId 再 createCellEntity)。
class Pet(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def onWriteToDB(self):
		"""
		KBEngine method.写库登记锚(dbid 此时已分配,同 Item.onWriteToDB)。
		"""
		msg = "Pet[%i] SAVED dbid=%i name=%s owner=%i" % (
			self.id, self.dbid, self.name, self.ownerDbid,
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
