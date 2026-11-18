// 活动 profile 引擎根自动补录契约(2026-11-18 用户亲报 P0:
// 「kode 扫描之后提示缺引擎 未记录引擎根」)。四钉子:
// ①assetsRoot 上层有引擎 marker → 自动补录并持久化(resolveActiveProfile 读到新值)
// ②无 marker → 保持空 + 仍报 engine-missing(不伪造路径)
// ③已记录非空 → 不重探(幂等,探测面零调用)
// ④显式 kbengine.engineRoot 优先于自动探测(显式 > 自动,不覆盖用户手填)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ACTIVE_PROFILE_STATE_KEY, setActiveProfile } from '../src/activeProfile';
import { ensureActiveProfileEngineRoot } from '../src/engineRootAutoFill';
import { collectProfileHealth } from '../src/profileHealth';
import { ProjectProfileStore } from '../src/projectProfiles';
import type { PythonServiceFacts } from '../src/pythonLanguageServiceStatus';

// 内存 Memento 替身(与 ensureDefaultProfile.test.ts 同形)
class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }

  setKeysForSync(_keys: readonly string[]): void {
    /* 内存替身不参与云同步 */
  }
}

/** 建一棵工作区:assetsRoot 在其下,引擎树(marker)落在上层或指定层 */
function makeTree(withMarker: boolean): { base: string; assetsRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engineroof-autofill-'));
  const assetsRoot = path.join(base, 'proj');
  fs.mkdirSync(assetsRoot, { recursive: true });
  if (withMarker) {
    const markerDir = path.join(base, 'kbe', 'src', 'lib', 'common');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, 'kbeversion.h'),
      '#define KBE_VERSION_MAJOR 2\n#define KBE_VERSION_MINOR 5\n#define KBE_VERSION_PATCH 10\n',
      'utf8'
    );
  }
  return { base, assetsRoot };
}

async function seedProfile(
  memento: vscode.Memento,
  assetsRoot: string,
  engineRoot: string
): Promise<string> {
  const profile = await new ProjectProfileStore(memento).create({
    displayName: 'proj',
    assetsRoot,
    engineRoot,
    interpreterPath: null,
    interpreterSource: 'missing'
  });
  await setActiveProfile(memento, profile.id);
  return profile.id;
}

const trees: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of trees) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('活动 profile 引擎根自动补录(故障 A)', () => {
  it('① assetsRoot 上层有引擎 marker → 自动补录并持久化', async () => {
    const { base, assetsRoot } = makeTree(true);
    trees.push(base);
    const memento = new MemoryMemento();
    await seedProfile(memento, assetsRoot, '');
    const result = await ensureActiveProfileEngineRoot(memento, {
      probeWithSiblingsFn: () => base
    });
    expect(result.recorded).toBe(base);
    expect(result.stillMissing).toBe(false);
    // 持久化落地:活动 profile 快照读到新引擎根(profileHealth 的 engine-missing 自然消失)
    const persisted = new ProjectProfileStore(memento).get(
      memento.get<string>(ACTIVE_PROFILE_STATE_KEY)!
    );
    expect(persisted?.engineRoot).toBe(base);
  });

  it('② 无 marker → 保持空 + 仍报 engine-missing(不伪造路径)', async () => {
    const { base, assetsRoot } = makeTree(false);
    trees.push(base);
    const memento = new MemoryMemento();
    const id = await seedProfile(memento, assetsRoot, '');
    const result = await ensureActiveProfileEngineRoot(memento);
    expect(result.recorded).toBeNull();
    expect(result.stillMissing).toBe(true);
    const after = new ProjectProfileStore(memento).get(id)!;
    expect(after.engineRoot).toBe('');
    const issues = collectProfileHealth(after, {} as PythonServiceFacts, { exists: () => true });
    expect(issues.some(issue => issue.kind === 'engine-missing')).toBe(true);
  });

  it('③ 已记录非空 → 不重探(幂等,不覆盖用户手填)', async () => {
    const { assetsRoot } = makeTree(true);
    const memento = new MemoryMemento();
    await seedProfile(memento, assetsRoot, '/user/filled/engine');
    const probe = vi.fn().mockReturnValue('/user/filled/engine');
    const result = await ensureActiveProfileEngineRoot(memento, { probeWithSiblingsFn: probe });
    expect(probe, '已记录时不探测').not.toHaveBeenCalled();
    expect(result.recorded).toBeNull();
    expect(result.stillMissing).toBe(false);
  });

  it('④ 显式 kbengine.engineRoot 优先于自动探测', async () => {
    const { base, assetsRoot } = makeTree(true);
    trees.push(base);
    const memento = new MemoryMemento();
    await seedProfile(memento, assetsRoot, '');
    const explicit = path.join(base, 'kbe');
    const probe = vi.fn().mockReturnValue(explicit);
    const result = await ensureActiveProfileEngineRoot(memento, {
      probeWithSiblingsFn: probe,
      explicitEngineRoot: () => explicit
    });
    expect(probe).toHaveBeenCalledWith(assetsRoot, explicit);
    expect(result.recorded).toBe(explicit);
  });

  it('⑤ 兄弟目录布局:assets 同级 kbengine* 引擎仓(marker 命中)→ 自动补录', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engineroof-sibling-'));
    trees.push(base);
    const assetsRoot = path.join(base, 'assets');
    fs.mkdirSync(assetsRoot, { recursive: true });
    // 兄弟引擎仓:目录名含 kbengine(marker 落在仓内 kbe/src/lib/common)
    const engineRoot = path.join(base, 'kbengine');
    const markerDir = path.join(engineRoot, 'kbe', 'src', 'lib', 'common');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, 'kbeversion.h'),
      '#define KBE_VERSION_MAJOR 2\n#define KBE_VERSION_MINOR 5\n#define KBE_VERSION_PATCH 10\n',
      'utf8'
    );
    const memento = new MemoryMemento();
    await seedProfile(memento, assetsRoot, '');
    const result = await ensureActiveProfileEngineRoot(memento);
    expect(result.recorded).toBe(engineRoot);
    expect(result.stillMissing).toBe(false);
    const persisted = new ProjectProfileStore(memento).get(
      memento.get<string>(ACTIVE_PROFILE_STATE_KEY)!
    );
    expect(persisted?.engineRoot).toBe(engineRoot);
  });

  it('⑥ 兄弟目录无 marker / 目录名不含 kbengine → 不误认,如实缺', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engineroof-sibneg-'));
    trees.push(base);
    const assetsRoot = path.join(base, 'assets');
    fs.mkdirSync(assetsRoot, { recursive: true });
    // 同级有随机名目录(无 marker)与 marker 目录但名不含 kbengine —— 都不是候选
    const plain = path.join(base, 'neighbor');
    fs.mkdirSync(plain, { recursive: true });
    const markerDir = path.join(base, 'engine-src', 'kbe', 'src', 'lib', 'common');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'kbeversion.h'), '#define KBE_VERSION_MAJOR 2\n', 'utf8');
    const memento = new MemoryMemento();
    const id = await seedProfile(memento, assetsRoot, '');
    const result = await ensureActiveProfileEngineRoot(memento);
    expect(result.recorded).toBeNull();
    expect(result.stillMissing).toBe(true);
    expect(new ProjectProfileStore(memento).get(id)!.engineRoot).toBe('');
  });

  it('无活动 profile / 无 assetsRoot → 如实缺,零写入', async () => {
    const memento = new MemoryMemento();
    const empty = await ensureActiveProfileEngineRoot(memento);
    expect(empty).toEqual({ stillMissing: true, recorded: null });

    const { assetsRoot } = makeTree(true);
    const m2 = new MemoryMemento();
    await seedProfile(m2, assetsRoot, '');
    const probe = vi.fn().mockReturnValue('/x');
    const id = new ProjectProfileStore(m2).get(m2.get<string>(ACTIVE_PROFILE_STATE_KEY)!)!.id;
    await new ProjectProfileStore(m2).saveRoots(id, { assetsRoot: '' });
    const result = await ensureActiveProfileEngineRoot(m2, { probeWithSiblingsFn: probe });
    expect(probe, '空基底不探(会以 cwd 误探)').not.toHaveBeenCalled();
    expect(result).toEqual({ stillMissing: true, recorded: null });
  });
});