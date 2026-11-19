/**
 * 热更配置文件闸(RUST-336 / 旧 HR-WATCH-012 配置检查半面):批内 KBEngine
 * 配置文件在发送前做内容校验——types.xml 值域/一致性复用 RUST-177 引擎
 * 真源结构检查(computeTypesXmlStructureFindings),其余配置 XML(entity_defs
 * 实体定义/kbengine.xml)至少过良构。致命发现即整批拦下,不默认发送半成品
 * 配置(与语法闸「有错误时标 blocked」同语义,闸位在火线路径,与 def 结构
 * 闸 IDE-REV-024 邻位);零发现放行走普通通道(与 def 非结构批同哲学:
 * 证明不了的风险拦,证明得了的放)。
 *
 * 保守边界与 def 闸同口径:内容读不到/无读取通道 = 证明不了无风险,如实
 * 拦下并点名原因,不猜;引擎非致命级(别名重定义等 Warning)不拦,与引擎
 * 「打日志但装载继续」的行为一致。纯核零 vscode,读取通道由装配注入。
 */

import { parseDefDocument } from './defParser';
import { computeTypesXmlStructureFindings } from './typesXmlStructureCheck';

/** 所发文件内容读取口(与 HotReloadTargetStateWiring.readFileContent 同形) */
export type ConfigContentReader = (file: string) => Promise<string | null> | string | null;

export interface ConfigGateVerdict {
  /** 拦下理由列表(空数组=放行) */
  readonly reasons: readonly string[];
}

const basename = (file: string): string => {
  const norm = file.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1).toLowerCase();
};

/**
 * 热更配置文件判定:types.xml(KBEngine 类型表)、kbengine.xml/
 * kbengine_defaults.xml(引擎全局配置)任意目录,以及 entity_defs/ 下的
 * 实体定义 XML。判定只看路径形状,不猜项目布局之外的文件。
 */
export function isHotReloadConfigFile(file: string): boolean {
  const norm = file.replace(/\\/g, '/').toLowerCase();
  const base = basename(file);
  if (base === 'types.xml' || base === 'kbengine.xml' || base === 'kbengine_defaults.xml') {
    return true;
  }
  return norm.endsWith('.xml') && norm.includes('/entity_defs/');
}

/**
 * 对一批待发送文件里的配置文件做校验,返回拦下理由(空=放行)。
 * 非配置文件不读不判(纯 Python 批零额外 IO);配置文件逐个:
 * 读不到=保守拦;畸形 XML=良构拦;types.xml 另跑引擎真源结构检查,
 * 只拦 error 级(Warning 与引擎「打日志但继续」同行为,不拦)。
 */
export async function checkHotReloadConfigFiles(
  files: readonly string[],
  readFile: ConfigContentReader
): Promise<ConfigGateVerdict> {
  const configFiles = files.filter(isHotReloadConfigFile);
  if (configFiles.length === 0) {
    return { reasons: [] };
  }
  const reasons: string[] = [];
  for (const file of configFiles) {
    let content: string | null | undefined;
    try {
      content = await readFile(file);
    } catch (error) {
      reasons.push(`${file}: 内容读取异常(${(error as Error).message}),证明不了无风险(保守拦)`);
      continue;
    }
    if (content === null || content === undefined) {
      reasons.push(`${file}: 内容不可读,证明不了无风险(保守拦)`);
      continue;
    }
    // 良构:畸形 XML 解析器抛异常(defParser 定位失败);空文档(无根元素)
    // 如实放行,交由 types.xml 面的零发现口径
    try {
      parseDefDocument(content);
    } catch (error) {
      reasons.push(`${file}: XML 良构失败(${(error as Error).message})`);
      continue;
    }
    if (basename(file) === 'types.xml') {
      const fatal = computeTypesXmlStructureFindings(content).filter(
        finding => finding.severity === 'error'
      );
      for (const finding of fatal) {
        reasons.push(`${file}: ${finding.message}`);
      }
    }
  }
  return { reasons };
}
