import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// DEMO-GAME-003:战斗与成长(夹具内容契约)。
// 攻击面 reqAttack(Exposed)→ receiveDamage;死亡重生 cell 销毁→基座计时→回出生点满血;
// 击杀奖励金币(Inventory 组件)+ 经验(基座持有,死亡不丢)→ 升级 onLevelUp 通知客户端。
// 真机验收(无头一局日志断言)见 docs/acceptance-evidence/DEMO-GAME-003.md。
const ASSETS = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
const p = (...parts: string[]) => path.join(ASSETS, ...parts);
const read = (...parts: string[]) => fs.readFileSync(p(...parts), 'utf8');

describe('DEMO-GAME-003 战斗与成长(夹具内容契约)', () => {
  it('Avatar.def:攻击/奖励/通知三面齐备', () => {
    const def = read('scripts', 'entity_defs', 'Avatar.def');
    // 攻击入口:cell exposed,bots 无头玩家可调
    expect(def).toMatch(/<reqAttack>\s*<Exposed>\s*true\s*<\/Exposed>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/reqAttack>/);
    // 经验基座持有:cell 死亡销毁不丢(def 内含注释,逐项断言)
    expect(def).toMatch(/<experience>/);
    expect(def).toMatch(/<experience>[\s\S]*?<Type>\s*UINT32\s*<\/Type>\s*<Flags>\s*BASE_AND_CLIENT\s*<\/Flags>/);
    // 基座结算 + 死亡回调 + 升级通知
    expect(def).toMatch(/<cellAddExperience>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/cellAddExperience>/);
    expect(def).toMatch(/<onAvatarDead>\s*<\/onAvatarDead>/);
    expect(def).toMatch(/<onLevelUp>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/onLevelUp>/);
  });

  it('common/DemoConsts.py:base/cell 共用常数,不跨目录互导', () => {
    const consts = read('scripts', 'common', 'DemoConsts.py');
    expect(consts).toMatch(/DEMO_ATTACK_RANGE\s*=/);
    expect(consts).toMatch(/DEMO_RESPAWN_DELAY\s*=/);
    expect(consts).toMatch(/DEMO_GOLD_PER_KILL\s*=/);
    expect(consts).toMatch(/DEMO_XP_PER_KILL\s*=/);
    expect(consts).not.toMatch(/import\s+KBEngine/);
    const cellAvatar = read('scripts', 'cell', 'Avatar.py');
    expect(cellAvatar).toMatch(/from DemoConsts import/);
  });

  it('cell/Avatar.py:reqAttack(_attack 共路径/冷却/距离校验) + 自动战斗心跳 + 死亡走基座重生', () => {
    const cell = read('scripts', 'cell', 'Avatar.py');
    expect(cell).toMatch(/def\s+reqAttack\(self,\s*targetId\)/);
    expect(cell).toMatch(/addTimer\(DEMO_ATTACK_COOLDOWN,\s*DEMO_ATTACK_COOLDOWN,\s*self\.TIMER_AUTOATTACK\)/);
    expect(cell).toMatch(/self\.entitiesInRange\(DEMO_ATTACK_RANGE,\s*"Monster"\)/);
    expect(cell).toMatch(/target\.receiveDamage\(DEMO_AVATAR_DAMAGE,\s*self\.id\)/);
    // cellapp 脚本无 destroyCellEntity(基座面 API),死亡只上报基座
    expect(cell).toMatch(/base = getattr\(self,\s*"base",\s*None\)[\s\S]{0,120}base\.onAvatarDead\(\)/);
    expect(cell).not.toMatch(/self\.destroyCellEntity\(\)/);
  });

  it('base/Avatar.py:销 cell+重生计时 + 经验/升级结算(基座持有)', () => {
    const base = read('scripts', 'base', 'Avatar.py');
    expect(base).toMatch(/def\s+onAvatarDead\(self\)[\s\S]*destroyCellEntity\(\)[\s\S]*addTimer\(DEMO_RESPAWN_DELAY/);
    expect(base).toMatch(/def\s+onTimer\(self,\s*timerID,\s*userArg\)[\s\S]*RESPAWN/);
    expect(base).toMatch(/def\s+cellAddExperience\(self,\s*xp\)[\s\S]*newLevel\s*=\s*self\.experience\s*\/\/\s*DEMO_LEVEL_UP_STEP\s*\+\s*1/);
    expect(base).toMatch(/self\.client\.onLevelUp\(newLevel\)/);
  });

  it('cell/Monster.py:受击三段(反击仇恨→父类扣血→死亡奖励+自毁)', () => {
    const monster = read('scripts', 'cell', 'Monster.py');
    expect(monster).toMatch(/def\s+receiveDamage\(self,\s*damage,\s*attackerId\)/);
    expect(monster).toMatch(/self\.onDamaged\(attackerId\)/);
    expect(monster).toMatch(/Avatar\.receiveDamage\(self,\s*damage,\s*attackerId\)/);
    expect(monster).toMatch(/killer\.bag\.gold\s*\+=\s*DEMO_GOLD_PER_KILL/);
    expect(monster).toMatch(/killer\.base\.cellAddExperience\(DEMO_XP_PER_KILL\)/);
    expect(monster).toMatch(/self\.destroy\(\)/);
  });

  it('bots/Avatar.py:雷达走位+回击完整回路(回调驱动,bots 无实体计时器/索敌面)', () => {
    const bots = read('scripts', 'bots', 'Avatar.py');
    // 引擎取证:bots 无 KBEngine.entities 模块面/实体 entities 描述子/addTimer 断言失败
    expect(bots).not.toMatch(/KBEngine\.entities\./);
    expect(bots).not.toMatch(/addTimer\(/);
    expect(bots).toMatch(/def\s+onMonsterNear\(self,\s*x,\s*z,\s*monsterId\)/);
    expect(bots).toMatch(/def\s+onEnterWorld\(self\)/);
    expect(bots).toMatch(/def\s+onMoveOver\(self,\s*controllerId,\s*userarg\)/);
    // 走位改服务端权威:reqGoto(exposed)→ cell moveToPoint(client_lib 计时器在 bots 不泵)
    expect(bots).toMatch(/self\.cell\.reqGoto\(\)/);
    expect(bots).toMatch(/self\.cell\.reqAttack\(monsterId\)/);
    expect(bots).toMatch(/def\s+onLevelUp\(self,\s*newLevel\)/);
    expect(read('scripts', 'client', 'Avatar.py')).toMatch(/def\s+onLevelUp\(self,\s*newLevel\)/);
    // 服务端雷达面:cell 侧 self.client 依赖 witness 链(bots 真机恒 None),
    // 受击推送走基座中继:onRadarPush(BaseMethods)→ base.client.onMonsterNear
    const def = read('scripts', 'entity_defs', 'Avatar.def');
    expect(def).toMatch(/<onMonsterNear>\s*<Arg>\s*FLOAT\s*<\/Arg>\s*<Arg>\s*FLOAT\s*<\/Arg>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/onMonsterNear>/);
    expect(def).toMatch(/<onRadarPush>\s*<Arg>\s*FLOAT\s*<\/Arg>\s*<Arg>\s*FLOAT\s*<\/Arg>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/onRadarPush>/);
    const cell = read('scripts', 'cell', 'Avatar.py');
    expect(cell).toMatch(/base\.onRadarPush\(/);
    expect(cell).toMatch(/DEMO_BOTS_MOVE_VELOCITY/);
    expect(cell).toMatch(/def\s+reqGoto\(self\)/);
    expect(cell).toMatch(/def\s+onMoveOver\(self,\s*controllerId,\s*userarg\)/);
    const base = read('scripts', 'base', 'Avatar.py');
    expect(base).toMatch(/self\.client\.onMonsterNear\(/);
  });

  it('Space 刷怪表扩容(8 怪 waves 一局)', () => {
    const space = read('scripts', 'cell', 'Space.py');
    const matches = space.match(/\("Monster",\s*\(/g) ?? [];
    expect(matches.length).toBe(8);
  });
});
