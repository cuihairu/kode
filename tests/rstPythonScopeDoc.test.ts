import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-001 修正 R1 的 Python 泛化结论:R1 审计把「全量 Python 冷扫
// 107.7s→4.88s」泛化成 Python 面整体不值得迁移、交互无卡;同日架构审计
// 实测了反例——pythonReturnTypeInference 的返回注解索引构建在 Python
// hover 路径同步执行并绕过 worker,8,000 方法文件 51.27 秒,普通变量
// hover 2,200 方法文件两次 3,480.79/3,287.03ms 且结果为空。修正要求:
// 保留 4.88 秒冷扫事实,补反例与范围说明(反例机制此后已由 TS 修法
// 修复,「不值得」降格为范围判断,不得再由扫描面泛化到整个交互面)。

const root = join(__dirname, '..');
const readDoc = (relative: string): string =>
  readFileSync(join(root, relative), 'utf8');
const r1 = readDoc('docs/review/2026-10-27-r1-migration-data-audit.md');
const audit = readDoc('docs/review/2026-10-27-kbengine-ide-architecture-audit.md');

describe('R1 Python 泛化结论修正(IDE-RST-001)', () => {
  it('保留 4.88 秒冷扫事实(修正不删原始数据行)', () => {
    for (const fact of ['107,737 ms', '4,880 ms', '22×', '4.88']) {
      expect(r1, `R1 缺冷扫事实 ${fact}`).toContain(fact);
    }
  });

  it('R1 补 51.27 秒反例与普通变量 hover 实测', () => {
    for (const fact of ['51.27', '51,271.48', '3,480.79', '3,287.03', 'pythonReturnTypeInference']) {
      expect(r1, `R1 缺反例事实 ${fact}`).toContain(fact);
    }
  });

  it('范围说明在位:反例指向 hover 路径且绕过 worker,结论降格为范围判断', () => {
    for (const note of ['绕过', '范围判断', '同步', 'hover 路径']) {
      expect(r1, `R1 缺范围说明 ${note}`).toContain(note);
    }
    // 修正必须记录反例机制其后已修:异步化/取消/修复提交面
    expect(r1).toContain('7a29a6c');
    expect(r1).toMatch(/异步|可取消/);
  });

  it('反例源文档在档且仍含原始数字(防漂移)', () => {
    for (const fact of ['51.27', '51,271.48', '3,480.79', 'PERF-01']) {
      expect(audit, `架构审计缺 ${fact}`).toContain(fact);
    }
  });
});
