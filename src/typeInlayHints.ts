import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import { findPythonSelfPropertyAccesses, propertyAccessKey } from './propertyCodeLens';

// 批154(用户令 todo:7):types.xml 数据类型 inlay hints —— python 侧
// self.<属性> 访问处原位渲染 def 声明的 <Type> 取值(types.xml 自定义别名
// 或内建),读法与属性 F12/属性标记同走 resolvePropertyDefinitionInfo 索引,
// 零重复解析。一枚独立开关 kbengine.inlayHints.typeData(默认开);inlay
// 没有变更事件可 fire,provider 每次调用现读配置,下一次渲染即生效。
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
      if (!typeName) {
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
    return hints;
  }
}
