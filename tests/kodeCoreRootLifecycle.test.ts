import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreGate } from '../src/backend/kodeCoreGate';

// RUST-069-W 装配验收(真 kode-server 二进制):根生命周期生产接线——
// 新增同名实体根仍隔离 / 移除根清镜像+候选且回执记账 / 保留根仍可查 /
// 重新添加取得新身份且旧化身不复活。session 库单测与 handle_message 装配
// 测试(crates/kode-server/tests/root_lifecycle.rs)之外,这里锁真实进程
// 链路(gate → stdio client → Rust server)。二进制缺失现场 cargo build;
// 无 Rust 工具链的环境跳过本套件(单测基线不背工具链依赖)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');

if (!existsSync(binaryPath)) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, timeout: 300_000 });
}
const binaryReady = existsSync(binaryPath);

const suite = binaryReady ? describe : describe.skip;

const ROOT_A = '/ws-root/a';
const ROOT_B = '/ws-root/b';
const DEF_A = `file://${ROOT_A}/scripts/entity_defs/Avatar.def`;
const ENTITIES_A = `file://${ROOT_A}/scripts/entities.xml`;
const DEF_B = `file://${ROOT_B}/scripts/entity_defs/Avatar.def`;
const ENTITIES_B = `file://${ROOT_B}/scripts/entities.xml`;

function avatarDef(prop: 'hp' | 'mp'): string {
  return `<root>\n\t<Properties>\n\t\t<${prop}>\n\t\t\t<Type> UINT32 </Type>\n\t\t</${prop}>\n\t</Properties>\n</root>\n`;
}

interface DefinitionResult {
  uri?: string;
}

interface HoverResult {
  contents?: { value?: string };
}

interface RootsResult {
  roots?: Array<[number, string]>;
}

suite('kode core 根生命周期(真实 kode-server 二进制,RUST-069-W)', () => {
  const gates: KodeCoreGate[] = [];
  afterAll(async () => {
    for (const gate of gates) {
      await gate.dispose().catch(() => undefined);
    }
  });

  function makeGate(): KodeCoreGate {
    const gate = new KodeCoreGate();
    gate.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 2000 });
    gate.setInitializeParams({
      processId: process.pid,
      capabilities: {},
      workspaceFolders: [{ uri: `file://${ROOT_A}`, name: 'a' }],
    });
    gates.push(gate);
    return gate;
  }

  const definitionParams = (uri: string): unknown => ({
    textDocument: { uri },
    position: { line: 1, character: 3 },
  });

  it('新增同名实体根仍隔离;移除清镜像+候选;保留根仍可查;重加取得新身份', async () => {
    const gate = makeGate();
    // workspace folder A 经握手注册;B 运行期新增(rootAdded 生产面)
    const added = await gate.registerRoot(ROOT_B);
    expect(added, 'rootAdded 回执带根身份').not.toBeNull();
    const rootB = (added as { root: number }).root;
    expect(rootB).toBeGreaterThan(0);

    // 两根同名实体各一份(A=hp 属性,B=mp 属性),经镜像腿入库
    await gate.mirrorDocument(DEF_A, 'kbengine-def', 1, avatarDef('hp'));
    await gate.mirrorDocument(DEF_B, 'kbengine-def', 1, avatarDef('mp'));
    await gate.mirrorDocument(ENTITIES_A, 'xml', 1, '<root>\n  <Avatar/>\n</root>\n');
    await gate.mirrorDocument(ENTITIES_B, 'xml', 1, '<root>\n  <Avatar/>\n</root>\n');

    // 同名隔离:B 查询落 B 根候选,A 查询落 A 根候选(真实进程 root_for 链路)
    const defB = (await gate.serveInRust<DefinitionResult | null>(
      'textDocument/definition',
      definitionParams(ENTITIES_B),
      null,
      { timeoutMs: 10_000 }
    )) as DefinitionResult | null;
    expect(defB?.uri).toBe(`${ROOT_B}/scripts/entity_defs/Avatar.def`);
    const defA = (await gate.serveInRust<DefinitionResult | null>(
      'textDocument/definition',
      definitionParams(ENTITIES_A),
      null,
      { timeoutMs: 10_000 }
    )) as DefinitionResult | null;
    expect(defA?.uri).toBe(`${ROOT_A}/scripts/entity_defs/Avatar.def`);

    // 移除 B:回执 removed:true;被撤根查询回 null(镜像/候选已扇出清理);
    // 保留根 A 仍可查。
    const removal = await gate.removeRoot(ROOT_B);
    expect(removal?.removed, 'rootRemoved 回执 removed:true').toBe(true);
    const invalidated = (removal as { invalidated?: Array<[string, number]> }).invalidated ?? [];
    expect(
      invalidated.map(([sink]) => sink),
      '回执按登记序列消费面(镜像仓库→hover 引擎)'
    ).toEqual(['document-store', 'hover-engine']);
    expect(invalidated.every(([, cleared]) => cleared >= 1), '每个消费面都清到条目').toBe(true);
    const defAfterRemoval = (await gate.serveInRust<DefinitionResult | null>(
      'textDocument/definition',
      definitionParams(ENTITIES_B),
      null,
      { timeoutMs: 10_000 }
    )) as DefinitionResult | null;
    expect(defAfterRemoval, '被撤根查询回 null').toBeNull();
    const defARetained = (await gate.serveInRust<DefinitionResult | null>(
      'textDocument/definition',
      definitionParams(ENTITIES_A),
      null,
      { timeoutMs: 10_000 }
    )) as DefinitionResult | null;
    expect(defARetained?.uri, '保留根仍可查').toBe(`${ROOT_A}/scripts/entity_defs/Avatar.def`);

    // 重新添加:新身份(id 永不复用);旧化身候选不复活(entities 重开、
    // def 未重开 → null);新化身 fresh 内容(mp)入库后查询恢复。
    const addedAgain = await gate.registerRoot(ROOT_B);
    expect(addedAgain).not.toBeNull();
    const rootB2 = (addedAgain as { root: number }).root;
    expect(rootB2, '重新添加取得新身份').not.toBe(rootB);
    await gate.mirrorDocument(ENTITIES_B, 'xml', 1, '<root>\n  <Avatar/>\n</root>\n');
    const stale = (await gate.serveInRust<DefinitionResult | null>(
      'textDocument/definition',
      definitionParams(ENTITIES_B),
      null,
      { timeoutMs: 10_000 }
    )) as DefinitionResult | null;
    expect(stale, '旧化身候选不得复活').toBeNull();
    await gate.mirrorDocument(DEF_B, 'kbengine-def', 1, avatarDef('mp'));
    const revived = (await gate.serveInRust<DefinitionResult | null>(
      'textDocument/definition',
      definitionParams(ENTITIES_B),
      null,
      { timeoutMs: 10_000 }
    )) as DefinitionResult | null;
    expect(revived?.uri, '新化身 fresh 入库后查询恢复').toBe(
      `${ROOT_B}/scripts/entity_defs/Avatar.def`
    );
    const hover = (await gate.serveInRust<HoverResult | null>(
      'textDocument/hover',
      {
        textDocument: { uri: DEF_B },
        // 属性标签位(mp 行)才有 hover 面;容器/缩进位恒 null(实测)。
        position: { line: 2, character: 3 },
      },
      null,
      { timeoutMs: 10_000 }
    )) as HoverResult | null;
    expect(hover?.contents?.value ?? '', '新化身内容为 mp(非旧化身 hp)').toContain('mp');

    // 注册表对账面:roots 列表含两根,B 是新化身 id。
    const roots = (await gate.serveInRust<RootsResult>(
      '$/kode/workspace/roots',
      {},
      { roots: [] },
      { timeoutMs: 10_000 }
    )) as RootsResult;
    const paths = (roots.roots ?? []).map(([, path]) => path);
    expect(paths).toContain(ROOT_A);
    expect(paths).toContain(ROOT_B);
    const rootBEntry = (roots.roots ?? []).find(([, path]) => path === ROOT_B);
    expect(rootBEntry?.[0], '注册表 B 根为新化身 id').toBe(rootB2);
    await gate.dispose();
  });
});
