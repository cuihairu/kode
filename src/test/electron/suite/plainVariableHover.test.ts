import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

import { getFileReadTotals, resetFileReadMetrics } from '../../../fileReadMetrics';

// IDE-ACC-001:普通变量冷 hover 验收——真实编辑器(扩展宿主)覆盖
// 「大文件无注解」场景,分别记录命中与空结果的请求耗时及读盘量。
// 命中面=同文件 def 注解(HOV-010 快照级联第一层);空结果面=大文件内
// 无注解被调(级联全落空,触发受控后台构建但不等待——冷查询返回前不做
// 全项目发现/读取)。证据行 KEY=VALUE 落 KODE_ACC_OUT
// (缺省 docs/perf/2026-10-29-acc001-plain-hover-run.txt)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --field must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc001-plain-hover-run.txt');

interface KodeFieldProbeApi {
  probeHover(
    target: { file: string; line: number; character: number },
    cancelAfterMs?: number,
    preCancel?: boolean
  ): Promise<{
    elapsedMs: number;
    cancelled: boolean;
    returnedHover: boolean;
    preview: string;
  }>;
  pendingWork(): Record<string, number>;
}

const CALLER_REL = 'scripts/common/training/plain_var_caller.py';
const LARGE_REL = 'scripts/common/training/plain_var_large.py';

function lineOf(source: string, needle: string): number {
  const line = source.split(/\r?\n/).findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `fixture 缺行: ${needle}`);
  return line;
}

async function probeAt(
  probe: KodeFieldProbeApi,
  relPath: string,
  lineNeedle: string,
  symbol: string
): Promise<{ elapsedMs: number; returnedHover: boolean; preview: string }> {
  const filePath = path.join(WORKSPACE!, relPath);
  const source = fs.readFileSync(filePath, 'utf8');
  const line = lineOf(source, lineNeedle);
  const lineText = source.split(/\r?\n/)[line];
  const character = lineText.indexOf(symbol) + Math.floor(symbol.length / 2);
  const result = await probe.probeHover({ file: filePath, line, character });
  return { elapsedMs: result.elapsedMs, returnedHover: result.returnedHover, preview: result.preview };
}

describe('IDE-ACC-001:普通变量冷 hover(真实编辑器,大文件无注解场景)', () => {
  let probe: KodeFieldProbeApi;

  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as KodeFieldProbeApi;
    assert.ok(typeof probe.probeHover === 'function', 'activate 未返回 probeHover 探针');
  });

  it('命中与空结果各一次冷请求,记录耗时与读盘量', async function () {
    // 夹具在档(runTest field 模式生成):调用方同文件注解 def + 大文件无注解被调
    const callerPath = path.join(WORKSPACE!, CALLER_REL);
    const largePath = path.join(WORKSPACE!, LARGE_REL);
    assert.ok(fs.existsSync(callerPath), 'plain_var_caller.py 夹具缺失');
    assert.ok(fs.existsSync(largePath), 'plain_var_large.py 夹具缺失');
    // 大文件无注解:体量超 worker 阈值(256KiB),文件内无 '->' 返回注解
    assert.ok(fs.statSync(largePath).size > 256 * 1024, '大文件夹具体量不足 worker 阈值');
    assert.ok(!fs.readFileSync(largePath, 'utf8').includes('->'), '大文件夹具应无返回注解');

    // 空结果(冷):大文件被调无注解,级联全落空——记录耗时与读盘量
    const readsBefore = getFileReadTotals();
    const empty = await probeAt(probe, CALLER_REL, 'plain_local_info =', 'plain_local_info');
    const readsAfterEmpty = getFileReadTotals();
    assert.strictEqual(empty.returnedHover, false, `无注解局部变量不应出 hover: ${empty.preview}`);

    // 命中(冷):同文件 def 返回注解经悬停文档桶解析
    const hit = await probeAt(probe, CALLER_REL, 'data = get_annotated_data()', 'data');
    const readsAfterHit = getFileReadTotals();
    assert.strictEqual(hit.returnedHover, true, '同文件注解局部变量应出 hover');
    assert.ok(hit.preview.includes('JSONDATA'), `命中 hover 应含注解类型: ${hit.preview}`);

    // 受控后台构建落潮(不等全项目发现——这里只给它一个落潮窗,不参与判定)
    await new Promise(resolve => setTimeout(resolve, 2000));
    const readsAfterSettle = getFileReadTotals();

    const lines = [
      `acc001.empty.elapsedMs=${empty.elapsedMs}`,
      `acc001.empty.returnedHover=${empty.returnedHover}`,
      `acc001.hit.elapsedMs=${hit.elapsedMs}`,
      `acc001.hit.returnedHover=${hit.returnedHover}`,
      `acc001.hit.preview=${hit.preview.replace(/\n/g, ' ')}`,
      `acc001.reads.emptyDelta=${readsAfterEmpty.reads - readsBefore.reads}`,
      `acc001.reads.emptyBytesDelta=${readsAfterEmpty.bytes - readsBefore.bytes}`,
      `acc001.reads.hitDelta=${readsAfterHit.reads - readsAfterEmpty.reads}`,
      `acc001.reads.hitBytesDelta=${readsAfterHit.bytes - readsAfterEmpty.bytes}`,
      `acc001.reads.settleTotal=${readsAfterSettle.reads}`,
      `acc001.reads.settleBytes=${readsAfterSettle.bytes}`,
      `acc001.pendingWork=${JSON.stringify(probe.pendingWork())}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
    console.log('[acc001] evidence:\n' + lines.join('\n'));

    // 读盘量在档且非空:两次请求至少触达夹具文件
    assert.ok(readsAfterHit.reads - readsBefore.reads >= 1, '两次冷请求应产生可观测读盘');
  });

  it('TTL 过期重复 hover:同步路径零全仓重扫,事件循环延迟在档', async function () {
    const evidence: string[] = [];
    // 预热:命中一次并等受控后台索引建成,再越过 TTL(3s)进入过期态
    await probeAt(probe, CALLER_REL, 'data = get_annotated_data()', 'data');
    await new Promise(resolve => setTimeout(resolve, 4000));

    resetFileReadMetrics();
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const expired = await probeAt(probe, CALLER_REL, 'data = get_annotated_data()', 'data');
    const readsAtReturn = getFileReadTotals();
    histogram.disable();
    const delayP99Ms = histogram.percentile(99) / 1e6;

    // 过期悬停仍命中(文档桶不依赖磁盘索引新鲜度),且同步路径不做全仓重扫
    assert.strictEqual(expired.returnedHover, true, `过期重复 hover 应仍命中: ${expired.preview}`);
    assert.ok(expired.elapsedMs < 2000, `过期悬停不应等全仓重扫: ${expired.elapsedMs}ms`);
    assert.ok(readsAtReturn.reads <= 5, `过期悬停同步路径读盘应近零(实际 ${readsAtReturn.reads} 次)`);

    // 后台重建落潮窗(单列记录,不参与判定)
    await new Promise(resolve => setTimeout(resolve, 2000));
    const readsAfterSettle = getFileReadTotals();

    evidence.push(
      `acc002.expired.elapsedMs=${expired.elapsedMs}`,
      `acc002.expired.returnedHover=${expired.returnedHover}`,
      `acc002.expired.preview=${expired.preview.replace(/\n/g, ' ')}`,
      `acc002.loop.p99Ms=${delayP99Ms.toFixed(3)}`,
      `acc002.reads.atReturn=${readsAtReturn.reads}`,
      `acc002.reads.atReturnBytes=${readsAtReturn.bytes}`,
      `acc002.reads.settleTotal=${readsAfterSettle.reads}`,
      `acc002.reads.settleBytes=${readsAfterSettle.bytes}`,
      `acc002.pendingWork=${JSON.stringify(probe.pendingWork())}`
    );
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.appendFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc002] evidence:\n' + evidence.join('\n'));
  });
});
