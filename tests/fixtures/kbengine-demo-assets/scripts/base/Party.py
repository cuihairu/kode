# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


# Party (DEMO-GAME-0449): Base face. Method bodies land with the owning
# implementation batch; engine checkDefMethod needs the names and
# signatures to exist now.
class Party(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)


	def onLootModeSet(self, a1, a2):
		"""Base method declared in Party.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onPartyLeave(self, a1):
		"""Base method declared in Party.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onPartyReply(self, a1, a2):
		"""Base method declared in Party.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass

	def onPartyStartVoteReply(self, a1, a2):
		"""Base method declared in Party.def; implementation lands
		with its own DEMO-GAME batch (checkDefMethod signature face)."""
		pass