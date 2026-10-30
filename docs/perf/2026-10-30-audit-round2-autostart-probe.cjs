// Baseline 5715296; run with node from its checkout root. c647 recheck additionally reads that commit with git show.
// Run with node from the Kode bf26cbf checkout root; uses installed TypeScript and fake vscode.
const fs=require('fs');const perf=require('perf_hooks').performance;const ts=require(process.cwd()+'/node_modules/typescript');const Module=require('module');const old=Module._load;
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f);
Module._load=function(id){if(id==='vscode')return require(process.cwd()+'/tests/helpers/vscodeStub.ts');return old.apply(this,arguments)};
const load=n=>require(process.cwd()+'/src/'+n+'.ts');
(async()=>{
const vs=require(process.cwd()+'/tests/helpers/vscodeStub.ts');const {KBEngineServerManager}=load('serverManager');const m=Object.create(KBEngineServerManager.prototype);const calls=[];m.startComponent=async c=>{calls.push(c.name);return c.name!=='machine'};await m.startAutoComponents();console.log(JSON.stringify({test:'actualAutoStartContinuesAfterMachineFailure',calls}));
})().catch(e=>{console.error(e.stack);process.exitCode=1});