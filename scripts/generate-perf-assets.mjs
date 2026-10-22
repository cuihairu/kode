#!/usr/bin/env node
// PR1 性能基线测试资产集生成器(docs/review/2026-10-22 §2.3)。
//
// 用法:
//   node scripts/generate-perf-assets.mjs [--out DIR] [--large-files N] [--keep]
//
// 场景(与评审基线矩阵一一对应):
//   small        小型项目:行为正确性口径
//   large        数万级源文件模拟(.py,默认 30000,--large-files 可调)
//   multi-root   三个互相独立的资产根,含同名实体(Avatar)与同名 Python 类(Inventory)
//   big-py       单个超大 Python 文件(局部变量推导/Definition 压力)
//   def-heavy    大量 .def + entities.xml/types.xml/alias.xml
//   noise        含 .git/build/third_party 噪声目录(排除式扫描口径)
//
// 输出为确定性内容(无随机),同参数重复生成结果一致;默认打印每个场景
// 的文件计数摘要。目录已存在时先删除重建,保证可重复。

import { cpus } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const flagOn = name => args.includes(name);

const outRoot = path.resolve(argValue('--out', '.perf-assets'));
const largeFileCount = Number(argValue('--large-files', '30000'));
const keepExisting = flagOn('--keep');

const PY_SCAN_EXCLUDED_DIRS = new Set(['.git', 'build', 'third_party', '__pycache__']);

function writeFileSyncp(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function rmdirForceSafe(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function countFiles(root) {
  let count = 0;
  const walk = dir => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(root);
  return count;
}

/** KBEngine 资产树骨架:scripts/{entity_defs,base,cell} + entities/types/alias.xml */
function scaffoldAssetRoot(root, { entity = 'Avatar' } = {}) {
  const scripts = path.join(root, 'scripts');
  writeFileSyncp(path.join(scripts, 'entities.xml'),
    `<root>\n  <${entity} config="kbengine_${entity.toLowerCase()}_defaults"/>\n</root>\n`);
  writeFileSyncp(path.join(scripts, 'types.xml'),
    '<root>\n  <JSONDATA type="UINT32"/>\n</root>\n');
  writeFileSyncp(path.join(root, 'scripts', 'entity_defs', 'alias.xml'),
    '<root>\n  <BOOL_LIST type="ARRAY" of="BOOL"/>\n</root>\n');
}

function defContent(entity, methodCount) {
  const methods = [];
  for (let i = 0; i < methodCount; i += 1) {
    methods.push(`    <onRpc${i} args="UInt32"/>`);
  }
  return `<root>\n  <Properties>\n    <hp type="UINT32" flags="BASE"/>\n  </Properties>\n`
    + `  <BaseMethods>\n${methods.join('\n')}\n  </BaseMethods>\n</root>\n`;
}

function pyModuleContent(name, classCount = 1, methodCount = 4) {
  const classes = [];
  for (let c = 0; c < classCount; c += 1) {
    const methods = [];
    for (let m = 0; m < methodCount; m += 1) {
      methods.push(`    def method_${m}(self):\n        return ${m}\n`);
    }
    classes.push(`class ${name}_${c}:\n${methods.join('')}`);
  }
  return classes.join('\n') + '\n';
}

const scenarios = {
  small(root) {
    scaffoldAssetRoot(root);
    writeFileSyncp(path.join(root, 'scripts/entity_defs/Avatar.def'), defContent('Avatar', 3));
    writeFileSyncp(path.join(root, 'scripts/entity_defs/Monster.def'), defContent('Monster', 2));
    writeFileSyncp(path.join(root, 'scripts/base/Avatar.py'),
      'class Avatar:\n    def onTimer(self):\n        return 0\n');
    writeFileSyncp(path.join(root, 'scripts/cell/Monster.py'),
      'class Monster:\n    def patrol(self):\n        return 1\n');
  },

  large(root) {
    scaffoldAssetRoot(root);
    writeFileSyncp(path.join(root, 'scripts/entity_defs/Avatar.def'), defContent('Avatar', 4));
    writeFileSyncp(path.join(root, 'scripts/base/Avatar.py'),
      'class Avatar:\n    def onEnterWorld(self):\n        return 0\n');
    // 数万级模拟:每模块 1 类 2 方法的小文件,目录分层避免单目录过深列表
    for (let i = 0; i < largeFileCount; i += 1) {
      const shard = `m${Math.floor(i / 500)}`;
      writeFileSyncp(
        path.join(root, 'scripts/base/gen', shard, `Gen${i}.py`),
        pyModuleContent(`Gen${i}`, 1, 2)
      );
    }
  },

  'multi-root'(root) {
    // 三个独立资产根:同名实体 Avatar、同名类 Inventory,各根内容可区分
    for (const name of ['root_a', 'root_b', 'root_c']) {
      const sub = path.join(root, name);
      scaffoldAssetRoot(sub);
      writeFileSyncp(path.join(sub, 'scripts/entity_defs/Avatar.def'), defContent(`Avatar_${name}`, 2));
      writeFileSyncp(path.join(sub, 'scripts/base/Avatar.py'),
        `class Avatar:\n    def home_of(self):\n        return '${name}'\n`
        + `class Inventory:\n    def size(self):\n        return 1\n`);
      writeFileSyncp(path.join(sub, 'scripts/cell/Inventory.py'),
        `class Inventory:\n    def clear(self):\n        return '${name}'\n`);
    }
  },

  'big-py'(root) {
    scaffoldAssetRoot(root);
    writeFileSyncp(path.join(root, 'scripts/entity_defs/BigEntity.def'), defContent('BigEntity', 8));
    // 超大单文件:8000 个赋值 + 8000 个方法(局部变量上行推导最坏路径)
    const lines = ['class BigEntity:'];
    for (let i = 0; i < 8000; i += 1) {
      lines.push(`    def handler_${i}(self, arg):`);
      lines.push(`        data_${i} = loader.fetch(${i})`);
      lines.push(`        return data_${i}`);
    }
    writeFileSyncp(path.join(root, 'scripts/cell/BigEntity.py'), lines.join('\n') + '\n');
  },

  'def-heavy'(root) {
    scaffoldAssetRoot(root);
    // 1200 个 .def + 40 组 entities/types/alias 变体目录
    for (let i = 0; i < 1200; i += 1) {
      writeFileSyncp(
        path.join(root, 'scripts/entity_defs', `Unit${i}.def`),
        defContent(`Unit${i}`, 6)
      );
    }
    for (let i = 0; i < 40; i += 1) {
      const sub = path.join(root, 'scripts', `space${i}`);
      writeFileSyncp(path.join(sub, 'entities.xml'), `<root><Unit${i}/></root>\n`);
      writeFileSyncp(path.join(sub, 'types.xml'),
        `<root><TYPE_${i} type="UINT64"/></root>\n`);
      writeFileSyncp(path.join(sub, 'entity_defs', 'alias.xml'),
        `<root><ALIAS_${i} type="ARRAY" of="UINT8"/></root>\n`);
    }
  },

  noise(root) {
    scaffoldAssetRoot(root);
    writeFileSyncp(path.join(root, 'scripts/entity_defs/Avatar.def'), defContent('Avatar', 2));
    writeFileSyncp(path.join(root, 'scripts/base/Avatar.py'),
      'class Avatar:\n    def hello(self):\n        return 0\n');
    // 排除式扫描口径:这些目录必须被 PY_SCAN_EXCLUDE 排除,不进索引
    writeFileSyncp(path.join(root, '.git/objects/pack', 'pack.idx'), 'binary-ish\n');
    for (let i = 0; i < 200; i += 1) {
      writeFileSyncp(path.join(root, 'build/obj', `Obj${i}.py`), pyModuleContent(`Obj${i}`, 1, 2));
      writeFileSyncp(path.join(root, 'third_party/lib', `Lib${i}.py`), pyModuleContent(`Lib${i}`, 1, 2));
    }
  }
};

const parent = outRoot;
if (!keepExisting) {
  rmdirForceSafe(parent);
}
fs.mkdirSync(parent, { recursive: true });

for (const [name, build] of Object.entries(scenarios)) {
  const target = path.join(parent, name);
  if (fs.existsSync(target)) {
    rmdirForceSafe(target);
  }
  build(target);
  console.log(`${name.padEnd(10)} ${String(countFiles(target)).padStart(7)} files -> ${target}`);
}
console.log(`cpus=${cpus().length} largeFiles=${largeFileCount}`);
