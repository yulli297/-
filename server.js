// =====================================================
//  한글날 초성 퀴즈 서버 (Node.js + Express + Socket.io)
// =====================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 5000, pingTimeout: 6000 });

const PORT = process.env.PORT || 3000;
const STDICT_KEY = (process.env.STDICT_KEY || '').trim();     // 표준국어대사전 키 (메인)
const OPENDICT_KEY = (process.env.OPENDICT_KEY || '').trim(); // 우리말샘 키 (비상용)

// ===== 게임 설정 (여기 숫자만 바꾸면 규칙이 바뀌어요) =====
const CONFIG = {
  MAX_NUM: 24,          // 학생 번호 최대값
  ROOM_COUNT: 6,        // 방 개수
  TURN_MS: 10000,       // 한 사람 제한시간 (10초)
  LAPS: 4,              // 아무도 안 틀리면 몇 바퀴 돌고 라운드 종료
  TOTAL_ROUNDS: 5,      // 전체 라운드 수
  LOSS_LIMIT: 2,        // 라운드 탈락 몇 번이면 패배
  POPUP_MS: 3000,       // 뜻 팝업 시간 (3초)
  COUNTDOWN: 5,         // 게임 시작 카운트다운 (5초)
  DICT_TIMEOUT_MS: 5000,// 사전 응답 기다리는 최대 시간
  DEF_MAX: 80,          // 뜻 최대 글자 수
};
const BLOCK_TYPES = ['방언', '북한어', '옛말', '지역어']; // 인정하지 않는 단어 종류

app.use(express.static(path.join(__dirname, 'public')));
app.get('/teacher', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
app.get('/health', (req, res) => res.send('ok'));

// ===== 한글 처리 =====
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
// ㄱ+ㅅ을 이어 치면 ㄳ이 되는 문제 해결용
const SPLIT = { 'ㄳ':'ㄱㅅ','ㄵ':'ㄴㅈ','ㄶ':'ㄴㅎ','ㄺ':'ㄹㄱ','ㄻ':'ㄹㅁ','ㄼ':'ㄹㅂ','ㄽ':'ㄹㅅ','ㄾ':'ㄹㅌ','ㄿ':'ㄹㅍ','ㅀ':'ㄹㅎ','ㅄ':'ㅂㅅ' };
function normalizeChosung(s) {
  return String(s || '').replace(/\s/g, '').split('').map(c => SPLIT[c] || c).join('');
}
function isValidChosung(s) {
  return s.length >= 1 && s.length <= 6 && s.split('').every(c => CHO.includes(c));
}
function choOf(ch) {
  const c = ch.charCodeAt(0) - 0xAC00;
  if (c < 0 || c > 11171) return null;
  return CHO[Math.floor(c / 588)];
}
function localCheck(word, cho) {
  if (!word) return '단어를 입력해주세요.';
  for (const ch of word) if (choOf(ch) === null) return '완성된 한글 글자로만 써주세요.';
  if (word.length !== cho.length) return `${cho.length}글자 단어를 써주세요.`;
  for (let i = 0; i < word.length; i++) if (choOf(word[i]) !== cho[i]) return '초성이 맞지 않아요.';
  return '';
}

// ===== 사전 확인 =====
function toArr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
function cleanWord(w) { return String(w || '').replace(/[-^\s]/g, ''); }
function cleanDef(s) {
  let d = String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (d.length > CONFIG.DEF_MAX) d = d.slice(0, CONFIG.DEF_MAX) + '…';
  return d;
}
async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.DICT_TIMEOUT_MS);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
function dictList() {
  // 표준국어대사전이 메인(판정+뜻), 우리말샘은 표준이 먹통일 때만 사용
  const list = [];
  if (STDICT_KEY) list.push({ name: '표준국어대사전', base: 'https://stdict.korean.go.kr/api/search.do', key: STDICT_KEY });
  if (OPENDICT_KEY) list.push({ name: '우리말샘', base: 'https://opendict.korean.go.kr/api/search', key: OPENDICT_KEY });
  return list;
}
// 결과: {status:'ok', def} 또는 {status:'notfound'}. 연결 문제면 에러를 던짐
async function queryDict(base, key, word) {
  const url = `${base}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(word)}&req_type=json&advanced=y&method=exact&num=30`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = (await res.text()).trim();
  if (!text) return { status: 'notfound' };
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('응답 형식 오류'); }
  if (data.error) throw new Error('API 오류 ' + JSON.stringify(data.error));
  const items = toArr(data.channel && data.channel.item);
  for (const it of items) {
    if (cleanWord(it.word) !== word) continue;
    for (const s of toArr(it.sense)) {
      if (BLOCK_TYPES.includes(String(s.type || '').trim())) continue;
      return { status: 'ok', def: cleanDef(s.definition) };
    }
  }
  return { status: 'notfound' };
}
// 표준국어대사전 → (먹통일 때만) 우리말샘 → 둘 다 먹통이면 down
// 표준이 정상 응답했는데 단어가 없으면 그대로 '없는 단어' 처리 (우리말샘으로 넘어가지 않음)
async function checkWord(word) {
  for (const d of dictList()) {
    try { const r = await queryDict(d.base, d.key, word); r.source = d.name; return r; }
    catch (e) { console.log(`[사전] ${d.name} 연결 실패:`, e.message); }
  }
  return { status: 'down' };
}

// ===== 게임 상태 =====
const students = new Map(); // 번호 -> { num, token, socketId, connected }
let gameSeq = 0;
let chosungList = ['', '', '', '', ''];
let countdownTimer = null;
let game = freshGame();

function freshGame() {
  return { id: ++gameSeq, phase: 'lobby', round: 0, chosung: '', rooms: [], stats: {}, countdown: 0, endReason: '' };
}
function newRoom(id, members) {
  return {
    id, members, order: [], pos: -1, lap: 1, used: [], words: [],
    status: 'idle', current: null, typing: '', remaining: CONFIG.TURN_MS, deadline: 0,
    checking: false, popup: null, lastLoser: null, _turnTimer: null, _popupTimer: null,
  };
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function onlineNums() {
  return [...students.values()].filter(s => s.connected).map(s => s.num).sort((a, b) => a - b);
}
function isConnected(num) { const s = students.get(num); return !!(s && s.connected); }
function aliveOf(room) { return room.members.filter(n => !game.stats[n].defeated); }
function roomOf(num) { const st = game.stats[num]; return st ? game.rooms[st.room - 1] : null; }
function clearRoomTimers(room) {
  clearTimeout(room._turnTimer); clearTimeout(room._popupTimer);
  room._turnTimer = null; room._popupTimer = null;
}
function clearAllTimers() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  game.rooms.forEach(clearRoomTimers);
}

function snapshot() {
  const now = Date.now();
  return {
    phase: game.phase, round: game.round, totalRounds: CONFIG.TOTAL_ROUNDS, laps: CONFIG.LAPS,
    lossLimit: CONFIG.LOSS_LIMIT, maxNum: CONFIG.MAX_NUM,
    chosung: (game.phase === 'playing' || game.phase === 'roundEnd') ? game.chosung : '',
    countdown: game.countdown, endReason: game.endReason,
    online: onlineNums(),
    rooms: game.rooms.map(r => ({
      id: r.id, members: r.members, order: r.order, status: r.status, current: r.current,
      typing: r.typing, checking: r.checking, words: r.words, lap: r.lap, popup: r.popup,
      lastLoser: r.lastLoser,
      remaining: (r.status === 'live' && r.current != null && !r.checking && !r.popup)
        ? Math.max(0, r.deadline - now) : r.remaining,
    })),
    stats: game.stats,
  };
}
function broadcast() { io.emit('state', snapshot()); }
function teacherInfo() {
  return { chosungList, keys: { opendict: !!OPENDICT_KEY, stdict: !!STDICT_KEY }, maxNum: CONFIG.MAX_NUM, totalRounds: CONFIG.TOTAL_ROUNDS };
}

// ===== 라운드 / 차례 진행 =====
function startRound(n) {
  game.round = n;
  game.chosung = chosungList[n - 1];
  game.phase = 'playing';
  for (const room of game.rooms) {
    clearRoomTimers(room);
    room.used = []; room.words = []; room.typing = ''; room.popup = null;
    room.checking = false; room.current = null; room.lastLoser = null;
    if (room.status === 'finished') continue;
    const alive = aliveOf(room);
    if (alive.length <= 1) { room.status = 'finished'; continue; }
    room.order = shuffle(alive.slice());
    room.pos = -1; room.lap = 1; room.status = 'live';
    advance(room);
  }
  checkAllDone();
}

// 다음 학생으로 (접속 끊긴 학생은 건너뜀)
function advance(room) {
  room.typing = ''; room.popup = null; room.checking = false; room.current = null;
  while (true) {
    room.pos++;
    if (room.pos >= room.order.length) {
      room.pos = 0; room.lap++;
      if (room.lap > CONFIG.LAPS) { room.lap = CONFIG.LAPS; return endRoomRound(room, null); }
    }
    const num = room.order[room.pos];
    if (isConnected(num)) return startTurn(room, num);
  }
}
function startTurn(room, num) {
  room.current = num; room.typing = ''; room.checking = false; room.popup = null;
  room.remaining = CONFIG.TURN_MS;
  runTimer(room);
}
function runTimer(room) {
  clearTimeout(room._turnTimer);
  room.deadline = Date.now() + room.remaining;
  const gid = game.id;
  room._turnTimer = setTimeout(() => {
    if (game.id !== gid || room.status !== 'live' || room.checking || room.popup) return;
    console.log(`[시간초과] ${room.id}번 방 ${room.lap}바퀴 ${room.current}번 라운드 탈락`);
    endRoomRound(room, room.current); // 시간 초과 = 라운드 탈락
    broadcast();
  }, room.remaining);
}
function pauseTimer(room) {
  clearTimeout(room._turnTimer); room._turnTimer = null;
  room.remaining = Math.max(0, room.deadline - Date.now());
  room.checking = true;
}
function resumeTimer(room) {
  room.checking = false;
  room.remaining = Math.max(300, room.remaining);
  runTimer(room);
}
function endRoomRound(room, loser) {
  clearRoomTimers(room);
  room.current = null; room.typing = ''; room.checking = false; room.popup = null;
  room.lastLoser = loser;
  if (loser != null) {
    const st = game.stats[loser];
    st.losses++;
    if (st.losses >= CONFIG.LOSS_LIMIT) st.defeated = true;
  }
  room.status = aliveOf(room).length <= 1 ? 'finished' : 'done';
  checkAllDone();
}
function checkAllDone() {
  if (game.phase !== 'playing') return;
  if (game.rooms.some(r => r.status === 'live')) return;
  if (game.round >= CONFIG.TOTAL_ROUNDS || game.rooms.every(r => r.status === 'finished')) endGame('');
  else game.phase = 'roundEnd';
}
function endGame(reason) {
  clearAllTimers();
  game.rooms.forEach(r => {
    if (r.status === 'live') r.status = 'done';
    r.current = null; r.typing = ''; r.checking = false; r.popup = null;
  });
  game.phase = 'gameOver';
  game.endReason = reason || '';
}

// ===== 소켓 이벤트 =====
io.on('connection', (socket) => {
  socket.emit('state', snapshot());

  // ---------- 학생 ----------
  socket.on('studentLogin', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const num = parseInt(data && data.num, 10);
    const token = String((data && data.token) || '');
    if (!Number.isInteger(num) || num < 1 || num > CONFIG.MAX_NUM) {
      return cb({ ok: false, msg: `1~${CONFIG.MAX_NUM} 사이의 번호를 입력해주세요.` });
    }
    let s = students.get(num);
    if (s && s.connected && s.token !== token) {
      return cb({ ok: false, msg: '이미 접속 중인 번호예요. 내 번호가 맞는지 확인해주세요.' });
    }
    if (!s) { s = { num }; students.set(num, s); }
    const oldId = s.connected ? s.socketId : null;
    s.token = token; s.socketId = socket.id; s.connected = true;
    socket.data.role = 'student'; socket.data.num = num;
    if (oldId && oldId !== socket.id) {
      const old = io.sockets.sockets.get(oldId);
      if (old) old.disconnect(true);
    }
    cb({ ok: true, num });
    broadcast();
  });

  socket.on('studentLogout', () => {
    const num = socket.data.num;
    if (game.phase === 'lobby' && num) {
      const s = students.get(num);
      if (s && s.socketId === socket.id) students.delete(num);
      socket.data.role = null; socket.data.num = null;
      broadcast();
    }
  });

  socket.on('typing', (text) => {
    const num = socket.data.num;
    const room = roomOf(num);
    if (!room || game.phase !== 'playing' || room.status !== 'live' || room.current !== num || room.checking || room.popup) return;
    room.typing = String(text || '').slice(0, 20);
    io.emit('typing', { room: room.id, text: room.typing });
  });

  socket.on('submitWord', async (raw, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const num = socket.data.num;
    const room = roomOf(num);
    const word = String(raw || '').replace(/\s/g, '');
    if (!room || game.phase !== 'playing' || room.status !== 'live' || room.current !== num || room.checking || room.popup) {
      const why = !room ? '방 없음' : room.current !== num ? `차례 아님(현재 ${room.current}번)` : room.checking ? '확인 중' : room.popup ? '팝업 중' : `상태 ${room.status}`;
      console.log(`[제출 무시] ${num}번 "${word}" → ${why}`);
      return cb({ ok: false, msg: '' });
    }
    const tag = `[제출] ${room.id}번 방 ${room.lap}바퀴 ${num}번 "${word}"`;
    const err = localCheck(word, game.chosung);
    if (err) { console.log(`${tag} → ${err}`); return cb({ ok: false, msg: err }); }
    if (room.used.includes(word)) { console.log(`${tag} → 이미 제출된 단어`); return cb({ ok: false, msg: '이미 제출된 정답입니다.' }); }

    pauseTimer(room); // 사전 확인하는 동안 시간 멈춤
    broadcast();
    const gid = game.id, round = game.round;
    const t0 = Date.now();
    const r = await checkWord(word);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${tag} → ${r.status === 'ok' ? '정답' : r.status === 'notfound' ? '사전에 없음' : '사전 먹통'} (${r.source || '-'}, ${sec}초)`);
    if (game.id !== gid || game.round !== round || room.status !== 'live' || room.current !== num) return;

    if (r.status === 'down') {
      cb({ ok: false, msg: '' });
      endGame('사전에 연결할 수 없어서 게임이 종료됐어요.');
      return broadcast();
    }
    if (r.status === 'notfound') {
      cb({ ok: false, msg: '사전에 없는 단어예요. 다시 써보세요!' });
      if (!isConnected(num)) advance(room); else resumeTimer(room);
      return broadcast();
    }
    // 정답!
    room.used.push(word);
    room.words.push({ word, num });
    game.stats[num].correct++;
    room.typing = '';
    room.popup = { word, def: r.def, num };
    cb({ ok: true });
    broadcast();
    room._popupTimer = setTimeout(() => {
      if (game.id !== gid || room.status !== 'live') return;
      advance(room);
      broadcast();
    }, CONFIG.POPUP_MS);
  });

  // ---------- 교사 ----------
  socket.on('teacherJoin', () => {
    socket.data.role = 'teacher';
    socket.join('teacher');
    socket.emit('teacherInfo', teacherInfo());
    socket.emit('state', snapshot());
  });

  socket.on('saveChosung', (list) => {
    if (game.phase !== 'lobby' || !Array.isArray(list)) return;
    chosungList = list.slice(0, CONFIG.TOTAL_ROUNDS).map(normalizeChosung);
    while (chosungList.length < CONFIG.TOTAL_ROUNDS) chosungList.push('');
    socket.to('teacher').emit('teacherInfo', teacherInfo());
  });

  socket.on('startGame', (list, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (game.phase !== 'lobby') return cb({ ok: false, msg: '이미 게임이 진행 중이에요.' });
    const norm = (Array.isArray(list) ? list : []).slice(0, CONFIG.TOTAL_ROUNDS).map(normalizeChosung);
    if (norm.length < CONFIG.TOTAL_ROUNDS || !norm.every(isValidChosung)) {
      return cb({ ok: false, msg: `초성 ${CONFIG.TOTAL_ROUNDS}개를 모두 자음으로만 입력해주세요.` });
    }
    if (!dictList().length) return cb({ ok: false, msg: '사전 키가 설정되지 않았어요. Render 환경변수를 확인해주세요.' });
    const nums = onlineNums();
    if (nums.length < 2) return cb({ ok: false, msg: '학생이 2명 이상 접속해야 시작할 수 있어요.' });

    chosungList = norm;
    shuffle(nums);
    const roomCount = Math.min(CONFIG.ROOM_COUNT, Math.floor(nums.length / 2));
    const base = Math.floor(nums.length / roomCount), extra = nums.length % roomCount;
    let idx = 0;
    game.rooms = []; game.stats = {};
    for (let i = 0; i < roomCount; i++) {
      const size = base + (i < extra ? 1 : 0);
      const members = nums.slice(idx, idx + size).sort((a, b) => a - b);
      idx += size;
      game.rooms.push(newRoom(i + 1, members));
      members.forEach(n => { game.stats[n] = { room: i + 1, losses: 0, correct: 0, defeated: false }; });
    }
    game.phase = 'assigning';
    game.countdown = CONFIG.COUNTDOWN;
    cb({ ok: true });
    broadcast();
    const gid = game.id;
    countdownTimer = setInterval(() => {
      if (game.id !== gid) { clearInterval(countdownTimer); countdownTimer = null; return; }
      game.countdown--;
      if (game.countdown <= 0) {
        clearInterval(countdownTimer); countdownTimer = null;
        startRound(1);
      }
      broadcast();
    }, 1000);
  });

  socket.on('nextRound', () => {
    if (game.phase !== 'roundEnd') return;
    startRound(game.round + 1);
    broadcast();
  });

  socket.on('forceEnd', () => {
    if (game.phase === 'lobby' || game.phase === 'gameOver') return;
    endGame('선생님이 게임을 끝냈어요.');
    broadcast();
  });

  socket.on('resetGame', () => {
    clearAllTimers();
    game = freshGame();
    for (const [num, s] of students) if (!s.connected) students.delete(num);
    io.to('teacher').emit('teacherInfo', teacherInfo());
    broadcast();
  });

  socket.on('testDict', async (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const out = [];
    if (!STDICT_KEY) out.push('표준국어대사전(메인): 키가 설정되지 않았어요 (STDICT_KEY)');
    if (!OPENDICT_KEY) out.push('우리말샘(비상용): 키가 설정되지 않았어요 (OPENDICT_KEY)');
    for (const d of dictList()) {
      try {
        const r = await queryDict(d.base, d.key, '학교');
        out.push(r.status === 'ok'
          ? `${d.name}: 연결 성공! ("학교" → ${r.def.slice(0, 30)}…)`
          : `${d.name}: 연결은 됐지만 "학교"를 찾지 못했어요. 키를 다시 확인해주세요.`);
      } catch (e) {
        out.push(`${d.name}: 연결 실패 (${e.message})`);
      }
    }
    cb(out);
  });

  // ---------- 접속 끊김 ----------
  socket.on('disconnect', () => {
    if (socket.data.role !== 'student') return;
    const num = socket.data.num;
    const s = students.get(num);
    if (!s || s.socketId !== socket.id) return;
    s.connected = false; s.socketId = null;
    if (game.phase === 'lobby') students.delete(num);
    const room = roomOf(num);
    // 자기 차례에 끊기면 바로 다음 사람으로 건너뜀
    if (room && game.phase === 'playing' && room.status === 'live' && room.current === num && !room.checking && !room.popup) {
      clearRoomTimers(room);
      advance(room);
    }
    broadcast();
  });
});

server.listen(PORT, () => console.log(`초성 퀴즈 서버 실행 중: ${PORT}`));
