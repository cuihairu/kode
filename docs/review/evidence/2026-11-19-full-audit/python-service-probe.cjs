// Run from repository root. Current service source; real Python + controlled process events.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const cp=require('node:child_process'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const box={exports:{},require:n=>n==='./processManager'?{spawnProcess:cp.spawn}:require(n),Buffer,setTimeout,clearTimeout};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/backend/pythonExecService.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,box);
const {createPythonExecService}=box.exports;
const frame=o=>{const s=JSON.stringify(o);return Buffer.byteLength(s)+'\n'+s+'\n';};
const tick=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
 const real=createPythonExecService({timeoutMs:200,handshakeTimeoutMs:2000});
 try {
  const good=await real.runCompile({content:'x=1'});assert.equal(good.ok,true);
  const bad=await real.runCompile({content:'变量 = “abc”'});
  assert.equal(bad.infra,true);assert.match(bad.error,/超时/);
  console.log('FULL-001: real Python Unicode syntax error became infra timeout:',bad.error);
 } finally {real.dispose();}
 const procs=[];
 function spawn(){const p=new EventEmitter();p.pid=100+procs.length;p.exitCode=null;p.signalCode=null;
  p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdout.setEncoding=p.stderr.setEncoding=()=>{};
  p.stdin={write:()=>true};p.kill=()=>{p.killed=true;return true;};procs.push(p);
  setImmediate(()=>p.stdout.emit('data',frame({ready:true})));return p;}
 const svc=createPythonExecService({spawn,timeoutMs:70,handshakeTimeoutMs:500});
 const first=await svc.runCompile({content:'x=1'});assert.equal(first.infra,true);
 const retry=svc.runCompile({content:'x=2'});await tick();
 assert.equal(procs.length,2);assert.equal(svc.pid(),101);
 procs[0].exitCode=0;procs[0].emit('exit',0);
 const result=await retry;assert.equal(result.infra,true);assert.equal(procs[1].killed,true);
 console.log('FULL-002: old process exit killed replacement and rejected its pending compile');svc.dispose();
})().catch(e=>{console.error(e);process.exitCode=1;});
