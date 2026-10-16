# 客户端实体 SDK 生成


按 `entities.xml` 登记的实体，从 `.def` 生成客户端实体骨架。当前支持 TypeScript 与 C# 两种目标语言，在命令内勾选（可多选）。

## 能力概览

- 生成来源：`entities.xml` 登记的实体，缺 `.def` 文件的登记项跳过
- 属性面：只收 `Flags` 含客户端域（`BASE_AND_CLIENT`/`OWN_CLIENT`/`CELL_PUBLIC_AND_OWN`/`ALL_CLIENTS`/`OTHER_CLIENTS`）的项，成为可写字段
- 回调面：`ClientMethods` 成为虚位回调，签名与参数类型齐全，方法体留 TODO
- 请求面：带 `<Exposed>` 的 `BaseMethods`/`CellMethods` 成为包装调用
- 发送接缝：`onBaseOutgoing`/`onCellOutgoing` 两个空实现，实际发送通道按所用客户端插件自己实现
- 固定字典：被客户端可见属性引用的 `FIXED_DICT` 类型另出伴随文件
- 不自动覆盖：默认跳过已存在文件，覆盖策略在命令内选

## 相关命令

- `kbengine.clientSdk.generate`

命令说明见 [命令与面板](./commands.md)。

## 相关配置

### `kbengine.clientSdk.outputDir`

输出目录，相对工作区根，默认 `scripts/client_entities`。语言清单不在此配置，在命令执行时勾选。

## 生成内容口径

### 实体文件

每个实体一个文件，文件名为 `<实体名>.ts` / `<实体名>.cs`。类内依次是：实体 id 只读成员、客户端可见属性、构造函数、`ClientMethods` 回调、Exposed 包装调用、两个发送接缝。

- TypeScript：属性保持 def 原名，回调为具体方法，参数名 `_arg0`/`_arg1`…（def 的 `<Arg>` 只有类型没有名字）
- C#：命名转 PascalCase（`hp` → `Hp`、`onHPChanged` → `OnHPChanged`），属性为 `get; set;`，回调为 `virtual`，参数写在类型之后，参数名 `arg0`/`arg1`…

### 属性

只收客户端可见项，纯服务端属性（`BASE`、`CELL`、`CELL_PRIVATE`）不进客户端面。每个属性上方标注 def 的原始 `Flags`，便于回查引擎语义。

### 方法

- `ClientMethods` 全部收入，不要求 `<Exposed>`——它们是客户端要实现的回调位
- `BaseMethods`/`CellMethods` 只收带 `<Exposed>` 的；未 Exposed 的服务端方法客户端不可请求，不生成

### 发送接缝

包装调用的方法体只做一件事：把方法名和参数交给对应接缝。

```ts
public baseCallCreateAvatar(_arg0: number): void {
  this.onBaseOutgoing('createAvatar', [_arg0]);
}
```

接缝本身是空实现。客户端插件各自的 base/cell 调用通道（Unity 插件、js 插件等）由使用者在自己的继承类里实现接缝，生成器不假设任何插件 API。

## 类型映射

| def 类型 | TypeScript | C# |
| --- | --- | --- |
| `UINT8` / `UINT16` / `UINT32` / `UINT64` | `number` | `byte` / `ushort` / `uint` / `ulong` |
| `INT8` / `INT16` / `INT32` / `INT64` | `number` | `sbyte` / `short` / `int` / `long` |
| `FLOAT` / `DOUBLE` | `number` | `float` / `double` |
| `STRING` / `UNICODE` | `string` | `string` |
| `VECTOR2` / `VECTOR3` / `VECTOR4` | `[number, number]` / `[number, number, number]` / `[number, number, number, number]` | `Vector2` / `Vector3` / `Vector4` |
| `ENTITYCALL` / `PYTHON` / `PY_DICT` / `PY_TUPLE` / `PY_LIST` / `BLOB` | `unknown` | `object` |
| `ARRAY`（`<of>` 元素类型） | 元素类型 + `[]` | 元素类型 + `[]` |
| `FIXED_DICT` 别名 | 伴随文件的 `interface` 名 | 伴随文件的 `class` 名 |
| 未识别 | `unknown` | `object` |

类型表与引擎注册表同源（17 个内置类型）。引擎未注册的 `BOOL` 等幻影类型不给映射，落兜底值，由 def 分析诊断照报。

C# 向量默认 `Vector2`/`Vector3`/`Vector4` 裸名（Unity 自带）；非 Unity 工程按工程内的向量类型改名。

## 固定字典伴随文件

有客户端可见属性引用 `FIXED_DICT` 别名时才出伴随文件，文件名为 `ClientSdkFixedDicts.ts` / `ClientSdkFixedDicts.cs`，只收录被引用到的类型（`types.xml` 里声明了但没被引用的别名不生成）。TypeScript 侧为 `interface` 并由实体文件 `import`，C# 侧为 `class`，与实体文件同命名空间（固定 `KbEngineClient`，改名需改生成器常量 `CLIENT_SDK_CSHARP_NAMESPACE`）。

## 典型流程

1. 打开工程，确认 `scripts/entities.xml` 与 `scripts/entity_defs/` 布局正常
2. 执行 `Generate Client Entity SDK`
3. 勾选目标语言
4. 确认输出目录（默认 `scripts/client_entities`）
5. 选择已存在文件的处理方式（默认跳过）
6. 在通知里看写入了几个文件
7. 在自己的继承类里实现 `onBaseOutgoing`/`onCellOutgoing`，接上所用客户端插件的调用通道

## 当前边界

还没有做到：

- 不生成客户端插件的调用通道实现，`onBaseOutgoing`/`onCellOutgoing` 需要按所用插件自己实现
- 语言清单首批只有 TypeScript 与 C#；GDScript、C++ 未做
- 只按 `entities.xml` 登记的实体生成，未登记的 `.def` 不生成
- 默认不覆盖已存在文件，重复生成同名实体会被跳过
- 生成文件不自动进入版本控制或构建流程，接入方式由使用者决定
