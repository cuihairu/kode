//! AUDIT-003:引擎 def MD5 核查入口测试——收集面(golden.rs 同布局)、SDK
//! 盖章扫描(js/cs 两盖章形态)、编排对拍三态(match/mismatch/unverifiable,
//! 不猜)、报告渲染与命令接线。Rust 真实 RPC 段仅在 kode-server 二进制在场
//! 时测(skipIf),断言摘要形态与「def 改动即变」。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Uri, type ExtensionContext } from './fake-vscode/core';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { channels, messages, windowState } from './fake-vscode/windowState';
import {
  DEF_MD5_CHANNEL_NAME,
  DEF_MD5_CHECK_COMMAND,
  collectDefMd5Inputs,
  findEngineSdkStamps,
  renderDefMd5CheckReport,
  runDefMd5Check,
  setupDefMd5Check,
  type DefMd5CheckDeps
} from '../src/defMd5Check';
import { computeDefMd5InRust } from '../src/backend/defMd5Rust';
import { negotiateEngineDigest } from '../src/backend/hotReloadDefHash';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// ---------------------------------------------------------------- fixtures

/** MD5 形态常量(32 hex;大小写两个样本) */
const MD5_A = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const MD5_B = '0123456789abcdef0123456789abcdef';

/** 标准 KBEngine 资产树(def 三层 + xml 三件 + 双侧组件脚本 + 场外 def)。 */
const makeAssets = (root: string): void => {
  const scripts = path.join(root, 'scripts');
  const defs = path.join(scripts, 'entity_defs');
  fs.mkdirSync(path.join(defs, 'interfaces'), { recursive: true });
  fs.mkdirSync(path.join(defs, 'components'), { recursive: true });
  fs.mkdirSync(path.join(scripts, 'base', 'components'), { recursive: true });
  fs.mkdirSync(path.join(scripts, 'cell', 'components'), { recursive: true });
  fs.writeFileSync(path.join(defs, 'Avatar.def'), '<root> avatar-def </root>');
  fs.writeFileSync(path.join(defs, 'interfaces', 'IMailbox.def'), '<root> iface-def </root>');
  fs.writeFileSync(path.join(defs, 'components', 'Health.def'), '<root> comp-def </root>');
  fs.writeFileSync(path.join(defs, 'types.xml'), '<root> types </root>');
  fs.writeFileSync(path.join(scripts, 'entities.xml'), '<root><Avatar hasCell="true"/></root>');
  fs.writeFileSync(path.join(defs, 'alias.xml'), '<root> alias </root>');
  fs.writeFileSync(path.join(scripts, 'base', 'components', 'Inventory.py'), '# base comp');
  fs.writeFileSync(path.join(scripts, 'cell', 'components', 'Guard.py'), '# cell comp');
  // 场外 def:引擎喂入序只认 entity_defs 三处,此文件必须被排除
  fs.mkdirSync(path.join(root, 'client_sdk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client_sdk', 'Nested.def'), '<root> outside </root>');
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
};

/**
 * fs 背书依赖:findFiles 按真实目录树跑 glob 家族(与引擎发现链同语义的
 * 最小替身),readText 直读磁盘(deps 覆盖面模拟缓冲区优先),assetsRoot
 * 锁定夹具根。extraFiles 额外声明 SDK 扫描面的命中清单。
 */
const makeDeps = (root: string, overrides: Partial<DefMd5CheckDeps> = {}): DefMd5CheckDeps => {
  const base: DefMd5CheckDeps = {
    findFiles: async (glob: string) => {
      const all = walk(root);
      let matched: string[] = [];
      if (glob === '**/*.def') {
        matched = all.filter((p) => p.endsWith('.def'));
      } else if (glob === '**/base/components/*.py') {
        matched = all.filter((p) => p.includes('/base/components/') && p.endsWith('.py'));
      } else if (glob === '**/cell/components/*.py') {
        matched = all.filter((p) => p.includes('/cell/components/') && p.endsWith('.py'));
      } else if (glob === '**/kbengine.js') {
        matched = all.filter((p) => path.basename(p) === 'kbengine.js');
      } else if (glob === '**/KBEngine.cs') {
        matched = all.filter((p) => path.basename(p) === 'KBEngine.cs');
      }
      return matched.map((p) => Uri.file(p));
    },
    readText: (fsPath: string): string | null => {
      try {
        return fs.readFileSync(fsPath, 'utf-8');
      } catch {
        return null;
      }
    },
    assetsRoot: () => root
  };
  return { ...base, ...overrides };
};

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  globalStorageUri: Uri.file('/tmp/gs')
});

const findChannel = (name: string): { lines: string[] } | undefined =>
  channels.filter((channel) => channel.name === name).at(-1);

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
});

// 通知面走 fire-and-forget promise;每个用例尾部排干微任务。
afterEach(async () => {
  await Promise.resolve();
});

// --------------------------------------------------------- 收集面(golden 同布局)

describe('AUDIT-003:collectDefMd5Inputs(引擎喂入序收集)', () => {
  it('collects the golden-layout inputs: def by dir type, xml triple, both sides of component scripts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-ok-'));
    try {
      makeAssets(root);
      const result = await collectDefMd5Inputs(makeDeps(root));
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') {
        return;
      }
      expect(result.params.defs).toEqual({
        Avatar: '<root> avatar-def </root>',
        IMailbox: '<root> iface-def </root>',
        Health: '<root> comp-def </root>'
      });
      expect(result.params.typesXml).toBe('<root> types </root>');
      expect(result.params.entitiesXml).toBe('<root><Avatar hasCell="true"/></root>');
      expect(result.params.aliasXml).toBe('<root> alias </root>');
      expect(result.params.componentScripts).toEqual(['base:Inventory', 'cell:Guard']);
      expect(result.notes).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('missing feed files enter the stream as empty strings with honest notes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-empty-'));
    try {
      const result = await collectDefMd5Inputs(makeDeps(root));
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') {
        return;
      }
      expect(result.params.typesXml).toBe('');
      expect(result.params.entitiesXml).toBe('');
      expect(result.params.aliasXml).toBe('');
      expect(result.params.defs).toEqual({});
      expect(result.params.componentScripts).toEqual([]);
      expect(result.notes.some((note) => note.includes('entity_defs/types.xml'))).toBe(true);
      expect(result.notes.some((note) => note.includes('scripts/entities.xml'))).toBe(true);
      expect(result.notes.some((note) => note.includes('entity_defs/alias.xml'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('no assets root → unavailable with the honest reason', async () => {
    const deps = makeDeps('/tmp/unused', { assetsRoot: () => '' });
    const result = await collectDefMd5Inputs(deps);
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') {
      return;
    }
    expect(result.reason).toContain('资产根');
  });

  it('def outside the three engine feed dirs is excluded', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-out-'));
    try {
      makeAssets(root);
      const result = await collectDefMd5Inputs(makeDeps(root));
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') {
        return;
      }
      expect(Object.keys(result.params.defs).sort()).toEqual(['Avatar', 'Health', 'IMailbox']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('unreadable def is skipped with a note, not fed as empty silently', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-dead-'));
    try {
      makeAssets(root);
      const avatarPath = path.join(root, 'scripts', 'entity_defs', 'Avatar.def');
      const deps = makeDeps(root, {
        readText: (fsPath: string): string | null => (fsPath === avatarPath ? null : fs.readFileSync(fsPath, 'utf-8'))
      });
      const result = await collectDefMd5Inputs(deps);
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') {
        return;
      }
      expect(result.params.defs.Avatar).toBeUndefined();
      expect(result.notes.some((note) => note.includes('Avatar.def') && note.includes('不可读'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('readText output enters the digest stream verbatim (buffer-first contract)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-buf-'));
    try {
      makeAssets(root);
      const avatarPath = path.join(root, 'scripts', 'entity_defs', 'Avatar.def');
      // 打开缓冲区优先:readSharedFileSnapshot 返回编辑器全文——这里以替身
      // 锁定「readText 说什么,摘要输入就是什么」的契约。
      const deps = makeDeps(root, {
        readText: (fsPath: string): string | null =>
          fsPath === avatarPath ? '<root> unsaved-buffer </root>' : fs.readFileSync(fsPath, 'utf-8')
      });
      const result = await collectDefMd5Inputs(deps);
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') {
        return;
      }
      expect(result.params.defs.Avatar).toBe('<root> unsaved-buffer </root>');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------- SDK 盖章扫描

describe('AUDIT-003:findEngineSdkStamps(js/cs 两盖章面)', () => {
  const stampJs = (stamp: string): string =>
    `var KBEngine = {};\nKBEngine.serverEntityDefMD5 = "${stamp}";\n`;
  const stampCs = (stamp: string): string =>
    `public class KBEngine {\n  public static string serverEntitydefMD5 = "${stamp}";\n}\n`;

  it('finds the js stamp (serverEntityDefMD5) and the unity stamp (serverEntitydefMD5)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-sdk-'));
    try {
      fs.mkdirSync(path.join(root, 'js_sdk'), { recursive: true });
      fs.mkdirSync(path.join(root, 'unity_sdk'), { recursive: true });
      fs.writeFileSync(path.join(root, 'js_sdk', 'kbengine.js'), stampJs(MD5_A));
      fs.writeFileSync(path.join(root, 'unity_sdk', 'KBEngine.cs'), stampCs(MD5_B));
      const notes: string[] = [];
      const stamps = await findEngineSdkStamps(makeDeps(root), notes);
      expect(stamps).toEqual([
        { path: path.join(root, 'js_sdk', 'kbengine.js'), stamp: MD5_A },
        { path: path.join(root, 'unity_sdk', 'KBEngine.cs'), stamp: MD5_B }
      ]);
      expect(notes).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sdk files without a stamp are honestly skipped (no fabrication)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-nostamp-'));
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'kbengine.js'), 'var KBEngine = {};\n');
      const stamps = await findEngineSdkStamps(makeDeps(root));
      expect(stamps).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('per-glob scan is bounded with an honest cap note', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-cap-'));
    try {
      // 上限面针对 findEngineSdkStamps 的切片行为:51 命中 → 只扫前 50 + 备注
      const uris = Array.from({ length: 51 }, (_, i) => Uri.file(`/w/sdk_${String(i).padStart(2, '0')}/kbengine.js`));
      const deps = makeDeps(root, {
        findFiles: async (glob: string) => (glob === '**/kbengine.js' ? uris : []),
        readText: () => stampJs(MD5_A)
      });
      const notes: string[] = [];
      const stamps = await findEngineSdkStamps(deps, notes);
      expect(stamps.length).toBe(50);
      expect(notes.some((note) => note.includes('51') && note.includes('50'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------- 编排对拍三态

describe('AUDIT-003:runDefMd5Check(match/mismatch/unverifiable,不猜)', () => {
  const setupWorkspace = (): { root: string; cleanup: () => void } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-run-'));
    makeAssets(root);
    fs.mkdirSync(path.join(root, 'js_sdk'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'js_sdk', 'kbengine.js'),
      `KBEngine.serverEntityDefMD5 = "${MD5_A}";\n`
    );
    return { root, cleanup: (): void => fs.rmSync(root, { recursive: true, force: true }) };
  };

  it('stamp equals workspace digest → match', async () => {
    const { root, cleanup } = setupWorkspace();
    try {
      const outcome = await runDefMd5Check(makeDeps(root), async () => ({ md5: MD5_A }));
      expect(outcome.unavailableReason).toBeUndefined();
      expect(outcome.workspaceMd5).toBe(MD5_A);
      expect(outcome.stamps).toEqual([
        { path: path.join(root, 'js_sdk', 'kbengine.js'), stamp: MD5_A, verdict: 'match' }
      ]);
    } finally {
      cleanup();
    }
  });

  it('def changed since SDK generation → mismatch with the stamp surfaced', async () => {
    const { root, cleanup } = setupWorkspace();
    try {
      const outcome = await runDefMd5Check(makeDeps(root), async () => ({ md5: MD5_B }));
      expect(outcome.workspaceMd5).toBe(MD5_B);
      expect(outcome.stamps[0]?.verdict).toBe('mismatch');
    } finally {
      cleanup();
    }
  });

  it('rust unavailable → workspace md5 stays unknown, stamps unverifiable (no guess)', async () => {
    const { root, cleanup } = setupWorkspace();
    try {
      const outcome = await runDefMd5Check(makeDeps(root), async () => null);
      expect(outcome.workspaceMd5).toBeNull();
      expect(outcome.stamps[0]?.verdict).toBe('unverifiable');
      // AUDIT-004:Digest 协商退化——unknown/未协商,不猜引擎算法
      expect(outcome.handshake.algorithm).toBe('unknown');
      expect(outcome.handshake.negotiated).toBe(false);
      const report = renderDefMd5CheckReport(outcome);
      expect(report).toContain('工作区闭包 MD5: 未知');
      expect(report).toContain('无法比对');
      expect(report).toContain('Digest 协商: 未协商');
    } finally {
      cleanup();
    }
  });

  it('AUDIT-004: digest handshake negotiated from the rust-recomputed md5', async () => {
    const { root, cleanup } = setupWorkspace();
    try {
      const outcome = await runDefMd5Check(makeDeps(root), async () => ({ md5: MD5_A }));
      expect(outcome.handshake.algorithm).toBe('md5');
      expect(outcome.handshake.negotiated).toBe(true);
      expect(outcome.handshake.digest).toBe(MD5_A);
      const report = renderDefMd5CheckReport(outcome);
      expect(report).toContain(`Digest 协商: md5 已协商(digest=${MD5_A}`);
    } finally {
      cleanup();
    }
  });

  it('no assets root → unavailable reason carried to the outcome', async () => {
    const deps = makeDeps('/tmp/unused', { assetsRoot: () => '' });
    const outcome = await runDefMd5Check(deps, async () => ({ md5: MD5_A }));
    expect(outcome.unavailableReason).toContain('资产根');
    expect(outcome.stamps).toEqual([]);
    expect(renderDefMd5CheckReport(outcome)).toContain('核查未执行');
  });
});

// --------------------------------------------------------- 报告渲染

describe('AUDIT-003:renderDefMd5CheckReport(逐行可断言)', () => {
  it('zero-stamp face renders 未检出 with the engine receipt provenance', () => {
    const report = renderDefMd5CheckReport({
      workspaceMd5: MD5_A,
      handshake: negotiateEngineDigest(MD5_A),
      notes: [],
      stamps: []
    });
    expect(report).toContain('SDK 盖章: 未检出');
    expect(report).toContain('onHelloCB');
    expect(report).toContain(MD5_A);
  });

  it('mismatch face renders the stamp value and the drift explanation', () => {
    const report = renderDefMd5CheckReport({
      workspaceMd5: MD5_B,
      handshake: negotiateEngineDigest(MD5_B),
      notes: ['entity_defs/types.xml: 缺失(以空串入流)'],
      stamps: [{ path: '/w/js_sdk/kbengine.js', stamp: MD5_A, verdict: 'mismatch' }]
    });
    expect(report).toContain('不一致(SDK 盖章 A1B2');
    expect(report).toContain('def 在 SDK 生成后改动过');
    expect(report).toContain('备注: entity_defs/types.xml: 缺失(以空串入流)');
  });
});

// --------------------------------------------------------- 命令接线

describe('AUDIT-003:setupDefMd5Check(命令接线)', () => {
  it('registers the command and renders the report into the def-analysis channel', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-wire-'));
    try {
      makeAssets(root);
      fs.mkdirSync(path.join(root, 'js_sdk'), { recursive: true });
      fs.writeFileSync(path.join(root, 'js_sdk', 'kbengine.js'), `KBEngine.serverEntityDefMD5 = "${MD5_A}";\n`);
      const context = makeContext();
      setupDefMd5Check(context, {
        deps: makeDeps(root),
        compute: async () => ({ md5: MD5_A })
      });
      expect(commandRegistry.registeredCommandIds()).toContain(DEF_MD5_CHECK_COMMAND);
      await commands.executeCommand(DEF_MD5_CHECK_COMMAND);
      const channel = findChannel(DEF_MD5_CHANNEL_NAME);
      expect(channel).toBeDefined();
      expect(channel?.lines.join('')).toContain('引擎 def MD5 一致性核查');
      expect(channel?.lines.join('')).toContain('一致');
      expect(messages.info.some((msg) => msg.includes('1 处 SDK 盖章全部一致'))).toBe(true);
      // 句柄自进 subscriptions
      expect(context.subscriptions.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('mismatch verdict surfaces a warning notification', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-warn-'));
    try {
      makeAssets(root);
      fs.mkdirSync(path.join(root, 'js_sdk'), { recursive: true });
      fs.writeFileSync(path.join(root, 'js_sdk', 'kbengine.js'), `KBEngine.serverEntityDefMD5 = "${MD5_A}";\n`);
      setupDefMd5Check(makeContext(), {
        deps: makeDeps(root),
        compute: async () => ({ md5: MD5_B })
      });
      await commands.executeCommand(DEF_MD5_CHECK_COMMAND);
      expect(messages.warning.some((msg) => msg.includes('1 处 SDK 盖章与工作区闭包不一致'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('unverifiable verdict stays honest in the notification (unknown, not fake-match)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-unk-'));
    try {
      makeAssets(root);
      fs.mkdirSync(path.join(root, 'js_sdk'), { recursive: true });
      fs.writeFileSync(path.join(root, 'js_sdk', 'kbengine.js'), `KBEngine.serverEntityDefMD5 = "${MD5_A}";\n`);
      setupDefMd5Check(makeContext(), {
        deps: makeDeps(root),
        compute: async () => null
      });
      await commands.executeCommand(DEF_MD5_CHECK_COMMAND);
      expect(messages.info.some((msg) => msg.includes('未知') && msg.includes('未与 SDK 盖章比对'))).toBe(true);
      expect(messages.warning).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('unavailable face notifies without a fake verdict', async () => {
    setupDefMd5Check(makeContext(), {
      deps: makeDeps('/tmp/unused', { assetsRoot: () => '' }),
      compute: async () => ({ md5: MD5_A })
    });
    await commands.executeCommand(DEF_MD5_CHECK_COMMAND);
    expect(messages.info.some((msg) => msg.includes('核查未执行') && msg.includes('资产根'))).toBe(true);
  });
});

// ---------------------------------------------- Rust 真实 RPC 段(二进制在场才测)

const KODE_SERVER = path.resolve(__dirname, '..', 'target', 'debug', 'kode-server');

describe('AUDIT-003 Rust 真实 RPC 段(二进制在场才测)', () => {
  const hasBinary = fs.existsSync(KODE_SERVER);

  it.skipIf(!hasBinary)('computeDefMd5InRust round-trips the collected inputs and reacts to def edits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defmd5-rpc-'));
    const gate = new KodeCoreGate({ now: Date.now });
    gate.setConfig({ backend: 'shadow', serverPath: KODE_SERVER, shadowTimeoutMs: 10_000 });
    setKodeCoreShadowGate(gate);
    // 引擎摘要吃解析后的属性结构(非原文自由文本):夹具带一个属性,编辑加
    // 第二个属性——结构变 → 摘必变。
    const AVATAR_BASE = [
      '<root>',
      '  <Properties>',
      '    <level>',
      '      <Type>UINT8</Type>',
      '      <Flags>ALL_CLIENTS</Flags>',
      '    </level>',
      '  </Properties>',
      '</root>',
      ''
    ].join('\n');
    const AVATAR_EDITED = AVATAR_BASE.replace('  </Properties>', '    <hp>\n      <Type>UINT32</Type>\n      <Flags>BASE</Flags>\n    </hp>\n  </Properties>');
    try {
      makeAssets(root);
      const avatarPath = path.join(root, 'scripts', 'entity_defs', 'Avatar.def');
      fs.writeFileSync(avatarPath, AVATAR_BASE);
      const deps = makeDeps(root);
      const collected = await collectDefMd5Inputs(deps);
      expect(collected.kind).toBe('ready');
      if (collected.kind !== 'ready') {
        return;
      }
      const before = await computeDefMd5InRust(collected.params);
      expect(before).not.toBeNull();
      expect(before?.md5).toMatch(/^[0-9a-fA-F]{32}$/);
      expect(before?.algorithm).toBe('md5');

      // def 结构改动(未保存缓冲区同路径:TS 收集原文变化)→ 摘要必变
      fs.writeFileSync(avatarPath, AVATAR_EDITED);
      const edited = await collectDefMd5Inputs(deps);
      if (edited.kind !== 'ready') {
        return;
      }
      const after = await computeDefMd5InRust(edited.params);
      expect(after?.md5).toMatch(/^[0-9a-fA-F]{32}$/);
      expect(after?.md5).not.toBe(before?.md5);
    } finally {
      setKodeCoreShadowGate(null);
      gate.setConfig({ backend: 'shadow', serverPath: '', shadowTimeoutMs: 2000 }); // 停 Rust 子进程
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
