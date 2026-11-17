// Этап 6: кот в мешке, аукцион, финальный раунд, реакции — включая краевые случаи
import { io } from './socket-client.mjs';

const BASE = 'http://localhost:3000';
const PACK = 'test-pack-special';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const call = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const ok = (s, ev, p) => call(s, ev, p).then((r) => {
  if (r?.ok === false) throw new Error(`${ev}: ${r.error}`);
  return r;
});
const wait = (s, ev) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), 5000);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setupRoom(nicks) {
  const host = await connect();
  const { roomId, hostToken } = await ok(host, 'room:create', { packId: PACK });
  const { state } = await ok(host, 'session:resume', { roomId, hostToken });
  check('новая комната: безлимитный ответ, вопрос показывается игрокам',
    state.settings.answerTimeSec === 0 && state.settings.unlimitedAnswerTime && state.settings.showQuestionToPlayers);
  const players = [];
  for (const nick of nicks) {
    const p = await connect();
    const join = await ok(p, 'room:join', { roomId, nick });
    players.push({ socket: p, id: join.playerId, nick });
  }
  await ok(host, 'game:start', {});
  return { host, roomId, hostToken, players };
}

async function main() {
  // ================= КОТ В МЕШКЕ =================
  {
    const { host, roomId, hostToken, players } = await setupRoom(['Аня', 'Борис']);
    const [a, b] = players;
    await ok(host, 'game:setPicker', { playerId: b.id });
    const catPending = wait(host, 'cat:pending');
    await ok(b.socket, 'board:select', { themeIdx: 0, qIdx: 1 });
    const cat = await catPending;
    const { questionId, prices } = cat;
    check('кот: событие содержит выбравшего игрока и две цены раунда',
      cat.selectedByPlayerId === b.id && prices.join() === '100,300' && cat.text === undefined && cat.answer === undefined);
    const { state } = await ok(host, 'session:resume', { roomId, hostToken });
    check('кот: снимок сохраняет выбравшего игрока', state.game.cat.selectedByPlayerId === b.id);
    const selfAssign = await call(b.socket, 'cat:assign', { questionId, playerId: b.id });
    check('кот: вопрос нельзя передать выбравшему игроку', !selfAssign.ok && /выбравшему/.test(selfAssign.error));

    let r = await call(host, 'buzz:press', {});
    check('кот: pressBuzz ведущим недоступен (не игрок)', r.ok === false);
    r = await call(a.socket, 'buzz:press', {});
    check('кот: кнопка не работает до назначения', r.accepted === false);

    r = await call(a.socket, 'cat:assign', { questionId, playerId: b.id });
    check('кот: другой игрок не может назначить получателя', !r.ok);
    r = await call(b.socket, 'cat:assign', { questionId: 'old-question', playerId: a.id });
    check('кот: устаревший запрос передачи отклонён', !r.ok);
    await ok(b.socket, 'cat:assign', { questionId, playerId: a.id });
    const waiting = (await ok(host, 'session:resume', { roomId, hostToken })).state;
    check('кот: получатель сохранён, пока выбирает цену', waiting.phase === 'cat' && waiting.game.cat.recipientId === a.id);
    r = await call(b.socket, 'cat:price', { questionId, price: prices[0] });
    check('кот: цену может выбрать только получатель', !r.ok);
    r = await call(a.socket, 'cat:price', { questionId, price: 125 });
    check('кот: произвольная цена отклонена', !r.ok);

    const winner = wait(host, 'buzz:winner');
    const question = wait(host, 'question:show');
    await ok(a.socket, 'cat:price', { questionId, price: prices[1] });
    const w = await winner;
    check('кот: назначенный игрок отвечает', w.playerId === a.id);
    check('кот: вопрос открыт по выбранной цене', (await question).price === prices[1]);

    r = await call(b.socket, 'buzz:press', {});
    check('кот: второй игрок не может вмешаться', r.accepted === false);

    await ok(host, 'answer:judge', { correct: false });
    await sleep(100);
    r = await call(b.socket, 'buzz:press', {});
    check('кот: после неверного ребуза нет — фаза reveal/закрытие', r.accepted === false);
    r = await call(host, 'question:close', {});
    check('кот: после неверного вопрос закрывается через reveal', r.ok === true);
    host.close(); a.socket.close(); b.socket.close();
  }

  // ================= АУКЦИОН =================
  {
    const { host, players } = await setupRoom(['Аня', 'Борис', 'Вова']);
    const [a, b, v] = players;
    // Аня в минусе: ставка может быть только минимальной
    await ok(host, 'score:adjust', { playerId: a.id, delta: -300 });
    await ok(host, 'score:adjust', { playerId: b.id, delta: 300 });

    const aucStart = wait(host, 'auction:start');
    await ok(host, 'board:select', { themeIdx: 1, qIdx: 0 });
    const { minBet } = await aucStart;
    check('аукцион: фаза, minBet = цена ячейки (100)', minBet === 100);

    let r = await call(a.socket, 'auction:bet', { amount: 200 });
    check('аукцион: при счёте −300 ставка выше минимума отклонена', r.ok === false);
    r = await call(a.socket, 'auction:bet', { amount: 100 });
    check('аукцион: при счёте −300 минимальная ставка принята', r.ok === true);

    r = await call(b.socket, 'auction:bet', { amount: 50 });
    check('аукцион: ставка ниже цены ячейки отклонена', r.ok === false);
    r = await call(b.socket, 'auction:bet', { amount: 100500 });
    check('аукцион: ставка выше счёта отклонена', r.ok === false);

    r = await call(b.socket, 'auction:bet', { amount: 100 });
    check('аукцион: нельзя повторить ставку другого игрока', !r.ok && /выше текущей/.test(r.error));
    await ok(b.socket, 'auction:bet', { amount: 150 });
    r = await call(b.socket, 'auction:bet', { amount: 150 });
    check('аукцион: нельзя повторить собственную ставку', !r.ok);
    r = await call(v.socket, 'auction:bet', { amount: 100 });
    check('аукцион: нельзя поставить ниже действующей ставки', !r.ok && /выше текущей/.test(r.error));
    await ok(b.socket, 'auction:bet', { amount: 200 });
    const winner = wait(host, 'buzz:winner');
    await ok(host, 'auction:close', {});
    const w = await winner;
    check('аукцион: отвечает игрок, повысивший ставку до 200', w.playerId === b.id);

    const scoresP = wait(host, 'score:update');
    await ok(host, 'answer:judge', { correct: true });
    const scores = (await scoresP).scores;
    const bScore = scores.find((s) => s.id === b.id)?.score;
    check('аукцион: на кону ставка (200), а не цена ячейки', bScore === 500);
    host.close(); players.forEach((p) => p.socket.close());
  }

  // аукцион без ставок → вопрос сгорает
  {
    const { host, players } = await setupRoom(['Аня']);
    await ok(host, 'board:select', { themeIdx: 1, qIdx: 0 });
    const boardBack = wait(host, 'board:update');
    await ok(host, 'auction:close', {});
    await boardBack;
    const r = await call(host, 'board:select', { themeIdx: 1, qIdx: 0 });
    check('аукцион без ставок: ячейка сгорела, повторный выбор невозможен', r.ok === false);
    host.close(); players.forEach((p) => p.socket.close());
  }

  // ================= ФИНАЛЬНЫЙ РАУНД =================
  {
    const { host, players } = await setupRoom(['Аня', 'Борис', 'Вова']);
    const [a, b, v] = players;
    await ok(host, 'score:adjust', { playerId: a.id, delta: 500 });
    await ok(host, 'score:adjust', { playerId: b.id, delta: 300 });
    // Вова в минусе — в финале не участвует
    await ok(host, 'score:adjust', { playerId: v.id, delta: -100 });

    const previous = wait(host, 'question:answer');
    await ok(host, 'board:select', { themeIdx: 0, qIdx: 0 });
    const previousAnswer = (await previous).answer;
    const finalStart = wait(host, 'final:start');
    await ok(host, 'round:end', {}); // единственный раунд → финал
    const fs = await finalStart;
    check('финал: начался после конца раунда', fs.title === 'Столицы мира');

    let r = await call(v.socket, 'final:stake', { amount: 0 });
    check('финал: игрок с отрицательным счётом не делает ставку', r.ok === false);
    r = await call(a.socket, 'final:stake', { amount: 9999 });
    check('финал: ставка выше счёта отклонена', r.ok === false);
    await ok(a.socket, 'final:stake', { amount: 200 });
    // Борис НЕ ставит — краевой случай «игрок без ставки»

    const qshow = wait(a.socket, 'question:show');
    const hostAnswer = wait(host, 'question:answer');
    await ok(host, 'final:go', {});
    const q = await qshow;
    check('финал: вопрос показан игрокам с текстом', q.text === 'Столица Австралии?');
    check('финал: правильный ответ обновился у ведущего и скрыт у игрока',
      (await hostAnswer).answer === 'Канберра' && previousAnswer !== 'Канберра' && q.answer === undefined);

    r = await call(b.socket, 'final:answer', { text: 'Сидней' });
    check('финал: игрок без ставки не может отвечать', r.ok === false);
    await ok(a.socket, 'final:answer', { text: 'Канберра' });

    const answers = wait(host, 'final:answers');
    await ok(host, 'final:go', {}); // досрочно закрыть приём
    const aw = await answers;
    check('финал: ведущий видит ответы и ставки', aw.entries.length === 1 && aw.entries[0].text === 'Канберра' && aw.entries[0].bet === 200);
    check('финал: ведущему дан правильный ответ', aw.answer === 'Канберра');

    r = await call(host, 'final:judge', { playerId: b.id, correct: true });
    check('финал: судить неучаствовавшего нельзя', r.ok === false);

    const results = wait(host, 'final:results');
    await ok(host, 'final:judge', { playerId: a.id, correct: true });
    const res = await results;
    check('финал: после всех вердиктов — итоги финала', res.entries.length === 1 && res.entries[0].verdict === true);

    r = await call(host, 'final:judge', { playerId: a.id, correct: false });
    check('финал: повторный вердикт отклонён', r.ok === false);

    const over = wait(host, 'game:over');
    await ok(host, 'game:end', {});
    const { standings } = await over;
    check('финал: итоговая таблица, Аня 700 (+200 ставка)', standings[0].id === a.id && standings[0].score === 700 && standings[0].place === 1);
    check('финал: места расставлены (Вова последний)', standings[2].id === v.id);
    host.close(); players.forEach((p) => p.socket.close());
  }

  // ================= РЕАКЦИИ =================
  {
    const { host, players } = await setupRoom(['Аня']);
    const [a] = players;
    const shown = wait(host, 'reaction:show');
    let r = await call(a.socket, 'reaction:send', { emoji: '🔥' });
    check('реакция принята', r.ok === true);
    const sh = await shown;
    check('reaction:show долетел с ником и эмодзи', sh.emoji === '🔥' && sh.nick === 'Аня');
    r = await call(a.socket, 'reaction:send', { emoji: '👍' });
    check('антиспам: чаще раза в 3 сек отклонено', r.ok === false && r.retryAfterMs > 0);
    r = await call(a.socket, 'reaction:send', { emoji: '💩' });
    check('эмодзи вне списка отклонён', r.ok === false);
    await sleep(3100);
    r = await call(a.socket, 'reaction:send', { emoji: '👍' });
    check('после 3 сек реакция снова принимается', r.ok === true);
    host.close(); a.socket.close();
  }

  console.log(`\nИтого: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Тест упал:', e); process.exit(1); });
