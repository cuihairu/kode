# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def respawn(self):
		"""
		KBEngine method.
		重生
		"""
		DEBUG_MSG("Avatar[%i].respawn" % self.id)

	def onEnterSpace(self):
		"""
		KBEngine method.
		进入空间(cell 侧钩子,无参):角色正式进世界
		"""
		INFO_MSG("Avatar[%i].onEnterSpace: spaceID=%s, position=%s" % (self.id, self.spaceID, self.position))
		msg = "Avatar[%i].onEnterSpace: ENTERED WORLD spaceID=%s pos=%s" % (self.id, self.spaceID, self.position)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onLeaveSpace(self):
		"""
		KBEngine method.
		离开空间(cell 侧钩子,无参)
		"""
		DEBUG_MSG("Avatar[%i].onLeaveSpace" % self.id)

	def onMove(self, position):
		"""
		interface ROLE.
		移动回调(接口方法声明在 interfaces/ROLE.def)。引擎 checkDefMethod
		要求接口声明的方法在实体脚本类上真实存在,故在此给出实现;
		默认实现样例仍见 scripts/interfaces/ROLE.py。
		"""
		DEBUG_MSG("Avatar[%i].onMove: %s" % (self.id, position))

	def notifyMove(self):
		"""测试模型补充(组合根验收):实体调用其接口 ROLE 的回调(默认实现在 interfaces/ROLE.py)。"""
		self.onMove(None)
