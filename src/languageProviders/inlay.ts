// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { EntityMappingManager } from '../entityMapping';
import { getDocumentLines } from '../documentStore';
import { hasKnownEntityBuiltinPropertyType, resolveEntityComponentFaceFromPath, collectEntityBuiltinPropertyInlayTargets, type EntityComponentFace } from '../entityBuiltinProperties';
import { getLanguageFeatureConfig } from './shared';
/**
 * 内建属性行内类型提示(用户令 2026-10-21 形态升级单 ③):实体脚本内单段
 * `self.<内建属性>` 访问处在其 range 之后渲染 `: <type>` 右对齐提示
 * (kind=Type);面判定与命中集合和 hover 同一底座
 * (resolveEntityComponentFaceFromPath / getEntityComponentFacesForPythonFile /
 * resolveEntityBuiltinPropertyHit)。开关 kbengine.python.builtinTypeInlayHints
 * (默认开)且受总闸 kbengine.entity.builtinProperties 双控,false 即不给
 * 提示;provider 每次现读配置,下一次渲染即生效(inlay 无变更事件可 fire)。
 */
export class KBEngineBuiltinTypeInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    const featureConfig = getLanguageFeatureConfig();
    if (!featureConfig.entityBuiltinProperties || !featureConfig.entityBuiltinTypeInlayHints) {
      return [];
    }
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    let defFaces: readonly EntityComponentFace[] | null = null;
    if (!pathFace) {
      if (!this.entityMappingManager) {
        return [];
      }
      try {
        defFaces = await this.entityMappingManager.getEntityComponentFacesForPythonFile(
          document.fileName
        );
      } catch {
        defFaces = null;
      }
    }
    // PR2 快照接入:行数组走 documentStore(同版本复用,不再逐次全文拆行)
    const lines = getDocumentLines(document);
    return collectEntityBuiltinPropertyInlayTargets(lines, pathFace, defFaces)
      // inlay 按可视区要:视图口外的访问行不出 hint(批154 同口径);
      // Any 位(未知)按「能推才显」闸整个不出 hint(无提示降级)
      .filter(target => hasKnownEntityBuiltinPropertyType(target.property))
      .filter(target => target.line >= range.start.line && target.line <= range.end.line)
      .map(
        target =>
          new vscode.InlayHint(
            new vscode.Position(target.line, target.endCharacter),
            `: ${target.property.type}`,
            vscode.InlayHintKind.Type
          )
      );
  }
}
