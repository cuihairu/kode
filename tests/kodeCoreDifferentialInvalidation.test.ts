import { existsSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { serveHoverFromRust, setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// RUST-120-W:分类失效差异化 e2e(真实 kode-server 二进制)。同文件三类
// 编辑经生产 mirrorDocument 链(didOpen/didChange → 风暴缓冲 → 调度队列)
// 落健康面 ingest 四记账键,悬停视图按类别差异化:identical/body-only 零
// 失效(悬停保持旧事实),signature 重灌(悬停反映新类型)。二进制缺失时
// 跳过(与 kodeCoreServingE2E 同口径)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const suite = existsSync(binaryPath) ? describe : describe.skip;

const DEF_V1 =
  '<root>\n' +
  '\t<Properties>\n' +
  '\t\t<hp>\n' +
  '\t\t\t<Type> UINT32 </Type>\n' +
  '\t\t\t<Flags> BASE </Flags>\n' +
  '\t\t</hp>\n' +
  '\t</Properties>\n' +
  '</root>\n';
// 尾部注释:全部已登记位置不变 → 语料模型全等 → body-only。
const DEF_BODY_ONLY = DEF_V1 + '\n<!-- RUST-120-W body-only 尾注 -->\n';
// 属性类型变更 → signature。
const DEF_SIGNATURE = DEF_V1.replace('UINT32', 'UINT16');
const SYNTH = '/tmp/kode-e2e-r120w-differential.def';

suite('kode 分类失效差异化 e2e(真实二进制)', () => {
  let client: KodeCoreClient | null = null;
  let gate: KodeCoreGate | null = null;

  afterAll(async () => {
    setKodeCoreShadowGate(null);
    await gate?.dispose().catch(() => undefined);
  });

  it('ingest 四记账键按类别分化;悬停视图 identical/body-only 零失效、signature 重灌', async () => {
    client = new KodeCoreClient({ binaryPath });
    gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 5000 });
    setKodeCoreShadowGate(gate);

    const health = async (): Promise<Record<string, number>> =>
      ((await client!.health()) as unknown as { ingest: Record<string, number> }).ingest;
    // didChange 过 300ms 风暴窗,执行时刻不与请求同步——轮询健康面直到
    // 该类别记账到位(上限 2s,窗界内的诚实等待,不假设即时执行)。
    const waitFor = async (
      pred: (h: Record<string, number>) => boolean
    ): Promise<Record<string, number>> => {
      const t0 = Date.now();
      for (;;) {
        const h = await health();
        if (pred(h)) {
          return h;
        }
        if (Date.now() - t0 > 2000) {
          throw new Error(`ingest 记账未到位: ${JSON.stringify(h)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    };
    const hoverHp = async (version: number, text: string): Promise<string | null> =>
      serveHoverFromRust(
        {
          uri: { fsPath: SYNTH },
          languageId: 'kbengine-def',
          version,
          getText: () => text
        } as never,
        // `\t\t<hp>` 在 0 基第 2 行,词 hp 起点列 3,取中 4。
        { line: 2, character: 4 } as never
      );

    // 首次入库 = signature;悬停出 UINT32。
    await gate.mirrorDocument(SYNTH, 'kbengine-def', 1, DEF_V1);
    expect(await hoverHp(1, DEF_V1)).toContain('`UINT32`');
    const afterOpen = await waitFor(h => h.ingestSignature >= 1);

    // 同文本 didChange(新版本) = identical;悬停不变。
    const sigBefore = afterOpen.ingestSignature;
    await gate.mirrorDocument(SYNTH, 'kbengine-def', 2, DEF_V1);
    expect(await hoverHp(2, DEF_V1)).toContain('`UINT32`');
    const afterIdentical = await waitFor(h => h.ingestIdentical >= 1);
    expect(afterIdentical.ingestSignature).toBe(sigBefore);

    // 尾注 didChange = body-only(零失效);悬停保持旧事实。
    await gate.mirrorDocument(SYNTH, 'kbengine-def', 3, DEF_BODY_ONLY);
    expect(await hoverHp(3, DEF_BODY_ONLY)).toContain('`UINT32`');
    const afterBodyOnly = await waitFor(
      h => h.ingestBodyOnly >= 1 && h.ingestSignature === sigBefore
    );

    // 属性类型变更 didChange = signature;悬停重灌出 UINT16。
    await gate.mirrorDocument(SYNTH, 'kbengine-def', 4, DEF_SIGNATURE);
    expect(await hoverHp(4, DEF_SIGNATURE)).toContain('`UINT16`');
    await waitFor(h => h.ingestSignature === sigBefore + 1);
  }, 30_000);
});
