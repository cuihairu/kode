import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import { findPythonSelfPropertyAccesses, propertyAccessKey } from './propertyCodeLens';
import {
  getWorkspaceRootForDocument,
  resolveEntityAnnotationType
} from './definitionWorkspace';
import { PYTHON_TYPE_STUB_FALLBACK } from './pythonTypeStubs';
import {
  findPythonReceiverCallArguments,
  type PythonReceiverCallWithArguments
} from './pythonLanguageUtils';

// 批154(用户令 todo:7):types.xml 数据类型 inlay hints —— python 侧
// self.<属性> 访问处原位渲染 def 声明的 <Type> 取值(types.xml 自定义别名
// 或内建),读法与属性 F12 同走 resolvePropertyDefinitionInfo 索引,
// 零重复解析。一枚独立开关 kbengine.inlayHints.typeData(默认开);inlay
// 没有变更事件可 fire,provider 每次调用现读配置,下一次渲染即生效。
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
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>('inlayHints.typeData', true)) {
      return [];
    }

    // 同一属性多处访问只解析一次:解析结果按 (根段, 完整路径) 一一对应
    // (与属性标记 provider 同口径,共用 propertyAccessKey 键)
    const hits = new Map<string, string | null>();
    const hints: vscode.InlayHint[] = [];
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
        hits.set(key, location ? location.typeName ?? null : null);
      }
      const typeName = hits.get(key);
      if (!typeName || typeName === 'Any') {
        // 无 typeName 或解析落 Any(未知)→ 不出提示(能推才显,不显 Any)
        continue;
      }
      hints.push(
        new vscode.InlayHint(
          new vscode.Position(access.line, access.character + access.rootSymbol.length),
          `: ${typeName}`,
          vscode.InlayHintKind.Type
        )
      );
    }
    await this.collectRpcParameterHints(document, range, hints);
    return hints;
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
