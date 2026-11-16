// RUST-244(旧 QA-015)守卫:每个修复 PR 附复现脚本、测试证据、
// profile/perf delta、回退计划——四字段落在 .github/PULL_REQUEST_TEMPLATE.md
// (GitHub 建 PR 自动载入),本测试锁字段齐全,漂移删除即红(docsCommands
// 同款守卫法:直接读目标面断言结构)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('RUST-244 PR 模板四字段守卫(旧 QA-015)', () => {
  it('PULL_REQUEST_TEMPLATE.md 必含复现脚本/测试证据/profile-perf delta/回退计划', () => {
    const templatePath = path.resolve(__dirname, '../.github/PULL_REQUEST_TEMPLATE.md');
    expect(fs.existsSync(templatePath), '.github/PULL_REQUEST_TEMPLATE.md 不存在').toBe(true);
    const template = fs.readFileSync(templatePath, 'utf8');
    for (const heading of ['## 复现脚本', '## 测试证据', '## Profile/Perf delta', '## 回退计划']) {
      expect(template.includes(heading), `PR 模板缺 QA-015 四字段之一: ${heading}`).toBe(true);
    }
    expect(template.length, 'PR 模板疑似被清空').toBeGreaterThan(200);
  });

  it('CONTRIBUTING.md PR 描述节与模板四字段一致(防双模板漂移)', () => {
    const contributing = fs.readFileSync(path.resolve(__dirname, '../CONTRIBUTING.md'), 'utf8');
    for (const heading of ['复现脚本', '测试证据', 'Profile/Perf delta', '回退计划']) {
      expect(contributing.includes(heading), `CONTRIBUTING PR 描述缺四字段之一: ${heading}`).toBe(true);
    }
  });
});
