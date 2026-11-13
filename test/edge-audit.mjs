// Диагностический аудит: ошибки печатаются как FAIL и дают exit 1. БД всегда временная.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { io } from './socket-client.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigame-edge-audit-'));
const listener = net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
const port = listener.address().port; await new Promise((r)=>listener.close(r));
const BASE = `http://localhost:${port}`;
const env = {...process.env,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:BASE,DATA_DIR:path.join(dir,'data')};
const server = fork(path.join(root,'server/index.js'),[],{cwd:root,env,silent:true});
let serverErrors='';server.stderr.on('data',(s)=>{serverErrors+=s;});server.stdout.resume();
const clients=[]; const results=[]; const metrics={};
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
function check(id,description,condition,evidence={}) {const r={id,description,passed:!!condition,evidence};results.push(r);console.log(`${condition?'PASS':'FAIL'} ${id}: ${description} ${JSON.stringify(evidence)}`);}
async function test(name,fn){try{await fn();}catch(e){check(name,'сценарий завершился без необработанной ошибки',false,{error:e.message});}}
async function connect(){const s=io(BASE,{transports:['websocket'],reconnection:false});clients.push(s);await new Promise((r,j)=>{s.once('connect',r);s.once('connect_error',j);});return s;}
const call=(s,ev,p={})=>new Promise((r,j)=>s.timeout(5000).emit(ev,p,(e,v)=>e?j(e):r(v)));
async function ok(s,e,p){const r=await call(s,e,p);assert.equal(r.ok,true,`${e}: ${r.error}`);return r;}
async function setup(n=2,packId='test-pack-special'){
 const host=await connect();const created=await ok(host,'room:create',{packId});const auth={roomId:created.roomId,hostToken:created.hostToken};await ok(host,'session:resume',auth);
 const players=[];for(let i=0;i<n;i++){const s=await connect();const p=await ok(s,'room:join',{roomId:auth.roomId,nick:'Игрок'+i});players.push({...p,s});}
 await ok(host,'settings:update',{answerTimeSec:3,buzzTimeoutSec:5});
 const state=async()=> (await ok(host,'session:resume',auth)).state;
 return {host,auth,players,state,start:()=>ok(host,'game:start')};
}
async function final(c){await c.start();await ok(c.host,'score:adjust',{playerId:c.players[0].playerId,delta:1000});await ok(c.host,'round:end');await ok(c.players[0].s,'final:stake',{amount:100});}
try{
 for(let i=0;i<100;i++){try{if((await fetch(BASE+'/healthz')).ok)break;}catch{} await sleep(50);}
 const custom={title:'Аудит: один вопрос и финал',rounds:[{title:'Р',themes:[{title:'Т',questions:[{price:100,text:'Вопрос',answer:'Ответ'}]}]}],final:{title:'Финал',text:'Финальный вопрос',answer:'Ответ'}};
 const pack=(await (await fetch(BASE+'/api/packs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(custom)})).json()).pack;
 for(const action of ['correct','close','skip','end-round'])await test('natural-final-'+action,async()=>{
  const c=await setup(1,pack.id);await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});let r;
  if(action==='correct'||action==='close'){await ok(c.host,'buzz:open');await ok(c.players[0].s,'buzz:press');r=await call(c.host,'answer:judge',{correct:action==='correct'});if(action==='close')r=await call(c.host,'question:close');}
  else r=await call(c.host,action==='skip'?'question:skip':'round:end');
  const state=await c.state();check('natural-final-'+action,'переход в финал из '+action,r.ok&&state.phase==='final',{response:r,phase:state.phase,roundIndex:state.game?.roundIndex});
 });
 await test('spectators-only',async()=>{const c=await setup(1);await ok(c.host,'player:setRole',{playerId:c.players[0].playerId,role:'spectator'});const r=await call(c.host,'game:start');const state=await c.state();check('spectators-only','запуск без активных игроков отклонён без смены lobby',!r.ok&&state.phase==='lobby',{response:r,phase:state.phase,game:state.game});});
 await test('undo-buzz-timer',async()=>{const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await ok(c.host,'buzz:open');await ok(c.host,'score:adjust',{playerId:c.players[0].playerId,delta:10});await ok(c.host,'score:undo');await sleep(5300);const s=await c.state();check('undo-buzz-timer','undo ручного счёта не останавливает таймер кнопки',s.phase==='reveal',{phase:s.phase,deadlineTs:s.game.deadlineTs,now:Date.now()});});
 await test('undo-answer-timer',async()=>{const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await ok(c.host,'buzz:open');await ok(c.players[0].s,'buzz:press');await ok(c.host,'score:adjust',{playerId:c.players[1].playerId,delta:10});await ok(c.host,'score:undo');await sleep(3300);const s=await c.state();check('undo-answer-timer','undo ручного счёта не останавливает таймер ответа',s.phase!=='answer',{phase:s.phase,score:s.players[0].score});});
 await test('auction-kick',async()=>{const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:1,qIdx:0});await ok(c.players[0].s,'auction:bet',{amount:100});await ok(c.host,'player:kick',{playerId:c.players[0].playerId});const r=await call(c.host,'auction:close');check('auction-kick','удаление ставившего не блокирует закрытие аукциона',r.ok,{response:r,phase:(await c.state()).phase});});
 await test('auction-spectator',async()=>{const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:1,qIdx:0});await ok(c.players[0].s,'auction:bet',{amount:100});await ok(c.host,'player:setRole',{playerId:c.players[0].playerId,role:'spectator'});const r=await call(c.host,'auction:close');const s=await c.state();check('auction-spectator','зритель не назначается отвечающим после своей ставки',!r.ok||s.game.buzz.winnerId!==c.players[0].playerId,{response:r,phase:s.phase,winnerId:s.game.buzz.winnerId});});
 await test('final-kick',async()=>{const c=await setup();await final(c);await ok(c.host,'final:go');await ok(c.players[0].s,'final:answer',{text:'Ответ'});await ok(c.host,'final:go');await ok(c.host,'player:kick',{playerId:c.players[0].playerId});const r=await call(c.host,'final:judge',{playerId:c.players[0].playerId,correct:true});check('final-kick','удалённый участник финала обработан без TypeError',r.ok||!r.error?.includes('undefined'),{response:r});});
 await test('final-undo',async()=>{const c=await setup();await final(c);await ok(c.host,'final:go');await ok(c.host,'final:go');await ok(c.host,'final:judge',{playerId:c.players[0].playerId,correct:true});await ok(c.host,'score:undo');const s=await c.state();const r=await call(c.host,'final:judge',{playerId:c.players[0].playerId,correct:false});check('final-undo','undo финального вердикта позволяет исправить решение',r.ok,{response:r,verdict:s.game.final.entries[0].verdict,score:s.players[0].score});});
 await test('late-verdict',async()=>{const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await ok(c.host,'buzz:open');await ok(c.players[0].s,'buzz:press');await ok(c.host,'answer:judge',{correct:false});await ok(c.players[1].s,'buzz:press');const r=await call(c.host,'answer:judge',{correct:true,playerId:c.players[0].playerId,themeIdx:999,qIdx:999});const s=await c.state();check('late-verdict','устаревший вердикт старому игроку не судит нового',!r.ok&&s.phase==='answer'&&s.players.find(p=>p.id===c.players[1].playerId).score===0,{response:r,phase:s.phase,scores:s.players.map(p=>p.score)});});
 await test('spectator-leave',async()=>{const c=await setup();await ok(c.host,'player:setRole',{playerId:c.players[0].playerId,role:'spectator'});await ok(c.players[0].s,'player:leave');await c.start();let leaked=null;c.players[0].s.on('question:show',q=>{leaked=q;});await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await sleep(100);check('spectator-leave','вышедший зритель больше не получает вопросы',leaked===null,{received:leaked});});
 await test('cross-room',async()=>{const c=await setup(2);const other=await setup(0);await ok(c.players[0].s,'room:join',{roomId:other.auth.roomId,nick:'Перешёл'});let leaked=null;c.players[0].s.on('question:show',q=>{leaked=q;});await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await sleep(100);check('cross-room','переход в другую комнату удаляет старые подписки',leaked===null,{received:leaked});});
 await test('fractional-bet',async()=>{const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:1,qIdx:0});const r=await call(c.players[0].s,'auction:bet',{amount:'100xyz'});check('fractional-bet','некорректная строка ставки отклонена',!r.ok,{response:r});});
 await test('attempt-identity',async()=>{
  const c=await setup();await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await ok(c.host,'buzz:open');await ok(c.players[0].s,'buzz:press');
  const before=await c.state();const old={correct:true,playerId:c.players[0].playerId,questionId:before.game.questionId,answerAttemptId:before.game.answerAttemptId};
  await ok(c.host,'answer:judge',{correct:false});await ok(c.players[1].s,'buzz:press');
  let r=await call(c.host,'answer:judge',old);check('old-attempt-id','старый ID попытки отклонён после ребуза',!r.ok);
  r=await call(c.host,'answer:judge',{correct:true,answerAttemptId:null,questionId:null});check('missing-attempt-id','вердикт без идентификатора отклонён',!r.ok);
  const second=await c.state();const previous={correct:true,playerId:c.players[1].playerId,questionId:second.game.questionId,answerAttemptId:second.game.answerAttemptId};
  await ok(c.host,'answer:judge',{correct:true});await ok(c.host,'score:undo');
  r=await call(c.host,'answer:judge',previous);check('undo-new-attempt','после undo тот же игрок получает новый ID попытки',!r.ok&&(await c.state()).phase==='answer');
  await ok(c.host,'answer:judge',{correct:true});
 });
 await test('undo-last-question',async()=>{
  const c=await setup(1,pack.id);await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await ok(c.host,'buzz:open');await ok(c.players[0].s,'buzz:press');await ok(c.host,'answer:judge',{correct:true});await ok(c.host,'score:undo');
  let state=await c.state();check('undo-before-final-stakes','последний вердикт можно отменить до ставок финала',state.phase==='answer'&&state.players[0].score===0&&!state.game.board.themes[0].questions[0].used);
  await ok(c.host,'answer:judge',{correct:true});state=await c.state();check('repeat-final-after-undo','после повторного ответа финал запускается снова',state.phase==='final'&&state.players[0].score===100);
 });
 await test('all-profile-sockets',async()=>{
  const c=await setup();const p=c.players[0];const extra=await connect();await ok(extra,'session:resume',{roomId:c.auth.roomId,playerId:p.playerId,sessionToken:p.sessionToken});
  await ok(c.host,'player:setRole',{playerId:p.playerId,role:'spectator'});await ok(c.host,'player:setRole',{playerId:p.playerId,role:'player'});
  let first=null,second=null;p.s.on('question:show',q=>first=q);extra.on('question:show',q=>second=q);await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await sleep(50);
  check('role-all-tabs','возврат из зрителей скрывает вопрос во всех вкладках',first&&!first.text&&second&&!second.text);
  await ok(c.host,'player:kick',{playerId:p.playerId});first=null;second=null;await ok(c.host,'question:skip');await ok(c.host,'board:select',{themeIdx:0,qIdx:2});await sleep(50);
  check('kick-all-tabs','кик снимает подписки со всех вкладок профиля',first===null&&second===null);
  check('revoked-old-socket','старая вкладка после кика лишена роли игрока',!(await call(p.s,'buzz:press')).ok);
 });
 await test('zero-timer-setting',async()=>{const c=await setup();await ok(c.host,'settings:update',{answerTimeSec:0});let s=await c.state();check('zero-is-unlimited','0 секунд включает безлимит',s.settings.answerTimeSec===0&&s.settings.unlimitedAnswerTime);await ok(c.host,'settings:update',{answerTimeSec:7});s=await c.state();check('positive-restores-timer','положительное число возвращает таймер',s.settings.answerTimeSec===7&&!s.settings.unlimitedAnswerTime);});
 await test('load-50',async()=>{const c=await setup(50,'test-pack');await c.start();await ok(c.host,'board:select',{themeIdx:0,qIdx:0});await ok(c.host,'buzz:open');const start=performance.now();const race=await Promise.all(c.players.map(p=>call(p.s,'buzz:press')));metrics.race50Ms=+(performance.now()-start).toFixed(2);check('load-50','гонка 50 клиентов даёт одного победителя',race.filter(r=>r.accepted).length===1,{winners:race.filter(r=>r.accepted).length,durationMs:metrics.race50Ms});});
 await test('rtt',async()=>{const c=await setup(1);const times=[];for(let i=0;i<150;i++){const start=performance.now();await c.state();times.push(performance.now()-start);}times.sort((a,b)=>a-b);metrics.stateRTT={p50:+times[75].toFixed(2),p95:+times[142].toFixed(2),max:+times.at(-1).toFixed(2),samples:times.length};check('rtt','150 последовательных запросов состояния завершены',true,metrics.stateRTT);});
 check('server-alive','после всех ошибочных запросов сервер жив',(await fetch(BASE+'/healthz')).ok);
}finally{
 for(const s of clients)s.disconnect();
 if(server.exitCode===null){const exited=once(server,'exit');server.send('shutdown');await exited;}
 const report={timestamp:new Date().toISOString(),base:BASE,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results,metrics,serverErrors};
 const output=process.env.AUDIT_OUTPUT||path.join(dir,'results.json');fs.writeFileSync(output,JSON.stringify(report,null,2));
 console.log('AUDIT_REPORT '+output);console.log(`Итого аудит: ${report.passed} пройдено, ${report.failed} проблем`);process.exitCode=report.failed?1:0;
}
