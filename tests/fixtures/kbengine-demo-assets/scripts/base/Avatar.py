# -*- coding: utf-8 -*-
import KBEngine
import cultivation
from KBEDebug import *
from Spaces import spaceByIndex


# 迷你 ARPG:角色出生配置(单世界空间)
DEMO_SPACE_INDEX = 1


# 迷你 ARPG 战斗常数:见 common/DemoConsts.py(base/cell 共用)
from DemoConsts import DEMO_BAG_CAPACITY, DEMO_LEVEL_UP_STEP, DEMO_RESPAWN_DELAY

TIMER_RESPAWN = 1


class Avatar(KBEngine.Proxy):
	def __init__(self):
		KBEngine.Proxy.__init__(self)
		self.lastAttackAt = 0.0
		INFO_MSG("Avatar[%i] created, name=%s" % (self.id, self.name))
		msg = "Avatar[%i] created, name=%s -> enterSpace(%i)" % (self.id, self.name, DEMO_SPACE_INDEX)
		print("[demo-evidence] %s" % msg, flush=True)
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
			print("[demo-evidence] %s" % msg, flush=True)
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
		print("[demo-evidence] %s" % msg, flush=True)
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
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.addTimer(DEMO_RESPAWN_DELAY, 0, TIMER_RESPAWN)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.(基座计时器:重生回调)
		"""
		if userArg != TIMER_RESPAWN:
			return
		msg = "Avatar[%i] RESPAWN -> enterSpace(%i) (fresh cell, full hp)" % (self.id, DEMO_SPACE_INDEX)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.enterSpace(DEMO_SPACE_INDEX)

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
			print("[demo-evidence] %s" % msg, flush=True)
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
		print("[demo-evidence] %s" % msg, flush=True)
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
		print("[demo-evidence] %s" % msg, flush=True)
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
			print("[demo-evidence] %s" % msg, flush=True)
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
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
