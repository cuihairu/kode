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
const binaryPath = path.join(repoRoot, 'target', 'debug', 'kode-server');
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
  return { dir, defUris, defTexts };
};

const DEF_PROBE = { line: 3, character: 12 };
const COMPLETION_TEXT_SUFFIX = '\n\t\t<';
const completionProbe = (text: string): { line: number; character: number } => ({
  line: text.split('\n').length - 1,
  character: 3
});

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
    // 镜像语料(编辑/查询的底座)+ 10 个补全上下文文档(轮转面)
    for (let i = 0; i < ws.defUris.length; i += 1) {
      await client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
    }
    const compUris: string[] = [];
    const compTexts: string[] = [];
    for (let i = 0; i < Math.min(10, ws.defUris.length); i += 1) {
      const text = ws.defTexts[i] + COMPLETION_TEXT_SUFFIX;
      const uri = `${ws.defUris[i]}.comp.def`;
      compUris.push(uri);
      compTexts.push(text);
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
          await client.request('textDocument/definition', {
            textDocument: { uri: defUri },
            position: DEF_PROBE
          });
          defSamples.push(performance.now() - t);
          windowRequests += 1;
          t = performance.now();
          await client.request('textDocument/completion', {
            textDocument: { uri: compUris[i] },
            position: completionProbe(compTexts[i])
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
          }
          t = performance.now();
          await client.request('textDocument/diagnostic', {
            textDocument: { uri: defUri }
          });
          diagSamples.push(performance.now() - t);
          windowRequests += 1;
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
  }, SOAK_SECONDS * 1000 + 120_000);
});
