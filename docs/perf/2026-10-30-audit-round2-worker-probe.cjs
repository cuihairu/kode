// Baseline 5715296; run with node from its checkout root. c647 recheck additionally reads that commit with git show.
// Run with node from the Kode bf26cbf checkout root; uses installed TypeScript and fake vscode.
const fs=require('fs');const perf=require('perf_hooks').performance;const ts=require(process.cwd()+'/node_modules/typescript');const Module=require('module');const old=Module._load;
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f);
Module._load=function(id){if(id==='vscode')return require(process.cwd()+'/tests/helpers/vscodeStub.ts');return old.apply(this,arguments)};
const load=n=>require(process.cwd()+'/src/'+n+'.ts');
(async()=>{
const originalLoad=Module._load,exists=fs.existsSync;let posted=0,bytes=0;class FrozenWorker{unref(){}on(){return this}postMessage(m){posted++;bytes+=Buffer.byteLength(m.content,'utf8')}terminate(){return Promise.resolve(0)}};
Module._load=function(id){if(id==='worker_threads')return {Worker:FrozenWorker};return originalLoad.apply(this,arguments)};fs.existsSync=f=>String(f).endsWith('pythonParserWorker.js')?true:exists(f);
const w=load('pythonParserWorkerHost');const content='#'+'x'.repeat(w.PYTHON_WORKER_PARSE_THRESHOLD);const jobs=[];for(let i=0;i<100;i++)jobs.push(w.parsePythonFileResponsive(content,'/ws/unique-'+i+'.py',1).catch(()=>null));console.log(JSON.stringify({test:'distinctFilesBypassWorkerQueueBudget',posted,totalPostedBytes:bytes,gauge:w.getPythonParserWorkerGauge()}));w.disposePythonParserWorker();await Promise.all(jobs);fs.existsSync=exists;Module._load=originalLoad;
})().catch(e=>{console.error(e.stack);process.exitCode=1});