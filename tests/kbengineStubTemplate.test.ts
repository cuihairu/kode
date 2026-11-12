import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// 批 ③(用户令 2026-11-11 静态模板定案):插件内置 KBEngine 桩包模板落在
// 仓库顶层 typings/(README + KBEngine/ 包目录,与 fork typings 同形,
// VSIX 随包)。这里锁模板的形状契约:清单齐全、__init__ 重导出序(桩包
// shadowing 契约)、Entity/Proxy 关键注入面、导入改写净度、README 钉点。
// 模板由 scripts/derive-kbengine-stub-typings.mjs 从 fork(cuihairu/kbengine,
// 钉点见 README)派生,再生成走脚本,不手改。

const TEMPLATE_ROOT = join(__dirname, '..', 'typings');
const PACKAGE_DIR = join(TEMPLATE_ROOT, 'KBEngine');

const read = (relative: string): string => readFileSync(join(TEMPLATE_ROOT, relative), 'utf8');

describe('typings/ 内置桩包模板(清单)', () => {
  it('公共包仅含共享类型,具体进程分别有独立入口与类文件', () => {
    expect(readdirSync(PACKAGE_DIR).sort()).toEqual(['FixedArray.pyi', '__init__.pyi', '_vectors.pyi']);
    for (const role of ['base', 'cell', 'bots']) {
      for (const name of ['__init__.pyi', 'Entity.pyi', 'EntityComponent.pyi', 'Entities.pyi', 'MemoryStream.pyi']) {
        expect(existsSync(join(TEMPLATE_ROOT, 'processes', role, 'KBEngine', name))).toBe(true);
      }
    }
  });

  it('README 带 fork 钉点与再生成说明(防手改漂移)', () => {
    const readme = read('README.md');
    expect(readme).toContain('28d2117');
    expect(readme).toContain('derive-kbengine-stub-typings.mjs');
    expect(readme).toContain('copy-if-absent');
  });
});

describe('typings 进程入口与 Entity 模型', () => {
  it('公共入口不再星导入所有进程或以 Any 吞掉未定义 API', () => {
    const init = read('KBEngine/__init__.pyi');
    expect(init).not.toContain('import *');
    expect(init).not.toContain('__getattr__');
    expect(init).toContain('Vector3 as Vector3');
  });

  it('每个进程显式导出自身 API,base/cell/bots 实体互相隔离', () => {
    for (const role of ['base', 'cell', 'bots', 'client', 'dbmgr', 'interfaces', 'logger', 'loginapp']) {
      const init = read(`processes/${role}/KBEngine/__init__.pyi`);
      expect(init).not.toContain('import *');
      expect(init).not.toContain('__getattr__');
    }
    const base = read('processes/base/KBEngine/Entity.pyi');
    const cell = read('processes/cell/KBEngine/Entity.pyi');
    const bots = read('processes/bots/KBEngine/Entity.pyi');
    expect(base).toContain('cellData: Dict[str, Any]');
    expect(cell).not.toContain('cellData:');
    expect(bots).not.toContain('cellData:');
    expect(cell).toContain('def navigate(');
    expect(base).not.toContain('def navigate(');
    expect(bots).not.toContain('def navigate(');
  });
});

describe('typings/KBEngine/Proxy.pyi(内部属性注入面)', () => {
  const proxy = read('processes/base/KBEngine/Proxy.pyi');

  it('登录内部属性为只读字符串', () => {
    expect(proxy).toContain('class Proxy(Entity):');
    expect(proxy).toContain('def __ACCOUNT_NAME__(self) -> str:');
    expect(proxy).toContain('def __ACCOUNT_PASSWORD__(self) -> str:');
  });
});

describe('typings/KBEngine/_vectors.pyi(kode 唯一自绘面)', () => {
  it('Vector2/3/4 在案,类型名称有导入且包含构造重载', () => {
    const vectors = read('KBEngine/_vectors.pyi');
    expect(vectors).toContain('class Vector2:');
    expect(vectors).toContain('class Vector3:');
    expect(vectors).toContain('class Vector4:');
    expect(vectors).toContain('from typing import List, Tuple');
    expect(vectors).toContain('def __init__(self) -> None:');
  });
});

describe('typings/ 导入改写净度(派生脚本净度闸)', () => {
  it('全部 .pyi 无未改写的 `from _KBEngine_*` 顶层导入(留了就是断链 import)', () => {
    const violations: string[] = [];
    for (const name of readdirSync(join(TEMPLATE_ROOT, 'processes/base/KBEngine'))) {
      if (!name.endsWith('.pyi')) {
        continue;
      }
      const content = readFileSync(join(TEMPLATE_ROOT, 'processes/base/KBEngine', name), 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        if (/^from _KBEngine_/.test(line)) {
          violations.push(`KBEngine/${name}:${index + 1}: ${line}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
