import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { serveCompletionFromRust, serveCompletionResolveFromRust, serveDefinitionFromRust, serveDiagnosticsFromRust, serveHoverFromRust, serveReferencesFromRust, setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// 2026-11-08 用户令「直接切到 rust」:定义面 rust 服务 e2e(真实 kode-server
// 二进制)。证明 switch 不是纸面:gate 服务轨道 + serveDefinitionFromRust
// 走真进程回真实落点。二进制缺失时跳过(与 kodeCoreE2E 同口径,单测基线
// 不背工具链依赖)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const suite = existsSync(binaryPath) ? describe : describe.skip;

const DEF = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'Avatar.def');

suite('kode 定义面 rust 服务 e2e(真实二进制)', () => {
  let client: KodeCoreClient | null = null;
  let gate: KodeCoreGate | null = null;

  afterAll(async () => {
    setKodeCoreShadowGate(null);
    await gate?.dispose().catch(() => undefined);
  });

  it('rust 轨道:Avatar.def 的 DetailLevel 值 MEDIUM → 同文件 DetailLevels 声明落点', async () => {
    client = new KodeCoreClient({ binaryPath });
    gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 5000 });
    setKodeCoreShadowGate(gate);

    const text = readFileSync(DEF, 'utf8');
    const document = {
      uri: { fsPath: DEF },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => text
    };
    // 第 36 行(0 基 35)`<DetailLevel> MEDIUM </DetailLevel>`:词 MEDIUM 起点
    // 字符偏移 = 3 tab + `<DetailLevel> `(13) = 16,取中 18。
    const position = { line: 35, character: 18 };

    const location = await serveDefinitionFromRust(
      document as never,
      position as never
    );

    expect(location).not.toBeNull();
    expect(location!.uri).toBe(DEF);
    // 落点应在 <DetailLevels><MEDIUM>(文件第 61 行,0 基 60)附近
    expect(location!.range.start.line).toBeGreaterThanOrEqual(60);
    expect(location!.range.start.line).toBeLessThanOrEqual(62);
  }, 20_000);

  it('rust 轨道:非语料文档(schema)零请求直通 null', async () => {
    // 复用上一用例的 gate(真实进程已拉起)
    const document = {
      uri: { fsPath: '/w/Avatar.schema' },
      languageId: 'kbengine-schema',
      version: 1,
      getText: () => ''
    };
    const location = await serveDefinitionFromRust(
      document as never,
      { line: 0, character: 0 } as never
    );
    expect(location).toBeNull();
  }, 20_000);

  it('rust 轨道:def 三方法段声明词返 null(能力边界:回落 TS 脚本层)', async () => {
    // demo def-to-cell/base/client 验收面:方法词 Rust 不落注册行(会挡住
    // TS 下一层的 py 实现落点),返 null 由 provideDefinitionRustFirst 回落
    // TS def 调用链取 py 实现。
    const cellDef = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'TrainingAvatar.def');
    const text = readFileSync(cellDef, 'utf8');
    const document = {
      uri: { fsPath: cellDef },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => text
    };
    // 第 4 行(0 基 3)`    <CellMethods><reqAttack>…`:词 reqAttack 区间
    // 18-26,取中 20。
    const location = await serveDefinitionFromRust(
      document as never,
      { line: 3, character: 20 } as never
    );
    expect(location).toBeNull();
  }, 20_000);

  it('rust 轨道:def Properties 段声明词返 null(2026-11-17 回归收回:回落 TS 脚本层)', async () => {
    // 复用 gate(真实进程已拉起)。属性声明词曾落 entities.xml 注册行,短路
    // TS F12 属性链的脚本实现层=def 无法跳 py 实现;与三方法段同口径返 null,
    // 脚本落点/注册兜底全链归 TS。
    const text = readFileSync(DEF, 'utf8');
    const document = {
      uri: { fsPath: DEF },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => text
    };
    // 第 19 行(0 基 18)`\t\t<hp>`:词 hp 区间 2-4,取中 3。
    const location = await serveDefinitionFromRust(
      document as never,
      { line: 18, character: 3 } as never
    );
    expect(location).toBeNull();
  }, 20_000);

  it('rust 轨道:def Properties 开标签补全出已声明属性', async () => {
    // 复用 gate(真实进程已拉起);独立 uri 防同版本镜像 no-op 吃掉合成文本。
    const syntheticUri = '/tmp/kode-e2e-synthetic-properties.def';
    const defText =
      '<root>\n' +
      '\t<Properties>\n' +
      '\t\t<name>\n' +
      '\t\t\t<Type> STRING </Type>\n' +
      '\t\t</name>\n' +
      '\t\t<level>\n' +
      '\t\t\t<Type> UINT32 </Type>\n' +
      '\t\t</level>\n' +
      '\t\t<\n';
    const document = {
      uri: { fsPath: syntheticUri },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => defText
    };
    // 第 9 行(0 基 8)`\t\t<`:开标签上下文,片段空 → 属性面。
    const report = await serveCompletionFromRust(
      document as never,
      { line: 8, character: 3 } as never
    );
    expect(report).not.toBeNull();
    expect(report!.items.length).toBeGreaterThan(0);
    const labels = report!.items.map(item => item.label);
    expect(labels).toContain('name');
    expect(labels).toContain('level');
    // 属性 kind=LSP property(10);类型面 kind=Class(7) 不混入(面=属性)
    expect(report!.items.every(item => item.kind === 10)).toBe(true);
  }, 20_000);

  it('rust 轨道:def `<Type>` 取值补全出 types.xml 类型面(需语料镜像)', async () => {
    const typesPath = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'types.xml');
    const syntheticUri = '/tmp/kode-e2e-synthetic-type.def';
    const defText =
      '<root>\n' +
      '\t<Properties>\n' +
      '\t\t<weapon>\n' +
      '\t\t\t<Type> SKILL_SLOT </Type>\n' +
      '\t\t</weapon>\n' +
      '\t\t<level>\n' +
      '\t\t\t<Type> UINT32 </Type>\n' +
      '\t\t</level>\n';
    // 语料前置:类型面只由 types.xml 入库声明(内建 STRING 不在面),先镜像。
    const typesText = readFileSync(typesPath, 'utf8');
    await gate!.mirrorDocument(typesPath, 'xml', 1, typesText);
    const document = {
      uri: { fsPath: syntheticUri },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => defText
    };
    // 第 4 行(0 基 3)`\t\t\t<Type> SKILL_SLOT </Type>`:取值上下文,片段
    // SKILL_SLOT(位置词尾,字符 20 = 3 tab + `<Type> `(7) + SKILL_SLOT(10))。
    const report = await serveCompletionFromRust(
      document as never,
      { line: 3, character: 20 } as never
    );
    expect(report).not.toBeNull();
    const labels = report!.items.map(item => item.label);
    // types.xml 的 FIXED_DICT 自定义类型 SKILL_SLOT 在类型面。
    expect(labels).toContain('SKILL_SLOT');
    // 类型面 kind=LSP Class(7)(别名/实体不混入此面)。
    expect(report!.items.every(item => item.kind === 7)).toBe(true);
  }, 20_000);

  it('rust 轨道:诊断面逐码形态(真实二进制;已注册静默/missingPythonFile 不在面)', async () => {
    // 语料前置:非空类型注册视图(否则未知类型 unverifiable 静默)。
    const typesPath = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'types.xml');
    await gate!.mirrorDocument(typesPath, 'xml', 1, readFileSync(typesPath, 'utf8'));
    // 逐码合成文档:标量三码(未知 Flags/`|` 组合/未知 DetailLevel)+ 未知
    // 类型 + 结构码(缺 Type/缺 Flags/属性作用域重复/方法段重复)+ 已注册
    // 类型(应静默)。
    const defText = [
      '<root>',
      '\t<Properties>',
      '\t\t<hp>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> NOT_A_FLAG </Flags>',
      '\t\t</hp>',
      '\t\t<combo>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> BASE|CELL_PUBLIC </Flags>',
      '\t\t</combo>',
      '\t\t<lvl>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> BASE </Flags>',
      '\t\t\t<DetailLevel> ULTRA </DetailLevel>',
      '\t\t</lvl>',
      '\t\t<noType>',
      '\t\t\t<Flags> BASE </Flags>',
      '\t\t</noType>',
      '\t\t<noFlags>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t</noFlags>',
      '\t\t<dupProp>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> BASE </Flags>',
      '\t\t</dupProp>',
      '\t\t<dupProp>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> BASE </Flags>',
      '\t\t</dupProp>',
      '\t\t<regType>',
      '\t\t\t<Type> SKILL_SLOT </Type>',
      '\t\t\t<Flags> BASE </Flags>',
      '\t\t</regType>',
      '\t\t<ghosty>',
      '\t\t\t<Type> GHOST_TYPE </Type>',
      '\t\t\t<Flags> BASE </Flags>',
      '\t\t</ghosty>',
      '\t</Properties>',
      '\t<BaseMethods>',
      '\t\t<moveTo>',
      '\t\t\t<Exposed> true </Exposed>',
      '\t\t</moveTo>',
      '\t\t<moveTo>',
      '\t\t\t<Exposed> true </Exposed>',
      '\t\t</moveTo>',
      '\t</BaseMethods>',
      '</root>'
    ].join('\n');
    const syntheticUri = '/tmp/kode-e2e-synthetic-diag.def';
    const document = {
      uri: { fsPath: syntheticUri },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => defText
    };
    const report = await serveDiagnosticsFromRust(document as never);
    expect(report).not.toBeNull();
    expect(report!.kind).toBe('full');
    const messages = report!.items.map(item => item.message);
    // 标量三码 + 未知类型(文案与 TS 逐字节同源)
    expect(messages).toContain('未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。');
    expect(messages.some(message => message.includes('BASE|CELL_PUBLIC') && message.includes("不支持 '|' 组合形态"))).toBe(true);
    expect(messages).toContain('未知的 DetailLevel: ULTRA');
    expect(messages).toContain('自定义类型 GHOST_TYPE 未在 types.xml 中注册，请先在 types.xml 注册后再引用');
    // 结构码:缺字段(节点区间)+ 重复成对(Warning+Info,属性按作用域)
    expect(messages).toContain('属性 noType 缺少 <Type> 定义');
    expect(messages).toContain('属性 noFlags 缺少 <Flags> 定义');
    expect(messages).toContain('属性区块中存在重复定义: dupProp (Base)');
    expect(messages).toContain('dupProp 在 属性区块 中已在 Base 作用域定义');
    expect(messages).toContain('方法区块中存在重复定义: moveTo');
    expect(messages).toContain('moveTo 在 方法区块 中已定义');
    // 已注册类型静默(不误报);missingPythonFile 盘上探测分支不在 Rust 面
    // (划归 TS 保留,归并时外来码不丢)。
    expect(messages.some(message => message.includes('SKILL_SLOT'))).toBe(false);
    expect(messages.some(message => message.includes('user_type'))).toBe(false);
    // 严重级(LSP 基):Error=1 / Warning=2 / Information=3
    const severityOf = (needle: string): number =>
      report!.items.find(item => item.message.includes(needle))!.severity;
    expect(severityOf('NOT_A_FLAG')).toBe(1);
    expect(severityOf('缺少 <Type> 定义')).toBe(1);
    expect(severityOf('重复定义: dupProp')).toBe(2);
    expect(severityOf('已在 Base 作用域定义')).toBe(3);
    // 候选词子区间抽查:第 5 行(0 基 4)`\t\t\t<Flags> NOT_A_FLAG </Flags>`
    // 的 NOT_A_FLAG = 列 11..21。
    const flagsItem = report!.items.find(item => item.message.includes('NOT_A_FLAG'))!;
    expect(flagsItem.range.start).toEqual({ line: 4, character: 11 });
    expect(flagsItem.range.end.character).toBe(21);
  }, 20_000);

  it('rust 轨道:Avatar.def 属性词 hover 出 markdown 内容(真实二进制)', async () => {
    // 复用 gate(真实进程已拉起,Avatar.def 已随定义面用例镜像);hover 腿
    // 自带镜像(同版本幂等)。`<name>` 声明在 1 基第 8 行(0 基 7),词 name
    // 起点列 3,取中 4。
    const text = readFileSync(DEF, 'utf8');
    const document = {
      uri: { fsPath: DEF },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => text
    };
    const value = await serveHoverFromRust(
      document as never,
      { line: 7, character: 4 } as never
    );
    expect(value).not.toBeNull();
    expect(value!).toContain('**name**');
    expect(value!).toContain('`STRING`');
    expect(value!).toContain('`BASE_AND_CLIENT`');
    expect(value!).toContain('`64`');
  }, 20_000);

  it('rust 轨道:非语料/未知词 hover 返 null(回落 TS 既有链)', async () => {
    // python 文档不在语料面:serveHoverFromRust 直通 null(provider 层
    // python 文档本就零请求,此处锁 face 函数语义)。
    const pyDocument = {
      uri: { fsPath: '/workspace/demo/scripts/base/Avatar.py' },
      languageId: 'python',
      version: 1,
      getText: () => 'class Avatar:\n    pass\n'
    };
    expect(
      await serveHoverFromRust(pyDocument as never, { line: 0, character: 6 } as never)
    ).toBeNull();
    // 语料文档词未知:Rust 返 null,调用方回 TS 全链(py 契约/schema 面)。
    const text = readFileSync(DEF, 'utf8');
    const document = {
      uri: { fsPath: DEF },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => text
    };
    expect(
      await serveHoverFromRust(document as never, { line: 0, character: 1 } as never)
    ).toBeNull();
  }, 20_000);

  it('rust 轨道:py self. 实体成员面(真实二进制;RUST-134)', async () => {
    // 语料前置:entities.xml(注册 Avatar)+ Avatar.def(实体模型)镜像,
    // py 文档 overlay 走真 fixture 路径(/scripts/ 面 + stem 归属)。
    const scripts = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts');
    const entitiesPath = join(scripts, 'entities.xml');
    const avatarDefPath = join(scripts, 'entity_defs', 'Avatar.def');
    const avatarPyPath = join(scripts, 'base', 'Avatar.py');
    await gate!.mirrorDocument(entitiesPath, 'xml', 1, readFileSync(entitiesPath, 'utf8'));
    await gate!.mirrorDocument(avatarDefPath, 'kbengine-def', 1, readFileSync(avatarDefPath, 'utf8'));
    const pyText = 'import KBEngine\n\n\nclass Avatar:\n\tdef onTick(self):\n\t\tself.\n';
    const pyDocument = {
      uri: { fsPath: avatarPyPath },
      languageId: 'python',
      version: 1,
      getText: () => pyText
    };
    // 行 6(1 基)= `\t\tself.`,character 7 = 行尾全量点。
    const report = await serveCompletionFromRust(pyDocument as never, {
      line: 5,
      character: 7
    } as never);
    expect(report).not.toBeNull();
    const labels = report!.items.map(item => item.label);
    // def 声明属性(name/level/hp/experience)+ 方法分面(onAvatarDead 等
    // base 面)全量出项;detail=类型(def <Type> 首文本)。
    expect(labels).toEqual(expect.arrayContaining(['name', 'level', 'hp', 'experience']));
    expect(labels).toContain('onAvatarDead');
    const nameItem = report!.items.find(item => item.label === 'name');
    expect(nameItem!.detail).toBe('STRING');
    expect(nameItem!.kind).toBe(10);
    // 方法条目 kind=2(method)。
    const methodItem = report!.items.find(item => item.label === 'onAvatarDead');
    expect(methodItem!.kind).toBe(2);

    // RUST-135:resolve 延迟补详情——hp 条目经 serve 面(与 provider 同口)
    // 回传 completionItem/resolve,文档面(类型 + 来源 def 路径)由语料复算;
    // data 往返载荷原样保留。
    const hp = report!.items.find(item => item.label === 'hp');
    expect(hp!.data).toBeTruthy();
    expect(hp!.sortText).toBe(String(report!.items.indexOf(hp!)).padStart(4, '0'));
    expect(hp!.filterText).toBe('hp');
    const resolved = await serveCompletionResolveFromRust({
      label: hp!.label,
      detail: hp!.detail,
      data: hp!.data
    });
    expect(resolved).not.toBeNull();
    const doc = resolved!.documentation?.value ?? '';
    expect(doc).toContain('**hp**');
    expect(doc).toContain('`UINT32`');
    expect(doc).toContain('entity_defs/Avatar.def');
  }, 20_000);
});

// RUST-138 接线:引用面 rust 服务(真实 kode-server 二进制)。服务面 =
// 语义引用(textDocument/references → semantic_reference_locations):
// 跨 root 同名异声明(Shadow)与不可解析(Dangling)不入列。二进制缺失
// 时跳过(与上套件同口径)。

const refsSuite = existsSync(binaryPath) ? describe : describe.skip;

suite('kode 引用面 rust 服务 e2e(RUST-138 接线,真实二进制)', () => {
  let client: KodeCoreClient | null = null;
  let gate: KodeCoreGate | null = null;

  afterAll(async () => {
    setKodeCoreShadowGate(null);
    await gate?.dispose().catch(() => undefined);
  });

  it('rust 轨道:def 类型引用 SKILL_SLOT → types.xml 声明 + 全语料使用位', async () => {
    client = new KodeCoreClient({ binaryPath });
    gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 5000 });
    setKodeCoreShadowGate(gate);

    const defsDir = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs');
    const avatarPath = join(defsDir, 'Avatar.def');
    const typesPath = join(defsDir, 'types.xml');
    // 语料前置:引用扫描逐文件全文重扫,types.xml 必须在库(声明落点)。
    await gate.mirrorDocument(typesPath, 'xml', 1, readFileSync(typesPath, 'utf8'));
    const avatarText = readFileSync(avatarPath, 'utf8');
    const document = {
      uri: { fsPath: avatarPath },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => avatarText
    };
    // 第 41 行(0 基 40)`\t\t\t<of> SKILL_SLOT </of>`:词 SKILL_SLOT
    // 起点 = 3 tab + `<of> `(5)= 8,取中 10。
    const locations = await serveReferencesFromRust(document as never, {
      line: 40,
      character: 10
    } as never, true);
    expect(locations).not.toBeNull();
    const uris = locations!.map(location => location.uri);
    // 声明先行:types.xml `<SKILL_SLOT>` 开标签行(1 基 14 → 0 基 13)。
    const declaration = locations!.find(location => location.uri === typesPath);
    expect(declaration).toBeDefined();
    expect(declaration!.range.start.line).toBe(13);
    expect(declaration!.range.start.character).toBe(0);
    // 使用位:Avatar.def 同文件 `<of>` 值(1 基 41 → 0 基 40)。
    const usage = locations!.find(location => location.uri === avatarPath);
    expect(usage).toBeDefined();
    expect(usage!.range.start.line).toBe(40);
  }, 20_000);

  it('rust 轨道:includeDeclaration=false 不含声明行', async () => {
    const defsDir = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs');
    const avatarPath = join(defsDir, 'Avatar.def');
    const typesPath = join(defsDir, 'types.xml');
    const avatarText = readFileSync(avatarPath, 'utf8');
    const document = {
      uri: { fsPath: avatarPath },
      languageId: 'kbengine-def',
      version: 1,
      getText: () => avatarText
    };
    const locations = await serveReferencesFromRust(document as never, {
      line: 40,
      character: 10
    } as never, false);
    expect(locations).not.toBeNull();
    // 使用位仍在,types.xml 声明行不在列。
    expect(locations!.some(location => location.uri === avatarPath)).toBe(true);
    expect(locations!.every(location => location.uri !== typesPath)).toBe(true);
  }, 20_000);

  it('rust 轨道:types.xml 符号引用 ITEM_ID → 语料使用位(无声明位)', async () => {
    const defsDir = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs');
    const avatarPath = join(defsDir, 'Avatar.def');
    const typesPath = join(defsDir, 'types.xml');
    const typesText = readFileSync(typesPath, 'utf8');
    // 语料前置:声明方 types.xml 与使用方 .def 都在库。
    await gate!.mirrorDocument(avatarPath, 'kbengine-def', 1, readFileSync(avatarPath, 'utf8'));
    const document = {
      uri: { fsPath: typesPath },
      languageId: 'xml',
      version: 1,
      getText: () => typesText
    };
    // 第 8 行(0 基 7)`\t<ITEM_ID> UINT16 </ITEM_ID>`:声明名 ITEM_ID,
    // 词起点 = 1 tab + `<` = 2,取中 4。
    const locations = await serveReferencesFromRust(document as never, {
      line: 7,
      character: 4
    } as never, true);
    expect(locations).not.toBeNull();
    // types.xml 面无声明位(TS provideTypesXmlReferences 同口径):唯一
    // 使用位 = 同文件 `<of> ITEM_ID </of>`(1 基 50 → 0 基 49)。
    expect(locations!.length).toBe(1);
    expect(locations![0].uri).toBe(typesPath);
    expect(locations![0].range.start.line).toBe(49);
  }, 20_000);

  it('rust 轨道:跨 root 同名异声明只收查询根语义引用(Shadow 不入列)', async () => {
    // 独立进程 + 显式双根注册(initialize workspaceFolders):同名类型
    // RATING 在两根各有独立声明。位置面会并收两根站点;语义面(生产面)
    // 只收「站点域声明==查询声明」的 root-a 站点 —— 用例即区分判据。
    const rootA = '/tmp/kode-e2e-refs-root-a';
    const rootB = '/tmp/kode-e2e-refs-root-b';
    const clientB = new KodeCoreClient({
      binaryPath,
      initializeParams: {
        processId: process.pid,
        capabilities: {},
        workspaceFolders: [
          { uri: `file://${rootA}`, name: 'root-a' },
          { uri: `file://${rootB}`, name: 'root-b' }
        ]
      }
    });
    const gateB = new KodeCoreGate({ clientFactory: () => clientB });
    gateB.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 5000 });
    // serveReferencesFromRust 走模块级全局门:本用例期间切到双根 gate
    // (镜像与请求同进程对账),finally 还原首用例 gate。
    setKodeCoreShadowGate(gateB);
    const defA = `${rootA}/scripts/entity_defs/MonsterA.def`;
    const typesA = `${rootA}/scripts/entity_defs/types.xml`;
    const defB = `${rootB}/scripts/entity_defs/MonsterB.def`;
    const typesB = `${rootB}/scripts/entity_defs/types.xml`;
    try {
      // 两根语料全量入库(didOpen 镜像,overlay-only 无需盘上文件)。
      await gateB.mirrorDocument(typesA, 'xml', 1, '<root>\n\t<RATING> UINT32 </RATING>\n</root>\n');
      await gateB.mirrorDocument(typesB, 'xml', 1, '<root>\n\t<RATING> UINT8 </RATING>\n</root>\n');
      const defAText = '<root>\n\t<Properties>\n\t\t<score>\n\t\t\t<Type> RATING </Type>\n\t\t</score>\n\t</Properties>\n</root>\n';
      const defBText = '<root>\n\t<Properties>\n\t\t<score>\n\t\t\t<Type> RATING </Type>\n\t\t</score>\n\t</Properties>\n</root>\n';
      await gateB.mirrorDocument(defA, 'kbengine-def', 1, defAText);
      await gateB.mirrorDocument(defB, 'kbengine-def', 1, defBText);
      const documentA = {
        uri: { fsPath: defA },
        languageId: 'kbengine-def',
        version: 1,
        getText: () => defAText
      };
      // 第 4 行(0 基 3)`\t\t\t<Type> RATING </Type>`:词 RATING 起点
      // = 3 tab + `<Type> `(7)= 10,取中 12。
      const locations = await serveReferencesFromRust(documentA as never, {
        line: 3,
        character: 12
      } as never, true);
      expect(locations).not.toBeNull();
      const uris = locations!.map(location => location.uri);
      // 查询根(root-a)声明 + 同根使用位全在列。
      expect(uris).toContain(typesA);
      expect(uris).toContain(defA);
      // 跨 root 同名(root-b 的声明与使用位)一律不入列(Shadow 过滤)。
      expect(uris).not.toContain(typesB);
      expect(uris).not.toContain(defB);
      expect(uris.every(uri => uri.startsWith(rootA))).toBe(true);
    } finally {
      setKodeCoreShadowGate(gate);
      await gateB.dispose().catch(() => undefined);
    }
  }, 30_000);

  it('rust 轨道:python 文档零请求直通 null(实体映射半边归 TS)', async () => {
    // 复用首用例 gate。py 的引用面(self 访问/方法调用)由 TS
    // entityMapping 半边接管,Rust 无此面(与 references.rs 批 1 边界同注)。
    const document = {
      uri: { fsPath: '/tmp/kode-e2e-refs-avatar.py' },
      languageId: 'python',
      version: 1,
      getText: () => 'class Avatar:\n    pass\n'
    };
    const locations = await serveReferencesFromRust(document as never, {
      line: 0,
      character: 6
    } as never, false);
    expect(locations).toBeNull();
  }, 20_000);
});
