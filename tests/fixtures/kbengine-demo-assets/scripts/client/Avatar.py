# -*- coding: utf-8 -*-
# 客户端实体脚本(真实工程在客户端 App 内;此处入库供 kode 的
# scripts/{base,cell,client} 约定链走查)。
class Avatar(object):
	def __init__(self):
		print("Avatar client entity created")

	def onHPChanged(self, hp):
		print("Avatar.onHPChanged: %i" % hp)

	def onLevelUp(self, newLevel):
		print("Avatar.onLevelUp: %i" % newLevel)

	def onRealmUp(self, realm):
		print("Avatar.onRealmUp: %i" % realm)

	def onBodySeized(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onBountyPosted(self, a1, a2, a3, a4):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onBountyResult(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onBuyResult(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onChatMessage(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onCostumeGained(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onDaoPartnerReply(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onDaoProposal(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onDungeonReady(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onFormationPlaced(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onMonsterNear(self, a1, a2, a3):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onPartyInvite(self, a1, a2, a3):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onPartyRoster(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onPartyStartVote(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onRankedMatchFound(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onReincarnateStart(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onSectChat(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onSeizeResult(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onStrengthenResult(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onTitleGained(self, a1):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onTradeEvent(self, a1, a2):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onTradeInvite(self, a1, a2, a3):
		"""Avatar client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass
