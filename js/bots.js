// Bot brains. Bots live on the host only; they move, plan a swing from an exact prediction
// of the (deterministic) ball, and swing their paddle through the ball like a human would.
import {
  HL, HW, TABLE_H, BODY_R, DT, ARENA_X, ARENA_Z, TURBO, clamp,
} from './constants.js';
import { cloneBall, stepBall } from './physics.js';
import { T } from './tune.js';

const rand = (a, b) => a + Math.random() * (b - a);

// --- tiny path finder around the table -----------------------------------
const RX = HL + BODY_R + 0.02, RZ = HW + BODY_R + 0.12;
const CORNERS = [[RX + 0.14, RZ + 0.14], [-RX - 0.14, RZ + 0.14], [RX + 0.14, -RZ - 0.14], [-RX - 0.14, -RZ - 0.14]];

function segHitsRect(x0, z0, x1, z1) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dz = z1 - z0;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 + RX) && clip(dx, RX - x0) && clip(-dz, z0 + RZ) && clip(dz, RZ - z0) && t0 < t1;
}

export function nextWaypoint(x, z, gx, gz) {
  if (!segHitsRect(x, z, gx, gz)) return [gx, gz];
  const nodes = [[x, z], ...CORNERS, [gx, gz]];
  const N = nodes.length, dist = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), done = new Array(N).fill(false);
  dist[0] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true;
    for (let v = 0; v < N; v++) {
      if (done[v] || v === u) continue;
      const [ax, az] = nodes[u], [bx, bz] = nodes[v];
      if (segHitsRect(ax, az, bx, bz)) continue;
      const d = dist[u] + Math.hypot(bx - ax, bz - az);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  let v = N - 1;
  if (prev[v] < 0) return [gx, gz];
  while (prev[v] !== 0 && prev[v] >= 0) v = prev[v];
  return nodes[v];
}

export function queueSpot(end, idx) {
  if (idx === 0) return [end * (HL + 0.6), 0];
  const row = Math.ceil(idx / 2), side = idx % 2 ? 1 : -1;
  return [end * Math.min(4.2, HL + 1.15 + 0.5 * (row - 1)), side * (0.75 + 0.55 * (row - 1))];
}

// --- planning --------------------------------------------------------------
// Exact look-ahead of the deterministic ball: where it bounces and a comfy spot to hit it.
export function predictHit(ball, t0) {
  const b = cloneBall(ball);
  let bounce = null, hit = null;
  for (let i = 0; i < 720; i++) {
    stepBall(b);
    if (b.dead) break;
    if (b.stage !== 1) continue;
    if (!bounce && ball.stage === 0) bounce = { x: b.x, z: b.z };
    const h = b.y - TABLE_H;
    const beyond = Math.abs(b.x) > HL + 0.05 || Math.abs(b.z) > HW + 0.05;
    if ((b.vy <= 0 && h > 0.03 && h < 0.65) || (beyond && h > 0.05 && h < 0.75)) {
      hit = { x: b.x, y: b.y, z: b.z, vx: b.vx, vz: b.vz, t: t0 + b.step * DT / T.bt };
      break;
    }
  }
  return { bounce, hit };
}

// Where to stand (outside the table) to comfortably reach a hit point, preferring the closest spot.
export function standSpot(hx, hz, need, px, pz) {
  const cands = [];
  const outside = Math.abs(hx) > HL + BODY_R * 0.6 || Math.abs(hz) > HW + BODY_R * 0.6;
  if (outside) cands.push([hx + need * 0.45, hz + (hz > 0 ? 0.18 : -0.18)]);
  cands.push([need * (HL + BODY_R + 0.08), clamp(hz, -HW, HW)]);
  cands.push([hx + need * 0.25, HW + BODY_R + 0.12]);
  cands.push([hx + need * 0.25, -HW - BODY_R - 0.12]);
  let best = null, bestD = Infinity;
  for (const c of cands) {
    if (Math.hypot(c[0] - hx, c[1] - hz) > T.reach - 0.12) continue;
    const d = Math.hypot(c[0] - px, c[1] - pz);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best || cands[0];
}

function planHit(game, p) {
  const need = game.ball.need;
  const hit = predictHit(game.ball, game.seg.t0).hit;
  if (!hit) return null;

  const sk = p.skill;
  // mistakes! a blunder is a clear whiff (bigger than the paddle, whatever the difficulty)
  const blunder = Math.random() < 0.03 + (1 - sk) * 0.25;
  hit.t += rand(-1, 1) * (1 - sk) * 0.05;
  const ea = rand(0, Math.PI * 2);
  const er = rand(0, (1 - sk) * 0.12) + (blunder ? T.paddleR + rand(0.12, 0.3) : 0);
  const ex = Math.cos(ea) * er, ez = Math.sin(ea) * er;
  const hx = hit.x + ex, hz = hit.z + ez;

  const best = standSpot(hx, hz, need, p.x, p.z);

  // shot choice
  const f = -need;
  const r = Math.random();
  const spin = r < 0.35 + sk * 0.1 ? 'top' : r < 0.82 ? 'none' : 'back';
  let fwd = rand(2.2, 4.5 + sk * 4);
  if (spin === 'top') fwd += 1.2;
  if (spin === 'back') fwd = Math.min(fwd, 6);
  const highBall = hit.y > TABLE_H + 0.35;
  if (highBall && Math.random() < sk) fwd = rand(8, 10.5); // smash!
  const s = 2.8 + 0.16 * Math.hypot(hit.vx, hit.vz) + 0.55 * fwd;
  const zLand = rand(-0.62, 0.62) * (0.6 + sk * 0.4);
  const D = Math.abs(f * 0.9 - hx) + 0.01;
  const lat = s * (zLand - hz) / D - 0.2 * hit.vz;
  const pvz = clamp(lat / 0.3, -9, 9);
  const curve = Math.random() < 0.15 + sk * 0.1 ? rand(5, 11) * (Math.random() < 0.5 ? -1 : 1) : 0;
  return {
    t: hit.t, hx, hz, body: best,
    swing: { pvx: f * fwd, pvz, spin, curve },
  };
}

function planServe(game, p, hb) {
  const f = -game.serveEnd;
  const r = Math.random();
  const spin = r < 0.3 ? 'top' : r < 0.85 ? 'none' : 'back';
  const fwd = rand(2.5, 5.5);
  const zLand = rand(-0.5, 0.5);
  const s = 2.7 + 0.42 * fwd;
  const lat = s * (zLand - hb.z) / (HL * 2);
  return {
    t: game.now() + 0.1, hx: hb.x, hz: hb.z, body: null,
    swing: { pvx: f * fwd, pvz: clamp(lat / 0.3, -6, 6), spin, curve: Math.random() < 0.15 ? rand(-8, 8) : 0 },
    serve: true,
  };
}

// --- per frame --------------------------------------------------------------
export function updateBot(game, p, dt, now) {
  const ai = p.ai || (p.ai = { plan: null, planKey: '', wait: 0, wander: null, serveZ: rand(-0.4, 0.4), blockedT: 0, slideKey: '' });
  let gx = p.x, gz = p.z, urgent = false;
  p.slapCd = Math.max(0, (p.slapCd || 0) - dt);

  if (!p.alive) {
    // happy ghost wandering around the arena
    if (!ai.wander || Math.hypot(ai.wander[0] - p.x, ai.wander[1] - p.z) < 0.3) {
      ai.wander = [rand(-ARENA_X + 0.4, ARENA_X - 0.4), (Math.random() < 0.5 ? -1 : 1) * rand(1.9, ARENA_Z - 0.2)];
    }
    gx = ai.wander[0]; gz = ai.wander[1];
    moveBody(game, p, gx, gz, dt, 0.35, false, true);
    restPaddle(p, dt);
    return;
  }

  const phase = game.phase;
  if ((phase === 'serve' || phase === 'countdown') && game.server === p.id) {
    const E = game.serveEnd;
    gx = E * (HL + 0.55); gz = ai.serveZ;
    if (phase === 'serve') {
      const close = Math.hypot(gx - p.x, gz - p.z) < 0.2;
      ai.wait = close ? ai.wait + dt : 0;
      const key = 'serve' + game.seq + ':' + game.phaseStart;
      if (ai.wait > 0.5 + (1 - p.skill) * 0.8 && ai.planKey !== key) {
        ai.plan = planServe(game, p, game.heldBall(now));
        ai.planKey = key;
      }
    }
  } else if (phase === 'rally' && game.seg && game.seg.recv === p.id && game.ball && !game.ball.dead) {
    const key = 'r' + game.seg.seq;
    if (ai.planKey !== key) { ai.plan = planHit(game, p); ai.planKey = key; }
    if (ai.plan) { gx = ai.plan.body[0]; gz = ai.plan.body[1]; urgent = true; }
  } else {
    ai.serveZ = rand(-0.4, 0.4);
    const qp = game.queuePos(p.id);
    if (qp) [gx, gz] = queueSpot(qp.end, qp.idx);
    // changing ends: sometimes belly-slide under the table (decided once per switch)
    if (qp && game.canSlide(p)) {
      const key = 'sl' + game.seq;
      if (ai.slideKey !== key) { ai.slideKey = key; if (Math.random() < (qp.idx <= 1 ? 0.65 : 0.25)) game.startSlide(p); }
    }
    // keep away from the active hitter's spot a bit
    if (phase === 'rally' && ai.plan && ai.planKey !== 'r' + (game.seg && game.seg.seq)) ai.plan = null;
  }
  if (phase !== 'rally' && phase !== 'serve') { if (!(ai.plan && ai.plan.serve)) ai.plan = null; }

  moveBody(game, p, gx, gz, dt, p.skill, urgent, false);
  // somebody standing on my spot or right in my path? slap them!
  // (nobody can slap the player whose turn it is: they are protected)
  const bid = !(p.slideT > 0) && !(p.kbT > 0) && !(p.dizzyT > 0) && game.phase !== 'countdown' ? blockerOf(game, p, gx, gz) : null;
  if (bid && bid === ai.blockId) ai.blockedT += dt;
  else { ai.blockId = bid; ai.blockedT = 0; }
  if (bid && ai.blockedT > 0.45 + (1 - p.skill) * 0.4 && p.slapCd <= 0) {
    const o = game.players.get(bid);
    ai.blockedT = 0;
    // bots are nicer with other bots (otherwise the queue turns into a brawl)
    if (o && (!o.bot || Math.random() < 0.4)) game.trySlap(p, bid, true);
    else ai.blockedT = -1.2;
  }
  // ...and sometimes slap back
  if (p.revenge && now >= p.revenge.t) {
    const id = p.revenge.id; p.revenge = null;
    if (game.phase !== 'countdown') game.trySlap(p, id, true);
  }

  // paddle
  const pl = ai.plan;
  const Ts = 0.13;
  if (pl && now > pl.t - 0.45 && now < pl.t + Ts) {
    const sw = pl.swing;
    const sp = Math.hypot(sw.pvx, sw.pvz) || 1;
    const ux = sw.pvx / sp, uz = sw.pvz / sp;
    const L = sp * Ts;
    let u = (now - pl.t) / Ts; // -inf..1 ; 0 = contact
    if (u < -0.5) u = -0.5;
    let tx = pl.hx + ux * L * u, tz = pl.hz + uz * L * u;
    setPaddle(p, tx, tz, dt, 1);
    p.ai.swing = sw;
  } else {
    restPaddle(p, dt);
    if (pl && now >= pl.t + Ts) ai.plan = pl.serve ? null : ai.plan;
  }
  // auto-height paddle
  const ball = game.ballView;
  let ty = TABLE_H + 0.16;
  if (ball && ball.visible && Math.hypot(ball.x - p.px, ball.z - p.pz) < 1.6 && (game.server === p.id || (game.seg && game.seg.recv === p.id))) {
    ty = clamp(ball.y, TABLE_H - 0.25, TABLE_H + 1.15);
  }
  p.py += (ty - p.py) * Math.min(1, dt * 20);
}

function setPaddle(p, tx, tz, dt, snap) {
  let dx = tx - p.x, dz = tz - p.z;
  const d = Math.hypot(dx, dz);
  if (d > T.reach) { dx *= T.reach / d; dz *= T.reach / d; }
  const nx = p.x + dx, nz = p.z + dz;
  if (snap >= 1) { p.px = nx; p.pz = nz; }
  else { p.px += (nx - p.px) * Math.min(1, dt * 14); p.pz += (nz - p.pz) * Math.min(1, dt * 14); }
}

function restPaddle(p, dt) {
  // hold the paddle in front, towards the table
  const tx = clamp(p.x, -HL, HL), tz = clamp(p.z, -HW, HW);
  let dx = tx - p.x, dz = tz - p.z;
  const d = Math.hypot(dx, dz) || 1;
  setPaddle(p, p.x + dx / d * 0.45, p.z + dz / d * 0.45, dt, 0);
}

// the player standing on the bot's spot, or between the bot and where it wants to go
function blockerOf(game, p, gx, gz) {
  const gd = Math.hypot(gx - p.x, gz - p.z);
  const [wx, wz] = gd > 0.35 ? nextWaypoint(p.x, p.z, gx, gz) : [gx, gz];
  const mx = wx - p.x, mz = wz - p.z, ml = Math.hypot(mx, mz) || 1;
  let best = null, bd = Infinity;
  for (const o of game.players.values()) {
    if (o === p || !game.slappable(o)) continue;
    const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
    if (d > 1.05) continue;
    const onSpot = Math.hypot(o.x - gx, o.z - gz) < 0.6;
    const inPath = gd > 0.35 && d < 0.85 && (dx * mx + dz * mz) / ((d || 1) * ml) > 0.5;
    if (!onSpot && !inPath) continue;
    if (d < bd) { bd = d; best = o.id; }
  }
  return best;
}

// returns the speed the bot wanted to move at (to detect being blocked)
function moveBody(game, p, gx, gz, dt, skill, urgent, ghost) {
  const [wx, wz] = ghost ? [gx, gz] : nextWaypoint(p.x, p.z, gx, gz);
  let dx = wx - p.x, dz = wz - p.z;
  const d = Math.hypot(dx, dz);
  const te = ghost ? 0 : game.targetEnd(p);
  const switching = te && p.x * te < HL - 0.2;
  const maxSp = T.run * (ghost ? 0.4 : 0.82 + 0.18 * skill) * (switching ? TURBO : 1);
  let tvx = 0, tvz = 0;
  if (d > 0.04) {
    const sp = Math.min(maxSp, d * 6);
    tvx = dx / d * sp; tvz = dz / d * sp;
  }
  p.dashCd = Math.max(0, (p.dashCd || 0) - dt);
  if (!ghost && urgent && d > 1.6 && p.dashCd <= 0 && Math.random() < skill * 0.6) {
    p.dashT = 0.15; p.dashCd = 1.2; p.dashX = dx / d; p.dashZ = dz / d;
  }
  game.integrateBody(p, tvx, tvz, dt, ghost);
  return Math.hypot(tvx, tvz);
}
