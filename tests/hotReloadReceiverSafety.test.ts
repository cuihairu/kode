// SRC-012 可选拆(2026-11-09)自 hotReloadReceiverRoundtrip.test.ts:F3 七轮至九轮与
// 九轮复审的产物路径安全/符号链接逃逸/暂存别名证据整段迁入,it 体逐字节未动;共享装具在
// tests/helpers/hotReloadReceiverHarness.ts,设计说明见 hotReloadReceiverRoundtrip.test.ts 头注。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createHotReloadReceiverRoundtripHarness } from './helpers/hotReloadReceiverHarness';

describe('IDE-AUD-007 参考接收端真实回环联调(F3 七八九轮与九轮复审 路径/别名安全证据)', () => {
  let harness: ReturnType<typeof createHotReloadReceiverRoundtripHarness>;
  let engineDirs: string[];
  let outsideDirs: string[];
  let start: (typeof harness)['start'];
  let postReload: (typeof harness)['postReload'];
  let sha256: (typeof harness)['sha256'];

  beforeEach(() => {
    harness = createHotReloadReceiverRoundtripHarness();
    engineDirs = harness.engineDirs;
    outsideDirs = harness.outsideDirs;
    start = harness.start;
    postReload = harness.postReload;
    sha256 = harness.sha256;
  });

  afterEach(() => {
    harness.dispose();
  });

  // F3 五轮(R2-F3 硬化 4)→ 七轮机制:temp+rename 下哈希不符只在临时文件
  // 上发生,既有产物从未被触碰(不删不改写,强于「还原原内容」)。
  it('F3 七轮回归:哈希不符失败 → 预存在产物原样保留(不删不改写)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 31\n';
    writeFileSync(file, content, 'utf8');
    // 引擎目录里已有上一批 applied 的旧产物
    const engineFile = path.join(engineDir, 'Avatar.py');
    const oldContent = 'class Avatar:\n    HP = 30\n';
    writeFileSync(engineFile, oldContent, 'utf8');
    const wrongDigest = sha256('drifted away');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: wrongDigest } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('不一致');
    // 旧产物原样保留(temp+rename 下失败只清理临时文件,产物位未被写入)
    expect(readFileSync(engineFile, 'utf8')).toBe(oldContent);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 七轮回归:多文件批坏文件失败只清自己的临时文件,好文件照常 applied,坏文件旧产物原样', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const good = path.join(receiver.root, 'Avatar.py');
    const bad = path.join(receiver.root, 'Monster.py');
    const goodContent = 'class Avatar:\n    HP = 32\n';
    const badContent = 'class Monster:\n    HP = 33\n';
    writeFileSync(good, goodContent, 'utf8');
    writeFileSync(bad, badContent, 'utf8');
    // 坏文件在引擎目录里也有上一批 applied 的旧产物:失败只清坏文件自己的
    // 临时文件,旧产物原样,好文件不受牵连
    const badOld = 'class Monster:\n    HP = 30\n';
    writeFileSync(path.join(engineDir, 'Monster.py'), badOld, 'utf8');

    const response = await postReload(receiver.port, {
      files: [good, bad],
      sender_digests: { [good]: sha256(goodContent), [bad]: sha256('drifted baseline') }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string }>;
    const goodReceipt = receipts.find(receipt => receipt.file === good);
    const badReceipt = receipts.find(receipt => receipt.file === bad);
    expect(goodReceipt?.status).toBe('applied');
    expect(badReceipt?.status).toBe('failed');
    // 好文件产物逐字一致;坏文件旧产物原样(只清了它自己的临时文件)
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(goodContent);
    expect(readFileSync(path.join(engineDir, 'Monster.py'), 'utf8')).toBe(badOld);
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim().split('\n')[0])).toMatchObject({ file: good });
  });

  // F3 六轮(复审 FAIL-4 闭合):部分写入后抛错 → 残留被回滚清理,如实报告
  // 「无残留」。用 RLIMIT_FSIZE 构造真实的「写一半再抛错」:接收端在
  // ulimit -f 2(单文件 1024 字节上限)下运行,900B 源文件可暂存,但产物内容
  // (非法 UTF-8 字节读入后再编码为 1100B)落盘越过上限 → 写入中途 EFBIG,
  // 留下 1024B 部分写入残留,回滚必须把它清干净。
  // Windows:无 sh/ulimit,RLIMIT_FSIZE 故障注入不成立,跳过
  it.skipIf(process.platform === 'win32')('F3 六轮回归:部分写入后抛错(RLIMIT_FSIZE)→ 残留被清理,如实「无残留」', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir], 'ulimit -f 2');
    const file = path.join(receiver.root, 'Big.py');
    // 800×'A' + 100×0x80(非法 UTF-8):接收端 utf8 读入得 100 个 U+FFFD,
    // 再编码落盘 = 800 + 300 = 1100B > 1024B 上限;暂存副本(原始 900B)可过
    const raw = Buffer.concat([Buffer.alloc(800, 0x41), Buffer.alloc(100, 0x80)]);
    writeFileSync(file, raw);
    const decoded = readFileSync(file, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(decoded) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('落盘失败');
    // 部分写入残留(1024B 半成品)被回滚清理:引擎目录无残留,如实声明
    expect(existsSync(path.join(engineDir, 'Big.py'))).toBe(false);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(receipt.reason).toContain('无残留');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 七轮(复审 FAIL-1):根内外命名空间碰撞——六轮对暂存根之外的文件回落
  // 「绝对路径全结构展开」,但该回落与根内相对路径共享同一命名空间:根内
  // <root>/tmp/X.py 映射 tmp/X.py,根外 /tmp/X.py 回落也展开成 tmp/X.py,
  // 分批发送后者覆盖前者。修后根外路径直接拒绝整批,产物命名空间只剩根内
  // 相对路径一种归属。
  it('F3 七轮回归:根内 tmp/X.py 与根外 /tmp/X.py 分批发送 → 根外拒绝整批,产物不被覆盖', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 根内:<root>/tmp/X.py → 映射 tmp/X.py
    const insideFile = path.join(receiver.root, 'tmp', 'X.py');
    const contentA = 'X_INSIDE_ROOT = 61\n';
    mkdirSync(path.dirname(insideFile), { recursive: true });
    writeFileSync(insideFile, contentA, 'utf8');
    const first = await postReload(receiver.port, { files: [insideFile], sender_digests: { [insideFile]: sha256(contentA) } });
    expect(JSON.parse(first.body as string).status).toBe('applied');
    // 根外:/tmp/X.py(与暂存根只差最后一层目录名,回落展开同名 tmp/X.py)
    const outsideFile = path.join(os.tmpdir(), 'X.py');
    const hadOriginal = existsSync(outsideFile);
    const originalBytes = hadOriginal ? readFileSync(outsideFile) : undefined;
    const contentB = 'X_OUTSIDE_ROOT = 62\n';
    writeFileSync(outsideFile, contentB, 'utf8');
    try {
      const second = await postReload(receiver.port, { files: [outsideFile], sender_digests: { [outsideFile]: sha256(contentB) } });
      const receipt = JSON.parse(second.body) as { status: string; reason?: string };
      // 根外路径拒绝整批:不写盘、不落台账
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('暂存根之外');
      // 第一批的产物不被第二批覆盖,也不落引擎目录根
      expect(readFileSync(path.join(engineDir, 'tmp', 'X.py'), 'utf8')).toBe(contentA);
      expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
      // 台账只有第一批(根内)的 applied 记录,根外拒绝不产生任何台账条目
      const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
      const ledgerEntries = ledger.trim().split('\n').map(line => JSON.parse(line) as { file: string });
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0].file).toBe(insideFile);
    } finally {
      if (hadOriginal && originalBytes !== undefined) {
        writeFileSync(outsideFile, originalBytes);
      } else {
        rmSync(outsideFile, { force: true });
      }
    }
  });

  // F3 六轮(复审 FAIL-2)七轮补口:悬空 symlink 穿透——最终组件是指向引擎
  // 目录外**不存在文件**的 symlink 时,realpath 抛 ENOENT 回落到最深已存在
  // 祖先(引擎目录本身)→ 六轮防护误判安全 → 写入沿悬空链接把产物落到引擎
  // 目录外。修后写前 lstat 最终组件:是 symlink(无论悬空与否)一律拒绝。
  it('F3 七轮回归:产物位悬空 symlink 指向目录外 → 拒绝写入不逃逸', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-outside-'));
    outsideDirs.push(outsideDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 产物位 = 悬空 symlink → 引擎目录外的不存在文件
    symlinkSync(path.join(outsideDir, 'missing.py'), path.join(engineDir, 'Dangling.py'), 'file');
    const file = path.join(receiver.root, 'Dangling.py');
    const content = 'X_DANGLING_PROBE = 71\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 绝不沿悬空链接把产物写到引擎目录外,链接本身也不被动过
    expect(existsSync(path.join(outsideDir, 'missing.py'))).toBe(false);
    expect(lstatSync(path.join(engineDir, 'Dangling.py')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 七轮:lstat 拒链接不分悬空与否——产物位是**指向引擎目录内**的 symlink
  // 也一律拒绝(链接位被整体替换的语义不引入;产物只落自建普通文件)。
  it('F3 七轮回归:产物位 symlink 指向目录内也一律拒绝', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 引擎目录内真实文件,产物位是指向它的 symlink
    writeFileSync(path.join(engineDir, 'real.py'), 'REAL = 1\n', 'utf8');
    symlinkSync(path.join(engineDir, 'real.py'), path.join(engineDir, 'Linked.py'), 'file');
    const file = path.join(receiver.root, 'Linked.py');
    const content = 'X_LINKED_PROBE = 72\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 链接与其目标都原样
    expect(lstatSync(path.join(engineDir, 'Linked.py')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(engineDir, 'real.py'), 'utf8')).toBe('REAL = 1\n');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 八轮(复审缺陷 2):暂存副本不再按 basename 落暂存根顶层——同批
  // <root>/sub/X.py 与 <root>/X.py 的顶层暂存路径相同,前者暂存动作直接把
  // 后者的**源文件**覆盖掉(后续读到的是被污染内容,digest 自然不符)。修后
  // 每文件按已清洗防碰撞的报文相对路径独立展开到 <root>/.staged/<相对路径>,
  // 同批互不覆盖、也碰不到任何源文件。
  it('F3 八轮回归:同批 sub/X.py 与 X.py → 暂存互不覆盖,源文件不被暂存动作污染', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const subFile = path.join(receiver.root, 'sub', 'X.py');
    const topFile = path.join(receiver.root, 'X.py');
    const subContent = 'X_IN_SUB = 81\n';
    const topContent = 'X_AT_TOP = 82\n';
    mkdirSync(path.dirname(subFile), { recursive: true });
    writeFileSync(subFile, subContent, 'utf8');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [subFile, topFile],
      sender_digests: { [subFile]: sha256(subContent), [topFile]: sha256(topContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    const subReceipt = receipts.find(receipt => receipt.file === subFile);
    const topReceipt = receipts.find(receipt => receipt.file === topFile);
    // 两个文件各自 applied:暂存动作没有污染任何源文件
    expect(subReceipt?.status).toBe('applied');
    expect(topReceipt?.status).toBe('applied');
    // 源文件逐字原样(旧实现:sub/X.py 的暂存副本按 basename 覆盖 root/X.py 源文件)
    expect(readFileSync(subFile, 'utf8')).toBe(subContent);
    expect(readFileSync(topFile, 'utf8')).toBe(topContent);
    // 产物各归各的相对路径
    expect(readFileSync(path.join(engineDir, 'sub', 'X.py'), 'utf8')).toBe(subContent);
    expect(readFileSync(path.join(engineDir, 'X.py'), 'utf8')).toBe(topContent);
    // 暂存副本独立子目录,各自内容正确,不再落暂存根顶层
    expect(readFileSync(path.join(receiver.root, '.staged', 'sub', 'X.py'), 'utf8')).toBe(subContent);
    expect(readFileSync(path.join(receiver.root, '.staged', 'X.py'), 'utf8')).toBe(topContent);
  });

  // F3 八轮(复审缺陷 1):目录竞争包含性验证——产物父目录链中某级是**指向
  // 引擎目录内**的 symlink 时,六轮包含性检查放行(解析结果仍在引擎目录内),
  // 旧 rename 直接沿真实父目录落盘(路径实际经 symlink 组件到达别处)。修后
  // rename 前 realpath 父目录并做双重验证:包含性(在引擎目录 real 内)+ 一致性
  // (解析结果与原路径逐字一致,否则说明有 symlink 组件)→ 一致性不过即拒绝。
  // 竞态(检查后目录被换成外部 symlink)在同一代码路径上被同一验证拦截;
  // JS 无 O_NOFOLLOW,realpath→rename 一瞬的残余窗口如实记录(见设计 §4.3)。
  it('F3 八轮回归:父目录链含 symlink 组件(指向引擎目录内)→ rename 前拒绝,不落盘', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 产物父目录 sub 是指向引擎目录内 other/ 的 symlink:包含性检查(六轮)放行
    mkdirSync(path.join(engineDir, 'other'), { recursive: true });
    symlinkSync(path.join(engineDir, 'other'), path.join(engineDir, 'sub'), 'dir');
    const file = path.join(receiver.root, 'sub', 'X.py');
    const content = 'X_THROUGH_LINK = 83\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 旧实现沿 symlink 组件把产物落进 engineDir/other/X.py;修后不落盘
    expect(existsSync(path.join(engineDir, 'other', 'X.py'))).toBe(false);
    // 链接原样,无台账,引擎目录根无临时残留
    expect(lstatSync(path.join(engineDir, 'sub')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    const engineEntries = readdirSync(engineDir).filter(name => name.startsWith('.kode-artifact-tmp-'));
    expect(engineEntries).toHaveLength(0);
  });

  // F3 九轮(复审窄点 1):暂存命名空间仍在允许源文件树内——八轮把暂存副本
  // 展开到 <root>/.staged/<相对路径>,但源路径清洗不排除 .staged 前缀:同批
  // 含既有 <root>/.staged/X.py 源文件时,<root>/X.py 的暂存副本 copyFileSync
  // 直接覆盖该源文件。修后 .staged 前缀源路径属接收端暂存命名空间,拒绝整批。
  it('F3 九轮回归:同批含 .staged 命名空间源文件 → 拒绝整批,既有 .staged/X.py 源文件不被暂存覆盖', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const topFile = path.join(receiver.root, 'X.py');
    const stagedSource = path.join(receiver.root, '.staged', 'X.py');
    const topContent = 'X_AT_TOP = 91\n';
    const stagedContent = 'X_STAGED_SRC = 92\n';
    mkdirSync(path.dirname(stagedSource), { recursive: true });
    writeFileSync(topFile, topContent, 'utf8');
    writeFileSync(stagedSource, stagedContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, stagedSource],
      sender_digests: { [topFile]: sha256(topContent), [stagedSource]: sha256(stagedContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    // 拒绝整批:两个文件都 failed 且 reason 点名 .staged 暂存命名空间
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('.staged');
    }
    // 旧实现:topFile 的暂存副本落 <root>/.staged/X.py,直接覆盖既有源文件——
    // 修后两个源文件都逐字原样
    expect(readFileSync(stagedSource, 'utf8')).toBe(stagedContent);
    expect(readFileSync(topFile, 'utf8')).toBe(topContent);
    // 整批拒绝:无任何产物落盘、无暂存副本、无应用台账
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, '.staged', 'X.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 九轮(复审窄点 1,暂存路径 symlink):暂存写入此前无 symlink 检查——
  // .staged(或更深目录)被换成指向暂存根外的 symlink 时,copyFileSync 沿
  // 链接把暂存副本写到暂存根外。修后暂存写前做与 rename 目标同一套双重验证
  // (包含性+一致性)+ lstat 最终组件拒 symlink,任一不过即拒绝本文件暂存。
  it('F3 九轮回归:.staged 是指向暂存根外的 symlink → 拒绝暂存,副本不沿链接逃逸', async () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-outside-'));
    outsideDirs.push(outsideDir);
    const receiver = await start('stage', 'accepted');
    // 接收端尚未自建暂存目录,.staged 预置为指向暂存根外的目录 symlink
    const escapeDir = path.join(outsideDir, 'escape');
    mkdirSync(escapeDir, { recursive: true });
    symlinkSync(escapeDir, path.join(receiver.root, '.staged'), 'dir');
    const file = path.join(receiver.root, 'X.py');
    const content = 'X_STAGE_LINK = 93\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file] });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 暂存副本绝不沿链接落到暂存根外,链接原样
    expect(readdirSync(escapeDir)).toHaveLength(0);
    expect(lstatSync(path.join(receiver.root, '.staged')).isSymbolicLink()).toBe(true);
  });

  // F3 九轮复审 FAIL-1 补口:词法 '.staged' 排除挡不住指向暂存树的 symlink
  // 别名——root/alias → root/.staged 时,同批发送 [root/X.py, root/alias/A.py]
  // (A.py 预置于暂存树内),X.py 的暂存目标 .staged/X.py 虽不直接覆盖 A.py,
  // 但 alias/A.py 读取经别名落到暂存树内、内容可被批内暂存动作影响——整批
  // 必须在写入前拒绝。
  it('F3 九轮复审回归:源路径 symlink 别名指向暂存树 → 拒绝整批', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 既有真实源文件落在暂存树内,另经别名 symlink 指向暂存树
    const stagedSource = path.join(receiver.root, '.staged', 'A.py');
    const aliasFile = path.join(receiver.root, 'alias', 'A.py');
    const topFile = path.join(receiver.root, 'X.py');
    const stagedContent = 'A_IN_STAGED = 61\n';
    const topContent = 'X_AT_TOP = 62\n';
    mkdirSync(path.dirname(stagedSource), { recursive: true });
    writeFileSync(stagedSource, stagedContent, 'utf8');
    symlinkSync(path.join(receiver.root, '.staged'), path.dirname(aliasFile), 'dir');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, aliasFile],
      sender_digests: { [topFile]: sha256(topContent), [aliasFile]: sha256(stagedContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
    }
    // 暂存树内既有源文件不被批内暂存动作覆盖
    expect(readFileSync(stagedSource, 'utf8')).toBe(stagedContent);
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, 'alias', 'A.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 九轮复审 FAIL-A 补口:悬空别名源 + 批内暂存补齐目标——alias/X.py 在
  // 批处理起点指向不存在的 .staged/X.py,同批 X.py 的暂存动作恰好把它「补齐」,
  // 旧实现预检放行后读取阶段经别名读到 X.py 的暂存副本内容并照常 applied。
  // 修后预检 realpath 失败但 lstat 成功(悬空链接)= 无法证明不在暂存树内 →
  // 写入前拒绝整批。
  it('F3 九轮复审回归:悬空别名源被批内暂存补齐 → 预检拒绝整批,不产生经别名的 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const aliasDir = path.join(receiver.root, 'alias');
    const aliasFile = path.join(aliasDir, 'X.py');
    const topFile = path.join(receiver.root, 'X.py');
    const topContent = 'X_DANGLING_ALIAS = 64\n';
    // 暂存树目录预存在(上一批残留),目标文件尚不存在 → alias 悬空
    mkdirSync(path.join(receiver.root, '.staged'), { recursive: true });
    symlinkSync(path.join(receiver.root, '.staged'), aliasDir, 'dir');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, aliasFile],
      sender_digests: { [topFile]: sha256(topContent), [aliasFile]: sha256(topContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    // 旧实现:X.py 暂存补齐 .staged/X.py 后,alias/X.py 读取成功且 digest 恰与
    // 所发一致 → 两个 applied(经别名的应用通路);修后整批在写入前拒绝
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('符号链接');
    }
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, 'alias', 'X.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 九轮复审 FAIL-4 兼容性回归:--root 自身经合法 symlink 祖先到达(如
  // macOS /tmp → /private/tmp)时,一致性验证必须相对已解析的暂存根比较,
  // 不误拒正常暂存;树内 symlink 组件仍拒绝(由既有八/九轮回归钉住)。
  it('F3 九轮复审回归:暂存根经 symlink 祖先到达 → 正常暂存不误拒', async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-rootbase-'));
    engineDirs.push(baseDir); // 复用 afterEach 清理
    const engineDir = path.join(baseDir, 'engine');
    mkdirSync(engineDir, { recursive: true });
    // 真实根 + 经 symlink 到达的路径别名作为 --root
    const rootReal = path.join(baseDir, 'root-real');
    mkdirSync(rootReal, { recursive: true });
    symlinkSync(rootReal, path.join(baseDir, 'root-link'), 'dir');
    const rootViaLink = path.join(baseDir, 'root-link');
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir], undefined, rootViaLink);
    const file = path.join(rootViaLink, 'X.py');
    const content = 'X_ROOT_ALIAS = 63\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('applied');
    expect(readFileSync(path.join(engineDir, 'X.py'), 'utf8')).toBe(content);
    // 暂存副本按解析后的相对路径落盘,内容正确
    expect(readFileSync(path.join(rootReal, '.staged', 'X.py'), 'utf8')).toBe(content);

    // 三轮 FAIL-2 补口:根自身是合法 symlink 时,真实缺失的源文件不得被祖先
    // 链探测误判为「疑似悬空别名」而整批拒绝——保持「读不到所发文件」逐文件
    // 失败语义,另一文件照常 applied
    const missingFile = path.join(rootViaLink, 'missing.py');
    const response2 = await postReload(receiver.port, {
      files: [file, missingFile],
      sender_digests: { [file]: sha256(content), [missingFile]: sha256('whatever') }
    });
    const receipts2 = JSON.parse(response2.body) as Array<{ status: string; file: string; reason?: string }>;
    const missingReceipt = receipts2.find(r => r.file === missingFile);
    const goodReceipt = receipts2.find(r => r.file === file);
    expect(missingReceipt?.status).toBe('failed');
    expect(missingReceipt?.reason).toContain('读不到');
    expect(goodReceipt?.status).toBe('applied');
  });

  // F3 九轮复审三轮 FAIL-1 补口:源文件**自身**是悬空 symlink(final 组件)
  // 时同样会在批内暂存补齐目标后经别名复活——预检必须连文件自身一起查。
  it('F3 九轮复审回归:源文件自身为悬空 symlink → 预检拒绝整批', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const aliasFile = path.join(receiver.root, 'alias.py');
    const topFile = path.join(receiver.root, 'X.py');
    const topContent = 'X_FILE_ALIAS = 65\n';
    // 暂存树目录预存在,alias.py → .staged/X.py(尚不存在,悬空)
    mkdirSync(path.join(receiver.root, '.staged'), { recursive: true });
    symlinkSync(path.join(receiver.root, '.staged', 'X.py'), aliasFile, 'file');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, aliasFile],
      sender_digests: { [topFile]: sha256(topContent), [aliasFile]: sha256(topContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('符号链接');
    }
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, 'alias.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });
});
