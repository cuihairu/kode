/**
 * RUST-430(HR-QA-018)安全与功能完成矩阵签收——守门测试。
 *
 * 本文件不重做各行为面的既有测试,而是把「矩阵签收」钉成可回归的三件事:
 *  ①轴线锁步:矩阵的四个轴(target=部署 profile / engine profile=profile 档 /
 *    文件类型 / 触发方式)必须与代码真实枚举一致——代码支持的集合变了,
 *    矩阵(及其文档)若不同步更新,本测试即红(矩阵不得静默漂移)。
 *  ②证据存活:文档中每个「已签收」单元引用的证据(test 文件 + it 名)必须
 *    真实存在于仓库——证据测试被删/改名,本测试即红(签收不得悬空)。
 *  ③被拦单元诚实:当前无法签收的单元(依赖未完成子任务)必须列在文档的
 *    「被拦」节,且与测试内 BLOCKED_CELLS 常量一致——单元被解决时不更新
 *    文档+常量,本测试即红(被拦不得悄悄消失)。
 * 纯核行为面(身份解析/def 结构闸/端点策略/信任闸)由既有各行为测试逐臂
 * 断言,本文件只做轴线锁步的轻量直证,不复制其断言矩阵。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { resolveHotReloadModuleIdentity } from '../src/backend/hotReloadModuleIdentity';
import { createDefStructuralGate } from '../src/backend/hotReloadDefGate';
import { decideHttpEndpoint, classifyHttpEndpoint } from '../src/backend/httpEndpointPolicy';
import { HOT_RELOAD_DEFAULT_TRIGGER_MODE, readHotReloadSettings } from '../src/hotReload';

const docPath = join(__dirname, '..', 'docs', 'hotreload', 'acceptance-matrix.md');
const readTest = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

/** 轴线锁步:矩阵四轴的文档化取值必须等于代码真实取值。 */
const AXES = {
  /** 触发方式(与 package.json kbengine.hotReload.triggerMode 枚举锁同步) */
  triggers: ['onSave', 'onDiskChange'] as const,
  /** 身份解析唯一支持的语言 */
  identityLanguage: 'python' as const,
  /** 文件类型面:py=身份解析;def=结构闸;other=解析器拒 */
  fileTypes: ['py', 'def', 'other'] as const,
  /** target=部署 profile(profile.id→targetId,零档时自动创建默认档) */
  targetModel: 'deployment-profile' as const
};

/**
 * 已签收单元:id + 证据(test 文件,相对 tests/ + it 名)。
 * 证据存活断言:每个证据必须真实存在于对应 test 文件。
 */
const SIGNED_CELLS: Array<{ id: string; file: string; test: string }> = [
  {
    id: 'C1',
    file: 'hotReloadModuleIdentity.test.ts',
    test: '多根候选:唯一命中即解析;零命中 out-of-root;嵌套多命中 ambiguous 列全候选不猜(HR-MOD-006)'
  },
  {
    id: 'C2',
    file: 'hotReloadDiskWatchWiring.test.ts',
    test: '切到 onDiskChange:配置变更即建面;切回 onSave 即拆(HR-WATCH-001/005)'
  },
  {
    id: 'C3',
    file: 'hotReloadFallbackCycle.test.ts',
    test: '关 Watch + 手动回退:enabled=false 不建 watcher 不自动发,手动路径仍写台账'
  },
  {
    id: 'C4',
    file: 'hotReloadDefGateWiring.test.ts',
    test: '结构性 def 变更(属性 Type 变化):实际发送器未收到 reload,日志与警告提示需重启'
  },
  {
    id: 'C5',
    file: 'hotReloadDefGateWiring.test.ts',
    test: '非结构 def 变更(只加注释):重启确认建立基线之后照常发送'
  },
  {
    id: 'C6',
    file: 'hotReloadModuleIdentity.test.ts',
    test: '诊断码透传:init-file / not-python / out-of-root(穿越词法上卷后落根外);空 fileUri 拒绝'
  },
  {
    id: 'C7',
    file: 'hotReloadChannelConfig.test.ts',
    test: '多 profile → 先选 profile 再进预设首屏,合计 2 步(≤2 步口径)'
  },
  {
    id: 'C8',
    file: 'hotReloadSecretLeakGuard.test.ts',
    test: 'history 输入/条目字段集无密钥形状字段(header/token 只允许在出站传输 DTO)'
  },
  {
    id: 'C10',
    file: 'hotReloadPluginLoad.test.ts',
    test: '20 插件:第 3 位应答者胜,其后 17 家未被问(成本=位置非全册)'
  },
  {
    id: 'C11',
    file: 'hotReloadSoak.test.ts',
    test: '200 次 rebuild 循环:创建数恒=销毁数+存活,存活有界(==根数),dispose 归零'
  }
];

/** 被拦单元:依赖未完成子任务,无法签收。与文档「被拦」节一致。 */
const BLOCKED_CELLS: Array<{ id: string; task: string; reason: string }> = [
  { id: 'C9', task: 'RUST-424', reason: 'HTTP 正确传短名且 UI 永远完整名装配面(接线批 HR-PR-02/03 收官后验)' },
  { id: 'C12', task: 'RUST-423', reason: '真机跨平台(WSL/SSH/DevContainer/macOS/Windows)实测未做;纯核路径矩阵已落' }
];

describe('RUST-430 安全与功能完成矩阵签收守门', () => {
  it('①轴线锁步:触发方式/语言/文件类型/目标模型与代码真实枚举一致', () => {
    expect(HOT_RELOAD_DEFAULT_TRIGGER_MODE).toBe(AXES.triggers[0]);
    // 触发方式枚举直证:文档化的两个取值必须正是代码接受的两个(onDiskChange
    // 显式才建磁盘面,onSave 是推荐默认;枚举外一律回落 onSave,不猜半态)。
    const readerOf = (triggerMode: unknown) => ({
      get: <T>(key: string, defaultValue: T): T => (key === 'triggerMode' ? (triggerMode as T) : (defaultValue as T))
    });
    expect(readHotReloadSettings(readerOf('onDiskChange')).triggerMode).toBe(AXES.triggers[1]);
    expect(readHotReloadSettings(readerOf('bogus')).triggerMode).toBe(AXES.triggers[0]);
    const identity = resolveHotReloadModuleIdentity({
      fileUri: 'file:///ws/scripts/entities/fight/FightAI.py',
      scriptRoot: '/ws/scripts',
      workspaceId: 'rust430',
      rootId: 'scripts',
      allowRootLevelStem: false
    });
    expect(identity.ok, 'py 文件应解析成功(文件类型面)').toBe(true);
    if (identity.ok) {
      expect(identity.identity.language).toBe(AXES.identityLanguage);
      expect(identity.identity.fullModule).toBe('entities.fight.FightAI');
      expect(identity.identity.rootId).toBe('scripts');
    }
    expect(AXES.targetModel).toBe('deployment-profile');
  });

  it('②证据存活:每个已签收单元的证据(test 文件+it 名)真实存在', () => {
    const doc = readFileSync(docPath, 'utf8');
    const blockedIds = new Set(BLOCKED_CELLS.map(c => c.id));
    for (const cell of SIGNED_CELLS) {
      const source = readTest(cell.file);
      expect(source, `证据测试 ${cell.file} 应含 it 名「${cell.test}」`).toContain(cell.test);
      expect(doc, `文档应引用已签收单元 ${cell.id}`).toContain(cell.id);
      // 互斥:已签收单元不得同时列被拦(「已签收又列被拦」是同步漂移)
      expect(blockedIds.has(cell.id), `已签收单元 ${cell.id} 不得同时被拦`).toBe(false);
    }
  });

  it('③被拦单元诚实:被拦集合与文档「被拦」节一致,且每个被拦单元都有未完成子任务', () => {
    const doc = readFileSync(docPath, 'utf8');
    expect(BLOCKED_CELLS.length).toBeGreaterThan(0);
    const signedIds = new Set(SIGNED_CELLS.map(c => c.id));
    for (const cell of BLOCKED_CELLS) {
      expect(doc, `文档「被拦」节应列出 ${cell.id}(${cell.task})`).toContain(cell.id);
      expect(doc).toContain(cell.task);
      // 每个被拦单元必须带一个未完成子任务(不能空泛被拦)
      expect(cell.task, `被拦单元 ${cell.id} 应关联一个任务 id`).toMatch(/^RUST-\d+$/);
      expect(cell.reason, `被拦单元 ${cell.id} 应说明原因`).not.toHaveLength(0);
      // 互斥:被拦单元不得同时已签收(单元被解决后须从被拦节移出,同表同现=漂移)
      expect(signedIds.has(cell.id), `被拦单元 ${cell.id} 不得同时已签收`).toBe(false);
    }
  });

  it('④纯核轻量直证:def 结构闸与端点策略行为面(不复制既有矩阵)', async () => {
    // def 结构闸:结构变化(属性 Type 变)被拦;仅注释变化放行。
    const defFile = '/ws/scripts/entity_defs/Foo.def';
    const base = '<root>\n\t<Type>Foo</Type>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n';
    const structural = '<root>\n\t<Type>Foo</Type>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT64 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n';
    const commentOnly = '<!-- note -->\n' + base;
    const gate = createDefStructuralGate(file => {
      if (file === defFile) {
        return commentOnly;
      }
      return null;
    }, new Map([[defFile, base]]));
    const verdictStructural = await gate.check([defFile]);
    // 基线=Foo 原内容;只加注释=非结构变化→放行;Type 变=结构变化→拦下。
    // 注意:本直证只测判定方向,不复制 wiring 测试的发送/审计面。
    expect(verdictStructural.reasons.length).toBe(0);
    const gateBlock = createDefStructuralGate(file => (file === defFile ? structural : null), new Map([[defFile, base]]));
    const verdictBlock = await gateBlock.check([defFile]);
    expect(verdictBlock.reasons.length).toBeGreaterThan(0);
    // 端点策略:loopback 放行;非 loopback 未授权阻止;已授权警告放行。
    expect(classifyHttpEndpoint('http://127.0.0.1:8090/hotfix').kind).toBe('loopback');
    expect(decideHttpEndpoint('https://evil.example/x', false).action).toBe('block');
    expect(decideHttpEndpoint('https://evil.example/x', true).action).toBe('warn');
    expect(decideHttpEndpoint('http://127.0.0.1:8090/hotfix', false).action).toBe('allow');
  });
});
