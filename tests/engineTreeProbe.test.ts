import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENGINE_TREE_MARKER,
  ENGINE_TREE_REASON,
  ENGINE_TREE_ROOT,
  detectEngineTree,
  describeWithEngineTree
} from './helpers/engineTree';

// V-07·a(C-8):探测与 skipIf 机制本身不依赖真树,全部走 fixture + 注入,
// 所以这两组用例会常驻门禁;真树断言挂在 describeWithEngineTree 下,
// 无树环境(CI 默认)整套 skip 且原因出现在套件标题里。

let treeFixture = '';

beforeAll(() => {
  treeFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-enginetree-'));
  fs.mkdirSync(path.join(treeFixture, 'kbe/src/lib/common'), { recursive: true });
  fs.writeFileSync(path.join(treeFixture, 'kbe/src/lib/common/version.h'), '#define KBE_VERSION "2.5.10"\n');
});

afterAll(() => {
  fs.rmSync(treeFixture, { recursive: true, force: true });
});

describe('engine tree probe', () => {
  it('uses KBENGINE_ROOT when the marker file exists', () => {
    const probe = detectEngineTree({ env: { KBENGINE_ROOT: treeFixture } });
    expect(probe.root).toBe(treeFixture);
    expect(probe.reason).toBe('');
  });

  it('rejects a KBENGINE_ROOT without the marker and names the bad path', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-enginetree-empty-'));
    try {
      const probe = detectEngineTree({ env: { KBENGINE_ROOT: emptyDir } });
      expect(probe.root).toBeNull();
      expect(probe.reason).toContain(`KBENGINE_ROOT=${emptyDir}`);
      expect(probe.reason).toContain(ENGINE_TREE_MARKER);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('honours KBENGINE_ROOT=off as an explicit opt-out', () => {
    const probe = detectEngineTree({ env: { KBENGINE_ROOT: 'off' }, startDirectory: treeFixture });
    expect(probe.root).toBeNull();
    expect(probe.reason).toContain('KBENGINE_ROOT=off');
  });

  it('falls back to the ../kbengine sibling of the start directory', () => {
    const sibling = path.resolve('/repo/proj', '..', 'kbengine');
    const marker = path.join(sibling, 'kbe/src/lib/common/version.h');
    const probe = detectEngineTree({
      env: {},
      startDirectory: '/repo/proj',
      existsSync: candidate => candidate === marker
    });
    expect(probe.root).toBe(sibling);
    expect(probe.reason).toBe('');
  });

  it('reports null with a visible hint instead of inventing a root', () => {
    const probe = detectEngineTree({ env: {}, startDirectory: '/nowhere', existsSync: () => false });
    expect(probe.root).toBeNull();
    expect(probe.reason).toContain('KBENGINE_ROOT');
    expect(probe.reason).toContain('../kbengine');
  });
});

describe('engine tree process probe (this environment)', () => {
  it('keeps root and reason mutually exclusive', () => {
    if (ENGINE_TREE_ROOT === null) {
      // KBENGINE_ROOT 指向真目录但标记文件缺席时,reason 报的是缺哪个标记
      // (如 'KBENGINE_ROOT=... has no kbe/src/lib/common/version.h'),不是笼统
      // 'no engine tree';此处只锁不变量:root 为 null 时 reason 必须是可见提示
      expect(ENGINE_TREE_REASON.length).toBeGreaterThan(0);
    } else {
      expect(path.isAbsolute(ENGINE_TREE_ROOT)).toBe(true);
      expect(ENGINE_TREE_REASON).toBe('');
    }
  });
});

describeWithEngineTree('engine tree sanity (real tree)', () => {
  it('reads the version macro from the marker file, no fabrication', () => {
    const root = ENGINE_TREE_ROOT as string;
    const source = fs.readFileSync(path.join(root, 'kbe/src/lib/common/version.h'), 'utf8');
    const match = source.match(/^#define\s+KBE_VERSION\s+"([^"]+)"/m);
    expect(match?.[1]).toEqual(expect.any(String));
  });
});
