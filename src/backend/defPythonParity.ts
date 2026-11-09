// 任务 C-19:def↔Python 方法一致性检查 + 一键生成骨架。
//
// 纯逻辑面(与 Rust 侧 `rules/def_python_parity.rs` 同口径,TS 只做符号表
// 采集与落盘,集合差/判定在 Rust):
// - [`collectDefPythonParityInput`]:按 KBEngine 标准布局
//   (`<assets>/scripts/{base,cell,client}/<Entity>.py`)把 def 文件的同名
//   实体类的各段已实现方法收成 `pythonParity` 入参(Rust RPC 直传);
// - [`buildPythonMethodSkeletonWithTypes`]:方法骨架,签名参数从 def `<Arg>`
//   类型映射(内建类型 → Python 注解,未识别兜底 `Any`),体默认
//   `raise NotImplementedError`(可 `pass` 配置)。
//
// 定位口径:def 文件名(去 `.def`)即实体名,同名 Python 类(与
// entityMapping 的 ownerName 同源);段文件解析失败/不存在 → 该段不产出
// (零误报,与 Rust 规则「段上下文缺失不核验」一致)。

import * as path from 'path';

import { parsePythonFile } from './pythonParser';
import { PYTHON_BUILTIN_TYPE_ANNOTATIONS, PYTHON_TYPE_STUB_FALLBACK } from '../pythonTypeStubs';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';

/** def 方法段 → 段目录名(KBEngine 标准布局 scripts/{base,cell,client})。 */
export type ParitySectionName = 'base' | 'cell' | 'client';

export const PARITY_SECTION_NAMES: readonly ParitySectionName[] = ['base', 'cell', 'client'];

/** Rust `PythonParitySection` 的 JSON 形(camelCase,TS 直传)。 */
export interface PythonParitySectionInput {
  pythonFile: string;
  implementedMethods: string[];
}

/** Rust `PythonParityInput` 的 JSON 形(camelCase,TS 直传)。 */
export interface PythonParityInput {
  pythonClass: string;
  base?: PythonParitySectionInput;
  cell?: PythonParitySectionInput;
  client?: PythonParitySectionInput;
}

/** 生成体形态(任务口径:raise NotImplementedError 或 pass,可配)。 */
export type ParitySkeletonBody = 'raise' | 'pass';

/** KBEngine 内置类型 → Python 注解(与 pythonTypeStubs 同表;未识别兜底)。 */
export function mapDefTypeToPythonAnnotation(typeName: string): string {
  const trimmed = typeName.trim();
  return PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed] ?? PYTHON_TYPE_STUB_FALLBACK;
}

/**
 * 方法骨架:4 缩进 `def <name>(self, argN: <注解>...)` + 体。签名参数按 def
 * `<Arg>` 类型序列映射(arg0..argN-1 与 IDE-NAV-014 同名序),无参数仅
 * (self);体默认 `raise NotImplementedError`(方法未实现语义)。
 */
export function buildPythonMethodSkeletonWithTypes(
  methodName: string,
  argTypes: readonly string[],
  body: ParitySkeletonBody = 'raise'
): string {
  const args = argTypes.map(
    (typeName, index) => `arg${index}: ${mapDefTypeToPythonAnnotation(typeName)}`
  );
  const signature = `def ${methodName}(self${args.length ? `, ${args.join(', ')}` : ''}) -> None:`;
  const bodyLine = body === 'raise' ? 'raise NotImplementedError' : 'pass';
  return `    ${signature}\n        ${bodyLine}\n`;
}

/**
 * 由 def 文件路径解析 assets 根(KBEngine 布局 `<root>/scripts/entity_defs/`),
 * 返回 `<root>`(截去 `/scripts/` 尾);非该布局 → null(不猜)。
 */
function assetsRootOfDefFile(defFile: string): string | null {
  const normalized = defFile.replace(/\\/g, '/');
  const marker = normalized.indexOf('/scripts/entity_defs/');
  if (marker <= 0) {
    return null;
  }
  const root = normalized.slice(0, marker);
  return root.endsWith('/scripts') ? root.slice(0, -'/scripts'.length) : root;
}

/** 实体名 = def 文件名去 `.def`(同名 Python 类,entityMapping ownerName 同源)。 */
export function entityNameOfDefFile(defFile: string): string {
  return path.basename(defFile, '.def');
}

/**
 * 采集一个 def 文件的 `pythonParity` 入参:对每个方法段,按标准布局定位
 * `scripts/{section}/{entity}.py`,读盘(打开缓冲区优先),解析出同名类的
 * 已实现方法集合。段文件缺失/解析失败 → 该段省略(零误报)。整体无法定位
 * assets 根 → 返回 null(调用方不给 pythonParity,Rust 规则零产出)。
 */
export function collectDefPythonParityInput(defFile: string): PythonParityInput | null {
  const assetsRoot = assetsRootOfDefFile(defFile);
  if (!assetsRoot) {
    return null;
  }
  const entityName = entityNameOfDefFile(defFile);
  const input: PythonParityInput = { pythonClass: entityName };
  for (const section of PARITY_SECTION_NAMES) {
    const pythonFile = path.join(assetsRoot, 'scripts', section, `${entityName}.py`);
    const snapshot = readSharedFileSnapshot(pythonFile);
    if (!snapshot) {
      continue;
    }
    const parsed = parsePythonFile(snapshot.content, pythonFile);
    const cls = parsed.classes.find(item => item.name === entityName);
    if (!cls) {
      continue;
    }
    input[section] = {
      pythonFile,
      implementedMethods: [...cls.methods.keys()]
    };
  }
  return input;
}
