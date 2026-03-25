# 语言能力

本页说明 Kode 在 `.def` 文件上的语言能力，包括高亮、补全、悬停、跳转和诊断。

## 支持范围

当前重点支持：

- `.def` 文件
- `entities.xml`
- 生成后的 Python 实体文件与 `.def` 的双向关联

## 语法高亮

`.def` 不是按“普通 XML”处理，而是按 KBEngine 语义做高亮。

### 当前高亮重点

- 区块标签
  - `Properties`
  - `CellProperties`
  - `ClientProperties`
  - `BaseMethods`
  - `CellMethods`
  - `ClientMethods`
- 字段标签
  - `Type`
  - `Flags`
  - `Default`
  - `Database`
  - `Identifier`
  - `DetailLevel`
  - `Arg`
- 类型值
  - `UINT32`
  - `VECTOR3`
  - `ARRAY`
  - `FIXED_DICT`
  - `TUPLE`
- 标志值
  - `BASE_CLIENT`
  - `CELL_PUBLIC`
  - `ALL_CLIENTS`
- 自定义属性名和方法名

### 设计目标

- 让 `.def` 看起来像 KBEngine DSL，而不是“套了颜色的 XML”
- 让结构标签、值和业务定义有明显层次
- 给后续诊断和跳转打基础

## 智能提示

### 类型补全

在 `<Type>` 或 `<Arg>` 的值语境中会提供常见类型补全。

### Flags 补全

在 `<Flags>` 中会提供 Flags 建议。

### DetailLevel 补全

在 `<DetailLevel>` 中会提供：

- `LOW`
- `MEDIUM`
- `HIGH`
- `CRITICAL`

### 标签补全

输入 `<` 时会提示常见结构标签。

## Hover

当前 Hover 分为三类，可以单独开关。

### 标签说明

例如悬停：

- `Type`
- `Flags`
- `Properties`
- `FIXED_DICT`

会显示该标签的用途说明。

配置项：

- `kbengine.hover.showTagDocs`

### 值说明

例如悬停：

- `UINT32`
- `BASE_CLIENT`
- `HIGH`

会显示值的含义、用途和说明。

配置项：

- `kbengine.hover.showValueDocs`

### 自定义符号摘要

例如悬停自定义属性或方法：

```xml
<HP>
  <Type> UINT32 </Type>
  <Flags> BASE_CLIENT </Flags>
</HP>
```

会显示当前定义的摘要信息，例如：

- `Type`
- `Flags`
- `Default`
- `DetailLevel`
- `Arg`

配置项：

- `kbengine.hover.showSymbolDocs`

## 跳转定义

### 当前支持

- 从 `entities.xml` 跳转到对应的 `.def`
- 从 `.def` 中 `Type` / `Arg` 里的实体引用跳转到对应实体定义
- 从生成的 Python 文件跳转回 `.def` 中的属性和方法

### 典型示例

```xml
<Target>
  <Type> Avatar </Type>
  <Flags> BASE_CLIENT </Flags>
</Target>
```

把光标放到 `Avatar` 上，可以跳到 `Avatar.def`。

## 诊断

诊断分成“总开关”和“规则子开关”。

### 当前规则

- 未知类型
- 未知 Flags
- 未知 DetailLevel
- `BASE` 与 `CELL_*` 冲突
- 重复属性或方法
- 非法子标签
- 属性缺少 `Type` / `Flags`

### 推荐使用方式

如果你觉得过于频繁，不要直接关掉全部诊断，优先关闭这些更吵的规则：

- `kbengine.diagnostics.checkDuplicateDefinitions`
- `kbengine.diagnostics.checkInvalidChildren`
- `kbengine.diagnostics.checkMissingPropertyFields`

更完整的说明见 [配置说明](./configuration.md)。

## 当前边界

目前还没有完整做到：

- 属性/方法重命名级别的真正重构支持
- 默认值与类型的严格匹配检查
- 跨全部项目实体引用的深度静态分析

这些属于下一阶段增强。
