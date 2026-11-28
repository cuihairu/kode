# -*- coding: utf-8 -*-
import random

import KBEngine
import cultivation
from KBEDebug import *
from Avatar import DEMO_SPACE_INDEX

class Account(KBEngine.Proxy):
	def __init__(self):
		KBEngine.Proxy.__init__(self)

	def onTimer(self, id, userArg):
		"""
		KBEngine method.
		Called when a timer added via addTimer expires.
		@param id      : the id returned by addTimer
		@param userArg : the user data passed to addTimer
		"""
		DEBUG_MSG(id, userArg)

	def onClientEnabled(self):
		"""
		KBEngine method.
		The entity is now active and its client-side counterpart exists;
		its cell part can be created here.
		"""
		INFO_MSG(f"account[{self.id}] entities enable. entityCall:{self.client}")
		# notify the client: account ready (client/Account.onLoginOK)
		self.client.onLoginOK()

	def onLogOnAttempt(self, ip, port, password):
		"""
		KBEngine method.
		Called when a client login attempt is rejected.
		"""
		INFO_MSG(ip, port, password)
		return KBEngine.LOG_ON_ACCEPT

	def onClientDeath(self):
		"""
		KBEngine method.
		The client-side counterpart entity was destroyed.
		"""
		DEBUG_MSG(f"Account[{self.id}].onClientDeath:")
		self.destroy()

	def reqCreateAvatar(self, name, race):
		"""
		exposed.
		Client asks to create an avatar: build an Avatar locally (Proxy,
		its __init__ enters the space and creates the cell), then hand the
		client over to the avatar. Creation rolls five random spirit roots
		into props (DEMO-GAME-009; the engine routes props keys onto the
		matching entity properties). Race (DEMO-GAME-069): 1 = human,
		2 = yao, out-of-range values are normalized by normalize_race.
		"""
		props = cultivation.creation_props(name, random.Random())
		props["race"] = cultivation.normalize_race(race)
		INFO_MSG(f"Account[{self.id}].reqCreateAvatar: {name} race={props['race']} spiritRoots={props['spiritRoots']}")
		msg = f"Account[{self.id}].reqCreateAvatar: {name} race={props['race']} spiritRoots={props['spiritRoots']}"
		evidenceLog(msg)
		avatar = KBEngine.createEntityLocally("Avatar", props)
		if avatar is None:
			ERROR_MSG(f"Account[{self.id}].reqCreateAvatar: create avatar failed")
			return
		self.giveClientTo(avatar)
		# DEMO-GAME-024: persist the avatar row now (databaseID is only
		# assigned after the async write completes), register it on the
		# account roster for in-boot re-select, and mark the row
		# shouldAutoLoad=1 so the engine EntityAutoLoader restores it at
		# the next boot (the login blob in tbl_accountinfos only carries
		# the registration snapshot -- child-table properties written by
		# writeToDB never reach the login path, 024 real-machine finding,
		# so autoload is the engine-native restore channel).
		avatar.writeToDB(self._onNewAvatarSaved, 1)

	def _onNewAvatarSaved(self, success, avatar):
		"""DEMO-GAME-024: roster write-back after the avatar row lands."""
		if not success or avatar is None:
			ERROR_MSG(f"Account[{self.id}] avatar save failed, roster skipped")
			return
		self.avatars = [e for e in self.avatars if e.get("name") != avatar.name]
		self.avatars.append({"name": avatar.name, "dbid": avatar.databaseID})
		self.writeToDB()
		msg = f"Account[{self.id}] AVATAR ROSTER REGISTERED name={avatar.name} dbid={avatar.databaseID}"
		evidenceLog(msg)

	def reqSelectAvatar(self, name):
		"""
		exposed.(DEMO-GAME-024 DB persistence round trip)
		Select an avatar by name: a roster hit reads the avatar back from
		the DB via createEntityFromDBID (the read half of the
		writeToDB/readFromDB round trip), a miss falls through to
		reqCreateAvatar. Empty name = select the first roster entry
		(024 real-machine findings: stable naming proved impossible --
		bots client entity ids drift every boot (id bases flip with the
		app start order) and accountName is empty via getattr on both
		the bots client entity and the base-side Proxy; a fixed --cid
		only stabilizes the ACCOUNT, and the roster hangs on the account
		row -- the roster itself is the stable mapping, the avatar name
		is just a display face and takes no part in addressing).
		"""
		dbid = 0
		if not name and len(self.avatars) > 0:
			name = self.avatars[0].get("name", "")
			dbid = self.avatars[0].get("dbid", 0)
		else:
			for entry in self.avatars:
				if entry.get("name") == name:
					dbid = entry.get("dbid", 0)
					break
		if not dbid:
			# Roster miss. First try the autoload channel: avatars written
			# with shouldAutoLoad=1 are restored into KBEngine.entities by
			# the engine EntityAutoLoader at boot (base entity, no client
			# attached). Hand this login the first idle restored Avatar
			# (demo scale: one avatar per account; the bots connect in
			# account-slot order so order-pairing is deterministic).
			restored = [e for e in KBEngine.entities.values()
				if getattr(e, "className", "") == "Avatar" and e.client is None]
			if len(restored) > 0:
				avatar = restored[0]
				# Autoloaded avatars get their __init__ during baseapp boot,
				# before onBaseAppReady creates the Spaces manager, so their
				# enterSpace soft-fails ("space not ready") and they sit
				# cell-less; create the cell now (bots log in long after the
				# Spaces manager is up).
				if avatar.cell is None:
					avatar.enterSpace(DEMO_SPACE_INDEX)
				msg = (f"Account[{self.id}] REBOUND RESTORED AVATAR id={avatar.id} "
					f"name={avatar.name} realm={avatar.realm} exp={avatar.experience} "
					f"sectId={avatar.sectId}")
				evidenceLog(msg)
				INFO_MSG(f"Account[{self.id}] rebind restored avatar {avatar.name}")
				self.giveClientTo(avatar)
				return
			if not name:
				name = f"bot{self.id}"
			INFO_MSG(f"Account[{self.id}].reqSelectAvatar: {name} not in roster, create")
			msg = f"Account[{self.id}] SELECT AVATAR {name}: not in roster -> create"
			evidenceLog(msg)
			self.reqCreateAvatar(name, 1)
			return
		msg = f"Account[{self.id}] SELECT AVATAR {name}: roster dbid={dbid} -> readFromDB"
		evidenceLog(msg)
		KBEngine.createEntityFromDBID("Avatar", dbid, self._onAvatarLoaded)

	def _onAvatarLoaded(self, baseRef, dbid, wasActive):
		"""
		DEMO-GAME-024: createEntityFromDBID completion callback
		(engine signature baseapp.cpp:1106; baseRef=None on failure).
		The avatar read back carries every persisted property (realm /
		experience / spirit roots / sect); handing the client over
		resumes play.
		"""
		if baseRef is None:
			ERROR_MSG(f"Account[{self.id}] avatar dbid={dbid} load failed")
			msg = f"Account[{self.id}] AVATAR READ FROM DB dbid={dbid} FAILED"
			evidenceLog(msg)
			return
		msg = (f"Account[{self.id}] AVATAR READ FROM DB dbid={dbid} name={baseRef.name} "
			f"realm={baseRef.realm} exp={baseRef.experience} sectId={baseRef.sectId}")
		evidenceLog(msg)
		INFO_MSG(f"Account[{self.id}] avatar read from DB: {baseRef.name} (dbid={dbid})")
		self.giveClientTo(baseRef)
