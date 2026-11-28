# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


# Item 物品实体(DEMO-GAME-014):base-only 持久化,第四种实体形态。
# 创建路径=装备库存入(060)/邮件附件(037);创建即 writeToDB 落 tbl_Item,
# 写库回调回填 dbid 后才把条目挂进归属者的名册(引擎 dbid 由 dbmgr 在
# 写库注册期分配,建实体瞬间读 dbid 恒 0)。
class Item(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def onWriteToDB(self, *args):
		"""
		KBEngine method.写库成功登记,打锚供真机 grep(dbid 此时已分配)。
		"""
		msg = "Item[%i] SAVED dbid=%i itemId=%i count=%i owner=%i" % (
			self.id, self.databaseID, self.itemId, self.count, self.ownerDbid,
		)
		evidenceLog(msg)
