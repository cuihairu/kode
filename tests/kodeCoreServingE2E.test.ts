import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/kodeCoreClient';
import { KodeCoreGate } from '../src/kodeCoreGate';
import { serveDefinitionFromRust, setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';

// 2026-11-08 用户令「直接切到 rust」:定义面 rust 服务 e2e(真实 kode-server
// 二进制)。证明 switch 不是纸面:gate 服务轨道 + serveDefinitionFromRust
// 走真进程回真实落点。二进制缺失时跳过(与 kodeCoreE2E 同口径,单测基线
// 不背工具链依赖)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const suite = existsSync(binaryPath) ? describe : describe.skip;

const DEF = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'Avatar.def');

suite('kode 定义面 rust 服务 e2e(真实二进制)', () => {
  let client: KodeCoreClient | null = null;
  let gate: KodeCoreGate | null = null;

  afterAll(async () => {
    setKodeCoreShadowGate(null);
    await gate?.dispose().catch(() => undefined);
  });

  it('rust 轨道:Avatar.def 的 DetailLevel 值 MEDIUM → 同文件 DetailLevels 声明落点', async () => {
    client = new KodeCoreClient({ binaryPath });
    gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 5000 });
    setKodeCoreShadowGate(gate);

    const text = readFileSync(DEF, 'utf8');
    const document = {
      uri: { fsPath: DEF },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => text
    };
    // 第 36 行(0 基 35)`<DetailLevel> MEDIUM </DetailLevel>`:词 MEDIUM 起点
    // 字符偏移 = 3 tab + `<DetailLevel> `(13) = 16,取中 18。
    const position = { line: 35, character: 18 };

    const location = await serveDefinitionFromRust(
      document as never,
      position as never
    );

    expect(location).not.toBeNull();
    expect(location!.uri).toBe(DEF);
    // 落点应在 <DetailLevels><MEDIUM>(文件第 61 行,0 基 60)附近
    expect(location!.range.start.line).toBeGreaterThanOrEqual(60);
    expect(location!.range.start.line).toBeLessThanOrEqual(62);
  }, 20_000);

  it('rust 轨道:非语料文档(schema)零请求直通 null', async () => {
    // 复用上一用例的 gate(真实进程已拉起)
    const document = {
      uri: { fsPath: '/w/Avatar.schema' },
      languageId: 'kbengine-schema',
      version: 1,
      getText: () => ''
    };
    const location = await serveDefinitionFromRust(
      document as never,
      { line: 0, character: 0 } as never
    );
    expect(location).toBeNull();
  }, 20_000);
});
