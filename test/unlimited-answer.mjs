import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sigame-unlimited-'));
const {RoomManager}=await import('../server/rooms.js');const {seedPacks}=await import('../server/packs.js');const game=await import('../server/game.js');const {db}=await import('../server/db.js');
seedPacks();const rooms=new RoomManager();const io={to(){return this;},except(){return this;},emit(){}};let checks=0;
function check(name,value){assert.ok(value,name);console.log('PASS '+name);checks++;}
const room=rooms.createRoom('test-pack-special');room.settings.unlimitedAnswerTime=false;room.settings.answerTimeSec=0;
const a=rooms.addPlayer(room,{nick:'Первый'}),b=rooms.addPlayer(room,{nick:'Второй'});
try{
 game.startGame(io,rooms,room);game.selectCell(io,rooms,room,0,0);game.openBuzz(io,rooms,room);game.pressBuzz(io,rooms,room,a.id);
 check('нет дедлайна и таймера ответа',room.game.deadlineTs===null&&!room._timers.answer);
 await new Promise(r=>setTimeout(r,3300));check('автоштраф не сработал',room.phase==='answer'&&a.score===0);
 game.togglePause(io,rooms,room);game.togglePause(io,rooms,room);check('пауза не создаёт таймер',room.game.deadlineTs===null&&!room._timers.answer);
 game.handlePlayerDisconnected(io,rooms,room,a.id);check('отключение сохраняет срок возврата',!!room._timers.disconnect);game.handlePlayerReconnected(io,rooms,room,a.id);check('возврат восстанавливает безлимит',room.game.deadlineTs===null&&!room._timers.answer);
 const restored=rooms._deserialize(rooms._serialize(room));check('настройка и фаза сохраняются в снимке',restored.settings.answerTimeSec===0&&restored.phase==='answer');
 game.judge(io,rooms,room,true,{playerId:a.id,questionId:room.game.question.id,answerAttemptId:room.game.answerAttemptId});game.undo(io,rooms,room);check('undo сохраняет безлимит',room.phase==='answer'&&room.game.deadlineTs===null&&!room._timers.answer);
 game.skipQuestion(io,rooms,room);game.setPicker(io,rooms,room,b.id);game.selectCell(io,rooms,room,0,1);
 const restoredCat=rooms._deserialize(rooms._serialize(room));
 assert.throws(()=>game.catAssign(io,rooms,restoredCat,b.id),/выбравшему/);
 check('запрет передачи кота выбравшему переживает восстановление',restoredCat.game.question.selectedByPlayerId===b.id);
 game.catAssign(io,rooms,room,a.id,b.id);
 const restoredRecipient=rooms._deserialize(rooms._serialize(room));
 check('получатель кота и цены переживают восстановление',restoredRecipient.game.question.catRecipientId===a.id&&rooms.publicCat(restoredRecipient).prices.length===2);
 game.catChoosePrice(io,rooms,room,a.id,rooms.publicCat(room).prices[0]);check('кот отвечает без таймера',room.phase==='answer'&&room.game.deadlineTs===null&&!room._timers.answer);
 game.skipQuestion(io,rooms,room);game.selectCell(io,rooms,room,1,0);game.auctionBet(io,rooms,room,b.id,100);game.auctionClose(io,rooms,room);check('аукцион отвечает без таймера',room.phase==='answer'&&room.game.deadlineTs===null&&!room._timers.answer);
 console.log(`Итого: ${checks} проверок`);
}finally{for(const r of [...rooms.rooms.values()])rooms.deleteRoom(r);db.close();}
