// Все тесты — в отдельной копии, без доступа к рабочей БД.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'sigame-tests-'));
for(const name of ['server','client','test','config.js','package.json','package-lock.json','node_modules'])fs.cpSync(path.join(root,name),path.join(work,name),{recursive:true});
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
for(const name of fs.readdirSync(path.join(work,'test'))){if(!name.endsWith('.mjs'))continue;const p=path.join(work,'test',name);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('http://localhost:3000',`http://localhost:${port}`));}
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:path.join(work,'data'),TEST_BASE:`http://localhost:${port}`,PUBLIC_URL:''};
const server=fork(path.join(work,'server/index.js'),[],{cwd:work,env,silent:true});server.stdout.resume();server.stderr.pipe(process.stderr);
async function run(name){console.log(`\n--- ${name} ---`);const p=spawn(process.execPath,[`test/${name}.mjs`],{cwd:work,env,stdio:'inherit'});const [code]=await once(p,'exit');if(code!==0)throw Error(`${name}: exit ${code}`);}
try{
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://localhost:${port}/healthz`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}if(!ready)throw Error('Server timeout');
 for(const name of ['e2e','late-judge','game','host','media','packs','special','final-resume','ui-audit','improvements','edge-audit','stability'])await run(name);
 console.log(`\nВсе проверки пройдены. Стенд: ${work}`);
}finally{if(server.exitCode===null){const end=once(server,'exit');server.send('shutdown');await end;}}
