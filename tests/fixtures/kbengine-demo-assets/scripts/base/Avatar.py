# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *
from Spaces import spaceByIndex


# 迷你 ARPG:角色出生配置(单世界空间)
DEMO_SPACE_INDEX = 1


class Avatar(KBEngine.Proxy):
	def __init__(self):
		KBEngine.Proxy.__init__(self)
		INFO_MSG("Avatar[%i] created, name=%s" % (self.id, self.name))
		msg = "Avatar[%i] created, name=%s -> enterSpace(%i)" % (self.id, self.name, DEMO_SPACE_INDEX)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.enterSpace(DEMO_SPACE_INDEX)

	def enterSpace(self, spaceIndex):
		"""
		KBEngine method.
		加入空间:把本实体的 cell 创建到目标空间(参数为空间基实体的 cellEntityCall,
		引擎要求 EntityCall 类型为 CELL)。
		"""
		space = spaceByIndex.get(spaceIndex)
		if space is None or space.cell is None:
			ERROR_MSG("Avatar[%i].enterSpace: space(%i) not ready" % (self.id, spaceIndex))
			return
		self.createCellEntity(space.cell)

	def onGetCell(self):
		"""
		KBEngine method.
		cell 部分创建成功
		"""
		DEBUG_MSG("Avatar[%i].onGetCell" % self.id)

	def onLoseCell(self):
		"""
		KBEngine method.
		cell 部分丢失:客户端已不在则销毁本体(onClientDeath 只销 cell 的收尾)
		"""
		DEBUG_MSG("Avatar[%i].onLoseCell" % self.id)
		if self.client is None:
			self.destroy()

	def onClientEnabled(self):
		"""
		KBEngine method.
		客户端已交接到本实体(Account.giveClientTo 之后)
		"""
		INFO_MSG("Avatar[%i].onClientEnabled: client=%s" % (self.id, self.client))
		msg = "Avatar[%i].onClientEnabled: client handed over (giveClientTo done)" % self.id
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onClientDeath(self):
		"""
		KBEngine method.
		客户端断开:角色仍持有 cell 时先销毁 cell(引擎要求 destroy 前无 cell,
		否则 "has cell, please destroyCellEntity() first"),onLoseCell 里再销毁本体。
		"""
		if self.cell is not None:
			self.destroyCellEntity()
			return
		self.destroy()

	def reqCastSkill(self, skillId):
		"""
		exposed.
		客户端请求施放技能
		"""
		DEBUG_MSG("Avatar[%i].reqCastSkill: %i" % (self.id, skillId))
