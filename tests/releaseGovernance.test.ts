// RUST-246(旧 QA-017)守卫:自动发布必须遵循仓库既有的手动发布规则——
// 版本号只能由人手动给出(tag / 手动触发即人工授权),自动化只跟随:
//   正式 GitHub Release = ci.yml 跟随 refs/tags/v*(Marketplace 与裸发布两条
//   绕闸腿已于 2026-10-24 拆除,见 ci.yml 注释);
//   Marketplace = publish.yml workflow_dispatch + publisher/版本一致性闸;
//   npm = npm.yml workflow_dispatch + 版本一致性闸,两处发布步骤均 if: inputs.publish;
//   nightly = 滚动 tag 恒 'nightly' + --prerelease(不占正式版本号)。
// 本测试锁触发面与发布命令的通道唯一性,重构顺手改变 release governance 即红。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_DIR = path.resolve(__dirname, '../.github/workflows');

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
}

/** on: 触发块 = `on:` 行起至下一个顶层键(无缩进)或文件尾。 */
function triggerBlock(content: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex(line => line === 'on:');
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !(lines[end].length > 0 && !lines[end].startsWith(' ') && !lines[end].startsWith('#'))) {
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

const ALL_WORKFLOWS = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yml'));

describe('RUST-246 release governance 守卫(旧 QA-017)', () => {
  it('无任何 workflow 用 release 事件自动触发(防 release:created 自动发布回归)', () => {
    expect(ALL_WORKFLOWS.length, 'workflow 文件数漂移,守卫覆盖面需复核').toBeGreaterThanOrEqual(7);
    for (const file of ALL_WORKFLOWS) {
      const block = triggerBlock(readWorkflow(file));
      expect(block.match(/^\s{2}release:/m), `${file} 不得用 release 事件触发发布`).toBeNull();
    }
  });

  it('Marketplace/npm 发布命令只允许出现在各自的 dispatch-only workflow', () => {
    expect(readWorkflow('publish.yml').includes('vsce publish'), 'publish.yml 须含 vsce publish').toBe(true);
    expect(readWorkflow('npm.yml').includes('npm publish'), 'npm.yml 须含 npm publish').toBe(true);
    for (const file of ALL_WORKFLOWS) {
      const content = readWorkflow(file);
      if (file === 'publish.yml' && content.includes('vsce publish')) { continue; }
      expect(content.includes('vsce publish'), `vsce publish 漂移进 ${file},正道只有 publish.yml`).toBe(false);
      if (file === 'npm.yml' && content.includes('npm publish')) { continue; }
      expect(content.includes('npm publish'), `npm publish 漂移进 ${file},正道只有 npm.yml`).toBe(false);
    }
  });

  it('publish/npm 触发面仅 workflow_dispatch 且版本一致性闸在位', () => {
    for (const file of ['publish.yml', 'npm.yml']) {
      const block = triggerBlock(readWorkflow(file));
      expect(block.match(/^\s{2}(push|pull_request|schedule|release|workflow_call):/m),
        `${file} 触发面只允许 workflow_dispatch`).toBeNull();
      expect(block.includes('workflow_dispatch'), `${file} 须保留手动触发入口`).toBe(true);
    }
    const publish = readWorkflow('publish.yml');
    const npm = readWorkflow('npm.yml');
    expect(publish.includes('v!==p.version'), 'publish.yml 缺版本一致性校验').toBe(true);
    expect(publish.includes('p.publisher!=="cuihairu"'), 'publish.yml 缺 publisher 校验').toBe(true);
    expect(npm.includes('v!==p.version'), 'npm.yml 缺版本一致性校验').toBe(true);
    expect(publish.includes('if: inputs.publish'), 'publish.yml 发布步骤须以 publish 输入为条件').toBe(true);
    expect(npm.includes('if: inputs.publish'), 'npm.yml 发布步骤须以 publish 输入为条件').toBe(true);
  });

  it('nightly 恒滚动 prerelease:tag 恒 nightly,不带版本号,不占正式版本', () => {
    const nightly = readWorkflow('nightly.yml');
    expect(nightly.includes('--prerelease'), 'nightly 发布必须标 --prerelease').toBe(true);
    expect(nightly.includes('gh release create nightly'), 'nightly tag 恒为 nightly 字面量').toBe(true);
    expect(nightly.match(/gh release create v/), 'nightly 不得创建版本号 release').toBeNull();
    expect(nightly.includes('48h no new commits'), 'nightly 保留 48h 停滞门(无更新不空转发布)').toBe(true);
  });

  it('ci.yml 正式 Release 只跟随 refs/tags/v*(tag 即人工授权),不给分支建 release', () => {
    const ci = readWorkflow('ci.yml');
    const block = triggerBlock(ci);
    expect(block.match(/^\s{6}-\s+'v\*'/m), 'ci on.tags 只允许 v* 通配').not.toBeNull();
    expect(ci.includes("startsWith(github.ref, 'refs/tags/v')"),
      'ci release 步骤须以 refs/tags/v* 为条件').toBe(true);
    expect(ci.match(/^\s{4}if:\s+refs:\s+branches:/m), '不得出现分支驱动的 release 条件').toBeNull();
    expect(ci.includes('gh release create'), 'ci 跟随 tag 建 release 的通道在位').toBe(true);
  });
});
