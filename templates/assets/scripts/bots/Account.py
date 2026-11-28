# -*- coding: utf-8 -*-
import KBEngine
import copy
from KBEDebug import *

class Account(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		DEBUG_MSG(f"Account::__init__:{self.__dict__}.")

	def onLoginOK(self):
		"""
		KBEngine method.(server-side Account.onClientEnabled notification)
		Login ready: select an avatar (a roster miss falls through to
		reqCreateAvatar server-side). DEMO-GAME-024 round trip: on a
		re-boot the same account reads its avatar straight from the DB.
		Pass an empty name; the server picks the account's roster first
		entry (024 real-machine findings: bots client entity ids drift
		every boot (id bases flip with the app start order) so entity-id
		names never match the roster, and accountName is empty on the
		bots client entity too -- selection therefore lives server-side,
		where the persisted roster is the stable mapping).
		"""
		INFO_MSG(f"bots Account[{self.id}].onLoginOK: reqSelectAvatar")
		msg = f"bots Account[{self.id}].onLoginOK: reqSelectAvatar"
		evidenceLog(msg)
		self.base.reqSelectAvatar("")
