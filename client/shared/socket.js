// Требует, чтобы перед модулем был подключен /socket.io/socket.io.js (глобальный io)
export const socket = window.io();

// emit с ack в виде Promise; при ok:false кидает Error с текстом сервера
export function call(event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('Сервер не отвечает'));
      if (!res?.ok) return reject(new Error(res?.error || 'Неизвестная ошибка'));
      resolve(res);
    });
  });
}

export function onReconnect(handler) {
  socket.io.on('reconnect', handler);
}

const connection = document.createElement('div'); connection.className='connection-status'; connection.setAttribute('role','status'); document.body.append(connection);
function renderConnection() { connection.textContent=socket.connected?'● На связи':'● Восстанавливаем соединение…'; connection.dataset.online=String(socket.connected); }
socket.on('connect',renderConnection); socket.on('disconnect',renderConnection); renderConnection();

const viewControls=document.createElement('div'); viewControls.className='view-controls';
for(const [label,action] of [ ['⛶',()=>{if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen().catch(()=>{});} ], ['Aa',()=>{document.body.classList.toggle('presentation');localStorage.setItem('sigame:presentation',document.body.classList.contains('presentation')?'1':'0');}] ]){
 const button=document.createElement('button');button.textContent=label;button.title=label==='Aa'?'Крупный текст':'Полный экран';button.addEventListener('click',action);viewControls.append(button);
}
if(localStorage.getItem('sigame:presentation')==='1')document.body.classList.add('presentation');document.body.append(viewControls);

const audioSettings=document.createElement('details');audioSettings.className='audio-settings';
const summary=document.createElement('summary');summary.textContent='Звук и связь';audioSettings.append(summary);
for(const [key,label] of [['effects','Эффекты'],['media','Медиа']]){
 const row=document.createElement('label');row.textContent=label;
 const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='1';slider.step='.05';slider.value=localStorage.getItem(`sigame:${key}-volume`)??'1';slider.setAttribute('aria-label',label);
 slider.addEventListener('input',()=>{localStorage.setItem(`sigame:${key}-volume`,slider.value);if(key==='media')document.querySelectorAll('audio,video').forEach(el=>el.volume=Number(slider.value));});row.append(slider);audioSettings.append(row);
}
const ping=document.createElement('button');ping.textContent='Проверить связь';ping.addEventListener('click',async()=>{const start=performance.now();try{await call('diagnostics:ping',{});ping.textContent=`Задержка: ${Math.round(performance.now()-start)} мс`;}catch{ping.textContent='Нет ответа. Проверьте сеть';}});audioSettings.append(ping);document.body.append(audioSettings);
