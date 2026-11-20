const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const box={exports:{},require:n=>n==='./hotReloadModuleIdentity'?{canonicalizeScriptFilePath:p=>p}:require(n),setTimeout,clearTimeout};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/backend/hotReloadSavePipeline.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,box);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let release,checking;const entered=new Promise(r=>{checking=r;});let snapshot=1;const emitted=[];
 const p=new box.exports.HotReloadSavePipeline({debounceMs:5,stabilityWindowMs:0,batchFlushMs:0,
  readSnapshot:async()=>({hash:String(snapshot),content:'version '+snapshot}),
  checkSyntax:async()=>{checking();return new Promise(r=>{release=r;});},onEmit:events=>emitted.push(...events)});
 p.offer('/test/a.py','save');await entered;
 snapshot=2;p.offer('/test/a.py','save');await pause(30);
 release({ok:true});await pause(30);
 assert.equal(emitted.length,1);assert.equal(emitted[0].diskHash,'1');
 assert.equal(p.pending.size,1);assert.equal(p.pending.get('/test/a.py').timer,undefined);
 console.log('FULL-014: second save stranded in pending with no timer after first syntax check; only v1 emitted');p.dispose();
})().catch(e=>{console.error(e);process.exitCode=1;});
