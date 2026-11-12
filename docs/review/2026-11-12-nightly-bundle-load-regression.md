# nightly 打包产物装载死亡回归 —— 纪实(2026-11-12)

用户报:新装的 nightly kode-0.2.0(2026-11-12 05:08 UTC 发布,da34656d)打开
任意侧栏视图即报「There is no data provider registered that can provide view
data」。上一版 nightly(7f28673a,00:37 UTC)正常。

## 根因链

1. 5200bfc0(isolate KBEngine Python typings by process)新增
   `src/pythonProcessConfig.ts`,`import ... from 'jsonc-parser'`;
2. jsonc-parser 3.3.1 无 `exports` 字段,`main` 指 `lib/umd/main.js`(UMD
   工厂),`module` 指 `lib/esm/main.js`(纯 ESM);esbuild `--platform=node`
   的默认 mainFields 只认 `main` → UMD 入场;
3. UMD 工厂体内 `require` 是**参数遮蔽**(`(function(t){...})(function(require,
   exports){... t("./impl/format")})`),esbuild 不改写 → 四条
   `require('./impl/format'|'./impl/edit'|'./impl/scanner'|'./impl/parser')`
   原样留在 bundle,宿主按 `out/` 相对路径解析 → MODULE_NOT_FOUND,模块求值
   在 activate 之前死亡;
4. `activate()` 首行才是 activateInfrastructure(视图空占位 provider 注册在
   其中最前)——模块没装载,占位也没注册 → 全部 13 个侧栏视图停在「已声明、
   无提供者」,宿主报用户所见错误。

**现场实证**(发布物直接探测):下载 nightly 的 kode-0.2.0-pure-ts.vsix,解包
`out/extension.js`,以最小 vscode 替身在 node 里装载 →
`Cannot find module './impl/format'`,与用户症状同因;本地
`npx esbuild src/extension.ts ...`(无修复旗标)产物同崩,发布物=本地构建
同源。

## 门禁为何没拦住

- demo 门禁(xvfb 真宿主激活)走 **tsc 逐文件输出**(`pnpm compile`),
  `require('jsonc-parser')` 从 node_modules 正常解析,永远测不到 esbuild
  bundle 的装载面;
- platform-vsix 的 verify 脚本核文件清单,不装载 bundle;
- ci.yml 打包步骤只打包不运行。

## 修复

`package.json` bundle 脚本三条 node 侧 esbuild 命令(extension /
pythonParserWorker / defParserWorker)加 `--main-fields=module,main`:
jsonc-parser 改走 `lib/esm/main.js`,纯 ESM 正常内联,UMD 泄漏消失(修复后
bundle `require("./impl/` 计 0,替身装载 OK)。webview 侧不受影响(browser
默认本就偏好 module 字段),未动。

## 回归门(新增 tests/bundleLoadSmoke.test.ts)

- 漂移断言:bundle 脚本三条 `--platform=node` 的 esbuild 段都必须带
  `--main-fields=module,main`,少一段即红;
- 装载断言:按脚本同旗标现场产 bundle(临时目录),以最小 vscode 替身经
  `Module._resolveFilename` 钩子真装载一次;bundle 内出现
  `require("./impl/`(UMD 工厂泄漏痕迹)即红——任何依赖再以「main 字段
  UMD/动态 require 泄漏」形态进包,装载期暴露,不等 nightly。

prove-red:
- 漂移断言:stash package.json 修复 → 该例红,恢复后绿;
- 装载断言:无修复旗标的 bundle(发布物与本地各一)在替身装载下
  `Cannot find module './impl/format'` 即本测试要红的形态。

## 门禁(2026-11-12,净检出 da34656d worktree)

- `npx tsc -p . --noEmit` 0;`npm run lint` 0;
- 全量 vitest(--maxWorkers=1)绿;xvfb demo RC=0(见 todo 勾行/推送记录);
- 新测试 2/2 绿,约 2s。

## 后续

推送后手动触发 nightly(workflow_dispatch,版本红线允许)替换用户手上的
坏死包;用户重装即可。
