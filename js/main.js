import { COLORS, HATS, BOT_NAMES, MAX_PLAYERS, TABLE_H, HL, END_NAME, END_EMOJI } from './constants.js';
import { T, LEVELS, setLevel } from './tune.js';
import { Renderer } from './render.js';
import { hittable } from './physics.js';
import { Game } from './game.js';
import { HostNet, GuestNet, cleanCode } from './net.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import * as UI from './ui.js';

const $ = UI.$;
const renderer = new Renderer($('three'));

// ------------------------------------------------------------------ profile
const store = {
  get(k, d) { try { const v = localStorage.getItem('ppp.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('ppp.' + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
};
const FUN_NAMES = ['Pingu', 'Spinner', 'Smashy', 'Loopy', 'Ziggy', 'Bonk', 'Chopper', 'Flick', 'Wobbles', 'Dinky'];
const pick = (a) => a[(Math.random() * a.length) | 0];
const profile = {
  name: store.get('name', pick(FUN_NAMES)),
  color: store.get('color', pick(COLORS)),
  hat: store.get('hat', pick(HATS).id),
  level: LEVELS[store.get('level', 'easy')] ? store.get('level', 'easy') : 'easy',
};
const cleanName = (n) => (String(n || '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 12)) || pick(FUN_NAMES);

// ------------------------------------------------------------------ session
const S = {
  mode: 'menu',          // menu | host | guest | practice
  net: null, code: null, localId: null,
  lobby: [], botCounter: 0, level: 'easy',
  game: null, attract: null, shown: null,
  clock: { offset: 0 }, samples: [], pingTimer: 0,
  joinResolve: null, duelShown: false, overTimer: 0,
};

const input = { keys: { up: false, down: false, left: false, right: false }, dash: false, swing: false, slap: false, spin: 'none', mouse: null, basis: null, mx: -1, my: -1, lmb: false, rmb: false };
const NO_INPUT = { keys: {}, dash: false, spin: 'none', mouse: null };

// ------------------------------------------------------------------ effects bridge
function makeFx(real) {
  return {
    ballEvent(type, x, y, z, info) {
      if (type === 'table') { renderer.ringPulse(x, TABLE_H, z, '#ffffff', 0.28, 0.35); if (real) sfx.table(info); }
      else if (type === 'net') { renderer.burst(x, y, z, '#ffffff', 6, 1.2); if (real) sfx.net(); }
      else if (type === 'floor') { renderer.ringPulse(x, 0.01, z, '#ffffff', 0.22, 0.3); if (real) sfx.floor(info); }
    },
    hit(seg, p, local, game) {
      const pw = Math.min(1, seg.fx.speed / 11);
      renderer.burst(seg.x, seg.y, seg.z, p ? p.color : '#fff', (8 + pw * 14) | 0, 1.4 + pw * 3);
      if (!real) return;
      sfx.paddle(pw);
      const sp = renderer.project(seg.x, seg.y + 0.35, seg.z);
      let label = null, col = '#fff', cls = 'sm';
      if (seg.fx.smash) { label = 'SMASH!'; col = '#ffe14d'; cls = 'lg'; renderer.addShake(0.75); sfx.whoosh(); }
      else if (seg.fx.curve) { label = 'CURVE!'; col = '#ff5cf0'; cls = ''; }
      else if (seg.fx.spin === 'top' && seg.fx.speed > 5) { label = 'TOPSPIN!'; col = '#ff8a5c'; }
      else if (seg.fx.spin === 'back') { label = 'BACKSPIN!'; col = '#5cd3ff'; }
      if (label) UI.popup(label, sp.x, sp.y, col, cls);
    },
    phase(ph, prev, game) {
      if (!real) {
        if (ph === 'over') setTimeout(() => { if (S.attract === game) startAttract(); }, 2500);
        return;
      }
      onPhase(ph, prev, game);
    },
    dash(p) { renderer.dust(p.x, p.z, 5); if (real) sfx.whoosh(); },
    banner(text, cls) { if (real) UI.banner(text, cls); },
    removed() {},
    swing() { if (real) sfx.swing(); },
    slap(a, b, game) {
      renderer.burst(b.x, 0.95, b.z, '#ffe14d', 14, 3);
      renderer.ringPulse(b.x, 0.01, b.z, '#ffe14d', 0.7, 0.35);
      if (!real) return;
      sfx.slap();
      const sp = renderer.project(b.x, 1.5, b.z);
      UI.popup(pick(['SLAP!', 'WHAP!', 'BONK!', 'POW!']), sp.x, sp.y, '#ffe14d', 'lg');
      if (b.id === game.localId) {
        renderer.addShake(0.55);
        if (!store.get('slapSeen', false)) { store.set('slapSeen', true); UI.toast('👋 You got slapped! Your turn: RIGHT CLICK on a player in your way.', 4200); }
      } else if (a && a.id === game.localId) renderer.addShake(0.25);
    },
    slide(p, game) {
      renderer.dust(p.x, p.z, 8);
      if (!real) return;
      sfx.slide();
      if (p.id === game.localId) { const sp = renderer.project(p.x, 1.2, p.z); UI.popup('SLIDE! 🛝', sp.x, sp.y, '#7ff0ff', 'sm'); }
    },
    shield(p) {
      if (!real) return;
      const sp = renderer.project(p.x, 1.5, p.z);
      UI.popup('🛡️ Not the hitter!', sp.x, sp.y, '#ffffff', 'sm');
    },
    early(p, game, why) {
      if (!real || input.mx < 0) return;
      UI.popup(why === 'far' ? '↔ Too far! Paddle on the 🎯' : '⏱ Too early! Hold the click', input.mx, input.my - 30, '#ffffff', 'sm');
    },
  };
}

function onPhase(ph, prev, game) {
  if (ph === 'serve') {
    if (game.duel && !S.duelShown) { S.duelShown = true; UI.banner('🔥 FINAL DUEL! 🔥', 'huge good', 2200); sfx.boing(); }
    else if (game.server === game.localId) { UI.banner('YOUR SERVE!', 'good small', 1200); sfx.turn(); }
  } else if (ph === 'point') {
    const pt = game.point;
    if (!pt) return;
    const p = pt.loser ? game.players.get(pt.loser) : null;
    const sp = renderer.project(pt.x, TABLE_H + 0.45, pt.z);
    if (pt.id >= 0) UI.popup(pt.reason, sp.x, sp.y, '#ff6b8a', 'lg');
    if (p) {
      if (pt.elim) { UI.banner(`💀 ${p.name} is OUT!`, 'bad', 2600); sfx.elim(); renderer.addShake(0.6); }
      else { UI.banner(`💔 ${p.name} −1 life`, 'bad', 1800); sfx.lifeLost(); }
      if (p.id === game.localId) renderer.addShake(0.9);
    } else UI.banner(pt.reason, 'small');
  } else if (ph === 'over') {
    const w = game.players.get(game.winner);
    UI.banner(w ? `🏆 ${w.name} WINS!` : 'Game over', 'huge good', 3000);
    sfx.win();
    renderer.confetti();
    clearTimeout(S.overTimer);
    S.overTimer = setTimeout(() => showOver(game), 2800);
  }
}

function showOver(game) {
  if (S.game !== game || game.phase !== 'over') return;
  const w = game.players.get(game.winner);
  $('over-title').textContent = w ? `${w.name} wins!` : 'Game over';
  $('over-sub').textContent = w && w.id === game.localId ? '🎉 You are the ping pong champion! 🎉' : 'GG everyone!';
  const host = S.mode === 'host' || S.mode === 'practice';
  $('over-host').classList.toggle('hidden', !host);
  $('over-guest').classList.toggle('hidden', host);
  $('btn-tolobby').classList.toggle('hidden', S.mode === 'practice');
  UI.showScreen('over');
}

// ------------------------------------------------------------------ attract mode (bots playing behind the menu)
function startAttract() {
  const players = [];
  for (let i = 0; i < 5; i++) players.push({ id: 'a' + i, name: BOT_NAMES[i], color: COLORS[(i * 3) % COLORS.length], hat: HATS[(i * 2) % HATS.length].id, bot: true, skill: 0.75 + Math.random() * 0.2 });
  S.attract = new Game({ isHost: true, localId: null, net: null, fx: makeFx(false), players });
  S.attract.hostStart();
}

// ------------------------------------------------------------------ menu
function buildMenu() {
  $('in-name').value = profile.name;
  $('in-name').addEventListener('input', () => { profile.name = $('in-name').value; store.set('name', profile.name); });
  const cw = $('colors');
  COLORS.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'swatch' + (c === profile.color ? ' sel' : '');
    d.style.background = c;
    d.onclick = () => { profile.color = c; store.set('color', c); [...cw.children].forEach((e) => e.classList.toggle('sel', e === d)); sfx.pop(); };
    cw.appendChild(d);
  });
  const hatIdx = () => Math.max(0, HATS.findIndex((h) => h.id === profile.hat));
  const showHat = () => { $('hat-label').textContent = HATS[hatIdx()].label; };
  const stepHat = (d) => { profile.hat = HATS[(hatIdx() + d + HATS.length) % HATS.length].id; store.set('hat', profile.hat); showHat(); sfx.pop(); };
  $('hat-prev').onclick = () => stepHat(-1);
  $('hat-next').onclick = () => stepHat(1);
  showHat();
  const sel = $('sel-bots');
  for (let i = 1; i <= MAX_PLAYERS - 1; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i; if (i === 4) o.selected = true; sel.appendChild(o); }

  UI.fillLevelSelect($('sel-level'), profile.level);
  UI.fillLevelSelect($('sel-level-lobby'), profile.level);
  $('sel-level').onchange = () => { profile.level = $('sel-level').value; store.set('level', profile.level); };
  $('sel-level-lobby').onchange = () => {
    if (S.mode !== 'host') return;
    S.level = $('sel-level-lobby').value; profile.level = S.level; store.set('level', S.level);
    $('sel-level').value = S.level;
    broadcastLobby();
  };
  $('btn-create').onclick = () => { initAudio(); firstTimeTutorial(createRoom); };
  $('btn-join').onclick = () => { initAudio(); firstTimeTutorial(() => joinRoom($('in-code').value)); };
  $('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { initAudio(); firstTimeTutorial(() => joinRoom($('in-code').value)); } });
  $('btn-practice').onclick = () => { initAudio(); firstTimeTutorial(() => startPractice(+sel.value)); };
  $('btn-tuto').onclick = () => showTutorial(null);
  $('btn-help').onclick = () => showTutorial(null);
  $('btn-tuto-ok').onclick = () => closeTutorial();

  $('btn-copy-code').onclick = () => copy(S.code, 'Room code copied!');
  $('btn-copy-link').onclick = () => copy(inviteLink(), 'Invite link copied!');
  $('btn-addbot').onclick = () => addBot();
  $('btn-start').onclick = () => { if (S.lobby.length >= 2) startMatch(); };
  $('btn-leave').onclick = () => leaveToMenu();
  $('lobby-list').addEventListener('click', (e) => {
    const id = e.target && e.target.dataset && e.target.dataset.kick;
    if (id && S.mode === 'host') kick(id);
  });
  $('btn-rematch').onclick = () => startMatch();
  $('btn-tolobby').onclick = () => hostToLobby();
  $('btn-over-leave').onclick = () => leaveToMenu();
  $('btn-quit').onclick = () => { if (confirm('Leave this game?')) leaveToMenu(); };
  $('btn-cam').onclick = () => cycleCamera();
  $('btn-mute').onclick = () => { setMuted(!isMuted()); store.set('muted', isMuted()); $('btn-mute').textContent = isMuted() ? '🔇' : '🔊'; };
  if (store.get('muted', false)) { setMuted(true); $('btn-mute').textContent = '🔇'; }

  const m = location.hash.match(/room=([A-Za-z0-9]+)/);
  if (m) { $('in-code').value = cleanCode(m[1]); setTimeout(() => UI.toast('Pick a name & color, then press Join!', 4000), 400); }
}

// ------------------------------------------------------------------ tutorial
let tutoNext = null;
function showTutorial(next) {
  tutoNext = next;
  $('tutorial').classList.remove('hidden');
}
function closeTutorial() {
  $('tutorial').classList.add('hidden');
  store.set('tutoSeen', true);
  sfx.pop();
  const n = tutoNext; tutoNext = null;
  if (n) n();
}
function firstTimeTutorial(next) {
  if (store.get('tutoSeen', false)) next(); else showTutorial(next);
}

function inviteLink() { return `${location.origin}${location.pathname}#room=${S.code}`; }
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); UI.toast(msg); }
  catch (_) { window.prompt('Copy this:', text); }
}
const myMeta = () => ({ name: cleanName(profile.name), color: profile.color, hat: profile.hat });
function menuError(msg) { $('menu-err').textContent = msg || ''; }

function freeColor(want, exceptId) {
  const used = new Set(S.lobby.filter((p) => p.id !== exceptId).map((p) => p.color));
  if (want && !used.has(want)) return want;
  return COLORS.find((c) => !used.has(c)) || want || COLORS[0];
}

// ------------------------------------------------------------------ host
async function createRoom() {
  menuError('');
  $('btn-create').disabled = true;
  $('btn-create').textContent = '⏳ Opening room…';
  const net = new HostNet({ onJoin: hostOnJoin, onMessage: hostOnMessage, onLeave: hostOnLeave });
  try {
    const code = await net.start();
    S.mode = 'host'; S.net = net; S.code = code; S.localId = 'h'; S.level = profile.level;
    S.lobby = [{ id: 'h', ...myMeta() }];
    $('room-code').textContent = code;
    $('share-hint').classList.remove('hidden');
    $('btn-copy-code').classList.remove('hidden'); $('btn-copy-link').classList.remove('hidden');
    renderLobby();
    UI.showScreen('lobby');
  } catch (e) {
    console.error(e);
    menuError('Could not open a room: ' + (e.type || e.message || e) + '. Check your internet connection.');
    net.close();
  } finally {
    $('btn-create').disabled = false;
    $('btn-create').textContent = '🏓 Create a room';
  }
}

function renderLobby() { UI.renderLobby(S.lobby, { isHost: S.mode === 'host', localId: S.localId, max: MAX_PLAYERS, level: S.level }); }
function broadcastLobby() { if (S.mode === 'host') S.net.broadcast({ type: 'lobby', players: S.lobby, level: S.level }); renderLobby(); }

function gamePlayersList(g) {
  return [...g.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat, bot: p.bot, skill: p.skill, lives: p.lives, alive: p.alive, spectator: p.spectator }));
}

function hostOnJoin(id, meta) {
  if (S.lobby.length >= MAX_PLAYERS) { S.net.sendTo(id, { type: 'full' }); return false; }
  const p = { id, name: cleanName(meta.name), color: freeColor(meta.color), hat: HATS.some((h) => h.id === meta.hat) ? meta.hat : 'none' };
  S.lobby.push(p);
  S.net.sendTo(id, { type: 'welcome', id, code: S.code, players: S.lobby, level: S.level });
  if (S.game && S.game.phase !== 'over') {
    S.game.addPlayer({ ...p, spectator: true, x: (Math.random() - 0.5) * 4, z: 3.2 });
    S.net.sendTo(id, { type: 'start', players: gamePlayersList(S.game), spawn: { [id]: [0, 3.2] }, state: S.game.stateMsg(), level: S.level });
    S.net.broadcast({ type: 'addp', p: { ...p, spectator: true } }, id);
  }
  broadcastLobby();
  UI.toast(`👋 ${p.name} joined!`);
  sfx.pop();
  return true;
}

function hostOnMessage(id, m) {
  if (m.type === 'ping') { S.net.sendTo(id, { type: 'pong', t: m.t, h: performance.now() / 1000 }); return; }
  if (S.game) S.game.onNet(id, m);
}

function hostOnLeave(id) {
  const i = S.lobby.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = S.lobby.splice(i, 1);
  if (S.game) { S.game.handleLeave(id); S.net.broadcast({ type: 'rmp', id }); }
  broadcastLobby();
  UI.toast(`${p.name} left`);
}

function addBot() {
  if (S.lobby.length >= MAX_PLAYERS) return;
  const used = new Set(S.lobby.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + (S.botCounter + 1);
  S.lobby.push({ id: 'b' + (++S.botCounter), name, color: freeColor(null), hat: pick(HATS).id, bot: true, skill: 0.5 + Math.random() * 0.45 });
  sfx.pop();
  broadcastLobby();
}

function kick(id) {
  const p = S.lobby.find((q) => q.id === id);
  if (!p) return;
  if (p.bot) { S.lobby = S.lobby.filter((q) => q.id !== id); broadcastLobby(); return; }
  S.net.sendTo(id, { type: 'kick' });
  setTimeout(() => S.net.kick(id), 300);
}

function hostAdapter() {
  return { send() {}, broadcast: (m) => S.net.broadcast(m), sendTo: (id, m) => S.net.sendTo(id, m) };
}

function startMatch() {
  clearTimeout(S.overTimer);
  S.duelShown = false;
  setLevel(S.level);
  const players = S.lobby.map((p) => ({ ...p, lives: undefined, alive: true, skill: p.bot ? p.skill * T.botSkill : p.skill }));
  S.game = new Game({ isHost: true, localId: 'h', net: S.mode === 'host' ? hostAdapter() : null, fx: makeFx(true), players });
  const spawn = S.game.hostStart();
  if (S.mode === 'host') S.net.broadcast({ type: 'start', players: gamePlayersList(S.game), spawn, state: S.game.stateMsg(), level: S.level });
  enterGameView();
}

function hostToLobby() {
  S.game = null;
  S.net.broadcast({ type: 'tolobby' });
  UI.showHud(false);
  renderLobby();
  UI.showScreen('lobby');
}

function startPractice(nBots) {
  S.mode = 'practice'; S.localId = 'h'; S.level = profile.level;
  S.lobby = [{ id: 'h', ...myMeta() }];
  S.botCounter = 0;
  for (let i = 0; i < nBots; i++) addBot();
  startMatch();
}

function enterGameView() {
  UI.showScreen(null);
  UI.showHud(true);
  UI.countdown('');
  UI.setHudHelp(T.level);
}

// ------------------------------------------------------------------ guest
async function joinRoom(raw) {
  const code = cleanCode(raw);
  if (code.length < 4) { menuError('Enter the room code from the host.'); return; }
  menuError('');
  $('btn-join').disabled = true; $('btn-join').textContent = '⏳';
  const net = new GuestNet({ onMessage: guestOnMessage, onClose: (r) => { if (S.net === net) leaveToMenu(r === 'Connection to host lost' ? '😢 The host left or the connection dropped.' : r); } });
  S.net = net; S.mode = 'guest'; S.code = code;
  try {
    await net.join(code, myMeta());
    await new Promise((res, rej) => { S.joinResolve = res; setTimeout(() => rej(new Error('The host did not answer.')), 8000); });
    startClockSync();
  } catch (e) {
    console.error(e);
    net.close();
    if (S.net === net) { S.net = null; S.mode = 'menu'; }
    menuError(e.message || String(e));
  } finally {
    $('btn-join').disabled = false; $('btn-join').textContent = 'Join';
  }
}

function guestOnMessage(m) {
  switch (m.type) {
    case 'welcome':
      S.localId = m.id; S.lobby = m.players; S.code = m.code; S.level = m.level || 'easy';
      $('room-code').textContent = m.code;
      renderLobby();
      if (!S.game) UI.showScreen('lobby');
      if (S.joinResolve) { S.joinResolve(); S.joinResolve = null; }
      sfx.pop();
      break;
    case 'lobby':
      S.lobby = m.players; S.level = m.level || S.level;
      renderLobby();
      break;
    case 'full':
      menuError('That room is full (10 players max).');
      leaveToMenu('That room is full (10 players max).');
      break;
    case 'kick':
      leaveToMenu('The host removed you from the room.');
      break;
    case 'start': {
      clearTimeout(S.overTimer);
      S.duelShown = false;
      S.level = setLevel(m.level);
      S.game = new Game({ isHost: false, localId: S.localId, net: { send: (x) => S.net.send(x), broadcast() {}, sendTo() {} }, fx: makeFx(true), clock: S.clock, players: m.players });
      const sp = m.spawn && m.spawn[S.localId];
      if (sp && S.game.me) S.game.placePlayer(S.game.me, sp);
      S.game.applyState(m.state, true);
      enterGameView();
      if (S.game.me && S.game.me.spectator) UI.toast('Game in progress — you are spectating. You play next round!', 4000);
      break;
    }
    case 'addp': if (S.game) S.game.addPlayer(m.p); break;
    case 'rmp': if (S.game) S.game.handleLeave(m.id); break;
    case 'tolobby':
      S.game = null;
      UI.showHud(false);
      renderLobby();
      UI.showScreen('lobby');
      break;
    case 'pong': onPong(m); break;
    default:
      if (S.game) S.game.onNet('h', m);
  }
}

function startClockSync() {
  clearInterval(S.pingTimer);
  S.samples = [];
  let n = 0;
  const ping = () => { if (S.net && S.mode === 'guest') S.net.send({ type: 'ping', t: performance.now() / 1000 }); };
  const fast = setInterval(() => { ping(); if (++n >= 8) clearInterval(fast); }, 150);
  S.pingTimer = setInterval(ping, 1500);
}

function onPong(m) {
  const now = performance.now() / 1000;
  const rtt = now - m.t;
  S.samples.push({ rtt, off: m.h + rtt / 2 - now });
  if (S.samples.length > 16) S.samples.shift();
  const best = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  // ease towards the best estimate to avoid time jumps
  const d = best.off - S.clock.offset;
  S.clock.offset += Math.abs(d) > 0.25 ? d : d * 0.3;
}

// ------------------------------------------------------------------ leave
function leaveToMenu(msg) {
  clearInterval(S.pingTimer);
  clearTimeout(S.overTimer);
  if (S.net) { try { S.net.close(); } catch (_) { /* ignore */ } }
  S.net = null; S.game = null; S.mode = 'menu'; S.lobby = []; S.localId = null;
  S.clock.offset = 0;
  UI.showHud(false);
  UI.countdown('');
  UI.callout(null);
  UI.cursorHint('');
  UI.showScreen('menu');
  menuError(msg || '');
  if (msg) UI.toast(msg, 3500);
}

// ------------------------------------------------------------------ input
// e.code = physical key, so WASD on QWERTY is ZQSD on AZERTY automatically
const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
const typing = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
const CAM_NAMES = { behind: '🎥 Camera: behind you', table: '🎥 Camera: whole table', first: '🎥 Camera: first person' };
function cycleCamera() {
  const m = renderer.cycleCamera();
  store.set('cam', m);
  UI.toast(CAM_NAMES[m] + '  (C to change)', 1800);
  sfx.pop();
}
renderer.setCameraMode(store.get('cam', 'behind'));
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  const k = KEYMAP[e.code];
  if (k) { input.keys[k] = true; if (S.game) e.preventDefault(); }
  if (e.code === 'Space') { if (!e.repeat) input.dash = true; if (S.game) e.preventDefault(); }
  if (e.code === 'KeyC' && !e.repeat && S.game) cycleCamera();
  if ((e.code === 'KeyE' || e.code === 'KeyF') && !e.repeat && S.game) input.slap = true; // slap without a right button
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) input.keys[k] = false; });
window.addEventListener('blur', () => { for (const k in input.keys) input.keys[k] = false; input.lmb = input.rmb = false; });
window.addEventListener('pointermove', (e) => { input.mx = e.clientX; input.my = e.clientY; });
const canvas = renderer.canvas;
// LEFT click = hit the ball (hold = stay ready), RIGHT click = slap a player in your way
canvas.addEventListener('pointerdown', (e) => {
  initAudio();
  if (e.button === 0) { input.lmb = true; input.swing = true; }
  if (e.button === 2) { input.rmb = true; input.slap = true; }
});
window.addEventListener('pointerup', (e) => { if (e.button === 0) input.lmb = false; if (e.button === 2) input.rmb = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => { if (S.game) e.preventDefault(); });

// ------------------------------------------------------------------ main loop
let lastStep = performance.now();
let hudAcc = 0, lastCd = '', lastStatus = '';

function step(nowMs, draw) {
  const dt = Math.min(0.05, Math.max(0, (nowMs - lastStep) / 1000));
  lastStep = nowMs;
  const realT = nowMs / 1000;
  const g = S.game || S.attract;
  if (g !== S.shown) { renderer.clearChars(); renderer.trail.length = 0; S.shown = g; }
  if (S.game) {
    input.spin = input.lmb ? 'top' : input.rmb ? 'back' : 'none';
    input.mouse = input.mx >= 0 ? renderer.mouseToWorld(input.mx, input.my) : null;
    input.basis = renderer.basis;
    S.game.update(dt, input, realT);
  } else if (S.attract) S.attract.update(dt, NO_INPUT, realT);
  if (!draw) return;
  renderer.frame(g, dt, realT, S.game ? input.mouse : null);

  if (S.game) {
    const gm = S.game;
    // countdown
    let cd = '';
    if (gm.phase === 'countdown') { const r = gm.phaseEnd - gm.now(); cd = r > 0.45 ? String(Math.ceil(r - 0.45)) : 'GO!'; }
    if (cd !== lastCd) { if (cd) sfx.beep(cd === 'GO!'); lastCd = cd; }
    UI.countdown(cd);
    hudAcc += dt;
    if (hudAcc > 0.1) {
      hudAcc = 0;
      UI.updateHud(gm, gm.now());
      const me = gm.me;
      const st = me ? gm.statusFor(me.id).kind : '';
      if (st === 'shot' && lastStatus !== 'shot') sfx.turn();
      lastStatus = st;
    }
    updateCallout(gm);
    updateCursorHint(gm);
  } else { UI.countdown(''); UI.callout(null); UI.cursorHint(''); }
}

// small hint next to the mouse: what a click does right now
function updateCursorHint(gm) {
  const me = gm.me;
  let text = '', cls = '';
  if (me && me.alive && gm.phase !== 'over' && gm.phase !== 'point' && input.mx >= 0 && $('tutorial').classList.contains('hidden')) {
    const st = gm.statusFor(me.id);
    const now = gm.now();
    if (st.kind === 'shot') {
      const pr = gm.pred && gm.pred.hit;
      const soon = pr ? pr.t - now : null;
      const now2 = pr ? soon < 0.6 && soon > -0.25 : !!(gm.ball && hittable(gm.ball, T.volley));
      if (now2) { text = '🖱️ CLICK!'; cls = 'hit'; } else { text = '🖱️ get ready…'; cls = 'ready'; }
    } else if (st.kind === 'serve' && me.x * st.end > HL - 0.3) { text = '🖱️ CLICK to serve!'; cls = 'hit'; }
    else if (gm.blockers.length) { text = '👋 RIGHT CLICK = SLAP!'; cls = 'slap'; }
    else if (!T.autoSlide && gm.canSlide(me)) { text = '⌨️ SPACE = slide under the table 🛝'; cls = 'slide'; }
  }
  UI.cursorHint(text, cls, input.mx, input.my);
}

// speech bubble above your own head telling you what to do right now
function updateCallout(gm) {
  const me = gm.me;
  if (!me || gm.phase === 'over' || gm.phase === 'init' || !$('tutorial').classList.contains('hidden')) { UI.callout(null); return; }
  const st = gm.statusFor(me.id);
  const endTxt = (e) => `${END_EMOJI[e]} ${END_NAME[e]}`;
  let text = '', cls = 'wait';
  if (gm.phase === 'countdown') { text = 'Get ready!'; cls = 'next'; }
  else if (st.kind === 'serve') {
    const far = me.x * st.end < HL - 0.2;
    if (far) { text = `RUN to ${endTxt(st.end)}!`; cls = 'run'; } else { text = 'SERVE! Click near the ball 🏓'; cls = 'hit'; }
  } else if (st.kind === 'shot') { text = T.guide ? 'CLICK to hit! 🎯' : 'YOUR SHOT! Click!'; cls = 'hit'; }
  else if (st.kind === 'queue') {
    const atEnd = me.x * st.end > HL - 0.2;
    if (!atEnd) { text = `RUN to ${endTxt(st.end)}!`; cls = 'run'; }
    else if (st.idx === 0) { text = "You're NEXT! 👀"; cls = 'next'; }
    else { text = `Wait… #${st.idx + 1} in line`; cls = 'wait'; }
  } else if (st.kind === 'out') { text = "👻 You're out!"; cls = 'wait'; }
  else if (st.kind === 'spectator') { text = '👀 Watching'; cls = 'wait'; }
  if (gm.phase === 'point' && st.kind !== 'out') { UI.callout(null); return; }
  if (renderer.effMode === 'table') {
    const p = renderer.project(me.x, me.alive ? 2.75 : 2.95, me.z);
    UI.callout(text, cls, p.x, Math.max(70, p.y));
  } else {
    // seen from behind, the space above your head is where the ball arrives: put the bubble at the bottom
    const hb = $('hud-help').getBoundingClientRect();
    UI.callout(text, cls + ' fixed', window.innerWidth / 2, (hb.height ? hb.top : window.innerHeight) - 8);
  }
}

function loop(ts) {
  step(ts, true);
  requestAnimationFrame(loop);
}

// keep the host simulating when its tab is in the background (rAF stops there)
try {
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),33)'], { type: 'text/javascript' })));
  w.onmessage = () => { if (document.hidden && S.game) step(performance.now(), false); };
} catch (_) { /* workers unavailable: fine */ }

buildMenu();
startAttract();
UI.showScreen('menu');
requestAnimationFrame(loop);

// handy for debugging in the console
window.__ppp = { S, renderer };
