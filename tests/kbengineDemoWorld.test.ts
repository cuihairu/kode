import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// DEMO-GAME-001:迷你 ARPG 世界地基。夹具在官方模板之上补齐 Spaces/Space
// 空间实体(hasBase/hasCell)、Space cell 刷怪表与怪物生成、
// Account.reqCreateAvatar→Avatar(Proxy)giveClientTo→入空间链路。
// 本文件锁夹具内容面(真引擎起服验收另见 scripts/ 与 docs/acceptance-evidence/)。
const ASSETS = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
const p = (...parts: string[]) => path.join(ASSETS, ...parts);
const read = (...parts: string[]) => fs.readFileSync(p(...parts), 'utf8');

describe('DEMO-GAME-001 世界地基(夹具内容)', () => {
  it('entities.xml 注册 Spaces(hasBase) 与 Space(hasBase+hasCell)', () => {
    const xml = read('scripts', 'entities.xml');
    expect(xml).toMatch(/<Spaces\s+hasBase="true"\s*><\/Spaces>/);
    expect(xml).toMatch(/<Space\s+hasBase="true"\s+hasCell="true"\s*><\/Space>/);
  });

  it('Space.def 声明 spaceIndex(UINT32/BASE);Spaces.def 存在', () => {
    const space = read('scripts', 'entity_defs', 'Space.def');
    expect(space).toMatch(/<spaceIndex>/);
    expect(space).toMatch(/<Type>\s*UINT32\s*<\/Type>/);
    expect(space).toMatch(/<Flags>\s*BASE\s*<\/Flags>/);
    expect(() => read('scripts', 'entity_defs', 'Spaces.def')).not.toThrow();
  });

  it('base/Spaces.py:baseapp 内逐空间号 createEntityLocally("Space") 并登记注册表', () => {
    const src = read('scripts', 'base', 'Spaces.py');
    expect(src).toMatch(/class\s+Spaces\(KBEngine\.Entity\)/);
    expect(src).toMatch(/KBEngine\.createEntityLocally\(\s*"Space"/);
    expect(src).toMatch(/spaceByIndex\[spaceIndex\]\s*=\s*space/);
    expect(src).toMatch(/createSpace\(1\)/);
  });

  it('base/Space.py:__init__ 内 createCellEntityInNewSpace,onGetCell 日志确认空间就绪', () => {
    const src = read('scripts', 'base', 'Space.py');
    expect(src).toMatch(/class\s+Space\(KBEngine\.Entity\)/);
    expect(src).toMatch(/self\.createCellEntityInNewSpace\(/);
    expect(src).toMatch(/def\s+onGetCell\(self\)/);
  });

  it('cell/Space.py:刷怪表 + addTimer 延迟 KBEngine.createEntity(空间号, 出生点)', () => {
    const src = read('scripts', 'cell', 'Space.py');
    // 引擎坑:空间型实体 initializeScript 流程内嵌套 createEntity 会段错误,须延迟
    expect(src).toMatch(/DEMO_SPAWNS\s*=/);
    expect(src).toMatch(/\("Monster",\s*\(/);
    expect(src).toMatch(/self\.addTimer\(/);
    expect(src).toMatch(/KBEngine\.createEntity\(\s*\w+,\s*self\.spaceID/);
  });

  it('base/Avatar.py:Proxy,__init__ 经 createCellEntity(space.cell) 入空间', () => {
    const src = read('scripts', 'base', 'Avatar.py');
    expect(src).toMatch(/class\s+Avatar\(KBEngine\.Proxy\)/);
    expect(src).toMatch(/self\.createCellEntity\(\s*space\.cell\s*\)/);
    expect(src).toMatch(/def\s+onClientEnabled\(self\)/);
    expect(src).toMatch(/def\s+onClientDeath\(self\)/);
  });

  it('base/Account.py:reqCreateAvatar 本地建 Avatar 并 giveClientTo;onClientEnabled 通知 onLoginOK', () => {
    const src = read('scripts', 'base', 'Account.py');
    expect(src).toMatch(/def\s+reqCreateAvatar\(self,\s*name\)/);
    expect(src).toMatch(/KBEngine\.createEntityLocally\(\s*"Avatar"/);
    expect(src).toMatch(/self\.giveClientTo\(\s*avatar\s*\)/);
    expect(src).toMatch(/self\.client\.onLoginOK\(\)/);
  });

  it('base/kbemain.py:onBaseAppReady 创建 Spaces 空间管理器', () => {
    const src = read('scripts', 'base', 'kbemain.py');
    expect(src).toMatch(/createEntityLocally\(\s*"Spaces"/);
  });

  it('cell/Avatar.py:onEnterSpace 进世界日志(真引擎验收锚)', () => {
    const src = read('scripts', 'cell', 'Avatar.py');
    expect(src).toMatch(/def\s+onEnterSpace\(self\)/);
    expect(src).toMatch(/def\s+onMove\(self,\s*position,\s*userData=None\)/);
  });

  it('cell/Monster.py 继承 Avatar 脚本类;Monster.def 不重复声明 ROLE(引擎双注册)', () => {
    const monster = read('scripts', 'cell', 'Monster.py');
    expect(monster).toMatch(/class\s+Monster\(Avatar\)/);
    const def = read('scripts', 'entity_defs', 'Monster.def');
    expect(def).toMatch(/<Parent>\s*Avatar\s*<\/Parent>/);
    expect(def).not.toMatch(/<Interfaces>/);
    // 引擎 CellMethod 参数用 UINT32(ENTITY_ID 非引擎 def 解析侧类型面)
    expect(def).toMatch(/<onAggro>[\s\S]*?<Arg>\s*UINT32\s*<\/Arg>/);
  });

  it('Inventory.def 组件属性带 CELL_PUBLIC(cell 侧可见)', () => {
    const def = read('scripts', 'entity_defs', 'components', 'Inventory.def');
    expect(def).toMatch(/<Flags>\s*CELL_PUBLIC\s*<\/Flags>/);
  });
});
