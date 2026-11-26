import { END_NAME, END_EMOJI, END_COLOR, HL } from './constants.js';
import { LEVELS, T } from './tune.js';

export const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function showScreen(name) {
  for (const s of ['menu', 'lobby', 'over']) $(s).classList.toggle('hidden', s !== name);
}
export function showHud(on) { $('hud').classList.toggle('hidden', !on); }

let toastTimer = 0;
export function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function banner(text, cls = '', ms = 1600) {
  const b = $('banner');
  const d = document.createElement('div');
  d.className = 'bn ' + cls;
  d.textContent = text;
  d.style.animationDuration = ms + 'ms';
  b.innerHTML = '';
  b.appendChild(d);
  setTimeout(() => { if (d.parentNode) d.remove(); }, ms);
}

export function popup(text, x, y, color = '#fff', cls = '') {
  const d = document.createElement('div');
  d.className = 'pop ' + cls;
  d.textContent = text;
  d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.color = color;
  $('popups').appendChild(d);
  setTimeout(() => d.remove(), 1150);
}

let cdShown = '';
export function countdown(text) {
  const c = $('countdown');
  if (text === cdShown) return;
  cdShown = text;
  c.textContent = text;
  c.classList.remove('tick');
  if (text) { void c.offsetWidth; c.classList.add('tick'); }
}

export function renderLobby(players, { isHost, localId, max, level }) {
  $('sel-level-lobby').classList.toggle('hidden', !isHost);
  $('sel-level-lobby').value = level;
  $('lobby-level').textContent = isHost ? '' : (LEVELS[level] || LEVELS.easy).label;
  const ul = $('lobby-list');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${esc(p.color)}"></span><span class="grow">${esc(p.name)}${p.id === localId ? ' (you)' : ''}</span>` +
      (p.id === 'h' ? '<span class="tag">HOST</span>' : '') + (p.bot ? '<span class="tag">BOT</span>' : '') +
      (isHost && p.id !== 'h' ? `<button data-kick="${esc(p.id)}">✕</button>` : '');
    ul.appendChild(li);
  }
  $('lobby-count').textContent = `${players.length}/${max}`;
  $('host-ctrl').classList.toggle('hidden', !isHost);
  $('guest-wait').classList.toggle('hidden', isHost);
  $('btn-start').disabled = players.length < 2;
  $('btn-addbot').disabled = players.length >= max;
}

function heartsHtml(lives, max = 2) {
  let s = '<span class="hearts">';
  for (let i = 0; i < max; i++) s += i < lives ? '❤' : '<span class="lost">❤</span>';
  return s + '</span>';
}

let lastHudKey = '';
export function updateHud(game, now) {
  const me = game.me;
  // players
  const ps = [...game.players.values()].filter((p) => !p.spectator);
  let html = '';
  for (const p of ps) {
    const cls = ['prow', p.id === game.localId ? 'me' : '', p.alive ? '' : 'out', game.isActive(p.id) ? 'active' : ''].join(' ');
    html += `<div class="${cls}"><span class="dot" style="background:${esc(p.color)}"></span><span class="nm">${esc(p.name)}</span>${p.alive ? heartsHtml(p.lives) : '💀'}</div>`;
  }
  // queues
  let qh = '';
  for (const end of [-1, 1]) {
    const q = game.Q(end);
    qh += `<div class="qend"><div class="qh" style="background:${END_COLOR[end]}">${END_EMOJI[end]} ${END_NAME[end]} end</div><div class="qlist">`;
    q.forEach((id, i) => {
      const p = game.players.get(id);
      if (!p) return;
      qh += `<span class="qp ${i === 0 ? 'head' : ''} ${id === game.localId ? 'me' : ''}">${i + 1}. ${esc(p.name)}</span>`;
    });
    if (!q.length) qh += '<span class="qp">—</span>';
    qh += '</div></div>';
  }
  if (game.duel) qh = '<div style="margin-bottom:4px">🔥 FINAL DUEL</div>' + qh;

  // status line
  let status = '', urgent = false;
  const st = me ? game.statusFor(me.id) : { kind: 'none' };
  const endTxt = (e) => `${END_EMOJI[e]} ${END_NAME[e]}`;
  if (game.phase === 'countdown') status = 'Get ready…';
  else if (game.phase === 'over') status = '🏆 Game over!';
  else if (st.kind === 'serve') {
    const far = me.x * st.end < HL - 0.2;
    status = far ? `🏃 Run to the ${endTxt(st.end)} end to serve!` : '🏓 YOUR SERVE! Click near the ball';
    urgent = true;
  } else if (st.kind === 'shot') { status = T.guide ? '⚡ YOUR SHOT! Paddle on the 🎯 + CLICK' : '⚡ YOUR SHOT! Click after the bounce'; urgent = true; }
  else if (st.kind === 'queue') {
    const atEnd = me.x * st.end > HL - 0.2;
    if (!atEnd) { status = `🏃 Run to the ${endTxt(st.end)} end!`; urgent = st.idx <= 1; }
    else if (st.idx === 0) status = `👀 You're next at ${endTxt(st.end)}!`;
    else status = `⏳ #${st.idx + 1} in line at ${endTxt(st.end)}`;
  } else if (st.kind === 'out') status = '👻 Eliminated! Float around & cheer';
  else if (st.kind === 'spectator') status = '👀 Spectating — you play next round';
  else if (game.phase === 'point') status = '…';

  const key = html + '|' + qh + '|' + status + urgent;
  if (key !== lastHudKey) {
    lastHudKey = key;
    $('hud-players').innerHTML = html;
    $('hud-queues').innerHTML = qh;
    const s = $('hud-status');
    s.textContent = status;
    s.classList.toggle('urgent', urgent);
  }
}

// little label next to the mouse pointer: what a click does right now
let chText = null, chCls = null;
export function cursorHint(text, cls, x, y) {
  const el = $('cursor-hint');
  if (!text) { if (chText !== null) { el.className = 'hidden'; chText = null; chCls = null; } return; }
  if (cls !== chCls || chText === null) { el.className = cls || ''; chCls = cls; }
  if (text !== chText) { el.textContent = text; chText = text; }
  el.style.left = Math.round(x + 22) + 'px';
  el.style.top = Math.round(y + 14) + 'px';
}

let coText = null, coCls = null;
export function callout(text, cls, x, y) {
  const el = $('callout');
  if (!text) { if (coText !== null) { el.className = 'hidden'; coText = null; coCls = null; } return; }
  if (cls !== coCls || coText === null) { el.className = cls; coCls = cls; }
  if (text !== coText) { el.textContent = text; coText = text; }
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
}

export function setHudHelp(level) {
  $('hud-help').innerHTML = level === 'easy'
    ? '<span>🖱️ <b>Mouse</b> = paddle</span><span><b>LEFT click</b> = hit 🏓</span><span><b>RIGHT click</b> = slap 👋</span><span>🏃 You walk by yourself · <b>WASD/ZQSD</b> to steer</span><span><b>Space</b> dash / slide</span><span><b>C</b> camera</span>'
    : '<span><b>WASD / ZQSD</b> run</span><span><b>Mouse</b> paddle</span><span><b>LEFT click</b> hit (topspin)</span><span><b>RIGHT click</b> slap 👋 · or backspin</span><span><b>Space</b> dash / slide under</span><span><b>C</b> camera</span>';
  $('hud-level').textContent = (LEVELS[level] || LEVELS.easy).label;
}

export function fillLevelSelect(sel, value) {
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(LEVELS)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label; if (k === value) o.selected = true;
    sel.appendChild(o);
  }
}
