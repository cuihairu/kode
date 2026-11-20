// Current aiClient source, API-shaped fixtures; no external API request.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const box={exports:{},require:n=>n==='vscode'?{}:require(n),setTimeout,clearTimeout,AbortController,fetch};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ai/aiClient.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,box);
const {sendAiMessage}=box.exports;
const endpoint={baseUrl:'',model:'fake',temperature:0,maxTokens:10,requestTimeoutMs:30,maxRetries:1};
(async()=>{
 const token={isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};
 let args;
 const reply=await sendAiMessage({endpoint,token,messages:[{role:'user',content:'hi'}],models:[{
  sendRequest:async(...a)=>{args=a;return {text:(async function*(){yield 'hello';yield ' world';})()};}
 }]});
 assert.equal(reply,'');assert.equal(args[1],token);assert.equal(args[2],undefined);
 console.log('FULL-011: real-API-shaped string stream became empty reply; token in argument 2 not 3');
 let calls=0,signal2,finishSecond;
 const p=sendAiMessage({endpoint:{...endpoint,baseUrl:'http://fixture'},messages:[],sleepImpl:async()=>{},
  fetchImpl:async(_url,opts)=>{
   if(++calls===1)return {ok:true,json:async()=>({choices:[]})};
   signal2=opts.signal;
   return new Promise(resolve=>{finishSecond=()=>resolve({ok:true,json:async()=>({choices:[{message:{content:'released'}}]})});});
  }});
 await new Promise(r=>setTimeout(r,90));
 assert.equal(calls,2);assert.equal(signal2.aborted,false);
 console.log('FULL-012: second request signal still not aborted after 3x total timeout');
 finishSecond();await p;
})().catch(e=>{console.error(e);process.exitCode=1;});
