# stubCopy 窄闸:内置桩包复制默认关(用户令 2026-11-16)

日期:2026-11-16
起因:用户令「stub 生成复制版本,在复制版本上修改默认关闭吧」——激活期自动往
工作区 `.kbengine/stubs/` 复制内置桩包这一步,默认不再发生。方案经用户拍板:
**只关复制,其余保持开**——总闸 `kbengine.python.stubExport`(默认 true)继续管
四件事,新增窄闸 `kbengine.python.stubCopy`(默认 **false**)只切其中「往工作区
复制桩包」这一步。

## 生产码(src/pythonStubExport.ts)

- `PYTHON_STUB_COPY_SETTING = 'python.stubCopy'`、
  `PYTHON_STUB_COPY_ENABLED_DEFAULT = false`;
- `StubExportOptions.manual?: boolean`:命令面板显式调用传 true,绕过窄闸
  (否则默认关闭变成不可恢复);
- `readStubCopyEnabled()`:读 `kbengine` 段窄闸键;
- `exportKbeStubs` 双闸:总闸 stubExport 先行(文案报 stubExport),窄闸其次
  (非静默时提示「自动复制已关闭(stubCopy,开启即激活期自动复制)」);
  `manual: true` 直过窄闸;
- 受闸的自动路径两处(装配层 src/activate/generators.ts):激活期静默导出链
  与托管目录 watcher 自动重建链——均不带 manual,默认关后零写;
- 不受窄闸的面:`kbengine.python.exportStubs`(manual:true)+ `resetStubs`
  (本就确认式覆盖,无窄闸)+ `exportTypeStubs`/实体存根方法面/extraPaths
  同步(归总闸管,总闸默认开不变)。

## manifest 与文档锁步

- package.json:`kbengine.python.stubCopy` boolean 默认 false(插在
  stubExport 前,总属性数 151);双 nls 各 367 键,描述含机制段+默认值段+
  详见链(默认包文案对齐仓库惯例为中文,`默认值`/`详见 [` 字面量过
  configMarkdownDescription 闸);
- docs/guide/configuration.md en+zh:总览分区表 stubCopy 行(stubExport 行前)
  + 末尾计数段补 2026-11-16 新增注;
- docs/features.md en+zh:特性条改「`stubCopy` 开启时才复制,默认关」+ 证据链
  加 stubCopy;Settings 表加 stubCopy 行+stubExport 行补窄闸注。
  docsCommands 四闸(configMarkdownDescription/manifestI18n/docsCommands/
  featureToggles)全绿。

## 测试(tests/)

- pythonStubExport.test.ts:exportKbeStubs 组 beforeEach 经
  `globalConfigurationOverrides` 常开窄闸(工作区覆写不挡);总闸文案钉收紧为
  `stubExport`(与窄闸文案可区分);新「stubCopy 窄闸」组 4 例=常量钉(键名/
  默认 false/总闸默认 true)+默认零配置零写零提示·非静默报 stubCopy+显式
  true 恢复自动复制+manual 位绕过照复制;
- pythonStubDir.test.ts / managedDir.test.ts:目录解析与落点组同样全局常开
  (窄闸自有钉在 pythonStubExport);
- covExtensionCommands.test.ts:entityStubMethods 迁移例显式开 stubCopy
  (钉的正是自动复制路径行为)+ 自建 `KBEngine/` 目录(窄闸默认关后激活期
  不再代建,用户魔改副本前置)。

### 坑账:workspaceState.reset() 清全局覆写表

tests/fake-vscode/workspaceState.ts 的 `workspaceState.reset()` 内部调
`globalConfigurationOverrides.clear()`——beforeEach 里先 set 全局再 reset 会
被静默清掉(窄闸看似开了实为关,首跑 4 例红且无直接线索)。纠偏=reset 后再
set(hook 内注释已记)。

## prove-red(两靶,cp 备份+变异+cmp 字节还原)

1. 靶1 窄闸默认翻 true → 2 例红(常量钉+默认零配置行为钉)——证明默认关
   面真有钉;还原 cmp OK;
2. 靶2 删 `!options.manual &&`(manual 位死)→ 1 例红(manual 绕过钉)——
   证明绕过面真有钉;还原 cmp OK。

## 门禁

pnpm lint 0;pnpm compile 0;pnpm test:unit 全量 846 文件 10357+8 skipped
RC=0;xvfb-run -a npm run test:demo:editor 25 RC=0。Rust 侧零改动(cargo 免)。

## 诚实边界

- 窄闸只挂 `exportKbeStubs` 一条函数;`resetStubs` 不设窄闸——它本就是
  确认式覆盖命令,再叠一层开关只会让「重置」语义含糊;
- 默认关后,全新安装若无显式命令/开关,Pylance 解析 `import KBEngine` 将
  失去桩包(extraPaths 管理段也不并入不存在的目录)——这是本令的预期行为,
  非 regression;配置指南 stubExport 段的既有文字不动(总闸语义未变);
- 托管目录重建链触发时窄闸关闭=整条 exportKbeStubs 静默返回,但
  kbe_types.pyi / entity_types.pyi / debug.json 重建不受影响(各自独立面)。
