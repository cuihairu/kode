# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *
from DemoConsts import SECT_MAX_MEMBERS


# Sect 宗门(DEMO-GAME-019)基座面:名册承载+宗门频道广播位。
# 建宗/入宗/离宗的账面在 Avatar 基座(reqCreateSect 等,直接改 members
# 后 writeToDB);本类只提供容量闸/成员账帮助面与频道转发。
class Sect(KBEngine.Entity):
	def full(self):
		return len(self.members) >= SECT_MAX_MEMBERS

	def hasMember(self, dbid):
		return next((m for m in self.members if m.get("dbid") == dbid), None) is not None

	def addMember(self, info):
		self.members.append(dict(info))

	def removeMember(self, dbid):
		self.members = [m for m in self.members if m.get("dbid") != dbid]

	def broadcast(self, senderName, text):
		"""
		宗门频道:把一条消息转发给所有本机已载成员的客户端
		(base-only 实体无 ALL_CLIENTS 面,广播走成员 Avatar.client 中继)。
		"""
		for e in KBEngine.entities.values():
			if getattr(e, "className", "") != "Avatar":
				continue
			if e.dbid != getattr(self, "leaderDbid", 0) and not self.hasMember(e.dbid):
				continue
			if getattr(e, "sectId", 0) != self.dbid:
				continue
			client = getattr(e, "client", None)
			if client is None:
				continue
			client.onSectChat(senderName, text)
		msg = "Sect[%i] CHAT from=%s len=%i members=%i" % (
			self.dbid, senderName, len(text), len(self.members),
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onWriteToDB(self, *args):
		"""
		KBEngine method.写库登记锚(dbid 此时已分配,同 Item/Pet 判例;
		子表 tbl_Sect_members 随 members ARRAY Persistent 落)。
		"""
		msg = "Sect[%i] SAVED dbid=%i name=%s leader=%i members=%i" % (
			self.id, self.dbid, self.name, self.leaderDbid, len(self.members),
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
