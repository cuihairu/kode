import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadDemoGameTemplateEntries } from '../src/demoGameTemplate';
import { planProjectCreation } from '../src/backend/projectTemplate';
import { identifyProjectLayout } from '../src/projectImport';

// DEMO-GAME-006:demo 游戏模板载荷契约。模板是夹具
// tests/fixtures/kbengine-demo-assets 的游戏子集逐字节拷贝(单一真源是
// 夹具,模板不自行演化),只有 scripts/entities.xml 裁剪掉 Training/Elite
// 导航测试实体注册。两侧漂移(夹具改了模板没跟,或模板被手改)都在这里红。

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates', 'demo-game');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'kbengine-demo-assets');

const loadTemplateFiles = (): Map<string, string> =>
  new Map(
    loadDemoGameTemplateEntries(TEMPLATE_ROOT)
      .filter((entry): entry is Extract<typeof entry, { kind: 'file' }> => entry.kind === 'file')
      .map(entry => [entry.relativePath, entry.content])
  );

describe('demo game template loader (DEMO-GAME-006)', () => {
  it('reads the real template dir into deterministic entries (directories parents-first, unique paths)', () => {
    const entries = loadDemoGameTemplateEntries(TEMPLATE_ROOT);
    expect(entries.length).toBeGreaterThan(80);
    const relatives = entries.map(entry => entry.relativePath);
    // 相对路径唯一;目录条目父先于子(落盘侧 mkdir 依赖此序,与最小清单同性质)
    expect(new Set(relatives).size).toBe(relatives.length);
    for (const relative of relatives) {
      const parentDir = path.posix.dirname(relative);
      if (parentDir !== '.') {
        expect(relatives.indexOf(parentDir)).toBeLessThan(relatives.indexOf(relative));
      }
    }
    // 两种条目都在场;文件内容非空
    const files = entries.filter(entry => entry.kind === 'file');
    expect(entries.length - files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(file.content.length).toBeGreaterThan(0);
    }
  });

  it('carries the full game surface: world/combat/bots faces and engine entry dirs', () => {
    const relatives = [...loadTemplateFiles().keys()];
    const mustHave = [
      'scripts/entities.xml',
      'scripts/entity_defs/Account.def',
      'scripts/entity_defs/Avatar.def',
      'scripts/entity_defs/Monster.def',
      'scripts/entity_defs/Space.def',
      'scripts/entity_defs/Spaces.def',
      'scripts/entity_defs/types.xml',
      'scripts/entity_defs/components/Inventory.def',
      'scripts/entity_defs/interfaces/ROLE.def',
      'scripts/base/Account.py',
      'scripts/base/Avatar.py',
      'scripts/cell/Avatar.py',
      'scripts/cell/Monster.py',
      'scripts/cell/Space.py',
      'scripts/cell/monster_ai.py',
      'scripts/bots/Account.py',
      'scripts/bots/Avatar.py',
      'scripts/client/Avatar.py',
      'scripts/common/DemoConsts.py',
      'scripts/common/KBEDebug.py',
      'scripts/user_type/POSITION_DATA.py',
      'scripts/user_type/SKILL_SLOT_DATA.py',
      'res/server/kbengine.xml',
      'res/server/server_errors.xml',
      'start_server.sh',
      'start_bots.sh'
    ];
    for (const key of mustHave) {
      expect(relatives).toContain(key);
    }
  });

  it('excludes the navigation-test assets: Training/Elite entities, training mixins, test harness', () => {
    const relatives = [...loadTemplateFiles().keys()];
    const banned = ['Training', 'Elite', 'common/training/', 'navigation-cases', 'play_demo', 'README', '.vscode/'];
    for (const marker of banned) {
      expect(relatives.some(p => p.includes(marker)), `template must not carry ${marker}`).toBe(false);
    }
  });

  it('entities.xml registers exactly the five game entities (trimmed registry)', () => {
    const entitiesXml = loadTemplateFiles().get('scripts/entities.xml') ?? '';
    for (const entity of ['Account', 'Spaces', 'Space', 'Avatar', 'Monster']) {
      expect(entitiesXml).toMatch(new RegExp(`<${entity}[\\s>]`));
    }
    expect(entitiesXml).not.toMatch(/Training|Elite/);
  });
});

describe('demo game template parity with the fixture (DEMO-GAME-006)', () => {
  it('every template file is byte-identical to its fixture counterpart (except trimmed entities.xml)', () => {
    for (const [relativePath, content] of loadTemplateFiles()) {
      if (relativePath === 'scripts/entities.xml') {
        continue;
      }
      const fixtureBytes = fs.readFileSync(path.join(FIXTURE_ROOT, relativePath));
      expect(content, `${relativePath} must stay byte-identical to the fixture`).toBe(
        fixtureBytes.toString('utf8')
      );
    }
  });

  it('the fixture game subset has no file missing from the template (exclusion ledger)', () => {
    // 排除账本:导航测试资产(Training/Elite 实体与 mixin、navigation-cases、
    // play_demo、README)与 .vscode 工程设置(脚手架不写它,避免与既有
    // settings.json 冲突)。除账本外,夹具文件必须在模板里有同名拷贝。
    const excluded = (relativePath: string): boolean =>
      relativePath === 'README.md' ||
      relativePath === 'navigation-cases.json' ||
      relativePath === 'play_demo.py' ||
      relativePath === 'scripts/entity_defs/Critical.def' ||
      relativePath === 'scripts/entity_defs/interfaces/TRAINING_ACTOR.def' ||
      relativePath.startsWith('.vscode/') ||
      relativePath.includes('Training') ||
      relativePath.includes('Elite') ||
      relativePath.startsWith('scripts/common/training/');
    const templateFiles = loadTemplateFiles();
    const walk = (dirPath: string, relativeDir: string): void => {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path.join(dirPath, entry.name), relativePath);
        } else if (!excluded(relativePath)) {
          expect(templateFiles.has(relativePath), `fixture file missing from template: ${relativePath}`).toBe(true);
        }
      }
    };
    walk(FIXTURE_ROOT, '');
  });
});

describe('demo game template plan integration (DEMO-GAME-006)', () => {
  it('plans exact absolute paths and surfaces conflicts on existing files', () => {
    const entries = loadDemoGameTemplateEntries(TEMPLATE_ROOT);
    const plan = planProjectCreation(
      '/ws/occupied',
      { exists: candidate => candidate === '/ws/occupied/scripts/entities.xml' },
      entries
    );
    expect(plan.entries).toHaveLength(entries.length);
    expect(plan.conflicts.map(conflict => conflict.absolutePath)).toEqual(['/ws/occupied/scripts/entities.xml']);
  });

  it('a materialized demo template is recognized by identifyProjectLayout on all three asset faces', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-demo-template-'));
    try {
      for (const entry of loadDemoGameTemplateEntries(TEMPLATE_ROOT)) {
        if (entry.kind !== 'file') {
          continue;
        }
        const target = path.join(base, entry.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.content, 'utf8');
      }
      const identification = identifyProjectLayout(base);
      expect(identification.entitiesXml).toBe(path.join(base, 'scripts', 'entities.xml'));
      expect(identification.entityDefsRoot).toBe(path.join(base, 'scripts', 'entity_defs'));
      expect(identification.scriptsRoot).toBe(path.join(base, 'scripts'));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
