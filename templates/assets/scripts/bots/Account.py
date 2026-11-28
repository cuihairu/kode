# -*- coding: utf-8 -*-
import KBEngine
import copy
from KBEDebug import *

class Account(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		DEBUG_MSG("Account::__init__:%s." % (self.__dict__))

	def onLoginOK(self):
		"""
		KBEngine method.(服务端 Account.onClientEnabled 通知)
		登录就绪:请求创建角色并进入世界(迷你 ARPG 无头玩家入口)
		"""
		INFO_MSG("bots Account[%s].onLoginOK: reqCreateAvatar" % self.id)
		msg = "bots Account[%s].onLoginOK: reqCreateAvatar" % self.id
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.base.reqCreateAvatar("bot%s" % self.id)
