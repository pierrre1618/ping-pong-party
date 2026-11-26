// Deterministic ball simulation. Only + - * / and Math.sqrt are used inside stepBall so every
// peer computes the exact same trajectory from the same "segment" (hit) data.
import {
  TABLE_H, NET_H, HL, HW, NET_OVER, BALL_R, G, DT, KM, KD, SPIN_DECAY,
  E_TABLE, E_FLOOR, SPIN_GRIP, clamp,
} from './constants.js';

const TOP = TABLE_H + BALL_R;

export function ballFromSeg(seg) {
  return {
    x: seg.x, y: seg.y, z: seg.z,
    vx: seg.vx, vy: seg.vy, vz: seg.vz,
    wx: seg.wx, wy: seg.wy, wz: seg.wz,
    need: seg.need,       // side (-1/1) the ball must land on first
    stage: 0,             // 0 = travelling to opponent side, 1 = bounced once there (hittable)
    net: false, inNet: false,
    dead: false, deadStep: -1, deadRole: null, deadReason: '',
    step: 0, frozen: false,
  };
}

export const cloneBall = (b) => Object.assign({}, b);

function kill(b, role, reason) {
  if (b.dead) return;
  b.dead = true; b.deadRole = role; b.deadReason = reason; b.deadStep = b.step;
}

function integrate(b) {
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  const ax = KM * (b.wy * b.vz - b.wz * b.vy) - KD * sp * b.vx;
  const ay = -G + KM * (b.wz * b.vx - b.wx * b.vz) - KD * sp * b.vy;
  const az = KM * (b.wx * b.vy - b.wy * b.vx) - KD * sp * b.vz;
  b.vx += ax * DT; b.vy += ay * DT; b.vz += az * DT;
  b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;
  const d = 1 - SPIN_DECAY * DT;
  b.wx *= d; b.wy *= d; b.wz *= d;
}

// ev(type, ball, info) is optional: 'table' | 'net' | 'floor'
export function stepBall(b, ev) {
  if (b.frozen) { b.step++; return; }
  const px = b.x, py = b.y;
  integrate(b);
  b.step++;

  // --- net ---
  const ax = b.x < 0 ? -b.x : b.x;
  if (ax > BALL_R * 1.5) b.inNet = false;
  if (!b.inNet && ax < BALL_R && b.y - BALL_R < TABLE_H + NET_H && b.y + BALL_R > TABLE_H &&
      (b.z < 0 ? -b.z : b.z) < HW + NET_OVER) {
    const from = px < 0 ? -1 : px > 0 ? 1 : (b.vx > 0 ? -1 : 1);
    if (b.vx * from < 0) {
      b.net = true; b.inNet = true;
      if (b.y > TABLE_H + NET_H - BALL_R * 0.35) {
        // net cord: dribbles over
        b.vx *= 0.45; b.vz *= 0.7;
        b.vy = (b.vy < 0 ? -b.vy : b.vy) * 0.35 + 0.55;
        b.wx *= 0.3; b.wy *= 0.3; b.wz *= 0.3;
        if (ev) ev('net', b, 0.6);
      } else {
        b.x = from * BALL_R * 1.05;
        b.vx = -b.vx * 0.12; b.vz *= 0.5; b.vy *= 0.4;
        b.wx *= 0.2; b.wy *= 0.2; b.wz *= 0.2;
        if (ev) ev('net', b, 1);
      }
    }
  }

  // --- table top ---
  const inX = (b.x < 0 ? -b.x : b.x) <= HL, inZ = (b.z < 0 ? -b.z : b.z) <= HW;
  if (b.vy < 0 && b.y < TOP && py >= TOP - 0.04 && inX && inZ) {
    b.y = TOP;
    const vyIn = -b.vy;
    // contact point slip velocity: v + w x (0,-R,0) = (vx + R wz, vz - R wx)
    const ux = b.vx + BALL_R * b.wz * SPIN_GRIP;
    const uz = b.vz - BALL_R * b.wx * SPIN_GRIP;
    const hs = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    let top = 0;
    if (hs > 0.01) top = (b.wx * b.vz - b.wz * b.vx) / hs; // + = topspin relative to travel
    let k = top * 0.0015; k = k < -0.15 ? -0.15 : k > 0.25 ? 0.25 : k;
    b.vy = vyIn * E_TABLE * (1 - k);
    b.vx -= 0.32 * ux; b.vz -= 0.32 * uz;
    // sidespin kick
    b.vx += 0.0022 * b.wy * b.vz; b.vz -= 0.0022 * b.wy * b.vx;
    b.wx *= 0.6; b.wy *= 0.6; b.wz *= 0.6;
    const side = b.x >= 0 ? 1 : -1;
    if (!b.dead) {
      if (b.stage === 0) {
        if (side === b.need) b.stage = 1;
        else kill(b, 'hitter', b.net ? 'NET!' : 'WRONG SIDE!');
      } else {
        kill(b, 'receiver', side === b.need ? 'DOUBLE BOUNCE!' : 'MISSED!');
      }
    }
    if (ev) ev('table', b, vyIn);
  } else if (b.y < TABLE_H && b.y > TABLE_H - 0.06 && inX && inZ && !(py < TABLE_H - 0.06)) {
    // clipped the table edge from the side: knock it back out
    const ox = HL - (b.x < 0 ? -b.x : b.x), oz = HW - (b.z < 0 ? -b.z : b.z);
    if (ox < oz) { b.x = (b.x < 0 ? -1 : 1) * (HL + 0.001); b.vx = -b.vx * 0.5; }
    else { b.z = (b.z < 0 ? -1 : 1) * (HW + 0.001); b.vz = -b.vz * 0.5; }
  }

  // --- floor ---
  if (b.y < BALL_R) {
    b.y = BALL_R;
    const vyIn = -b.vy;
    b.vy = vyIn > 0.4 ? vyIn * E_FLOOR : 0;
    b.vx *= 0.85; b.vz *= 0.85;
    b.wx *= 0.5; b.wy *= 0.5; b.wz *= 0.5;
    if (!b.dead) {
      if (b.stage === 0) kill(b, 'hitter', b.net ? 'NET!' : 'OUT!');
      else kill(b, 'receiver', 'MISSED!');
    }
    if (ev && vyIn > 0.4) ev('floor', b, vyIn);
  }
  if ((b.x < 0 ? -b.x : b.x) > 9 || (b.z < 0 ? -b.z : b.z) > 8) {
    if (!b.dead) kill(b, b.stage === 0 ? 'hitter' : 'receiver', b.stage === 0 ? 'OUT!' : 'MISSED!');
    b.frozen = true;
  }
}

// Where (x * f) does the ball come down through table height? (no collisions) used by auto-arc.
function landProgress(s, f) {
  const b = { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, wx: s.wx, wy: s.wy, wz: s.wz };
  let above = b.y > TOP;
  for (let i = 0; i < 900; i++) {
    integrate(b);
    if (b.y > TOP) above = true;
    else if (above && b.vy < 0) return { p: b.x * f, z: b.z };
    if (b.y < 0) return { p: -10, z: b.z };
  }
  return { p: b.x * f, z: b.z };
}

function solveVy(st, f, depth) {
  let lo = -4, hi = 8;
  st.vy = hi; if (landProgress(st, f).p < depth) return hi;
  st.vy = lo; if (landProgress(st, f).p > depth) return lo;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    st.vy = mid;
    if (landProgress(st, f).p < depth) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Simulate full rules; returns 'ok' | 'net' | 'out' (for net clearance assist)
function preview(st, need) {
  const b = ballFromSeg({ ...st, need });
  for (let i = 0; i < 900; i++) {
    stepBall(b);
    if (b.stage === 1) return b.net ? 'cord' : 'ok';
    if (b.dead) return b.net ? 'net' : 'out';
  }
  return 'out';
}

/**
 * Turn a paddle swing into a ball segment.
 * o: { x,y,z, vx,vy,vz (incoming), pvx,pvz (paddle velocity), end (hitter side -1/1),
 *      spin: 'top'|'back'|'none', curve (rad/s of swing direction change), serve,
 *      assist: 0 none | 1 fix near-misses | 2 always lands on the table, spinScale, maxSpeed }
 */
export function computeShot(o) {
  const f = -o.end;
  const assist = o.assist || 0;
  const spinK = o.spinScale ?? 1;
  const maxS = o.maxSpeed || 11.5;
  const vin = Math.hypot(o.vx, o.vz);
  const fwd = clamp(o.pvx * f, -4, 14);
  let s;
  if (o.serve) s = 2.7 + 0.42 * Math.max(0, fwd);
  else s = 2.8 + 0.16 * vin + 0.55 * Math.max(0, fwd) - 0.1 * Math.max(0, -fwd);
  if (o.spin === 'back') s *= 0.84;
  s = clamp(s, 2.4, maxS);

  // aim: swipe direction steers the ball, part of the incoming angle is kept (reflection)
  const lat = 0.3 * o.pvz + (o.serve ? 0 : 0.2 * o.vz);
  const ang = clamp(Math.atan2(lat, s), -0.85, 0.85);

  let wTop;
  if (o.spin === 'top') wTop = 60 + 9 * s;
  else if (o.spin === 'back') wTop = -(70 + 9 * s);
  else wTop = 8 + 2 * s;
  wTop *= spinK;
  const wy = clamp(-(o.curve || 0) * 13, -140, 140) * spinK;

  // power -> how deep it lands. Too much power = long (OUT) unless assisted.
  const safe = (o.spin === 'top' ? 10 : o.spin === 'back' ? 7.6 : 8.6) + (assist === 1 ? 1.2 : 0);
  const sMin = 2.4;
  let depth = s <= safe ? 0.3 + 0.95 * (s - sMin) / (safe - sMin) : 1.25 + (s - safe) * 0.33;
  if (assist >= 2) depth = clamp(depth, 0.35, 1.15);

  const st = { x: o.x, y: o.y, z: o.z, vx: 0, vy: 0, vz: 0, wx: 0, wy, wz: 0 };
  const setDir = (dx, dz) => { st.vx = dx * s; st.vz = dz * s; st.wx = wTop * dz; st.wz = -wTop * dx; };
  setDir(f * Math.cos(ang), Math.sin(ang));

  // aim assist: choose a landing point inside the table, then steer (and counter the curve) to reach it
  let zTarget = null;
  const run = (f * depth - o.x) * f;
  if (assist > 0 && run > 0.4) {
    const zStraight = o.z + Math.tan(ang) * run;
    const lim = HW - 0.1;
    if (assist >= 2 || Math.abs(zStraight) < HW + 0.45) zTarget = clamp(zStraight, -lim, lim);
  }

  let res = 'out';
  for (let tries = 0; tries < 5; tries++) {
    if (zTarget !== null) {
      let aimZ = zTarget;
      for (let k = 0; k < 3; k++) {
        const ddx = f * depth - o.x, ddz = aimZ - o.z, L = Math.hypot(ddx, ddz) || 1;
        setDir(ddx / L, ddz / L);
        st.vy = solveVy(st, f, depth);
        const land = landProgress(st, f);
        if (land.p < -5) break;
        aimZ += zTarget - land.z;
      }
    }
    st.vy = solveVy(st, f, depth);
    res = preview(st, f);
    if (res !== 'net') break;
    depth += 0.12; // lift it a little over the net (the "player instinct")
    if (assist >= 2) depth = Math.min(depth, 1.3);
  }
  const high = o.y > TABLE_H + 0.32;
  return {
    x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz, wx: st.wx, wy: st.wy, wz: st.wz,
    need: f,
    fx: {
      speed: s,
      smash: s >= Math.min(8, maxS * 0.9) && high,
      spin: o.spin,
      curve: Math.abs(wy) > 40 ? (wy > 0 ? 1 : -1) : 0,
    },
  };
}

// Is the ball something the receiver may hit right now?
export function hittable(b, volley) {
  if (b.dead) return false;
  if (b.stage === 1) return true;
  return !!volley && b.x * b.need > 0.25;
}

// Paddle/ball contact in the horizontal plane (height is handled by the auto-height paddle)
export function paddleTouches(px, pz, bx, by, bz, PADDLE_R) {
  if (by < TABLE_H - 0.35 || by > TABLE_H + 1.25) return false;
  const dx = bx - px, dz = bz - pz;
  const r = PADDLE_R + BALL_R;
  return dx * dx + dz * dz < r * r;
}
