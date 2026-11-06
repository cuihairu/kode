import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// F3 八轮(2026-11-08 复审):接收端两处精确缺陷的单元级红绿钉——
// ①失败收尾清理必须以「确认自建」为前提(wx 独占创建失败/EEXIST 时该路径上
//   的既有文件不是本次创建的,绝不触碰);
// ②rename 目标父目录必须做 realpath 包含性 + 与原路径逐字一致性双重验证
//   (中间目录被竞态换成 symlink 后,六轮只验包含性、不验一致性,rename 会
//   沿真实父目录落盘;一致性验证把该路径钉死为拒绝)。
// 参考接收端以 ES 模块导出这两个内部助手(脚本直接运行行为不变)。
// F3 九轮(2026-11-06 复审):收尾清理在「确认自建」之上再钉 **dev/ino 比对**——
// 创建时 fstatSync(fd) 捕获临时文件 dev/ino;收尾 unlink 前 lstat 比对路径
// 当前 dev/ino 与捕获一致才删,不符或捕获缺失跳过并如实报 rollback_skipped。
// lstat 比对→unlink 一瞬的残余竞态窗口如实为已知限制(见 design §4.3)。
interface TempCleanupReceipt {
  status: string;
  reason: string;
  rollback_failed?: string;
  rollback_skipped?: string;
}

const receiverModule = (await import('../scripts/hot-reload-receiver/referenceReceiver.mjs')) as {
  tempCleanupReceipt: (
    file: string,
    tempArtifact: string,
    reasonBase: string,
    created: boolean,
    createdStat?: { dev: number; ino: number }
  ) => TempCleanupReceipt;
  verifiedRealParentForRename: (dir: string, artifactDirReal: string) => string | undefined;
};

const { tempCleanupReceipt, verifiedRealParentForRename } = receiverModule;

describe('F3 八轮:接收端失败收尾清理标志位 + rename 父目录双重验证', () => {
  const dirs: string[] = [];

  const scratch = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-helper-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('清理标志位=false:同名既有文件不是本次创建,收尾绝不触碰', () => {
    const dir = scratch();
    const foreign = path.join(dir, '.kode-artifact-tmp-foreign');
    writeFileSync(foreign, 'PRE_EXISTING_FOREIGN_BYTES', 'utf8');

    const receipt = tempCleanupReceipt('/engine/Avatar.py', foreign, '应用产物落盘失败:EEXIST', false);

    expect(receipt.status).toBe('failed');
    // 未自建 → 不清理也不谎报残留
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(existsSync(foreign)).toBe(true);
    expect(readFileSync(foreign, 'utf8')).toBe('PRE_EXISTING_FOREIGN_BYTES');
  });

  it('清理标志位=true:确认自建的临时文件,收尾清理且如实「无残留」', () => {
    const dir = scratch();
    const mine = path.join(dir, '.kode-artifact-tmp-mine');
    writeFileSync(mine, 'SELF_CREATED_BYTES', 'utf8');
    // 九轮起收尾清理要求创建点 dev/ino 捕获(缺失=身份无法确认→跳过不删)
    const fd = openSync(mine, 'r');
    const createdStat = { dev: fstatSync(fd).dev, ino: fstatSync(fd).ino };
    closeSync(fd);

    const receipt = tempCleanupReceipt('/engine/Avatar.py', mine, '应用产物 sha256 与 sender_digest 不一致', true, createdStat);

    expect(receipt.status).toBe('failed');
    expect(existsSync(mine)).toBe(false);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(receipt.reason).toContain('无残留');
  });

  it('清理标志位=true 但目标已不存在:清理目标已达成,不谎报残留', () => {
    const dir = scratch();
    const gone = path.join(dir, '.kode-artifact-tmp-gone');
    const receipt = tempCleanupReceipt('/engine/Avatar.py', gone, '应用产物落盘失败:x', true);
    expect(receipt).not.toHaveProperty('rollback_failed');
  });

  // F3 九轮:路径被竞态替换后按路径 unlink 会删掉不是本次创建的文件——
  // 创建时 fstat 捕获 dev/ino,收尾 unlink 前 lstat 比对当前路径与之一致才删,
  // 不符跳过报 rollback_skipped
  it('清理标志位=true 且 dev/ino 与创建时不符(路径已被替换)→ 跳过清理报 rollback_skipped,不按路径盲删', () => {
    const dir = scratch();
    const mine = path.join(dir, '.kode-artifact-tmp-mine');
    // 创建后路径被竞态替换:同路径上现在是别的文件(dev/ino 已变)。替换文件
    // 先于目标文件存在(rename 保其原 inode)——两文件曾同时存在,inode 必不同,
    // 避免「删除后同 inode 复用」造成假通过
    const replacement = path.join(dir, '.kode-artifact-tmp-replacement');
    writeFileSync(replacement, 'RACED_FOREIGN_BYTES', 'utf8');
    writeFileSync(mine, 'SELF_CREATED_BYTES', 'utf8');
    const fd = openSync(mine, 'r');
    const createdStat = { dev: fstatSync(fd).dev, ino: fstatSync(fd).ino };
    closeSync(fd);
    renameSync(replacement, mine);

    const receipt = tempCleanupReceipt('/engine/Avatar.py', mine, '应用产物落盘失败:x', true, createdStat);

    expect(receipt.status).toBe('failed');
    expect(receipt.rollback_skipped).toBe(mine);
    expect(receipt).not.toHaveProperty('rollback_failed');
    // 被替换上去的文件原样保留(旧实现按路径 unlink 直接删掉;修后比对不符
    // 即跳过。lstat 比对→unlink 一瞬的残余竞态窗口如实为已知限制)
    expect(readFileSync(mine, 'utf8')).toBe('RACED_FOREIGN_BYTES');
  });

  it('清理标志位=true 且 dev/ino 与创建时一致 → 照常清理自建临时文件', () => {
    const dir = scratch();
    const mine = path.join(dir, '.kode-artifact-tmp-mine');
    writeFileSync(mine, 'SELF_CREATED_BYTES', 'utf8');
    const fd = openSync(mine, 'r');
    const createdStat = { dev: fstatSync(fd).dev, ino: fstatSync(fd).ino };
    closeSync(fd);

    const receipt = tempCleanupReceipt('/engine/Avatar.py', mine, '应用产物 sha256 与 sender_digest 不一致', true, createdStat);

    expect(receipt.status).toBe('failed');
    expect(existsSync(mine)).toBe(false);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(receipt).not.toHaveProperty('rollback_skipped');
    expect(receipt.reason).toContain('无残留');
  });

  // F3 九轮复审 FAIL-2:创建点 dev/ino 捕获缺失(created=true 但 createdStat
  // 不可用,如 fstatSync 失败)时,身份无法确认——宁留残留也不按路径盲删,
  // 如实报 rollback_skipped(旧实现直接按路径 unlink)
  it('清理标志位=true 但 dev/ino 捕获缺失 → 跳过清理报 rollback_skipped,不按路径盲删', () => {
    const dir = scratch();
    const mine = path.join(dir, '.kode-artifact-tmp-mine');
    writeFileSync(mine, 'UNVERIFIABLE_BYTES', 'utf8');

    const receipt = tempCleanupReceipt('/engine/Avatar.py', mine, '应用产物落盘失败:x', true, undefined);

    expect(receipt.status).toBe('failed');
    expect(receipt.rollback_skipped).toBe(mine);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(readFileSync(mine, 'utf8')).toBe('UNVERIFIABLE_BYTES');
  });

  it('rename 父目录验证:无 symlink 的真实目录 → 返回解析路径', () => {
    const dir = scratch();
    const engineReal = mkdtempSync(path.join(dir, 'engine-'));
    const parent = path.join(engineReal, 'sub');
    mkdirSync(parent, { recursive: true });
    expect(verifiedRealParentForRename(parent, engineReal)).toBe(parent);
    expect(verifiedRealParentForRename(engineReal, engineReal)).toBe(engineReal);
  });

  it('rename 父目录验证:中间组件是 symlink(即使指向引擎目录内)→ 拒绝', () => {
    const dir = scratch();
    const engineReal = mkdtempSync(path.join(dir, 'engine-'));
    const other = path.join(engineReal, 'other');
    mkdirSync(other, { recursive: true });
    // sub → other(引擎目录内):六轮只验包含性会放行;八轮一致性验证必须拒绝
    symlinkSync(other, path.join(engineReal, 'sub'), 'dir');
    const through = path.join(engineReal, 'sub');
    expect(verifiedRealParentForRename(through, engineReal)).toBeUndefined();
  });

  it('rename 父目录验证:解析到引擎目录外(外部 symlink)→ 拒绝', () => {
    const dir = scratch();
    const engineReal = mkdtempSync(path.join(dir, 'engine-'));
    const outside = mkdtempSync(path.join(dir, 'outside-'));
    symlinkSync(outside, path.join(engineReal, 'esc'), 'dir');
    expect(verifiedRealParentForRename(path.join(engineReal, 'esc'), engineReal)).toBeUndefined();
  });

  it('rename 父目录验证:父目录不存在(realpath 失败)→ 拒绝', () => {
    const dir = scratch();
    const engineReal = mkdtempSync(path.join(dir, 'engine-'));
    expect(verifiedRealParentForRename(path.join(engineReal, 'missing', 'deep'), engineReal)).toBeUndefined();
  });
});
