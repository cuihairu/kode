import { describe, expect, it, vi } from 'vitest';
import {
  detectEngineVersionMarker,
  engineVersionSuggestion,
  type EngineVersionDetectorDeps
} from '../src/backend/engineVersionDetect';

// KB-VER-004(todo.md「版本感知」):版本自动探测——从引擎安装目录读版本标记
// 并对 kbengine.engineVersion 只建议、绝不自动改用户设置。纯函数,fs 注入
// 桩;真实探测面(findEngineRoot/readEngineVersionMarker)由
// engineCompatibility.test.ts 覆盖,此处只测装配与建议决策。

const rootA = '/ws/a';
const rootB = '/ws/b';
const engineA = '/ws/a/kbe';
const engineB = '/ws/b/kbe';

const depsWith = (
  mapping: Record<string, { version?: string; root?: string | null }>
): EngineVersionDetectorDeps => ({
  findRoot: (startDirectory, explicitRoot) => {
    if (explicitRoot) return explicitRoot;
    const entry = mapping[startDirectory];
    return entry?.root ?? null;
  },
  readMarker: engineRoot => {
    // 版本挂在「工作区根条目」上,按该条目解出的引擎根反查版本
    const entry = Object.values(mapping).find(e => e.root === engineRoot);
    return entry?.version ?? null;
  }
});

describe('detectEngineVersionMarker(装配与首命中)', () => {
  it('单根命中:返回版本 + 引擎根', () => {
    const deps = depsWith({ [rootA]: { root: engineA, version: '2.5.10' } });
    expect(detectEngineVersionMarker([rootA], undefined, deps)).toEqual({
      version: '2.5.10',
      engineRoot: engineA
    });
  });

  it('多根:首个命中即返回,不扫描后续', () => {
    const deps = depsWith({
      [rootA]: { root: engineA, version: '2.5.10' },
      [rootB]: { root: engineB, version: '3.7.3' }
    });
    const findRoot = vi.fn(deps.findRoot);
    const result = detectEngineVersionMarker([rootA, rootB], undefined, { ...deps, findRoot });
    expect(result?.version).toBe('2.5.10');
    expect(findRoot).toHaveBeenCalledTimes(1);
  });

  it('首根无标记,续根命中', () => {
    const deps = depsWith({
      [rootA]: { root: engineA }, // readMarker → null
      [rootB]: { root: engineB, version: '3.7.3' }
    });
    expect(detectEngineVersionMarker([rootA, rootB], undefined, deps)?.version).toBe('3.7.3');
  });

  it('explicitRoot 透传给 findRoot(不再按工作区树探测)', () => {
    const findRoot = vi.fn(() => engineA);
    const readMarker = vi.fn(() => '2.5.10');
    const result = detectEngineVersionMarker([rootA], '/opt/engine', { findRoot, readMarker });
    expect(result?.version).toBe('2.5.10');
    expect(findRoot).toHaveBeenCalledWith(rootA, '/opt/engine');
  });

  it('全 miss:返回 null(标记缺失/畸形,绝不编造)', () => {
    const deps = depsWith({ [rootA]: { root: null } });
    expect(detectEngineVersionMarker([rootA], undefined, deps)).toBeNull();
    const nullMarker = depsWith({ [rootA]: { root: engineA } }); // readMarker → null
    expect(detectEngineVersionMarker([rootA], undefined, nullMarker)).toBeNull();
  });

  it('空工作区:返回 null', () => {
    expect(detectEngineVersionMarker([], undefined, depsWith({}))).toBeNull();
  });
});

describe('engineVersionSuggestion(建议决策)', () => {
  const detected = { version: '2.5.10', engineRoot: engineA };

  it('无探测结果:不建议(no-marker)', () => {
    expect(engineVersionSuggestion('3.7.3', null, undefined)).toEqual({
      kind: 'none',
      reason: 'no-marker'
    });
  });

  it('探测值等于当前设置:不建议(matches)', () => {
    expect(engineVersionSuggestion('2.5.10', detected, undefined)).toEqual({
      kind: 'none',
      reason: 'matches'
    });
  });

  it('当前设置经归一后相等(带空白):不建议(matches)', () => {
    expect(engineVersionSuggestion('  2.5.10  ', detected, undefined)).toEqual({
      kind: 'none',
      reason: 'matches'
    });
  });

  it('当前设置为空串(归一回落默认 3.7.3),探测 3.7.3:不建议', () => {
    expect(engineVersionSuggestion('', { version: '3.7.3', engineRoot: engineA }, undefined)).toEqual({
      kind: 'none',
      reason: 'matches'
    });
  });

  it('探测值不同于当前设置且未忽略:建议该值', () => {
    expect(engineVersionSuggestion('3.7.3', detected, undefined)).toEqual({
      kind: 'suggest',
      version: '2.5.10'
    });
  });

  it('该探测值已忽略过:不再建议(dismissed)', () => {
    expect(engineVersionSuggestion('3.7.3', detected, '2.5.10')).toEqual({
      kind: 'none',
      reason: 'dismissed'
    });
  });

  it('忽略的是旧值,探测值变了:可再建议', () => {
    expect(engineVersionSuggestion('3.7.3', { version: '2.5.9', engineRoot: engineA }, '2.5.10')).toEqual({
      kind: 'suggest',
      version: '2.5.9'
    });
  });
});
