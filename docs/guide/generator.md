# 代码生成器

Kode 内置实体代码生成器，用来快速创建 `.def` 和配套 Python 文件。

## 能力概览

- 实体创建向导
- 预置模板
- 自动生成 `.def`
- 自动生成 Python 文件
- 自动注册到 `entities.xml`
- 可配置输出目录

其中：

- 是否生成 Python 取决于 `kbengine.generator.generatePython`
- 是否写入 `entities.xml` 取决于 `kbengine.generator.registerInEntitiesXml`
- `entities.xml` 的目标位置会读取 `kbengine.entitiesXmlPath`

## 相关命令

- `kbengine.generator.wizard`
- `kbengine.generator.templates`

## 生成方式

### 向导模式

适合：

- 新建标准实体
- 逐步填写属性和方法
- 不想手写初始 XML 结构

### 模板模式

适合：

- 快速生成常见实体
- 团队内部约定的标准起点

## 相关配置

### `kbengine.generator.defOutputPath`

控制 `.def` 文件输出目录。

### `kbengine.generator.pythonOutputPath`

控制 Python 文件输出目录。

### `kbengine.generator.generatePython`

是否同时生成 Python 文件。

### `kbengine.generator.registerInEntitiesXml`

是否在生成后自动写入 `entities.xml`。

## 典型流程

1. 执行 `Create Entity from Wizard`
2. 选择实体名称和模板
3. 配置属性、方法、Base / Cell / Client 结构
4. 生成 `.def`
5. 按配置决定是否生成 Python
6. 按配置决定是否注册到 `entities.xml`

## 适合的使用场景

### 初始建模

在项目早期快速搭出实体骨架。

### 团队规范

通过统一模板减少：

- 手写 XML 格式错误
- 输出目录不一致
- `entities.xml` 漏注册

### 教学和 onboarding

新成员可以先从生成器出发，再去理解最终产物结构。

## 当前边界

当前生成器适合“快速起步”和“标准模板生成”。

还没有做到：

- 团队级模板库管理
- 自定义模板编辑器
- 从现有实体反向提炼模板
- 更复杂的继承链建模向导
