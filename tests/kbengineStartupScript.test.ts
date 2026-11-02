import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  CLI_STARTUP_PARAM_DOCS,
  STARTUP_ENV_VAR_DOCS,
  SERVER_PROCESS_NAMES,
  STARTUP_SCRIPT_DIAGNOSTIC_CODE,
  provideStartupScriptHover,
  provideStartupScriptCompletions,
  computeStartupScriptFindings
} from '../src/kbengineStartupScript';

// KBEXP-1 启动参数与启动脚本分析面(用户令 2026-11-02;KB-001 第六篇):
// 事实来源 kbe/src 源码取证(kbemain.h parseMainCommandArgs:238),悬浮/补全/
// 诊断只认 KBEngine 启动脚本链面。此处锁解析口径与代表性行,不逐键枚举。

const lines = (text: string): string[] => text.split(/\r?\n/);

const hoverValue = (hover: { contents: unknown } | null): string | null => {
  if (!hover) {
    return null;
  }
  const contents = hover.contents as { value: string } | Array<{ value: string }>;
  return Array.isArray(contents)
    ? contents.map(item => item.value).join('')
    : contents.value;
};

const at = (text: string, line: number, needle: string) =>
  provideStartupScriptHover(lines(text), line, Math.max(text.split('\n')[line]?.indexOf(needle) ?? 0, 0));

describe('provideStartupScriptHover', () => {
  const script = [
    '#!/bin/bash',
    'export KBE_ROOT=$HOME/kbe',
    'export KBE_RES_PATH=$KBE_ROOT/res',
    '"$KBE_BIN_PATH/baseapp" --cid=2001 --gus=1'
  ].join('\n');

  it('启动行上的 CLI 参数 --cid 出双语文档(含源码取证行)', () => {
    const hover = at(script, 3, '--cid');
    expect(hover).not.toBeNull();
    const value = hoverValue(hover);
    expect(value).toContain('--cid');
    expect(value).toContain(CLI_STARTUP_PARAM_DOCS.cid.zh);
    expect(value).toContain(CLI_STARTUP_PARAM_DOCS.cid.en);
    expect(value).toContain('kbemain.h:250');
  });

  it('CLI 参数名只悬停在参数名区间(值区不悬停)', () => {
    // 光标落在 1001(值区):参数名 token 区间是 --cid,不含值
    expect(provideStartupScriptHover(lines(script), 3, 31)).toBeNull();
  });

  it('环境变量引用 $KBE_ROOT 出文档', () => {
    const hover = at(script, 2, '$KBE_ROOT');
    expect(hover).not.toBeNull();
    expect(hoverValue(hover)).toContain(STARTUP_ENV_VAR_DOCS.KBE_ROOT.zh);
  });

  it('赋值形态 export KBE_RES_PATH= 也识别为环境变量', () => {
    const hover = at(script, 2, 'KBE_RES_PATH');
    expect(hover).not.toBeNull();
    expect(hoverValue(hover)).toContain('资源搜索路径');
  });

  it('未知参数/未知变量返回 null(交回既有体系)', () => {
    const unknown = ['"$KBE_BIN_PATH/baseapp" --foobar=1'].join('\n');
    expect(at(unknown, 0, '--foobar')).toBeNull();
    const noEnv = ['baseapp --cid=1'].join('\n');
    expect(at(noEnv, 0, 'baseapp')).toBeNull();
  });

  it('非启动脚本行(注释/纯命令)不产出悬浮', () => {
    const comment = ['# 启动 baseapp --cid=2001'].join('\n');
    expect(at(comment, 0, '--cid')).toBeNull();
  });
});

describe('provideStartupScriptCompletions', () => {
  const oneLine = (text: string, character: number) =>
    provideStartupScriptCompletions(lines(text), 0, character);

  it('-- 前缀补全 CLI 启动参数(含等号后缀与类型 detail)', () => {
    const items = oneLine('baseapp --', 'baseapp --'.length);
    expect(items).not.toBeNull();
    const labels = items!.map(item => item.label).sort();
    expect(labels).toContain('--cid=');
    expect(labels).toContain('--KBE_RES_PATH=');
    const cid = items!.find(item => item.label === '--cid=')!;
    expect(cid.detail).toBe('uint');
    expect(typeof cid.documentation).toBe('object');
  });

  it('$KBE_ 前缀补全环境变量(不重复 $,标签为裸名)', () => {
    const items = oneLine('export $KBE_R', 'export $KBE_R'.length);
    expect(items).not.toBeNull();
    expect(items!.some(item => item.label === 'KBE_RES_PATH')).toBe(true);
    expect(items!.some(item => item.label === 'KBE_BIN_PATH')).toBe(true);
  });

  it('无匹配前缀返回 null', () => {
    expect(oneLine('baseapp --cid=1', 0)).toBeNull();
    expect(oneLine('foo bar', 4)).toBeNull();
  });
});

describe('computeStartupScriptFindings', () => {
  const base = [
    '#!/bin/bash',
    'export KBE_ROOT=$HOME/kbe',
    'export KBE_RES_PATH=$KBE_ROOT/res',
    'export KBE_BIN_PATH=$KBE_ROOT/bin/server'
  ].join('\n');

  it('启动行未知 --xxx 参数告警(疑似拼写错误)', () => {
    const findings = computeStartupScriptFindings(
      [base, '"$KBE_BIN_PATH/baseapp" --cid=2001 --gus=1 --hdi=1'].join('\n')
    );
    const bad = findings.filter(f => f.message.includes('--hdi'));
    expect(bad).toHaveLength(1);
    expect(bad[0].code).toBe(STARTUP_SCRIPT_DIAGNOSTIC_CODE);
    expect(bad[0].line).toBe(4);
  });

  it('--cid / --gus 非数字值告警', () => {
    const findings = computeStartupScriptFindings(
      [base, '"$KBE_BIN_PATH/baseapp" --cid=abc --gus=2'].join('\n')
    );
    expect(findings.filter(f => f.message.includes('--cid'))).toHaveLength(1);
    expect(findings.some(f => f.message.includes('--gus'))).toBe(false);
    // gus 非数字也告警
    const gusBad = computeStartupScriptFindings(
      [base, '"$KBE_BIN_PATH/baseapp" --cid=1 --gus=xy'].join('\n')
    );
    expect(gusBad.some(f => f.message.includes('--gus'))).toBe(true);
  });

  it('合法启动行(数字 cid/gus,已知参数)零告警', () => {
    const findings = computeStartupScriptFindings(
      [base, '"$KBE_BIN_PATH/baseapp" --cid=2001 --gus=1 --hide=0'].join('\n')
    );
    expect(findings).toHaveLength(0);
  });

  it('非启动行不检(echo/pkill/kill/注释里的 --flag 不误报)', () => {
    const text = [
      base,
      'echo "--help"',
      'pkill -f cellapp',
      '# 启动 baseapp --cid=2001',
      'safe_kill'
    ].join('\n');
    const findings = computeStartupScriptFindings(text);
    expect(findings.filter(f => f.message.includes('--'))).toHaveLength(0);
  });

  it('启动行引用 $KBE_ 但本文件未赋值且无 source → 缺环境告警', () => {
    const text = ['#!/bin/bash', 'export KBE_ROOT=$HOME/kbe', '"$KBE_BIN_PATH/baseapp" --cid=1'].join('\n');
    const findings = computeStartupScriptFindings(text);
    // 命令路径引用的 $KBE_BIN_PATH 未赋值(且无 source)→ 告警
    expect(findings.some(f => f.message.includes('KBE_BIN_PATH'))).toBe(true);
  });

  it('有 export 赋值或 source 时不报缺环境', () => {
    const findings = computeStartupScriptFindings(base);
    expect(findings.filter(f => f.message.includes('KBE_RES_PATH'))).toHaveLength(0);
    const withSource = [
      '#!/bin/bash',
      'source /etc/kbe.env',
      '"$KBE_BIN_PATH/baseapp" --cid=1'
    ].join('\n');
    expect(computeStartupScriptFindings(withSource).filter(f => f.message.includes('KBE_RES_PATH'))).toHaveLength(0);
  });

  it('bat 形态(%KBE_BIN_PATH%\\baseapp.exe)也识别为服务器启动行', () => {
    const text = ['%KBE_BIN_PATH%\\baseapp.exe --cid=2001 --gus=bad'].join('\r\n');
    const findings = computeStartupScriptFindings(text);
    expect(findings.some(f => f.message.includes('--gus'))).toBe(true);
  });

  it('服务器进程集含 9 个服务器进程 + bots;工具(kbcmd/guiconsole)不在列', () => {
    for (const name of [
      'machine', 'logger', 'interfaces', 'dbmgr', 'baseappmgr', 'cellappmgr',
      'baseapp', 'cellapp', 'loginapp', 'bots'
    ]) {
      expect(SERVER_PROCESS_NAMES.has(name)).toBe(true);
    }
    // 工具进程参数面不同,不在启动行诊断集(防 gensdk.sh 误报)
    expect(SERVER_PROCESS_NAMES.has('kbcmd')).toBe(false);
    expect(SERVER_PROCESS_NAMES.has('guiconsole')).toBe(false);
  });

  it('真实引擎模板启动脚本零误报(防诊断对官方脚本翻车)', () => {
    const assets = '/home/cui/workspaces/kbengine/kbe/res/sdk_templates/server/python_assets';
    if (!existsSync(assets)) {
      return; // 引擎树不在本机,跳过(门禁机器无 kbe 源码)
    }
    for (const file of readdirSync(assets).filter(f => f.endsWith('.sh') || f.endsWith('.bat'))) {
      const findings = computeStartupScriptFindings(readFileSync(join(assets, file), 'utf8'));
      expect(findings, `${file} 不应有诊断: ${findings.map(f => f.message).join('; ')}`).toHaveLength(0);
    }
  });
});
