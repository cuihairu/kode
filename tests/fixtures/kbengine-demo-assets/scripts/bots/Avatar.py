# -*- coding: utf-8 -*-
# Avatar client-side entity in the bots process (headless players):
# created by the bots process once the server hands the client over
# via giveClientTo.
#
# Four engine facts (all proven on the real machine):
# 1) The bots process has no KBEngine.entities module face and client
#    entities have no self.entities either (bots only registers the
#    "bots" module, bots.cpp:180; the entities descriptor lives on
#    ClientObjectBase, not the script Entity) -- the client cannot
#    enumerate targets on its own.
# 2) Client entities in the bots process have no script timer face
#    (bots.out "assertion failed: g_pApp ... at: addTimer") -- every
#    action must be callback-driven.
# 3) Cell-side self.client depends on the witness chain
#    (cellapp/entity.cpp pyGetClientEntityCall) and is always None in
#    the bots process on the real machine -- cell->client direct push
#    is a dead end; client pushes must relay through the base
#    (onRadarPush BaseMethods -> base.client).
# 4) client_lib moveToPoint (client_lib/entity.cpp:29) is accepted but
#    its 0.1s ScriptCallbacks timer never pumps in the bots process
#    (real machine: no onMoveOver/onMoveFailure after the call) --
#    client-side movement is a dead end; walking is server-authoritative:
#    reqGoto (exposed) -> cell moveToPoint, position syncs back via the
#    view.
# Hence the server radar model: ping the nearest alive monster on
# entering + push the attacker position on being hit (relayed via the
# base onMonsterNear); headless players reqGoto toward the target and
# reqAttack once close -- the full loop login -> create avatar -> move
# -> attack -> kill rewards -> level up -> death/respawn runs without
# Unity.
import KBEngine
from KBEDebug import *
from DemoConsts import DEMO_ATTACK_RANGE


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.lastTargetId = 0
		self.aiMoving = False
		self.realmUpCount = 0
		INFO_MSG(f"bots Avatar[{self.id}] client entity created, pos={getattr(self, 'position', None)}")
		msg = f"bots Avatar[{self.id}] client entity created (entity sync), pos={getattr(self, 'position', None)}"
		evidenceLog(msg)

	def _fightAt(self, monsterId, x, z):
		"""Radar target: reqAttack once in range (exposed cell method),
		reqGoto for server-authoritative walking when far."""
		if monsterId != self.lastTargetId:
			msg = f"bots Avatar[{self.id}] target Monster[{monsterId}] radar=({x:.1f},{z:.1f})"
			evidenceLog(msg)
			self.lastTargetId = monsterId
			# Retarget resets walking: cell-face calls fired inside the login sync
			# window are dropped by the engine (real machine: the reqGoto sent
			# right on entering missed 10/10); the next radar push re-sends it.
			self.aiMoving = False
		# DEMO-GAME-023 combat-driven cultivation pump: radar pushes are the
		# only reliable client-side heartbeat in the bots process (real-machine
		# findings: onEnterWorld never fires, onHPChanged is a non-property
		# callback that never triggers, onLevelUp only beats on kills); each
		# push calls reqPractice, 20 exp per push crosses the REALM_EXP
		# threshold -> REALM UP. The base entitycall is None on client
		# entities created locally (training stubs), hence the guard.
		if self.base is not None:
			self.base.reqPractice()
		dist = ((self.position.x - x) ** 2 + (self.position.z - z) ** 2) ** 0.5
		if dist <= DEMO_ATTACK_RANGE:
			self.aiMoving = False
			if self.cell is not None:
				self.cell.reqAttack(monsterId)
			return
		if not self.aiMoving:
			self.aiMoving = True
			msg = (f"bots Avatar[{self.id}] move toward Monster[{monsterId}] "
				f"from ({self.position.x:.1f},{self.position.z:.1f}) dist={dist:.1f}")
			evidenceLog(msg)
			# Engine evidence: client_lib moveToPoint is driven by a 0.1s
			# ScriptCallbacks timer that never pumps in the bots process (real
			# machine: no onMoveOver/onMoveFailure after the call); client-side
			# movement is a dead end, so walking is server-authoritative:
			# reqGoto (exposed) -> cell moves toward the radar target via
			# moveToPoint (client orders, server moves, view syncs back).
			if self.cell is not None:
				self.cell.reqGoto()

	def onMonsterNear(self, x, z, monsterId):
		"""
		Client method.(Avatar.def ClientMethods; server radar push: attacker
		position when this entity takes a hit)
		"""
		self._fightAt(monsterId, x, z)

	def onEnterWorld(self):
		"""
		KBEngine method.(client entity entered the world: gameplay loop start)
		"""
		msg = f"bots Avatar[{self.id}] onEnterWorld pos=({self.position.x:.1f},{self.position.z:.1f})"
		evidenceLog(msg)
		# DEMO-GAME-023 bot loop kick-off: cultivation starts with the first
		# practice call; onHPChanged keeps pumping per damage tick so the
		# realm threshold is reached inside the run window.
		if self.base is not None:
			self.base.reqPractice()

	def onMoveOver(self, controllerId, userarg):
		"""
		KBEngine method.(client moveToPoint arrived,
		client_lib/moveto_point_handler.cpp:54; strike the last radar target
		on arrival if still locked).
		"""
		self.aiMoving = False
		msg = f"bots Avatar[{self.id}] arrived ({self.position.x:.1f},{self.position.z:.1f})"
		evidenceLog(msg)
		if self.lastTargetId and self.cell is not None:
			self.cell.reqAttack(self.lastTargetId)

	def onMoveFailure(self, controllerId, userarg):
		"""
		KBEngine method.(client move failed: target lost etc., reset walking)
		"""
		self.aiMoving = False
		msg = (f"bots Avatar[{self.id}] move FAILED "
			f"(pos={self.position.x:.1f},{self.position.z:.1f})")
		evidenceLog(msg)

	def onLevelUp(self, newLevel):
		"""
		Client method.(Avatar.def ClientMethods)
		DEMO-GAME-023: kill cadence doubles as a practice pump beat.
		"""
		msg = f"bots Avatar[{self.id}] onLevelUp level={newLevel}"
		evidenceLog(msg)
		if self.base is not None:
			self.base.reqPractice()

	def onRealmUp(self, realm):
		"""
		Client method.(Avatar.def ClientMethods, cultivation DEMO-GAME-011)
		DEMO-GAME-023 chain: first breakthrough places the formation;
		second fires the founder's sect chat (roster long settled by then).
		"""
		self.realmUpCount += 1
		msg = f"bots Avatar[{self.id}] onRealmUp realm={realm} count={self.realmUpCount}"
		evidenceLog(msg)
		if self.realmUpCount == 1:
			if self.base is not None:
				self.base.reqPlaceFormation("gather", self.position.x, self.position.z)
		elif self.realmUpCount == 2 and getattr(self, "sectId", 0):
			# No fixed-name founder test (bot names carry dynamic client ids,
			# 023 real-machine finding): chat on the second breakthrough while
			# already in a sect, the broadcast reaches every member client.
			if self.base is not None:
				self.base.reqSectChat("sect-demo is open, fellow cultivators")

	def onFormationPlaced(self, kind, formationId):
		"""
		Client method.(Avatar.def ClientMethods, DEMO-GAME-023 chain)
		After the formation receipt: adopt pet + forge talisman + join sect
		(join-or-found, see the sect branch comment below).
		"""
		msg = f"bots Avatar[{self.id}] onFormationPlaced kind={kind} fid={formationId}"
		evidenceLog(msg)
		if self.base is None:
			return
		self.base.reqAdoptPet(f"pet-{getattr(self, 'name', self.id)}")
		self.base.reqForgeTalisman()
		# 024: sect assignment is back to the 023 join-or-found pattern (all
		# request by name, whoever exhausts retries founds, the unique-name
		# gate guarantees a single winner; explicit founder-name tests have
		# no stable name left to key on). Already in a sect (sectId restored
		# by the DB read on reboot) skips it -- the sectId round trip is
		# itself an acceptance anchor.
		if not getattr(self, "sectId", 0):
			self.base.reqJoinSectByName("sect-demo")

	def onPetAdopted(self, petDbid):
		"""
		Client method.(Avatar.def ClientMethods, DEMO-GAME-023 chain)
		Adopt receipt -> summon beside (the assist anchor is the cell-side
		Pet ASSIST evidenceLog).
		"""
		msg = f"bots Avatar[{self.id}] onPetAdopted dbid={petDbid} -> summon"
		evidenceLog(msg)
		if self.base is not None:
			self.base.reqSummonPet(petDbid)

	def onTalismanGained(self, talismanDbid):
		"""
		Client method.(Avatar.def ClientMethods, DEMO-GAME-023 chain)
		Forge receipt -> use at once (the AOE anchor is the cell-side
		useTalismanBlast).
		"""
		msg = f"bots Avatar[{self.id}] onTalismanGained dbid={talismanDbid} -> use"
		evidenceLog(msg)
		if self.base is not None:
			self.base.reqUseTalisman(talismanDbid)

	def onHPChanged(self, hp):
		"""
		Client method.(Avatar.def ClientMethods)
		"""
		DEBUG_MSG(f"bots Avatar.onHPChanged: {hp}")
		if hp > 0:
			# DEMO-GAME-023: combat-driven cultivation pump (per damage tick)
			if self.base is not None:
				self.base.reqPractice()
			if not self.aiMoving and self.cell is not None:
				# strike back at the last radar target on each hit (melee range)
				self.cell.reqAttack(self.lastTargetId)

	def onSectChat(self, sender, text):
		"""Sect channel push (DEMO-GAME-019/023): real implementation for the
		stub declared above; anchor proves cross-entity roster broadcast."""
		msg = f"bots Avatar[{self.id}] SECT CHAT from={sender} text={text}"
		evidenceLog(msg)

	def onBodySeized(self, a1, a2):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onBountyPosted(self, a1, a2, a3, a4):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onBountyResult(self, a1, a2):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onBuyResult(self, a1, a2):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onChatMessage(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onCostumeGained(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onDaoPartnerReply(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onDaoProposal(self, a1, a2):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onDungeonReady(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass


	def onPartyInvite(self, a1, a2, a3):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onPartyRoster(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onPartyStartVote(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onRankedMatchFound(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onReincarnateStart(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass


	def onSeizeResult(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onStrengthenResult(self, a1, a2):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onTitleGained(self, a1):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onTradeEvent(self, a1, a2):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def onTradeInvite(self, a1, a2, a3):
		"""Avatar bots-client Client face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass
