// SRC-012 可选拆(2026-11-09)自 hotReloadReceiverRoundtrip.test.ts:F3 四轮至六轮
// apply/回滚/子目录映射证据整段迁入,it 体逐字节未动;共享装具在
// tests/helpers/hotReloadReceiverHarness.ts,设计说明见 hotReloadReceiverRoundtrip.test.ts 头注。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createHotReloadReceiverRoundtripHarness } from './helpers/hotReloadReceiverHarness';

describe('IDE-AUD-007 参考接收端真实回环联调(F3 四五六轮 apply/回滚/映射证据)', () => {
  let harness: ReturnType<typeof createHotReloadReceiverRoundtripHarness>;
  let engineDirs: string[];
  let outsideDirs: string[];
  let start: (typeof harness)['start'];
  let makeTransport: (typeof harness)['makeTransport'];
  let postReload: (typeof harness)['postReload'];
  let sha256: (typeof harness)['sha256'];

  beforeEach(() => {
    harness = createHotReloadReceiverRoundtripHarness();
    engineDirs = harness.engineDirs;
    outsideDirs = harness.outsideDirs;
    start = harness.start;
    makeTransport = harness.makeTransport;
    postReload = harness.postReload;
    sha256 = harness.sha256;
  });

  afterEach(() => {
    harness.dispose();
  });

  // F3 四轮:apply 模式未配置引擎产物目录 → 接收端写不了产物,只暂存不自称
  // applied,如实回 accepted + 未配置原因。
  it('F3 四轮回归:apply 模式未配置引擎产物目录 → 只暂存不自称 applied,如实回 accepted', async () => {
    const receiver = await start('apply', 'applied');
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    pass\n';
    writeFileSync(file, content, 'utf8');

    const summary = await makeTransport(receiver.port).send(
      { rootId: '/ws', targetId: 'cellapp-1' },
      [file],
      () => {},
      new Map([[file, sha256(content)]])
    );
    expect(summary.receipts[0].status).not.toBe('applied');
    expect(summary.receipts[0]).toMatchObject({ status: 'accepted', file });
    expect((summary.receipts[0] as { note?: string }).note).toContain('--artifact-dir');
    // 没有真实应用 → 不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 四轮(设计级):外部应用命令的副作用不可证实——接收端无法证明引擎目录
  // 里的产物是本次命令写的,命令退出 0 也最多 accepted(视为不可证实的副作用),
  // 绝不自称 applied、不落应用台账。
  it('F3 四轮回归:外部应用命令退出 0 → 降级 accepted(不可证实的副作用),绝不 applied 不落台账', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // 命令真实把产物写进引擎目录(副作用真实发生),但接收端证明不了是它写的
    // (Windows:路径字面量里的反斜杠在 JS 字符串转义后被吞,统一改正斜杠)
    const engineDirArg = process.platform === 'win32' ? engineDir.replace(/\\/g, '/') : engineDir;
    const applyCommand = `node -e "const fs=require('fs'),p=require('path');const d='${engineDirArg}';fs.mkdirSync(d,{recursive:true});fs.copyFileSync(process.env.KODE_RELOAD_FILE,p.join(d,p.basename(process.env.KODE_RELOAD_FILE)))"`;
    const receiver = await start('apply', 'applied', ['--apply-command', applyCommand, '--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 300\n';
    writeFileSync(file, content, 'utf8');

    const summary = await makeTransport(receiver.port).send(
      { rootId: '/ws', targetId: 'cellapp-1' },
      [file],
      () => {},
      new Map([[file, sha256(content)]])
    );
    // 降级:最多 accepted,绝不 applied
    expect(summary.receipts[0].status).not.toBe('applied');
    expect(summary.receipts[0]).toMatchObject({ status: 'accepted', file });
    expect((summary.receipts[0] as { note?: string }).note).toContain('不可证实');
    // 命令的副作用真实发生(引擎目录有产物),但回执仍不自称 applied
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(content);
    // 不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 回归:外部应用命令执行失败 → 如实回 failed(副作用失败是真失败)', async () => {
    const receiver = await start('apply', 'applied', ['--apply-command', 'node -e "process.exit(3)"']);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const summary = await makeTransport(receiver.port).send({ rootId: '/ws', targetId: 'cellapp-1' }, [file], () => {});
    expect(summary.receipts[0].status).toBe('failed');
    expect((summary.receipts[0] as { reason?: string }).reason).toContain('应用命令');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 四轮回归:外部应用命令空操作(退出 0、不写引擎产物)→ 降级 accepted,不存在假 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', [
      '--apply-command', 'node -e "process.exit(0)"',
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 1\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    expect(response.status).toBe(200);
    const receipt = JSON.parse(response.body) as { status: string; note?: string };
    // 旧实现:空操作命令仍能借产物核验/前后哈希假 applied;修后外部命令模式
    // 一律降级 accepted——空操作场景从设计上不存在假 applied
    expect(receipt.status).toBe('accepted');
    expect(receipt.note).toContain('不可证实');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 引擎目录没有产物(空操作什么都没写)
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 四轮回归:接收端自己写产物但 sender_digest 与内容不符 → failed 且产物回滚(引擎目录无残留)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // 接收端自己写产物模式(无外部命令);sender_digest 是别的内容的哈希
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 2\n';
    writeFileSync(file, content, 'utf8');
    const wrongDigest = sha256('not what the receiver will read');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: wrongDigest } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('不一致');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 哈希不符 → 已写产物回滚:引擎目录无残留
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 四轮回归:报文缺 sender_digest → 接收端不写产物不自称 applied,如实 failed', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const response = await postReload(receiver.port, { files: [file] });
    const receipt = JSON.parse(response.body) as { status: string };
    expect(receipt.status).toBe('failed');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 无比对基准就不落盘:引擎目录无产物
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 六轮回归:读旧产物失败(目录占位,非 ENOENT)→ 拒绝写入不删除,不自称 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 7\n';
    writeFileSync(file, content, 'utf8');
    // 产物路径被目录占用 → 写前读旧产物抛 EISDIR(非 ENOENT):不得当作
    // 「不存在」继续写,必须拒绝写入且不动已存在的产物
    const engineFile = path.join(engineDir, 'Avatar.py');
    writeFileSync(path.join(engineDir, 'placeholder'), '', 'utf8');
    mkdirSync(engineFile, { recursive: true });

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('读旧产物失败');
    // 已存在的产物(此处为目录)保持原样,没有被删除/清理
    expect(existsSync(engineFile)).toBe(true);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 五轮(R2-F3 硬化 1+2)→ 七轮按 temp+rename 机制重造:落盘全部发生在
  // 自建临时文件上('wx' 独占创建),引擎目录只读(0o555)时临时文件创建即
  // 失败 → failed;既有产物从头到尾未被触碰、无临时文件残留。(旧构造
  // 「0444 只读旧产物」在 temp+rename 下 rename 原子替换不读目标权限,如实
  // applied——该场景由目录级只读替代构造真实的落盘失败。)
  // Windows:目录只读位不阻止子文件创建,0o555 故障注入不成立,跳过
  it.skipIf(process.platform === 'win32')('F3 七轮回归:引擎目录只读(0o555)落盘失败 → failed,既有产物原样无残留', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 11\n';
    writeFileSync(file, content, 'utf8');
    // 既有旧产物 + 引擎目录只读:临时文件创建失败 → 落盘失败,旧产物不被触碰
    const engineFile = path.join(engineDir, 'Avatar.py');
    const oldContent = 'class Avatar:\n    HP = 10\n';
    writeFileSync(engineFile, oldContent, 'utf8');
    chmodSync(engineDir, 0o555);

    try {
      const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
      const receipt = JSON.parse(response.body) as { status: string; reason?: string; rollback_failed?: string };
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('落盘失败');
      // 既有产物逐字节原样(temp+rename 下失败收尾不碰产物)
      expect(readFileSync(engineFile, 'utf8')).toBe(oldContent);
      // 无临时文件残留,回执不虚报 rollback_failed
      expect(readdirSync(engineDir).filter(name => name.startsWith('.kode-artifact-tmp-'))).toEqual([]);
      expect(receipt).not.toHaveProperty('rollback_failed');
      expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    } finally {
      chmodSync(engineDir, 0o755);
    }
  });

  // F3 六轮(复审 FAIL-3a):写前读旧产物把一切异常当 ENOENT → EACCES 时误判
  // 「不存在」,失败回滚 unlink 把预存在产物误删。修后仅 ENOENT 视为不存在,
  // 其他读异常如实拒绝写入且绝不删除。
  // Windows:chmod 000 不产生读 EACCES,前提不成立
  it.skipIf(process.platform === 'win32')('F3 六轮回归:读旧产物 EACCES → 拒绝写入且不误删预存在产物', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 50\n';
    writeFileSync(file, content, 'utf8');
    // 预存在产物不可读(0000):写前读抛 EACCES → 不得当作不存在
    const engineFile = path.join(engineDir, 'Avatar.py');
    writeFileSync(engineFile, 'class Avatar:\n    HP = 49\n', 'utf8');
    chmodSync(engineFile, 0o000);

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('读旧产物失败');
    // 预存在产物不被误删(旧实现把读失败当不存在,失败回滚 unlink 误删)
    expect(existsSync(engineFile)).toBe(true);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    chmodSync(engineFile, 0o644);
  });

  // F3 六轮(复审 FAIL-3b):旧内容以 UTF-8 字符串保存,非 UTF-8 文件无法按
  // 原字节恢复。修后旧内容以 Buffer 保存恢复,逐字节还原。
  it('F3 六轮回归:非 UTF-8 旧产物失败回滚按原字节恢复(Buffer)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 51\n';
    writeFileSync(file, content, 'utf8');
    // 预存在旧产物含非法 UTF-8 字节:回滚必须按原字节还原,不得经 UTF-8 转码
    const engineFile = path.join(engineDir, 'Avatar.py');
    const rawOld = Buffer.from([0x41, 0x80, 0x42, 0xff, 0x43, 0x0a]);
    writeFileSync(engineFile, rawOld);

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256('drifted away') } });
    const receipt = JSON.parse(response.body) as { status: string };
    expect(receipt.status).toBe('failed');
    // 逐字节一致(旧实现 utf8 读→utf8 写会把 0x80/0xff 变成 U+FFFD,字节改变)
    const restored = readFileSync(engineFile);
    expect(Buffer.compare(restored, rawOld)).toBe(0);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 四轮回归:多文件批一个 digest 不符 → 该文件 failed 且只回滚该文件,另一文件照常 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const good = path.join(receiver.root, 'Avatar.py');
    const bad = path.join(receiver.root, 'Monster.py');
    const goodContent = 'class Avatar:\n    HP = 8\n';
    const badContent = 'class Monster:\n    HP = 9\n';
    writeFileSync(good, goodContent, 'utf8');
    writeFileSync(bad, badContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [good, bad],
      // bad 的 sender_digest 故意给错的(别的内容的哈希)
      sender_digests: { [good]: sha256(goodContent), [bad]: sha256('drifted baseline') }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    const goodReceipt = receipts.find(receipt => receipt.file === good);
    const badReceipt = receipts.find(receipt => receipt.file === bad);
    expect(goodReceipt?.status).toBe('applied');
    expect(badReceipt?.status).toBe('failed');
    expect(badReceipt?.reason).toContain('不一致');
    // 好文件产物在,坏文件产物已回滚
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(goodContent);
    expect(existsSync(path.join(engineDir, 'Monster.py'))).toBe(false);
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim().split('\n')[0])).toMatchObject({ file: good });
  });

  // F3 五轮(R2-F3 硬化 3):产物路径不再只用 basename——按报文内相对路径
  // 映射到 --artifact-dir 子结构,不同目录同名文件各归各,不相互踩踏。
  it('F3 五轮回归:不同目录同名文件 → 按报文相对路径映射子目录,不碰撞各自 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const fileA = path.join(receiver.root, 'subA', 'Monster.py');
    const fileB = path.join(receiver.root, 'subB', 'Monster.py');
    const contentA = 'class MonsterA:\n    HP = 21\n';
    const contentB = 'class MonsterB:\n    HP = 22\n';
    mkdirSync(path.dirname(fileA), { recursive: true });
    mkdirSync(path.dirname(fileB), { recursive: true });
    writeFileSync(fileA, contentA, 'utf8');
    writeFileSync(fileB, contentB, 'utf8');

    const response = await postReload(receiver.port, {
      files: [fileA, fileB],
      sender_digests: { [fileA]: sha256(contentA), [fileB]: sha256(contentB) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string }>;
    expect(receipts).toHaveLength(2);
    expect(receipts.map(receipt => receipt.status)).toEqual(['applied', 'applied']);
    // 各归各的子路径:同名不踩踏,内容逐字一致
    expect(readFileSync(path.join(engineDir, 'subA', 'Monster.py'), 'utf8')).toBe(contentA);
    expect(readFileSync(path.join(engineDir, 'subB', 'Monster.py'), 'utf8')).toBe(contentB);
  });

  // F3 六轮(复审 FAIL-1):映射必须跨批确定——不做批内共同祖先剥离,永远按
  // 报文内完整相对路径展开,与批次组成无关。旧实现 subA/X.py、subB/X.py 同批
  // → 各归子目录;分两次单文件发送 → 都映射到引擎目录根 X.py,后者覆盖前者。
  it('F3 六轮回归:跨批确定性映射——subA/X.py、subB/X.py 分两次单文件发送,各落子路径不覆盖', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const fileA = path.join(receiver.root, 'subA', 'X.py');
    const fileB = path.join(receiver.root, 'subB', 'X.py');
    const contentA = 'X_IN_SUB_A = 41\n';
    const contentB = 'X_IN_SUB_B = 42\n';
    mkdirSync(path.dirname(fileA), { recursive: true });
    mkdirSync(path.dirname(fileB), { recursive: true });
    writeFileSync(fileA, contentA, 'utf8');
    writeFileSync(fileB, contentB, 'utf8');

    // 第一批:只发 subA/X.py(单文件批)
    const first = await postReload(receiver.port, { files: [fileA], sender_digests: { [fileA]: sha256(contentA) } });
    const firstReceipt = JSON.parse(first.body) as { status: string };
    expect(firstReceipt.status).toBe('applied');
    // 第二批:只发 subB/X.py(单文件批)——批次组成不同,落位必须不变
    const second = await postReload(receiver.port, { files: [fileB], sender_digests: { [fileB]: sha256(contentB) } });
    const secondReceipt = JSON.parse(second.body) as { status: string };
    expect(secondReceipt.status).toBe('applied');
    // 各落各的子路径:第二批发送不覆盖第一批的产物,也不再裸落引擎目录根
    expect(readFileSync(path.join(engineDir, 'subA', 'X.py'), 'utf8')).toBe(contentA);
    expect(readFileSync(path.join(engineDir, 'subB', 'X.py'), 'utf8')).toBe(contentB);
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
  });

  // F3 六轮(复审 FAIL-2):字符串检查防不住产物目录内的符号链接——产物落位
  // 的某级目录是指向引擎目录外的 symlink 时,沿它写入会把产物写到引擎目录外。
  // 修后:写/unlink 前对目标 realpath 解析,验证仍在 artifact-dir 内,否则拒绝。
  it('F3 六轮回归:产物目录内符号链接指向目录外 → 拒绝写入不落盘', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-outside-'));
    outsideDirs.push(outsideDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 产物子路径 subLink 是指向引擎目录外的 symlink
    symlinkSync(outsideDir, path.join(engineDir, 'subLink'), 'dir');
    const file = path.join(receiver.root, 'subLink', 'X.py');
    const content = 'X_ESCAPE_PROBE = 51\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('逃逸');
    // 绝不沿 symlink 把产物写到引擎目录外,也不在链接处落任何东西
    expect(existsSync(path.join(outsideDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 五轮(R2-F3 硬化 3 防线):清洗后仍映射到同一产物位置(同一路径在批
  // 内重复出现)→ 拒绝整批,不写任何盘、不落台账。
  it('F3 五轮回归:批内映射到同一产物位置(同一路径重复)→ 拒绝整批不写盘', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 23\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, {
      files: [file, file],
      sender_digests: { [file]: sha256(content) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('拒绝整批');
    }
    // 整批拒绝:引擎目录不写任何产物,不落任何 applied 台账
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });
});
