import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import { findPythonSelfPropertyAccesses, propertyAccessKey } from './propertyCodeLens';
import {
  getWorkspaceRootForDocument,
  resolveEntityAnnotationType,
  resolveEntityFixedDictMember
} from './definitionWorkspace';
import { PYTHON_TYPE_STUB_FALLBACK } from './pythonTypeStubs';
import {
  findPythonReceiverCallArguments,
  type PythonReceiverCallWithArguments
} from './pythonLanguageUtils';
import { getKbeAliases } from './kbeModuleIndex';
import {
  GlobalDataDictIndex,
  findKbeDataDictAccesses,
  inferDataDictValueType,
  isKeyInsideLineComment
} from './globalDataIndex';

// 批154(用户令 todo:7):types.xml 数据类型 inlay hints —— python 侧
// self.<属性> 访问处原位渲染 def 声明的 <Type> 注解(2026-10-29 用户定
// 口径:解析到底——SERVER_ID(types.xml 别名)→int、VECTOR3→定长 tuple,
// 与下方 RPC 实参 inlay 同一 resolveEntityAnnotationType 链,同文件单一
// 口径),读法与属性 F12 同走 resolvePropertyDefinitionInfo 索引,
// 零重复解析;PYTHON(任意可 pickle 对象,datatype.cpp PythonType)与
// 未知类型最终落 Any,按「能推才显」闸不出提示。一枚独立开关
// kbengine.inlayHints.typeData(默认开);inlay 没有变更事件可 fire,
// provider 每次调用现读配置,下一次渲染即生效。
//
// RPC 调用点形参提示(用户令 2026-10-21 形态升级单;2026-10-29 用户定形态
// 只显类型):self.base/self.cell/self.client.X(...) 每实参后插 `: <类型>`,
// 只做 def 已声明的(不做任何推导):resolveMethodDefinition 第三参段闸同源
// (段不符/解析不出 → null,不给),形参类型走 formatDefMethodSignature
// (languageProviders.ts)同一 resolveEntityAnnotationType 解析链;不带合成
// 形参名 argN(.def <Arg> 无名可考,调用点上名字是噪音——名字留给签名
// 帮助/存根面);<Arg> 缺席/实参文本空/类型解析落 Any 的位不出;
// 实参数与声明数错位按位置对齐(取 min,逐位配对);跨行调用(同行括号
// 不闭合)不出。开关复用既有贡献面 kbengine.inlayHints.typeData。
export class PythonTypeInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(
    private entityMappingManager: EntityMappingManager,
    // GLOBDATA-002:数据字典键索引(读点类型并同键写点值类型);未注入跳过
    private dataDictIndex?: GlobalDataDictIndex
  ) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>('inlayHints.typeData', true)) {
      return [];
    }

    // 同一属性多处访问只解析一次:解析结果按 (根段, 完整路径) 一一对应
    // (与属性标记 provider 同口径,共用 propertyAccessKey 键)。子成员命中
    // (FIXED_DICT 字段/字典方法)时 member=true,标注位随完整路径。
    const hits = new Map<string, { annotation: string | null; member: boolean }>();
    const hints: vscode.InlayHint[] = [];
    const propertyWorkspaceRoot = getWorkspaceRootForDocument(document);
    const documentLines = document.getText().split(/\r?\n/);
    for (const access of findPythonSelfPropertyAccesses(document.getText())) {
      // inlay 按可视区要:视图口外的访问行不出 hint
      if (access.line < range.start.line || access.line > range.end.line) {
        continue;
      }
      const key = propertyAccessKey(access);
      if (!hits.has(key)) {
        const location = await this.entityMappingManager.resolvePropertyDefinitionInfo(
          document.fileName,
          access.fullPath,
          access.rootSymbol
        );
        // FIXED_DICT 子成员面(2026-10-30 用户令):fullPath 有后缀且根类型是
        // FIXED_DICT 时钻入 types.xml 解析子字段注解(items/keys/values/get 与
        // 字段读);未命中落回根注解(不硬造)。
        let memberHit: string | null = null;
        if (location?.typeName && access.fullPath !== access.rootSymbol) {
          const suffix = access.fullPath.slice(access.rootSymbol.length + 1);
          const isCall = isMemberCallAt(
            documentLines[access.line],
            access.character + access.fullPath.length
          );
          memberHit = resolveEntityFixedDictMember(
            propertyWorkspaceRoot ?? '',
            location.typeName,
            suffix,
            isCall
          );
        }
        hits.set(
          key,
          memberHit
            ? { annotation: memberHit, member: true }
            : {
                // 2026-10-29 用户定口径:解析到底(与 RPC 实参 inlay 同链)——
                // 别名/内建都到最终注解;PYTHON/未知落 Any 不出(能推才显)
                annotation: location?.typeName
                  ? resolveEntityAnnotationType(propertyWorkspaceRoot ?? '', location.typeName)
                  : null,
                member: false
              }
        );
      }
      const hit = hits.get(key);
      if (!hit || !hit.annotation || hit.annotation === PYTHON_TYPE_STUB_FALLBACK) {
        // 无 typeName 或解析落 Any(未知)→ 不出提示(能推才显,不显 Any)
        continue;
      }
      // 子成员命中标在完整路径后(items() 紧贴方法名/字段名);根命中标在根段后
      hints.push(
        new vscode.InlayHint(
          new vscode.Position(
            access.line,
            access.character + (hit.member ? access.fullPath.length : access.rootSymbol.length)
          ),
          `: ${hit.annotation}`,
          vscode.InlayHintKind.Type
        )
      );
    }
    await this.collectRpcParameterHints(document, range, hints);
    await this.collectDataDictHints(document, range, documentLines, hints);
    return hints;
  }

  /**
   * GLOBDATA-002 数据字典键类型提示:写点 `[K]=RHS` 出 `: <RHS 类型>`;
   * 读点 `[K]`/`.get(K)` 出 `: <同键写点值类型 union>`(无写点/推不出
   * 不出)。能推才显:inferDataDictValueType 严格面(Any/未知一律 null)。
   * 开关现读 kbengine.python.enableDataDictIndex(与 typeData 同款);
   * 写点只读本行无需索引(纯字面量面),读点才懒建索引(与 definition
   * 同源),纯写点文档零扫描成本。
   */
  private async collectDataDictHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    documentLines: string[],
    hints: vscode.InlayHint[]
  ): Promise<void> {
    if (!this.dataDictIndex) {
      return;
    }
    if (!vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableDataDictIndex', true)) {
      return;
    }
    const aliases = getKbeAliases(document.getText());
    if (aliases.size === 0) {
      return;
    }
    let ensured = false;
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(documentLines.length - 1, range.end.line);
    for (let line = startLine; line <= endLine; line += 1) {
      const lineText = documentLines[line];
      for (const access of findKbeDataDictAccesses(lineText, aliases)) {
        if (isKeyInsideLineComment(lineText, access.keyStart)) {
          continue;
        }
        if (access.kind === 'write') {
          const annotation = inferDataDictValueType(access.valueText);
          if (annotation !== null) {
            hints.push(new vscode.InlayHint(
              new vscode.Position(line, access.exprEnd),
              `: ${annotation}`,
              vscode.InlayHintKind.Type
            ));
          }
          continue;
        }
        // 读点:同键写点值类型 union(能推才显,无写点/全未知不出)
        if (!ensured) {
          await this.dataDictIndex.ensureStarted();
          ensured = true;
        }
        const types: string[] = [];
        for (const site of this.dataDictIndex.query(access.dict, access.keySignature)) {
          if (site.kind !== 'write') {
            continue;
          }
          const type = inferDataDictValueType(site.valueText);
          if (type !== null && !types.includes(type)) {
            types.push(type);
          }
        }
        if (types.length > 0) {
          hints.push(new vscode.InlayHint(
            new vscode.Position(line, access.exprEnd),
            `: ${types.join(' | ')}`,
            vscode.InlayHintKind.Type
          ));
        }
      }
    }
  }

  /**
   * RPC 调用点形参提示(只做 def 已声明的):每调用按段闸解析一次
   * (同 (接收者, 方法名) 记忆化,一文档多调用点零重复解析),声明 <Arg>
   * 序列与同行实参按位置配对,逐位出 `: <类型>`(kind=Parameter,与定义点
   * defParams inlay 同风格;不带 argN 合成名)。
   */
  private async collectRpcParameterHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    hints: vscode.InlayHint[]
  ): Promise<void> {
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const resolved = new Map<
      string,
      Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>
    >();
    for (const call of findPythonReceiverCallArguments(document.getText())) {
      // inlay 按可视区要:视图口外的调用行不出 hint
      if (call.line < range.start.line || call.line > range.end.line) {
        continue;
      }
      const location = await this.resolveRpcMethod(document, call, resolved);
      // 段不符/解析不出(resolveMethodDefinition 段闸第三参,miss 即 null)
      // → 不给提示
      if (!location) {
        continue;
      }
      const declaredArgs = location.declaredArgs ?? [];
      // 只做 def 已声明的:def 未声明 <Arg> 不硬造
      if (declaredArgs.length === 0) {
        continue;
      }
      // 数量错位按位置对齐:取声明数与实参数的 min,逐位配对
      const paired = Math.min(declaredArgs.length, call.arguments.length);
      for (let index = 0; index < paired; index += 1) {
        const declared = declaredArgs[index].trim();
        const argument = call.arguments[index];
        // def 有 <Arg> 无 <Type> 直文本,或实参空白(如尾逗号)→ 该位不出
        if (!declared || !argument.text) {
          continue;
        }
        // 类型与签名 formatter 同一解析链;链断/未知(落 Any)→ 该位不出
        const annotation = resolveEntityAnnotationType(workspaceRoot ?? '', declared);
        if (annotation === PYTHON_TYPE_STUB_FALLBACK) {
          continue;
        }
        // 只显类型不带 argN:.def <Arg> 无形参名可考,合成名在调用点是
        // 噪音(2026-10-29 用户定形态;定义点 defParams inlay 同风格)
        hints.push(
          new vscode.InlayHint(
            new vscode.Position(call.line, argument.end),
            `: ${annotation}`,
            vscode.InlayHintKind.Parameter
          )
        );
      }
    }
  }

  /** 段闸解析记忆化:同 (接收者, 方法名) 一次解析,跨调用点复用 */
  private async resolveRpcMethod(
    document: vscode.TextDocument,
    call: PythonReceiverCallWithArguments,
    resolved: Map<
      string,
      Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>
    >
  ): Promise<Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>> {
    const key = `${call.receiver}.${call.methodName}`;
    if (!resolved.has(key)) {
      let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
      try {
        location = await this.entityMappingManager.resolveMethodDefinition(
          document.fileName,
          call.methodName,
          call.section
        );
      } catch {
        location = null;
      }
      resolved.set(key, location);
    }
    return resolved.get(key) ?? null;
  }
}

/**
 * 成员名后紧跟 `(`(允许空白)= 方法调用:FIXED_DICT 字典方法面
 * (items/keys/values/get)据此区分「方法调用」与「字段读」。endColumn 为
 * 成员名末尾列(fullPath 末列),其后字符是 `(` 即调用。
 */
function isMemberCallAt(line: string, endColumn: number): boolean {
  return /^\s*\(/.test(line.slice(endColumn));
}
