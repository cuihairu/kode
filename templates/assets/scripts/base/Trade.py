# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


# Trade (DEMO-GAME-0446): Base face. Method bodies land with the owning
# implementation batch; engine checkDefMethod needs the names and
# signatures to exist now.
class Trade(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)


	def onTradeCancel(self, a1):
		"""Base method declared in Trade.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onTradeConfirm(self, a1):
		"""Base method declared in Trade.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onTradeLock(self, a1):
		"""Base method declared in Trade.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onTradeReply(self, a1, a2):
		"""Base method declared in Trade.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onTradeSetOffer(self, a1, a2):
		"""Base method declared in Trade.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass