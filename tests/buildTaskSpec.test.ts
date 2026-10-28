import { describe, expect, it } from 'vitest';
import {
  BUILD_TASK_TYPE,
  buildScriptCheckTaskSpec,
  formatBuildTaskPreview
} from '../src/buildTaskSpec';

// IDE-TSK-001 profile 的构建任务描述:一个 profile(assets 根+解释器)
// → 一条可精确预览的脚本编译检查任务——command/args/cwd/env 四要素
// 齐全且预览与实际执行一致(TSK-002 的 TaskProvider 按此描述注册,
// TSK-003 的 problem matcher 吃同一输出)。

const profile = {
  id: 'p-1',
  displayName: '主工程',
  assetsRoot: '/ws/demo/assets',
  interpreterPath: '/usr/bin/python3.12'
};

describe('buildScriptCheckTaskSpec(任务描述四要素)', () => {
  it('完整 profile:解释器+compileall+scripts 目录,env 带编码稳定项', () => {
    const spec = buildScriptCheckTaskSpec(profile);

    expect(spec).not.toBeNull();
    expect(spec!.type).toBe(BUILD_TASK_TYPE);
    expect(spec!.profileId).toBe('p-1');
    expect(spec!.name).toContain('主工程');
    expect(spec!.command).toBe('/usr/bin/python3.12');
    expect(spec!.args).toEqual(['-m', 'compileall', '-q', '/ws/demo/assets/scripts']);
    expect(spec!.cwd).toBe('/ws/demo/assets');
    expect(spec!.env).toEqual({ PYTHONUTF8: '1' });
  });

  it('assetsRoot 尾斜杠归一,不产双斜杠目标', () => {
    const spec = buildScriptCheckTaskSpec({ ...profile, assetsRoot: '/ws/demo/assets/' });

    expect(spec!.args[3]).toBe('/ws/demo/assets/scripts');
  });

  it('解释器缺失:回退 python3 且明细如实标注(预览与实际执行一致)', () => {
    const spec = buildScriptCheckTaskSpec({ ...profile, interpreterPath: null });

    expect(spec!.command).toBe('python3');
    expect(spec!.detail.some(line => line.includes('python3') && line.includes('回退'))).toBe(true);
  });
});

describe('formatBuildTaskPreview(预览=准确执行内容)', () => {
  it('含 cd 行/命令行原文/env 逐条;带空格的路径加引号', () => {
    const spec = buildScriptCheckTaskSpec({
      ...profile,
      assetsRoot: '/ws/my demo/assets'
    })!;

    const preview = formatBuildTaskPreview(spec);

    const lines = preview.split('\n');
    expect(lines.some(line => line === 'cd "/ws/my demo/assets"')).toBe(true);
    expect(
      lines.some(line => line.includes('/usr/bin/python3.12 -m compileall -q "/ws/my demo/assets/scripts"'))
    ).toBe(true);
    expect(lines.some(line => line.includes('PYTHONUTF8=1'))).toBe(true);
    expect(preview).toContain(spec.name);
    expect(preview).toContain(BUILD_TASK_TYPE);
  });

  it('回退解释器的预览也带回退标注行', () => {
    const preview = formatBuildTaskPreview(buildScriptCheckTaskSpec({ ...profile, interpreterPath: null })!);
    expect(preview.split('\n').some(line => line.includes('回退'))).toBe(true);
  });
});
