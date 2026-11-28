# -*- coding: utf-8 -*-
import KBEngine
import cultivation
from KBEDebug import *
from Spaces import spaceByIndex


# 迷你 ARPG:角色出生配置(单世界空间)
DEMO_SPACE_INDEX = 1


# 迷你 ARPG 战斗常数:见 common/DemoConsts.py(base/cell 共用)
from DemoConsts import DEMO_BAG_CAPACITY, DEMO_LEVEL_UP_STEP, DEMO_RESPAWN_DELAY, DEMO_TALISMAN_RADIUS
from Spaces import spaceByIndex

TIMER_RESPAWN = 1
TIMER_FORMATION_PLACE = 2


class Avatar(KBEngine.Proxy):
	def __init__(self):
		KBEngine.Proxy.__init__(self)
		self.lastAttackAt = 0.0
		self._pendingFormations = []
		INFO_MSG("Avatar[%i] created, name=%s" % (self.id, self.name))
		msg = "Avatar[%i] created, name=%s -> enterSpace(%i)" % (self.id, self.name, DEMO_SPACE_INDEX)
		evidenceLog(msg)
		self.enterSpace(DEMO_SPACE_INDEX)

	def reqPractice(self):
		"""
		Exposed.(Avatar.def BaseMethods,修仙战役 DEMO-GAME-011)
		修炼:经验 +PRACTICE_EXP_GAIN,过阈值即境界突破(realm+1)并 writeToDB
		落真表;境界规则全在 cultivation 纯函数核(单测钉死),本层只采集与执行。
		"""
		before = self.realm
		self.experience += cultivation.PRACTICE_EXP_GAIN
		new_realm, _gained, _need = cultivation.realm_of(self.experience)
		if new_realm != before:
			self.realm = new_realm
			self.writeToDB()
			msg = "Avatar[%i] REALM UP %s->%s exp=%i (writeToDB)" % (
				self.id, cultivation.REALM_NAMES[before], cultivation.REALM_NAMES[new_realm], self.experience,
			)
			evidenceLog(msg)
			if self.client is not None:
				self.client.onRealmUp(new_realm)
		else:
			DEBUG_MSG("Avatar[%i].reqPractice exp=%i realm=%s" % (
				self.id, self.experience, cultivation.REALM_NAMES[new_realm]))

	def enterSpace(self, spaceIndex):
		"""
		KBEngine method.
		加入空间:把本实体的 cell 创建到目标空间(参数为空间基实体的 cellEntityCall,
		引擎要求 EntityCall 类型为 CELL)。
		"""
		space = spaceByIndex.get(spaceIndex)
		if space is None or space.cell is None:
			ERROR_MSG("Avatar[%i].enterSpace: space(%i) not ready" % (self.id, spaceIndex))
			return
		# 五行战斗(DEMO-GAME-012):spiritRoots 是 BASE_AND_CLIENT,cell 面不可见;
		# 主灵根换算成 UINT8 桥属性,createCellEntity 前落 base 侧即随 cellData
		# 进 cell(引擎建 cellData 收 cell 可见面初值)。
		self.dominantRoot = cultivation.dominant_root(self.spiritRoots)
		msg = "Avatar[%i] enterSpace dominantRoot=%i (%s)" % (
			self.id, self.dominantRoot,
			cultivation.ROOT_KEYS[self.dominantRoot - 1] if self.dominantRoot else "none",
		)
		evidenceLog(msg)
		self.createCellEntity(space.cell)

	def onAvatarDead(self):
		"""
		KBEngine method.(Avatar.def BaseMethods,cell 侧死亡结算回调)
		销 cell(destroyCellEntity 是基座面 API,cellapp 脚本无此方法) +
		排重生计时:DEMO_RESPAWN_DELAY 后 enterSpace 回出生点满血回归
		"""
		if self.cell is not None:
			self.destroyCellEntity()
		msg = "Avatar[%i] base respawn scheduled in %.1fs" % (self.id, DEMO_RESPAWN_DELAY)
		evidenceLog(msg)
		self.addTimer(DEMO_RESPAWN_DELAY, 0, TIMER_RESPAWN)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(基座计时器:重生回调)
		"""
		if userArg == TIMER_FORMATION_PLACE:
			self._flushPendingFormations()
			return
		if userArg != TIMER_RESPAWN:
			return
		msg = "Avatar[%i] RESPAWN -> enterSpace(%i) (fresh cell, full hp)" % (self.id, DEMO_SPACE_INDEX)
		evidenceLog(msg)
		self.enterSpace(DEMO_SPACE_INDEX)

	def _flushPendingFormations(self):
		"""Deferred placement queue (Space spawn convention: cell creation
		never nested inside a creation flow)."""
		pending, self._pendingFormations = self._pendingFormations, []
		space = spaceByIndex.get(DEMO_SPACE_INDEX)
		for f in pending:
			if f is None or f.isDestroyed:
				continue
			if space is None or space.cell is None:
				ERROR_MSG("Avatar[%i].reqPlaceFormation: space not ready" % self.id)
				continue
			f.createCellEntity(space.cell)
			msg = "Avatar[%i] PLACE FORMATION kind=%s id=%i owner=%i at (%.1f,%.1f)" % (
				self.id, f.kind, f.id, self.dbid,
				f.cellData["position"][0], f.cellData["position"][2],
			)
			evidenceLog(msg)
			if self.client is not None:
				self.client.onFormationPlaced(f.kind, f.id)

	def reqPlaceFormation(self, kind):
		"""
		Exposed.(DEMO-GAME-018: place a formation ring at the caster's feet;
		gather heals, bind slows) Spawn position rides cellData["position"]
		(BASEAPP streams cell position from cellData, entity_macro.h).
		"""
		if kind not in cultivation.FORMATION_TYPES:
			kind = "gather"
		f = KBEngine.createEntityLocally("Formation", {
			"kind": kind,
			"ownerId": self.dbid,
			"ownerEntityId": self.id,
		})
		if f is None:
			ERROR_MSG("Avatar[%i].reqPlaceFormation: create Formation failed" % self.id)
			return
		f.cellData["position"] = (self.position.x, self.position.y, self.position.z)
		self._pendingFormations.append(f)
		self.addTimer(0.1, 0, TIMER_FORMATION_PLACE)
	# ---- Sect (DEMO-GAME-019) ----

	def _findSect(self, sectDbid):
		return next((e for e in KBEngine.entities.values()
			if getattr(e, "className", "") == "Sect" and e.dbid == sectDbid), None)

	def _memberInfo(self):
		return {
			"dbid": self.dbid,
			"name": self.name,
			"realm": self.realm,
			"rank": 0,
			"dept": 0,
		}

	def reqCreateSect(self, name):
		"""
		Exposed.(DEMO-GAME-019 建宗:宗名唯一→建 Sect 实体→写库→名册登记)
		建宗金币闸(SECT_CREATE_COST_GOLD)随经济批收口,demo 先零费。
		"""
		name = (name or "").strip()
		if not name:
			DEBUG_MSG("Avatar[%i].reqCreateSect: empty name" % self.id)
			return
		if getattr(self, "sectId", 0):
			DEBUG_MSG("Avatar[%i].reqCreateSect: already in sect %i" % (self.id, self.sectId))
			return
		if self._findSectByName(name) is not None:
			DEBUG_MSG("Avatar[%i].reqCreateSect: name taken %s" % (self.id, name))
			return
		# DEMO-GAME-020 globalData face: cross-process unique-name registry
		# (KBEngine.globalData is a dbmgr-synced map, globaldata_client.cpp
		# broadcasts writes to every baseapp/cellapp).
		sectKey = "sectname:" + name
		if KBEngine.globalData.get(sectKey) is not None:
			DEBUG_MSG("Avatar[%i].reqCreateSect: globalData name taken %s" % (self.id, name))
			return
		def onSaved(success, sect):
			if not success or sect is None:
				ERROR_MSG("Avatar[%i].reqCreateSect: writeToDB failed name=%s" % (self.id, name))
				return
			sect.members = [self._memberInfo()]
			self.sectId = sect.dbid
			self.sectName = sect.name
			msg = "Avatar[%i] SECT FOUNDED dbid=%i name=%s leader=%i" % (
				self.id, sect.dbid, sect.name, self.dbid)
			evidenceLog(msg)
			sect.writeToDB()
		sect = KBEngine.createEntityLocally("Sect", {
			"name": name,
			"leaderDbid": self.dbid,
			"members": [],
		})
		if sect is None:
			ERROR_MSG("Avatar[%i].reqCreateSect: create Sect failed" % self.id)
			return
		sect.writeToDB(onSaved)

	def _findSectByName(self, name):
		return next((e for e in KBEngine.entities.values()
			if getattr(e, "className", "") == "Sect" and e.name == name), None)

	def reqJoinSect(self, sectDbid):
		"""
		Exposed.(DEMO-GAME-019 入宗:按 dbid,本机已载复用,否则 createEntityFromDB)
		"""
		if getattr(self, "sectId", 0):
			DEBUG_MSG("Avatar[%i].reqJoinSect: already in sect %i" % (self.id, self.sectId))
			return

		def join(sect):
			if sect is None:
				ERROR_MSG("Avatar[%i].reqJoinSect: sect %i not found" % (self.id, sectDbid))
				return
			if sect.full() or sect.hasMember(self.dbid):
				DEBUG_MSG("Avatar[%i].reqJoinSect: sect full or already member" % self.id)
				return
			sect.addMember(self._memberInfo())
			self.sectId = sect.dbid
			self.sectName = sect.name
			sect.writeToDB()
			msg = "Avatar[%i] SECT JOIN dbid=%i name=%s members=%i" % (
				self.id, sect.dbid, sect.name, len(sect.members))
			evidenceLog(msg)

		sect = self._findSect(sectDbid)
		if sect is not None:
			join(sect)
			return

		def onLoaded(success, sect):
			join(sect if success else None)
		KBEngine.createEntityFromDB(sectDbid, onLoaded)

	def reqLeaveSect(self):
		"""
		Exposed.(DEMO-GAME-019 离宗:盟主离宗让位;空宗解散删档)
		"""
		sectDbid = getattr(self, "sectId", 0)
		if not sectDbid:
			DEBUG_MSG("Avatar[%i].reqLeaveSect: no sect" % self.id)
			return
		sect = self._findSect(sectDbid)
		if sect is None:
			ERROR_MSG("Avatar[%i].reqLeaveSect: sect %i not loaded" % (self.id, sectDbid))
			return
		sect.removeMember(self.dbid)
		self.sectId = 0
		self.sectName = ""
		if not len(sect.members):
			sectName = sect.name
			sectKey = "sectname:" + sectName
			if KBEngine.globalData.get(sectKey) is not None:
				del KBEngine.globalData[sectKey]
				msg = "Avatar[%i] SECT GLOBALDATA RELEASE %s" % (self.id, sectKey)
				evidenceLog(msg)
			sect.deleteFromDB()
			sect.destroy()
			msg = "Avatar[%i] SECT DISBAND dbid=%i name=%s (empty)" % (
				self.id, sectDbid, sectName)
			evidenceLog(msg)
			return
		if sect.leaderDbid == self.dbid:
			sect.leaderDbid = sect.members[0]["dbid"]
			msg = "Sect[%i] LEADER TRANSFER -> %i" % (sectDbid, sect.leaderDbid)
			evidenceLog(msg)
		sect.writeToDB()
		msg = "Avatar[%i] SECT LEAVE dbid=%i members=%i" % (
			self.id, sectDbid, len(sect.members))
		evidenceLog(msg)

	def reqSectChat(self, text):
		"""
		Exposed.(DEMO-GAME-019 宗门频道:经 Sect 基座广播给全体已载成员)
		"""
		sectDbid = getattr(self, "sectId", 0)
		if not sectDbid:
			return
		sect = self._findSect(sectDbid)
		if sect is None:
			return
		sect.broadcast(self.name, text)

	def cellAddExperience(self, xp):
		"""
		KBEngine method.(Avatar.def BaseMethods,cell 击杀结算回调)
		经验累加与升级判定(基座持有 experience/level,cell 死亡销毁不丢);
		跨过 DEMO_LEVEL_UP_STEP 整数倍即升 1 级并 onLevelUp 通知客户端。
		"""
		self.experience += xp
		newLevel = self.experience // DEMO_LEVEL_UP_STEP + 1
		if newLevel != self.level:
			self.level = newLevel
			msg = "Avatar[%i] LEVEL UP -> %i (experience=%i)" % (self.id, newLevel, self.experience)
			evidenceLog(msg)
			if self.client is not None:
				self.client.onLevelUp(newLevel)

	def onGetCell(self):
		"""
		KBEngine method.
		cell 部分创建成功
		"""
		DEBUG_MSG("Avatar[%i].onGetCell" % self.id)

	def onLoseCell(self):
		"""
		KBEngine method.
		cell 部分丢失:客户端已不在则销毁本体(onClientDeath 只销 cell 的收尾)
		"""
		DEBUG_MSG("Avatar[%i].onLoseCell" % self.id)
		if self.client is None:
			self.destroy()

	def onClientEnabled(self):
		"""
		KBEngine method.
		客户端已交接到本实体(Account.giveClientTo 之后)
		"""
		INFO_MSG("Avatar[%i].onClientEnabled: client=%s" % (self.id, self.client))
		msg = "Avatar[%i].onClientEnabled: client handed over (giveClientTo done)" % self.id
		evidenceLog(msg)

	def onRadarPush(self, x, z, attackerId):
		"""
		Cell method.(Avatar.def BaseMethods,cell 雷达推送中继:
		cell 侧 self.client 依赖 witness 链、bots 真机恒 None,故受击时
		攻击者位置经本基座转发客户端 onMonsterNear,bots 据此走位接敌)
		"""
		msg = "Avatar[%i].onRadarPush attacker=%i client=%s" % (
			self.id, attackerId, "set" if self.client is not None else "NONE",
		)
		evidenceLog(msg)
		if self.client is not None:
			self.client.onMonsterNear(x, z, attackerId)

	def onClientDeath(self):
		"""
		KBEngine method.
		客户端断开:角色仍持有 cell 时先销毁 cell(引擎要求 destroy 前无 cell,
		否则 "has cell, please destroyCellEntity() first"),onLoseCell 里再销毁本体。
		"""
		if self.cell is not None:
			self.destroyCellEntity()
			return
		self.destroy()

	def reqCastSkill(self, skillId):
		"""
		exposed.
		客户端请求施放技能
		"""
		DEBUG_MSG("Avatar[%i].reqCastSkill: %i" % (self.id, skillId))

	def reqDepotDeposit(self, itemId, count):
		"""
		Exposed.(DEMO-GAME-014/060 装备库存入)
		背包堆叠→库:remove_stack 从袋里扣量,建 Item 实体(base-only 第四种
		实体形态)承载,writeToDB 落 tbl_Item;dbid 由 dbmgr 在写库注册期分配,
		故名册条目在写库回调里回填(回调签名 success, entity)。
		"""
		merged, removed = cultivation.remove_stack(list(self.bag.items), itemId, count)
		if removed <= 0:
			DEBUG_MSG("Avatar[%i].reqDepotDeposit: no itemId=%i in bag" % (self.id, itemId))
			return
		self.bag.items = merged

		def onSaved(success, item):
			if not success or item is None:
				ERROR_MSG("Avatar[%i].reqDepotDeposit: writeToDB failed, refund itemId=%i count=%i" % (
					self.id, itemId, removed))
				refunded, _ = cultivation.merge_stack(
					list(self.bag.items), itemId, removed, DEMO_BAG_CAPACITY)
				self.bag.items = refunded
				return
			self.equipDepot.append({"dbid": item.dbid, "strengthen": 0})
			msg = "Avatar[%i] DEPOSIT itemId=%i count=%i -> Item dbid=%i depot=%i" % (
				self.id, itemId, removed, item.dbid, len(self.equipDepot))
			evidenceLog(msg)

		item = KBEngine.createEntityLocally("Item", {
			"itemId": itemId,
			"itemType": 1,
			"count": removed,
			"ownerDbid": self.dbid,
		})
		if item is None:
			ERROR_MSG("Avatar[%i].reqDepotDeposit: create Item failed" % self.id)
			return
		item.writeToDB(onSaved)

	def reqDepotWithdraw(self, itemDbid):
		"""
		Exposed.(DEMO-GAME-014/060 装备库取出)
		名册条目→找本机 Item 实体(demo 规模线性扫)→袋容量够则堆叠回袋,
		deleteFromDB+destroy 销实体,名册摘条目。
		"""
		idx = next((i for i, slot in enumerate(self.equipDepot)
			if slot.get("dbid") == itemDbid), None)
		if idx is None:
			DEBUG_MSG("Avatar[%i].reqDepotWithdraw: dbid=%i not in depot" % (self.id, itemDbid))
			return
		item = next((e for e in KBEngine.entities.values()
			if getattr(e, "dbid", 0) == itemDbid
			and getattr(e, "ownerDbid", 0) == self.dbid), None)
		if item is None:
			DEBUG_MSG("Avatar[%i].reqDepotWithdraw: Item entity dbid=%i not local" % (self.id, itemDbid))
			return
		merged, added = cultivation.merge_stack(
			list(self.bag.items), item.itemId, item.count, DEMO_BAG_CAPACITY)
		if added < item.count:
			DEBUG_MSG("Avatar[%i].reqDepotWithdraw: bag full, keep dbid=%i in depot" % (self.id, itemDbid))
			return
		self.bag.items = merged
		self.equipDepot = [sl for i, sl in enumerate(self.equipDepot) if i != idx]
		item.deleteFromDB()
		item.destroy()
		msg = "Avatar[%i] WITHDRAW Item dbid=%i itemId=%i count=%i -> bag (depot=%i)" % (
			self.id, itemDbid, item.itemId, item.count, len(self.equipDepot))
		evidenceLog(msg)

	def _findOwnedEquip(self, equipDbid):
		"""本机找归属装备实体(demo 规模线性扫,同 reqDepotWithdraw)。"""
		return next((e for e in KBEngine.entities.values()
			if getattr(e, "dbid", 0) == equipDbid
			and getattr(e, "ownerDbid", 0) == self.dbid
			and getattr(e, "className", "") == "Equipment"), None)

	def _recomputeAttrs(self, why):
		"""
		attrs 合成(DEMO-GAME-015/048):基础 catalog bonus+强化等+宝石和,
		遍历穿戴位实体本地重算;真机锚打前后差值(015 锚=穿前后变化)。
		"""
		before = dict(self.attrs)
		total = cultivation.empty_bonus()
		for slot in self.equipSlots:
			equip = self._findOwnedEquip(slot.get("dbid", 0))
			if equip is None:
				continue
			total = cultivation.add_bonus(total, cultivation.synthesize_bonus(
				equip.bonus, equip.strengthen, equip.gems))
		self.attrs = total
		msg = "Avatar[%i] ATTRS SYNTH (%s) maxHp %i->%i attack %i->%i defense %i->%i qi %i->%i" % (
			self.id, why,
			before.get("maxHp", 0), total["maxHp"], before.get("attack", 0), total["attack"],
			before.get("defense", 0), total["defense"], before.get("qi", 0), total["qi"],
		)
		evidenceLog(msg)

	def reqForgeEquip(self, itemId, slot):
		"""
		Exposed.(DEMO-GAME-015 锻造:catalog 表→Equipment 实体→装备库名册)
		itemId 走 cultivation.EQUIP_CATALOG;写库回调回填 dbid 入名册
		(同 reqDepotDeposit 时序判例)。
		"""
		entry = cultivation.EQUIP_CATALOG.get(itemId)
		if entry is None or entry["slot"] != slot:
			DEBUG_MSG("Avatar[%i].reqForgeEquip: unknown itemId=%i slot=%s" % (self.id, itemId, slot))
			return
		def onSaved(success, equip):
			if not success or equip is None:
				ERROR_MSG("Avatar[%i].reqForgeEquip: writeToDB failed itemId=%i" % (self.id, itemId))
				return
			self.equipDepot.append({"dbid": equip.dbid, "strengthen": 0})
			msg = "Avatar[%i] FORGE Equipment dbid=%i itemId=%i slot=%s -> depot=%i" % (
				self.id, equip.dbid, itemId, slot, len(self.equipDepot))
			evidenceLog(msg)
		equip = KBEngine.createEntityLocally("Equipment", {
			"itemId": itemId,
			"itemType": 2,
			"count": 1,
			"ownerDbid": self.dbid,
			"slot": slot,
			"realmReq": entry["realmReq"],
			"bonus": dict(entry["bonus"]),
		})
		if equip is None:
			ERROR_MSG("Avatar[%i].reqForgeEquip: create Equipment failed" % self.id)
			return
		equip.writeToDB(onSaved)

	def reqEquipWear(self, equipDbid, slot):
		"""
		Exposed.(DEMO-GAME-015 穿戴:名册→穿戴位,slot+境界闸 can_equip)
		"""
		idx = next((i for i, s0 in enumerate(self.equipDepot)
			if s0.get("dbid") == equipDbid), None)
		if idx is None:
			DEBUG_MSG("Avatar[%i].reqEquipWear: dbid=%i not in depot" % (self.id, equipDbid))
			return
		equip = self._findOwnedEquip(equipDbid)
		if equip is None:
			DEBUG_MSG("Avatar[%i].reqEquipWear: entity dbid=%i not local" % (self.id, equipDbid))
			return
		ok, reason = cultivation.can_equip(slot, equip.slot, self.realm, equip.realmReq)
		if not ok:
			DEBUG_MSG("Avatar[%i].reqEquipWear: refused (%s)" % (self.id, reason))
			return
		# 同位替换:旧件回库名册
		cur = next((s0 for s0 in self.equipSlots
			if self._findOwnedEquip(s0.get("dbid", 0)) is not None
			and self._findOwnedEquip(s0.get("dbid", 0)).slot == slot), None)
		if cur is not None:
			self.equipSlots = [s0 for s0 in self.equipSlots if s0 is not cur]
			self.equipDepot.append(cur)
		self.equipDepot = [s0 for i, s0 in enumerate(self.equipDepot) if i != idx]
		self.equipSlots.append({"dbid": equipDbid, "strengthen": equip.strengthen})
		self._recomputeAttrs("wear %s dbid=%i" % (slot, equipDbid))

	def _slotOf(self, slotEntry):
		equip = self._findOwnedEquip(slotEntry.get("dbid", 0))
		return equip.slot if equip is not None else ""

	def reqEquipUnwear(self, slot):
		"""
		Exposed.(DEMO-GAME-015 脱卸:穿戴位→名册)
		"""
		target = None
		for s0 in self.equipSlots:
			equip = self._findOwnedEquip(s0.get("dbid", 0))
			if equip is not None and equip.slot == slot:
				target = s0
				break
		if target is None:
			DEBUG_MSG("Avatar[%i].reqEquipUnwear: nothing in slot=%s" % (self.id, slot))
			return
		self.equipSlots = [s0 for s0 in self.equipSlots if s0 is not target]
		self.equipDepot.append(target)
		self._recomputeAttrs("unwear %s" % slot)

	def reqSocketGem(self, equipDbid, gemItemId):
		"""
		Exposed.(DEMO-GAME-048 嵌宝石:袋扣一颗宝石→装备孔位)
		"""
		entry = cultivation.GEM_CATALOG.get(gemItemId)
		if entry is None:
			DEBUG_MSG("Avatar[%i].reqSocketGem: unknown gem itemId=%i" % (self.id, gemItemId))
			return
		merged, removed = cultivation.remove_stack(list(self.bag.items), gemItemId, 1)
		if removed <= 0:
			DEBUG_MSG("Avatar[%i].reqSocketGem: no gem itemId=%i in bag" % (self.id, gemItemId))
			return
		equip = self._findOwnedEquip(equipDbid)
		if equip is None:
			self.bag.items = cultivation.merge_stack(
				list(self.bag.items), gemItemId, 1, DEMO_BAG_CAPACITY)[0]
			return
		equip.onSocketGem({
			"gemId": gemItemId,
			"level": entry["level"],
			"attrType": entry["attrType"],
			"attrValue": entry["attrValue"],
		})
		self.bag.items = merged
		self._recomputeAttrs("socket gem %i" % gemItemId)

	def reqUnsocketGem(self, equipDbid, gemIndex):
		"""
		Exposed.(DEMO-GAME-048 卸宝石)
		"""
		equip = self._findOwnedEquip(equipDbid)
		if equip is None:
			return
		equip.onUnsocketGem(gemIndex)
		self._recomputeAttrs("unsocket gem idx=%i" % gemIndex)

	def _findOwnedItem(self, itemDbid, className):
		"""本机找归属 Item 系实体(Equipment/Talisman 共用,线性扫)。"""
		return next((e for e in KBEngine.entities.values()
			if getattr(e, "dbid", 0) == itemDbid
			and getattr(e, "ownerDbid", 0) == self.dbid
			and getattr(e, "className", "") == className), None)

	def reqUseTalisman(self, talismanDbid):
		"""
		Exposed.(DEMO-GAME-016 用符:基座消耗次数→cell AOE)
		consume_talisman 纯函数判耗尽;耗尽走 deleteFromDB+destroy 自毁
		(016 行裁明 writeToDB 后 deleteFromDB 位);否则次数-1 并把
		radius+power 转发 cell useTalismanBlast(范围妖兽过 receiveDamage)。
		"""
		talisman = self._findOwnedItem(talismanDbid, "Talisman")
		if talisman is None:
			DEBUG_MSG("Avatar[%i].reqUseTalisman: dbid=%i not local" % (self.id, talismanDbid))
			return
		remaining, destroyed = cultivation.consume_talisman(talisman.charges)
		if destroyed:
			talisman.deleteFromDB()
			talisman.destroy()
			msg = "Avatar[%i] TALISMAN dbid=%i DEPLETED -> destroyed" % (self.id, talismanDbid)
			evidenceLog(msg)
			power = 0
		else:
			talisman.charges = remaining
			power = talisman.power
			msg = "Avatar[%i] TALISMAN dbid=%i use -> charges=%i power=%i" % (
				self.id, talismanDbid, remaining, power)
			evidenceLog(msg)
		if self.cell is not None and power > 0:
			self.cell.useTalismanBlast(int(DEMO_TALISMAN_RADIUS), power)

	# ---- Pet (DEMO-GAME-017) ----

	def reqAdoptPet(self, name):
		"""
		Exposed.(DEMO-GAME-017 收养:建 Pet 实体+写库+名册登记)
		dbid 回调回填入册(同 Equipment/Item 时序判例)。
		"""
		def onSaved(success, pet):
			if not success or pet is None:
				ERROR_MSG("Avatar[%i].reqAdoptPet: writeToDB failed name=%s" % (self.id, name))
				return
			self.petList.append({"dbid": pet.dbid, "name": name, "realm": pet.realm})
			msg = "Avatar[%i] ADOPT PET dbid=%i name=%s roster=%i" % (
				self.id, pet.dbid, name, len(self.petList))
			evidenceLog(msg)
		pet = KBEngine.createEntityLocally("Pet", {
			"name": name,
			"realm": 1,
			"ownerDbid": self.dbid,
		})
		if pet is None:
			ERROR_MSG("Avatar[%i].reqAdoptPet: create Pet failed" % self.id)
			return
		pet.writeToDB(onSaved)

	def reqSummonPet(self, petDbid):
		"""
		Exposed.(DEMO-GAME-017 召唤:createEntityFromDB→cell 落身边)
		"""
		if next((p for p in self.petList if p.get("dbid") == petDbid), None) is None:
			DEBUG_MSG("Avatar[%i].reqSummonPet: dbid=%i not in roster" % (self.id, petDbid))
			return
		space = spaceByIndex.get(DEMO_SPACE_INDEX)
		if space is None or space.cell is None:
			ERROR_MSG("Avatar[%i].reqSummonPet: space not ready" % self.id)
			return

		def summon(pet):
			# ownerEntityId 是 CELL_PUBLIC:createCellEntity 前落 base 侧
			# 即随 cellData 进 cell(dominantRoot 同款判例)。
			pet.ownerEntityId = self.id
			pet.createCellEntity(space.cell)
			msg = "Avatar[%i] SUMMON PET dbid=%i name=%s -> cell space=%i" % (
				self.id, petDbid, pet.name, DEMO_SPACE_INDEX)
			evidenceLog(msg)

		loaded = next((e for e in KBEngine.entities.values()
			if getattr(e, "className", "") == "Pet" and e.dbid == petDbid), None)
		if loaded is not None:
			summon(loaded)
			return

		def onLoaded(success, pet):
			if not success or pet is None:
				ERROR_MSG("Avatar[%i].reqSummonPet: load dbid=%i failed" % (self.id, petDbid))
				return
			summon(pet)
		KBEngine.createEntityFromDB(petDbid, onLoaded)

	def reqRecallPet(self):
		"""
		Exposed.(DEMO-GAME-017 收回:cell 销毁,base 留存待再召)
		"""
		pet = next((e for e in KBEngine.entities.values()
			if getattr(e, "ownerEntityId", 0) == self.id
			and getattr(e, "className", "") == "Pet"), None)
		if pet is None or pet.cell is None:
			DEBUG_MSG("Avatar[%i].reqRecallPet: no summoned pet" % self.id)
			return
		pet.destroyCellEntity()
		msg = "Avatar[%i] RECALL PET dbid=%i name=%s" % (self.id, pet.dbid, pet.name)
		evidenceLog(msg)

	def reqAcceptBounty(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqAddFriend(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqBuyGoods(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqBuyMonthlyCard(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqChatMessage(self, a1, a2):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqChoosePath(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqClaimFirstRecharge(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqClaimVipReward(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqCreateParty(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqDaoPartnerReply(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqDelFriend(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqDismissMerc(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqHireMerc(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqJoinRankedQueue(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqLeaveRankedQueue(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqPartyInvite(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqPartyLeave(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqPartyReply(self, a1, a2):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqPartyStart(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqPartyStartReply(self, a1, a2):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqPostBounty(self, a1, a2):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqReincarnate(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqRideOff(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqRideOn(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqSetAppearance(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqSetLootMode(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqStrengthenEquip(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqSummonMerc(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTemperBody(self):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTradeCancel(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTradeConfirm(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTradeLock(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTradeReply(self, a1, a2):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTradeSetOffer(self, a1, a2):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqTurnInBounty(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqWearCostume(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass

	def reqWearTitle(self, a1):
		"""Avatar base Base face declared in Avatar.def; implementation lands
		with its own DEMO-GAME batch (engine checkDefMethod needs
		the name and signature to exist)."""
		pass
