# -*- coding: utf-8 -*-
"""迷你 ARPG 战斗常数(DEMO-GAME-003):base/cell 两脚本面共用,放 common 避免跨目录互导。"""

# Avatar 攻击面
DEMO_ATTACK_RANGE = 3.5      # 攻击距离(Monster 近身 2 < 3.5,站桩可反打)
DEMO_AVATAR_DAMAGE = 15      # Avatar 单次攻击伤害
DEMO_ATTACK_COOLDOWN = 1.5   # 攻击冷却(秒)
DEMO_LEVEL_UP_STEP = 50      # 每 50 点经验升 1 级

# Avatar 死亡重生
DEMO_RESPAWN_DELAY = 5.0     # 倒地后回出生点满血重生的延时(秒)

# 击杀奖励(Monster 死亡 → 击杀者)
DEMO_GOLD_PER_KILL = 10      # 金币(Inventory 组件 gold)
DEMO_XP_PER_KILL = 30        # 经验(基座 experience)

# bots 无头玩家移动(DEMO-GAME-004)
DEMO_BOTS_MOVE_VELOCITY = 4.0  # bots 走向目标的速度(客户端权威位移,自动同步服务端)

# Cultivation combat (DEMO-GAME-009/012): five-element affinity damage.
CULTIVATION_OVERCOME_RATIO = 1.5   # damage multiplier when own element overcomes the target's
CULTIVATION_GENERATED_RATIO = 0.5  # damage multiplier against the element own element generates
CULTIVATION_SPELL_DAMAGE = 10      # base spell damage before element affinity ratios
CULTIVATION_SPELL_COOLDOWN = 2.0   # spell cooldown in seconds

# Pet follow (DEMO-GAME-009/017)
PET_FOLLOW_DISTANCE = 5.0          # pet keeps this distance from the owner
PET_TELEPORT_DISTANCE = 20.0       # pet teleports to the owner when farther than this

# Talisman (DEMO-GAME-009/016)
TALISMAN_BASE_POWER = 20           # base effect strength of a talisman
TALISMAN_DURATION_SECS = 30.0      # active duration of a talisman effect in seconds

# Formation (DEMO-GAME-009/018)
FORMATION_MAX_MEMBERS = 5          # max members sharing one formation
FORMATION_RADIUS = 10.0            # members must stay within this radius of the anchor
FORMATION_BUFF_RATIO = 0.1         # per-member damage buff ratio while in formation

# Sect (DEMO-GAME-009/019/033)
SECT_MAX_MEMBERS = 100             # roster cap of one sect
SECT_CREATE_COST_GOLD = 500        # gold required to found a sect
SECT_DONATE_EXP_RATIO = 0.1        # ratio of donated experience kept as sect funds

# Bag stacking / monster drops (DEMO-GAME-013)
DEMO_BAG_CAPACITY = 20             # slot cap of the Inventory bag
DEMO_DROP_ITEM_ID = 1              # item dropped per monster kill (妖兽材料)
DEMO_DROP_ITEM_COUNT = 1           # stack count added per kill

# Talisman AOE (DEMO-GAME-016)
DEMO_TALISMAN_RADIUS = 6.0        # blast radius around the caster
