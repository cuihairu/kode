# TS 后端独立目录抽取 · 批次 15(process/remote 族)2026-11-09

续批次 1-14,同式推进。

## 范围(7 件,`git mv` 至 src/backend/)

processManager / pyspyDump / remoteProcessList / remoteConnection / sshConfig /
debugpyPortProbe / debugpyPreflight

选族依据:零 `from 'vscode'` 的进程管理/远程进程/py-spy 采样/SSH 连接/
debugpy 端口探测与预检(共 ~1.7k 行)。**留 src/**:debugConfig(vscode
混合)、profileInterpreter / autoDebugpy(vscode)、命令与装配面。

## 改动面

- import 重基 57 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内互引
  (remoteProcessList→pyspyDump/remoteConnection/sshConfig、
  debugpyPortProbe→debugpyPreflight/processManager、pyspyDump→processManager)
  兄弟解析,出向留守件(debugConfig/profileInterpreter/autoDebugpy)改 `../`。
- 反向面核验:tests/registry 零静态锚、零动态拼路径读(预检)。
- 活文档路径对账 18 处:features.md en+zh 各 9。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量门禁见提交前记录。
- **与批次 16 合并提交**:批次 16 搬移发生在本批全量套件运行中,工作树
  交叠(extension.ts 等共享 importer 同含两批重基),拆笔必破 HEAD 可编译性;
  本批全量 693 文件 / 8390 过 RC=0(绿),合并态复跑见批次 16 纪实。
