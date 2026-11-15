// Rust 服务态 soak bench(2026-11-15 用户审计 P1-3:soak 此前只挂 TS 侧,
// 真实 kode-server 长时面只有一次性 serving-state 观测,无持续压力车道):
//   KODE_SERVING_SOAK_SECONDS=60 pnpm exec vitest run \
//     --config vitest.bench.config.ts tests/perf/servingSoak.bench.ts
//   1h 档:KODE_SERVING_SOAK_SECONDS=3600(超时按时长自动放宽)
//
// 负载形态 = 真实 kode-server 二进制 + 真实 client 稳态交互循环:
//   每窗 5s 内轮转 definition/completion/diagnostic 三面,每第 5 轮插入
//   didChange 编辑(版本递增+文本微改),验证编辑流下服务不劣化;
//   RSS 逐窗采样(/proc VmRSS)。
// 断言(本文件即 soak 闸,显式调用即断言):
//   ①零错误(任一请求抛错/超时计数,>0 红);
//   ②全程有请求(每窗 requests>0,服务未失能);
//   ③RSS 增量 < KODE_SERVING_SOAK_RSS_GROWTH_MB(缺省 100;Rust 分配器
//     有保留策略,界宽松只捕数量级泄漏);
//   ④无病态退化:末季度 definition p50 < 首季度 p50×10+5ms(只捕数量级
//     回退,单窗尾刺不红,与 soak.bench.ts 同纪律)。
// 输出 SERVING-SOAK-ENV/SERVING-SOAK-METRIC/SERVING-SOAK-SUMMARY 追加落
// docs/perf/serving-soak-run.txt(KODE_SERVING_SOAK_OUT 可覆盖)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { performance } from 'perf_hooks';

import { KodeCoreClient } from '../../src/backend/kodeCoreClient';

const OUT_FILE =
  process.env.KODE_SERVING_SOAK_OUT ??
  path.resolve(__dirname, '../../docs/perf/serving-soak-run.txt');

const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

/** kode-server 进程 RSS(/proc/<pid>/status VmRSS kB → MB);不可得返回 null */
const serverRssMb = (pid: number): number | null => {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return match ? mb(Number(match[1]) * 1024) : null;
  } catch {
    return null;
  }
};

const repoRoot = path.resolve(__dirname, '../..');
// KODE_SERVING_BINARY:红队替身入口(与 servingGate 同口径;缺省真二进制)。
const binaryPath =
  process.env.KODE_SERVING_BINARY ?? path.join(repoRoot, 'target', 'debug', 'kode-server');
const hasBinary = fs.existsSync(binaryPath);
if (!hasBinary && spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, stdio: 'ignore' });
}
const suite = fs.existsSync(binaryPath) ? describe : describe.skip;

const SOAK_SECONDS = Number(process.env.KODE_SERVING_SOAK_SECONDS ?? '60');
const WINDOW_SECONDS = 5;
const DEF_COUNT = Number(process.env.KODE_SERVING_SOAK_FILES ?? '2000');
const RSS_GROWTH_CEILING_MB = Number(process.env.KODE_SERVING_SOAK_RSS_GROWTH_MB ?? '100');

// ---- 合成语料(servingGate.bench.ts 同生成器形态) ----

const defTextOf = (name: string): string =>
  [
    '<root>',
    '\t<Properties>',
    ...Array.from({ length: 10 }, (_, i) =>
      [
        `\t\t<${name}_p${i}>`,
        `\t\t\t<Type> ${i % 3 === 0 ? 'UINT32' : i % 3 === 1 ? 'STRING' : 'DIALOG_VAR'} </Type>`,
        `\t\t\t<Flags> ${['BASE', 'CELL_PUBLIC', 'ALL_CLIENTS'][i % 3]} </Flags>`,
        `\t\t</${name}_p${i}>`
      ].join('\n')
    ),
    '\t</Properties>',
    '\t<BaseMethods>',
    ...Array.from({ length: 5 }, (_, i) =>
      [`\t\t<onBase${i}>`, `\t\t\t<Arg> UINT32 </Arg>`, `\t\t</onBase${i}>`].join('\n')
    ),
    '\t</BaseMethods>',
    '</root>'
  ].join('\n');

const TYPES_XML = ['<root>', '\t<DIALOG_VAR> UINT8 </DIALOG_VAR>', '</root>'].join('\n');
const ENTITIES_XML = ['<root>', '\t<Monster/>', '</root>'].join('\n');
const ALIAS_XML = [
  '<root>',
  '\t<ITEM_LIST>',
  '\t\t<ARRAY>',
  '\t\t\tof="DIALOG_VAR"',
  '\t\t</ARRAY>',
  '\t</ITEM_LIST>',
  '</root>'
].join('\n');

interface SoakWorkspace {
  dir: string;
  corpusUris: string[];
  defUris: string[];
  defTexts: string[];
}

const makeWorkspace = (dir: string, defCount: number): SoakWorkspace => {
  fs.rmSync(dir, { recursive: true, force: true });
  const defs = path.join(dir, 'scripts', 'entity_defs');
  fs.mkdirSync(defs, { recursive: true });
  const defUris: string[] = [];
  const defTexts: string[] = [];
  for (let i = 0; i < defCount; i += 1) {
    const name = `Soak${i}`;
    const file = path.join(defs, `${name}.def`);
    const text = defTextOf(name);
    fs.writeFileSync(file, text);
    defUris.push(`file://${file}`);
    defTexts.push(text);
  }
  fs.writeFileSync(path.join(defs, 'types.xml'), TYPES_XML);
  fs.writeFileSync(path.join(defs, 'entities.xml'), ENTITIES_XML);
  fs.writeFileSync(path.join(defs, 'alias.xml'), ALIAS_XML);
  // 三类 XML 也是镜像面(servingGate 同账本):服务器是纯 overlay 无盘扫,
  // 不镜像 types.xml 则 DIALOG_VAR 无注册面——definition 恒 null、诊断误报
  // 未注册(2026-11-15 语义断言面接线时实证)。
  const corpusUris = ['types.xml', 'entities.xml', 'alias.xml'].map(base =>
    `file://${path.join(defs, base)}`
  );
  return { dir, corpusUris, defUris, defTexts };
};

// 探针:p2 属性 <Type> 行(0 基第 11 行)DIALOG_VAR 词内(词起点列 10,
// 探 +1);DIALOG_VAR 在 types.xml 第 1 行注册 → definition 已知声明落点
// (语义断言面,P1-2 审计修正)。
const DEF_PROBE = { line: 11, character: 11 };
/** 补全上下文文档:开标签探针行「\t\t<」插在 </Properties> 之前(标签栈顶
 * =Properties,成员补全真上下文;旧夹具「<」在文档尾,栈空恒 null——
 * 2026-11-15 审计 P1-2 实证)。 */
const completionDocOf = (defText: string): {
  text: string;
  probe: { line: number; character: number };
} => {
  const lines = defText.split('\n');
  const at = lines.indexOf('\t</Properties>');
  const text = [...lines.slice(0, at), '\t\t<', ...lines.slice(at)].join('\n');
  return { text, probe: { line: at, character: 3 } };
};

suite(`Rust 服务态 soak(${SOAK_SECONDS}s,零错误+驻留界+无病态退化)`, () => {
  const ws = makeWorkspace(path.join(os.tmpdir(), 'kode-serving-soak'), DEF_COUNT);
  const clients: KodeCoreClient[] = [];
  let client: KodeCoreClient | null = null;

  afterAll(async () => {
    if (client) {
      await client.dispose().catch(() => undefined);
    }
    fs.rmSync(ws.dir, { recursive: true, force: true });
  });

  it('持续混合负载:零错误+服务恒活+RSS 增量在界+无病态退化', async () => {
    client = new KodeCoreClient({ binaryPath });
    clients.push(client);
    await client.start();
    // 镜像语料(编辑/查询的底座):三类 XML 先行 + 全量 def + 10 个补全
    // 上下文文档(轮转面)。
    for (const corpusUri of ws.corpusUris) {
      client.openDocument(
        corpusUri,
        'xml',
        1,
        fs.readFileSync(corpusUri.slice('file://'.length), 'utf8')
      );
    }
    for (let i = 0; i < ws.defUris.length; i += 1) {
      client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
    }
    const compUris: string[] = [];
    const compTexts: string[] = [];
    const compProbes: Array<{ line: number; character: number }> = [];
    for (let i = 0; i < Math.min(10, ws.defUris.length); i += 1) {
      const { text, probe } = completionDocOf(ws.defTexts[i]);
      const uri = `${ws.defUris[i]}.comp.def`;
      compUris.push(uri);
      compTexts.push(text);
      compProbes.push(probe);
      await client.openDocument(uri, 'kbengine-def', 1, text);
    }
    const startHealth = await client.health();
    const pid = startHealth.pid;
    const rssFirstMb = serverRssMb(pid) ?? 0;
    emit(
      `SERVING-SOAK-ENV seconds=${SOAK_SECONDS} window=${WINDOW_SECONDS} ` +
        `files=${DEF_COUNT} rssGrowthCeilingMb=${RSS_GROWTH_CEILING_MB} binary=${binaryPath}`
    );

    interface WindowStats {
      index: number;
      wall: number;
      requests: number;
      errors: number;
      defP50: number;
      diagP50: number;
      rssMb: number;
    }
    const windows: WindowStats[] = [];
    let editVersion = 1;
    let iteration = 0;
    // 语义面捕获(P1-2 审计修正:soak 此前只断速度/存活/驻留,「语义请求
    // 全 null 的替身」照样通过;首迭代+首个编辑轮各捕一组,循环后统一断言)。
    let defHit: unknown;
    let compHit: unknown;
    let diagHit: unknown;
    let postEditCompLabels: string[] = [];
    let preEditLabels4: string[] = [];
    const soakStarted = performance.now();
    const deadline = soakStarted + SOAK_SECONDS * 1000;

    while (performance.now() < deadline) {
      const windowStarted = performance.now();
      const defSamples: number[] = [];
      const compSamples: number[] = [];
      const diagSamples: number[] = [];
      let windowRequests = 0;
      let windowErrors = 0;
      // 单窗轮转直到窗满;面序=definition→completion→(每第5轮编辑)→diagnostic
      while (performance.now() - windowStarted < WINDOW_SECONDS * 1000) {
        const i = iteration % Math.min(10, ws.defUris.length);
        const defUri = ws.defUris[(iteration * 7) % ws.defUris.length];
        try {
          let t = performance.now();
          const defResponse = await client.request('textDocument/definition', {
            textDocument: { uri: defUri },
            position: DEF_PROBE
          });
          defSamples.push(performance.now() - t);
          windowRequests += 1;
          t = performance.now();
          const compResponse = await client.request('textDocument/completion', {
            textDocument: { uri: compUris[i] },
            position: compProbes[i]
          });
          compSamples.push(performance.now() - t);
          windowRequests += 1;
          if (iteration % 5 === 4) {
            // 编辑流:补全文档版本递增+文本微改(属性名后缀轮换)
            editVersion += 1;
            // /g:开+闭标签同改,保持 XML 配平(只改一处=永久坏文档,假编辑流)
            const edited = compTexts[i].replace(
              /_p0(_v\d+)?>/g,
              `_p0_v${editVersion % 100}>`
            );
            compTexts[i] = edited;
            await client.openDocument(compUris[i], 'kbengine-def', editVersion, edited);
            windowRequests += 1;
            if (iteration === 4) {
              // 首个编辑轮(改的是 i=4 即 Soak4 文档):编辑前基线取本轮编辑
              // 前的补全应答,编辑后再查——编辑后结果变化面。
              preEditLabels4 = ((compResponse as { items?: Array<{ label: string }> } | null)?.items ?? []).map(
                item => item.label
              );
              const postEdit = (await client.request('textDocument/completion', {
                textDocument: { uri: compUris[i] },
                position: compProbes[i]
              })) as { items?: Array<{ label: string }> } | null;
              postEditCompLabels = (postEdit?.items ?? []).map(item => item.label);
            }
          }
          t = performance.now();
          const diagResponse = await client.request('textDocument/diagnostic', {
            textDocument: { uri: defUri }
          });
          diagSamples.push(performance.now() - t);
          windowRequests += 1;
          if (iteration === 0) {
            defHit = defResponse;
            compHit = compResponse;
            diagHit = diagResponse;
          }
        } catch (error) {
          windowErrors += 1;
          emit(
            `SERVING-SOAK-METRIC windowError n=1 window=${windows.length + 1} ` +
              `iteration=${iteration} message=${String(error).slice(0, 200)}`
          );
        }
        iteration += 1;
      }
      const stats: WindowStats = {
        index: windows.length + 1,
        wall: Math.round(performance.now() - windowStarted),
        requests: windowRequests,
        errors: windowErrors,
        defP50: percentile(defSamples, 0.5),
        diagP50: percentile(diagSamples, 0.5),
        rssMb: serverRssMb(pid) ?? 0
      };
      windows.push(stats);
      emit(
        `SERVING-SOAK-METRIC window n=1 index=${stats.index} wall=${stats.wall}ms ` +
          `requests=${stats.requests} errors=${stats.errors} ` +
          `defP50=${stats.defP50}ms diagP50=${stats.diagP50}ms rssMb=${stats.rssMb}`
      );
    }
    const soakWall = performance.now() - soakStarted;
    // 极短时长(KODE_SERVING_SOAK_SECONDS<窗长)会零窗收尾——诚实失败,
    // 不对 windows[-1] 取值装完整一跑。
    expect(windows.length).toBeGreaterThan(0);

    // 退化趋势面:首季度 vs 末季度 definition p50(数量级回退闸,单窗尾刺不红)
    const quarter = Math.max(1, Math.floor(windows.length / 4));
    const firstQuarterDefP50 =
      percentile(
        windows.slice(0, quarter).map(w => w.defP50),
        0.5
      ) || 0.01;
    const lastQuarterDefP50 =
      percentile(
        windows.slice(-quarter).map(w => w.defP50),
        0.5
      ) || 0.01;
    const totalRequests = windows.reduce((sum, w) => sum + w.requests, 0);
    const totalErrors = windows.reduce((sum, w) => sum + w.errors, 0);
    const rssLastMb = windows[windows.length - 1].rssMb;
    const rssGrowthMb = rssLastMb - rssFirstMb;

    emit(
      `SERVING-SOAK-SUMMARY windows=${windows.length} wall=${Math.round(soakWall)}ms ` +
        `requests=${totalRequests} errors=${totalErrors} ` +
        `compRequests=${totalRequests} defP50FirstMs=${firstQuarterDefP50} ` +
        `defP50LastMs=${lastQuarterDefP50} ` +
        `rssFirstMb=${rssFirstMb} rssLastMb=${rssLastMb} ` +
        `rssGrowthMb=${Math.round(rssGrowthMb * 100) / 100}`
    );

    // 闸①:零错误
    expect(totalErrors).toBe(0);
    // 闸②:全程有请求(服务未失能)
    expect(windows.length).toBeGreaterThan(0);
    expect(totalRequests).toBeGreaterThan(0);
    // 闸③:RSS 增量在界(Rust 分配器保留策略,界宽松只捕数量级泄漏)
    expect(rssGrowthMb).toBeLessThan(RSS_GROWTH_CEILING_MB);
    // 闸④:无病态退化(末季度 p50 < 首季度×10+5ms)
    expect(lastQuarterDefP50).toBeLessThan(firstQuarterDefP50 * 10 + 5);
    // 闸⑤:语义面(P1-2 审计修正——「语义请求全 null 的替身」在此红):
    //   ① 已知声明落点 DIALOG_VAR→types.xml 第 1 行;② 必有补全项
    //   (开标签位本实体全部属性名);③ 干净语料零诊断;④ 首个编辑轮
    //   后补全面反映属性改名(编辑后结果变化)。
    expect(defHit, 'definition 命中已知声明落点(替身 null 在此红)').toMatchObject({
      uri: expect.stringContaining('types.xml')
    });
    expect((defHit as { range: { start: { line: number } } }).range.start.line).toBe(1);
    const baseLabels = ((compHit as { items?: Array<{ label: string }> }).items ?? []).map(
      item => item.label
    );
    expect(compHit, 'completion 非空(替身 null 在此红)').not.toBeNull();
    for (let i = 0; i < 10; i += 1) {
      expect(baseLabels.includes(`Soak0_p${i}`), `补全缺必有项 Soak0_p${i}`).toBe(true);
    }
    expect(diagHit, '干净 def 零诊断').toMatchObject({ items: [] });
    expect(
      preEditLabels4.includes('Soak4_p0'),
      '编辑前基线(Soak4)含原属性名'
    ).toBe(true);
    expect(
      postEditCompLabels.includes('Soak4_p0_v2'),
      `首个编辑轮后补全面必须含改名属性 Soak4_p0_v2(编辑后结果变化);实际: ${postEditCompLabels.slice(0, 12).join(',')}`
    ).toBe(true);
    expect(
      preEditLabels4.includes('Soak4_p0_v2'),
      '编辑前基线不含改名属性(增量真实性)'
    ).toBe(false);
  }, SOAK_SECONDS * 1000 + 120_000);
});
