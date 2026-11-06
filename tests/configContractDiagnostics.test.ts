// 配置契约检查诊断(内网开发机环境适配审核 docs/analysis/intranet-env-audit.md
// §4/§5,用户会话建议序 #2):kode 的 .def/entities.xml 层诊断很强,但工作区
// 「配置层」(debug.json / extraPaths / .gitignore / 文档声明)是 0 覆盖——
// 真实内网机(D:\kbengine)暴露的 4 项配置层事实(extraPaths 双层上跳、
// .gitignore 缺 .kbengine/、debug.json components 空且 telnet 段全注释、
// CLAUDE.md 密码声明与实值冲突)全部只能人肉 review 发现。
//
// 纯逻辑层单测——computeConfigContractFindings 不 import vscode,文件存在性
// 与目录存在性均注入,测试免 vscode 依赖。
//
// 验收断言:
//   - debug.json:components 空/缺、已知组件 telnet 端口缺失或偏离已知默认、
//     telnet 段整段被注释(JSONC 文本层检出)、telnetPassword 与文档声明冲突;
//   - extraPaths:含 ../.. 双层上跳、指向不存在目录、绝对路径条目
//     (CFG-02:生成面已改 ${workspaceFolder} 变量形态,绝对路径=不可移植);
//   - .gitignore 缺 .kbengine/ 条目;
//   - CLAUDE.md/README 声明的密码/端口与 debug.json 实值冲突;
//   - 干净工作区零产出;开关关闭零产出。

import { describe, expect, it } from 'vitest';
import {
  CONFIG_CONTRACT_DIAGNOSTICS_ENABLED_DEFAULT,
  computeConfigContractFindings,
  type ConfigContractWorkspaceInput
} from '../src/configContractDiagnostics';

/** 真实内网机口径的「配置正确」基线:任何单项变异都应恰好多出对应 finding */
const cleanInput = (overrides: Partial<ConfigContractWorkspaceInput> = {}): ConfigContractWorkspaceInput => ({
  debugJson: {
    exists: true,
    text: JSON.stringify({
      version: '1.0',
      debug: {
        defaultTelnetHost: '127.0.0.1',
        components: {
          loginapp: { telnetHost: '127.0.0.1', telnetPort: 31000, telnetPassword: 'HxQYjC9+WyeiRNYH' },
          dbmgr: { telnetHost: '127.0.0.1', telnetPort: 32000, telnetPassword: 'HxQYjC9+WyeiRNYH' },
          baseapp: { telnetHost: '127.0.0.1', telnetPort: 40000, telnetPassword: 'HxQYjC9+WyeiRNYH' },
          cellapp: { telnetHost: '127.0.0.1', telnetPort: 50000, telnetPassword: 'HxQYjC9+WyeiRNYH' }
        }
      }
    })
  },
  extraPaths: ['../kbe/typings'],
  extraPathExists: () => true,
  gitignore: { exists: true, text: '.kbengine/\nnode_modules/\n' },
  docs: [],
  enabled: true,
  ...overrides
});

const codesOf = (input: ConfigContractWorkspaceInput) =>
  computeConfigContractFindings(input).map(f => f.code);

describe('配置契约检查:debug.json components', () => {
  it('components 为空对象报 findings', () => {
    const findings = computeConfigContractFindings(cleanInput({
      debugJson: {
        exists: true,
        text: JSON.stringify({ version: '1.0', debug: { components: {} } })
      }
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.configContract.debugComponentsEmpty');
    expect(findings[0].severity).toBe('Warning');
    expect(findings[0].file).toBe('debug.json');
    expect(findings[0].message).toContain('components');
    expect(findings[0].message).toContain('loginapp');
    // 修复建议中英双语
    expect(findings[0].message).toContain('Start Debugging');
  });

  it('debug.components 字段缺失同样报(含 telnet 段被注释的文本层检出)', () => {
    const text = [
      '{',
      '  "version": "1.0",',
      '  "debug": {',
      '    "defaultTelnetHost": "127.0.0.1"',
      '    // "components": {',
      '    //   "loginapp": { "telnetHost": "127.0.0.1", "telnetPort": 31000 },',
      '    //   "dbmgr": { "telnetHost": "127.0.0.1", "telnetPort": 32000 }',
      '    // }',
      '  }',
      '}'
    ].join('\n');
    const codes = codesOf(cleanInput({ debugJson: { exists: true, text } }));
    expect(codes).toContain('kbengine.configContract.debugComponentsEmpty');
    expect(codes).toContain('kbengine.configContract.debugTelnetCommented');
  });

  it('已知组件端口缺失或偏离已知默认分别报', () => {
    const text = JSON.stringify({
      version: '1.0',
      debug: {
        components: {
          loginapp: { telnetHost: '127.0.0.1' },          // 端口缺失
          dbmgr: { telnetHost: '127.0.0.1', telnetPort: 32000 }, // 正确
          baseapp: { telnetHost: '127.0.0.1', telnetPort: 41000 }, // 偏离 40000
          cellapp: { telnetHost: '127.0.0.1', telnetPort: 50000 }  // 正确
        }
      }
    });
    const findings = computeConfigContractFindings(cleanInput({
      debugJson: { exists: true, text }
    }));
    const codes = findings.map(f => f.code);
    expect(codes).toContain('kbengine.configContract.debugTelnetPortMissing');
    expect(codes).toContain('kbengine.configContract.debugTelnetPortMismatch');
    const mismatch = findings.find(f => f.code === 'kbengine.configContract.debugTelnetPortMismatch');
    expect(mismatch?.message).toContain('baseapp');
    expect(mismatch?.message).toContain('40000');
    expect(mismatch?.message).toContain('41000');
  });

  it('debug.json 无法解析报 unparsable(按 components 缺失处理同源)', () => {
    const codes = codesOf(cleanInput({
      debugJson: { exists: true, text: '{ not json at all' }
    }));
    expect(codes).toContain('kbengine.configContract.debugJsonUnparsable');
  });

  it('debug.json 不存在不报(保持零噪声,缺失由 startDebugging 面提示)', () => {
    expect(codesOf(cleanInput({ debugJson: { exists: false } })))
      .not.toContain('kbengine.configContract.debugComponentsEmpty');
  });
});

describe('配置契约检查:extraPaths', () => {
  it('../../ 双层上跳报(对 kbe/typings 相对语义错)', () => {
    const findings = computeConfigContractFindings(cleanInput({
      extraPaths: ['../../kbe/typings', '../kbe/typings']
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.configContract.extraPathsDoubleUp');
    expect(findings[0].file).toBe('settings.json');
    expect(findings[0].message).toContain('../../kbe/typings');
    expect(findings[0].message).toContain('../kbe/typings'); // 修复建议含正确形态
  });

  it('指向不存在目录报(存在性注入)', () => {
    const findings = computeConfigContractFindings(cleanInput({
      extraPaths: ['../kbe/typings'],
      extraPathExists: (p) => p !== '../kbe/typings'
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.configContract.extraPathsMissingDir');
    expect(findings[0].message).toContain('../kbe/typings');
  });

  it('未注入存在性判定时跳过 missing-dir 检查(不猜)', () => {
    const findings = computeConfigContractFindings(cleanInput({
      extraPaths: ['../kbe/typings'],
      extraPathExists: undefined
    }));
    expect(findings).toHaveLength(0);
  });

  it('绝对路径条目报 extraPathsAbsolute(CFG-02:变量形态才可移植)', () => {
    const findings = computeConfigContractFindings(cleanInput({
      extraPaths: ['/home/u/proj/scripts', 'C:\\kbengine\\libs']
    }));
    expect(findings).toHaveLength(2);
    for (const entry of findings) {
      expect(entry.code).toBe('kbengine.configContract.extraPathsAbsolute');
      expect(entry.file).toBe('settings.json');
      expect(entry.severity).toBe('Warning');
      // 中英双语 + 指向 ${workspaceFolder} 修复形态
      expect(entry.message).toContain('${workspaceFolder}');
      expect(entry.message).toContain('English');
    }
    expect(findings[0].message).toContain('/home/u/proj/scripts');
    expect(findings[1].message).toContain('C:\\kbengine\\libs');
  });

  it('${workspaceFolder} 变量形态与相对路径不报 absolute', () => {
    const codes = codesOf(cleanInput({
      extraPaths: ['${workspaceFolder}/scripts', '${workspaceFolder}/.kbengine/stubs', '../kbe/typings']
    }));
    expect(codes).toEqual([]);
  });

  it('绝对路径条目根因一条:不再叠加 missing-dir 检查', () => {
    const findings = computeConfigContractFindings(cleanInput({
      extraPaths: ['/no/such/dir'],
      extraPathExists: () => false
    }));
    expect(findings.map(f => f.code)).toEqual(['kbengine.configContract.extraPathsAbsolute']);
  });
});

describe('配置契约检查:.gitignore', () => {
  it('缺 .kbengine/ 条目报', () => {
    const findings = computeConfigContractFindings(cleanInput({
      gitignore: { exists: true, text: 'node_modules/\nout/\n' }
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.configContract.gitignoreMissingKbengine');
    expect(findings[0].file).toBe('.gitignore');
    expect(findings[0].message).toContain('.kbengine/');
  });

  it('已在册(含前缀形态 / 展开形态)不报', () => {
    expect(computeConfigContractFindings(cleanInput({
      gitignore: { exists: true, text: '**/.kbengine/\n' }
    }))).toHaveLength(0);
    // .gitignore 不存在(非 git 仓)不报
    expect(computeConfigContractFindings(cleanInput({
      gitignore: { exists: false }
    }))).toHaveLength(0);
  });
});

describe('配置契约检查:文档声明与 debug.json 实值冲突', () => {
  it('CLAUDE.md 声明的 telnet 密码与实值冲突报(真实内网机事故形态)', () => {
    const findings = computeConfigContractFindings(cleanInput({
      docs: [{ name: 'CLAUDE.md', text: '# 项目\n- telnet 密码: pwd123456\n' }]
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.configContract.telnetPasswordDocConflict');
    expect(findings[0].file).toBe('CLAUDE.md');
    expect(findings[0].line).toBe(1); // 0 起,锚定声明行
    expect(findings[0].message).toContain('pwd123456');
    expect(findings[0].message).toContain('HxQYjC9+WyeiRNYH');
  });

  it('文档密码与实值一致不报;telnetPassword 形态(带 <>/反引号)同口径', () => {
    expect(computeConfigContractFindings(cleanInput({
      docs: [{ name: 'CLAUDE.md', text: '- telnet password: HxQYjC9+WyeiRNYH\n' }]
    }))).toHaveLength(0);
    expect(computeConfigContractFindings(cleanInput({
      docs: [{ name: 'CLAUDE.md', text: '- telnet 密码 `<password> HxQYjC9+WyeiRNYH </password>`\n' }]
    }))).toHaveLength(0);
  });

  it('文档声明的组件端口与 debug.json 实值冲突报', () => {
    const findings = computeConfigContractFindings(cleanInput({
      docs: [{ name: 'README.md', text: 'baseapp telnet_port: 41000\n' }]
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.configContract.telnetPortDocConflict');
    expect(findings[0].file).toBe('README.md');
    expect(findings[0].message).toContain('baseapp');
    expect(findings[0].message).toContain('40000');
    expect(findings[0].message).toContain('41000');
  });

  it('debug.json 无 telnetPassword 时不做密码冲突对账(无从对账不猜)', () => {
    const text = JSON.stringify({
      version: '1.0',
      debug: {
        components: { baseapp: { telnetHost: '127.0.0.1', telnetPort: 40000 } }
      }
    });
    expect(computeConfigContractFindings(cleanInput({
      debugJson: { exists: true, text },
      docs: [{ name: 'CLAUDE.md', text: 'telnet 密码: pwd123456\n' }]
    }))).toHaveLength(0);
  });
});

describe('配置契约检查:整体契约', () => {
  it('干净工作区零产出', () => {
    expect(computeConfigContractFindings(cleanInput())).toHaveLength(0);
  });

  it('开关默认开;关闭后零产出', () => {
    expect(CONFIG_CONTRACT_DIAGNOSTICS_ENABLED_DEFAULT).toBe(true);
    expect(computeConfigContractFindings(cleanInput({ enabled: false }))).toHaveLength(0);
  });

  it('全坏输入一次报全(各类 finding 并存不互相遮蔽)', () => {
    const codes = codesOf(cleanInput({
      debugJson: { exists: true, text: JSON.stringify({ version: '1.0', debug: { components: {} } }) },
      extraPaths: ['../../kbe/typings', '../kbe/no-such-dir'],
      extraPathExists: () => false,
      gitignore: { exists: true, text: '' },
      docs: [{ name: 'CLAUDE.md', text: 'telnet 密码: pwd123456\n' }]
    }));
    expect(codes).toContain('kbengine.configContract.debugComponentsEmpty');
    expect(codes).toContain('kbengine.configContract.extraPathsDoubleUp');
    expect(codes).toContain('kbengine.configContract.extraPathsMissingDir');
    expect(codes).toContain('kbengine.configContract.gitignoreMissingKbengine');
  });

  it('密码文档冲突与 gitignore/extraPaths finding 并存不互相遮蔽', () => {
    const codes = codesOf(cleanInput({
      extraPaths: ['../../kbe/typings'],
      gitignore: { exists: true, text: '' },
      docs: [{ name: 'CLAUDE.md', text: 'telnet 密码: pwd123456\n' }]
    }));
    expect(codes).toContain('kbengine.configContract.extraPathsDoubleUp');
    expect(codes).toContain('kbengine.configContract.gitignoreMissingKbengine');
    expect(codes).toContain('kbengine.configContract.telnetPasswordDocConflict');
  });
});
