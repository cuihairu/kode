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
// IDE-REV-035:大「当前文档」内 hover 验收——原场景是小调用方引用大外部
// 文件(acc001/acc002 行),本例在超 256KiB 的 .py 自身内部测首次与编辑后
// 立即 hover,分别记录命中、耗时与窗内最大宿主阻塞(下界口径);命中内容
// 含仅本文件存在的 BIGDOC_RETURN 标记=确实走了当前文档注解路径的结构性
// 证明。与小调用方场景分别报告(rev035.* 行独立分列,不混读)。
// IDE-REV-036:短查询事件循环采样方法修正——旧口径「enable→查询→disable」
// 的 p99 恒 0.001ms 级,把默认极小 p99 当已通过证据不成立。新口径四段:
// 预热(enable→100ms)→reset 清零(启动积压与 enable 前尖峰不入窗)→落
// 一拍(reset 重锚采样时钟,紧接的同步阻塞会被折进新锚记不到,实测吞掉
// 300ms 阻塞——落一拍让锚先落定)→查询→查询后窗(200ms,短查询延迟事件
// 常在返回后同拍落账)→落账有效样本数+最大延迟+p99;零/欠样本(<10)按
// 未测处理不许过,最大延迟有界(注入阻塞可触发失败,prove-red 已证)。
// acc002 例用完整断言面,rev035 三面同方法论记录。

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

    // 命中(冷):同文件 def 返回注解经悬停文档桶解析。IDE-REV-010(2026-10-29
    // bb801b6)起首次 hover 不再做同步整文件提取——本查询只读已发布桶,桶版本
    // 落后交给受控异步更新发布,发布后下次查询可见。空探针已对同文件排队了
    // 文档注解更新,这里等发布排干(去抖+让出式提取,有界)再断言命中:
    // 命中面从「首查同步出」对齐到「发布后可见」,不回退 REV-010 语义。
    let publishWaitMs = 0;
    while ((probe.pendingWork().annotationUpdates ?? 0) > 0 && publishWaitMs < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 250));
      publishWaitMs += 250;
    }
    assert.strictEqual(
      probe.pendingWork().annotationUpdates ?? 0, 0,
      '文档注解更新发布未在有界窗内排干'
    );
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
      `acc001.hit.publishWaitMs=${publishWaitMs}`,
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
    // IDE-REV-036:短查询事件循环采样方法修正——旧口径 enable 后立刻查询、
    // 返回即 disable,p99 恒极小(0.001ms 级),把「默认极小 p99」当已通过证
    // 据不成立。新口径四段:①预热(enable 后等 100ms 让直方图先跑起来)再
    // reset 清零——enable 前积压与启动尖峰不计入查询窗;②reset 后落一拍
    // (10ms):reset 重锚采样时钟,紧跟其后的同步阻塞会被折进新锚(实测
    // max≈0 吞掉 300ms 阻塞,prove-red 首版咬出),落一拍让锚先落定,
    // 测量面从锚定后开始;③查询本体;④查询后窗口(200ms)——短查询的
    // 延迟事件常在返回后同拍落账,返回即 disable 会漏记。落账=有效样本数
    // +最大延迟+p99,样本数不足(零样本)按未测处理不许过,最大延迟有界
    // (注入阻塞可触发失败,prove-red 已证)
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    await new Promise(resolve => setTimeout(resolve, 100));
    histogram.reset();
    await new Promise(resolve => setTimeout(resolve, 10));
    const expired = await probeAt(probe, CALLER_REL, 'data = get_annotated_data()', 'data');
    const readsAtReturn = getFileReadTotals();
    await new Promise(resolve => setTimeout(resolve, 200));
    histogram.disable();
    const loopSampleCount = histogram.count;
    const delayMaxMs = histogram.max / 1e6;
    const delayP99Ms = histogram.percentile(99) / 1e6;
    assert.ok(
      loopSampleCount >= 10,
      `事件循环样本 ${loopSampleCount} <10(零样本/欠采样=未测,采样方法未生效,本面不许记已通过)`
    );
    assert.ok(
      delayMaxMs < 200,
      `查询窗内最大宿主阻塞 ${delayMaxMs.toFixed(3)}ms ≥200ms(注入阻塞可触发本断言,prove-red 已证)`
    );

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
      `acc002.loop.tested=${loopSampleCount >= 10}(REV-036:预热+查询后窗,零/欠样本=未测)`,
      `acc002.loop.sampleCount=${loopSampleCount}`,
      `acc002.loop.maxMs=${delayMaxMs.toFixed(3)}`,
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

  it('IDE-REV-035:大当前文档内 hover(首次+编辑后立即),命中/耗时/最大宿主阻塞分列', async function () {
    this.timeout(60_000);
    const BIG_REL = 'scripts/common/training/plain_var_large_annotated.py';
    const bigPath = path.join(WORKSPACE!, BIG_REL);
    assert.ok(fs.existsSync(bigPath), 'plain_var_large_annotated.py 夹具缺失');
    const bigSource = fs.readFileSync(bigPath, 'utf8');
    assert.ok(fs.statSync(bigPath).size > 256 * 1024, '大注解文件夹具体量不足 worker 阈值');
    // 当前文档专属标记恰一处(词边界锚定:BIGDOC_RETURN_X 之类前缀撞名不
    // 计数——prove-red 曾证子串口径放过撞名夹具):命中内容含它=走的是当前
    // 文档注解路径,不是别处(小调用方的 JSONDATA/磁盘索引里其他文件)的注解
    assert.strictEqual(
      bigSource.match(/\bBIGDOC_RETURN\b/g)?.length ?? 0, 1,
      'BIGDOC_RETURN 标记应恰一处(词边界口径,当前文档专属,防夹具混入或撞名)'
    );

    const evidence: string[] = [];
    // 查询窗(REV-036 方法论):预热一拍后 reset 清零再跑查询,查询后留
    // 150ms 收尾样本(短查询的延迟事件常在返回后同拍落账);落账=窗内 max
    // +有效样本数,样本数不足=窗无效。窗内 max 记为下界口径(方法论的完整
    // 断言面在 acc002 例,本处如实记录不据此放行)
    const loopWindow = async <T>(run: () => Promise<T>):
      Promise<{ value: T; maxDelayMs: number; sampleCount: number }> => {
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      await new Promise(resolve => setTimeout(resolve, 30));
      histogram.reset();
      // reset 重锚采样时钟,落一拍让锚先落定(否则 reset 后紧接的同步阻塞
      // 会被折进新锚记不到——REV-036 prove-red 咬出的口径坑)
      await new Promise(resolve => setTimeout(resolve, 10));
      const value = await run();
      await new Promise(resolve => setTimeout(resolve, 150));
      histogram.disable();
      return { value, maxDelayMs: histogram.max / 1e6, sampleCount: histogram.count };
    };

    // ①首次 hover(大文档冷开):IDE-REV-010 语义=首查只读已发布桶,新文档
    // 无桶;命中与否如实记录(不硬断),只断言不等全项目
    resetFileReadMetrics();
    const firstWindow = await loopWindow(() =>
      probeAt(probe, BIG_REL, 'big_value = get_big_annotated()', 'big_value'));
    const first = firstWindow.value;
    const readsAtFirst = getFileReadTotals();
    evidence.push(
      `rev035.bigdoc.first.elapsedMs=${first.elapsedMs}`,
      `rev035.bigdoc.first.returnedHover=${first.returnedHover}`,
      `rev035.bigdoc.first.preview=${first.preview.replace(/\n/g, ' ')}`,
      `rev035.bigdoc.first.loopMaxMs=${firstWindow.maxDelayMs.toFixed(3)}(窗内下界,样本${firstWindow.sampleCount})`,
      `rev035.bigdoc.first.reads=${readsAtFirst.reads}`,
      `rev035.bigdoc.first.readBytes=${readsAtFirst.bytes}`
    );
    assert.ok(first.elapsedMs < 2000, `首次大文档 hover 不应等全项目发现: ${first.elapsedMs}ms`);

    // ②等当前文档注解发布排干(去抖+worker 解析>256KiB,有界)再查:发布
    // 后可见(REV-010 语义的命中面)
    let publishWaitMs = 0;
    while ((probe.pendingWork().annotationUpdates ?? 0) > 0 && publishWaitMs < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 250));
      publishWaitMs += 250;
    }
    assert.strictEqual(
      probe.pendingWork().annotationUpdates ?? 0, 0,
      '大文档注解发布未在有界窗内排干'
    );
    const afterPublishWindow = await loopWindow(() =>
      probeAt(probe, BIG_REL, 'big_value = get_big_annotated()', 'big_value'));
    const afterPublish = afterPublishWindow.value;
    evidence.push(
      `rev035.bigdoc.publishWaitMs=${publishWaitMs}`,
      `rev035.bigdoc.afterPublish.elapsedMs=${afterPublish.elapsedMs}`,
      `rev035.bigdoc.afterPublish.returnedHover=${afterPublish.returnedHover}`,
      `rev035.bigdoc.afterPublish.preview=${afterPublish.preview.replace(/\n/g, ' ')}`,
      `rev035.bigdoc.afterPublish.loopMaxMs=${afterPublishWindow.maxDelayMs.toFixed(3)}(窗内下界,样本${afterPublishWindow.sampleCount})`
    );
    assert.strictEqual(afterPublish.returnedHover, true, `发布后大文档内 hover 应命中: ${afterPublish.preview}`);
    assert.ok(
      /\bBIGDOC_RETURN\b/.test(afterPublish.preview),
      `命中应含大文档专属注解标记(词边界,当前文档注解路径的结构性证明): ${afterPublish.preview}`
    );

    // ③编辑后立即 hover:大文档末尾追加一行+保存(版本 bump→去抖重发布),
    // 不等发布立即查——编辑后立即面(REV-010 语义下读已发布桶,桶落后交给
    // 受控异步更新,记录命中与否与耗时)
    const bigDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(bigPath));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(bigDocument.uri, new vscode.Position(bigDocument.lineCount, 0), '# rev035 edit\n');
    assert.ok(await vscode.workspace.applyEdit(edit), '大文档 applyEdit 失败');
    assert.ok(await bigDocument.save(), '大文档保存失败');
    const editSavedAt = Date.now();
    const postEditWindow = await loopWindow(() =>
      probeAt(probe, BIG_REL, 'big_value = get_big_annotated()', 'big_value'));
    const postEdit = postEditWindow.value;
    evidence.push(
      `rev035.bigdoc.postEdit.saveToReturnMs=${Date.now() - editSavedAt}(编辑保存完成→hover 返回)`,
      `rev035.bigdoc.postEdit.elapsedMs=${postEdit.elapsedMs}`,
      `rev035.bigdoc.postEdit.returnedHover=${postEdit.returnedHover}`,
      `rev035.bigdoc.postEdit.preview=${postEdit.preview.replace(/\n/g, ' ')}`,
      `rev035.bigdoc.postEdit.loopMaxMs=${postEditWindow.maxDelayMs.toFixed(3)}(窗内下界,样本${postEditWindow.sampleCount})`
    );
    assert.ok(postEdit.elapsedMs < 2000, `编辑后立即 hover 不应等全量重解析: ${postEdit.elapsedMs}ms`);

    // 与原场景分别报告:acc001.*/acc002.*=小调用方引用大外部文件(引用处
    // hover);rev035.*=大当前文档内(定义与使用同在超阈值文档),两侧同档
    // 分列不混读
    evidence.push('rev035.report.separation=acc001.*/acc002.*=small caller referencing big external file;rev035.*=inside the oversized current document');
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.appendFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[rev035] evidence:\n' + evidence.join('\n'));
  });
});
