// Core match logic shared by host and guests.
// - Every peer moves its own character + paddle and streams it (host relays).
// - The ball is a deterministic simulation started from the last hit ("segment").
// - The player whose turn it is detects the hit locally (zero lag for them) and sends the new segment.
// - The host is the referee: validates hits, decides lost lives, rotates the "around the table" queues.
import {
  HL, HW, TABLE_H, BODY_R, DASH_TIME, DASH_CD, DASH_SPEED, ARENA_X, ARENA_Z,
  LIVES, DT, GRACE, SERVE_TIMEOUT, POINT_PAUSE, clamp, lerp,
  SLAP_R, SLAP_CD, KNOCK_T, KNOCK_SPEED, DIZZY_T, SLAP_IMMUNE, SLIDE_SPEED, TURBO, SWING_WIN,
} from './constants.js';
import { ballFromSeg, stepBall, computeShot, paddleTouches, hittable } from './physics.js';
import { updateBot, queueSpot, predictHit, standSpot, nextWaypoint } from './bots.js';
import { T } from './tune.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const moveFlags = (p) => (p.dashT > 0 ? 1 : 0) | (p.slideT > 0 ? 2 : 0);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

export class Game {
  constructor(o) {
    this.isHost = o.isHost;
    this.localId = o.localId;
    this.net = o.net;          // { send(msg), broadcast(msg), sendTo(id,msg) } or null (practice)
    this.fx = o.fx;
    this.clock = o.clock || { offset: 0 };
    this.players = new Map();
    for (const d of o.players) this.addPlayer(d);
    this.q = { L: [], R: [] };
    this.phase = 'init';
    this.phaseStart = 0; this.phaseEnd = 0;
    this.serveEnd = -1; this.server = null;
    this.seg = null; this.ball = null; this.seq = 0;
    this.point = null; this.winner = null; this.duel = false;
    this.pending = null; this.pendingHit = 0;
    this.hist = [];
    this.arm = null;              // armed swing of the local player (click = hit)
    this.autoRun = false;         // local player is auto-running to the other end
    this.moveIntent = { x: 0, z: 0 };
    this.blockers = [];           // ids of players in the local player's way (slap prompt)
    this.netAcc = 0; this.pingAcc = 0; this.pings = 0;
    this.smooth = { x: 0, y: 0, z: 0 };
    this.ballView = { x: 0, y: TABLE_H + 0.3, z: 0, visible: false, held: false };
    this.prevNow = this.now();
    this.nowCache = this.prevNow;
    this.evcb = (type, b, info) => {
      const t = this.seg.t0 + b.step * DT / T.bt;
      if (this.nowCache - t < 0.15) this.fx.ballEvent(type, b.x, b.y, b.z, info, this.seg);
    };
  }

  now() { return performance.now() / 1000 + this.clock.offset; }
  get me() { return this.players.get(this.localId); }
  Q(end) { return end > 0 ? this.q.R : this.q.L; }

  addPlayer(d) {
    const p = {
      id: d.id, name: d.name, color: d.color, hat: d.hat, bot: !!d.bot, skill: d.skill ?? 0.7,
      lives: d.lives ?? LIVES, alive: d.alive ?? true, spectator: !!d.spectator,
      x: d.x ?? 0, z: d.z ?? 3, vx: 0, vz: 0, px: d.x ?? 0, py: TABLE_H + 0.16, pz: (d.z ?? 3) - 0.4,
      prevPx: 0, prevPz: 0, dashT: 0, dashCd: 0, dashX: 0, dashZ: 0,
      buf: [], speed: 0, hitAnim: 0, ai: null,
      // interaction: knock-back, dizziness, belly slide, slap animation (fx* are game-time stamps)
      kbT: 0, kbx: 0, kbz: 0, dizzyT: 0, slideT: 0, slideDir: 0, slapCd: 0, lastSlap: -9,
      fxDizzy: 0, fxImm: 0, slapAnim: 0, slapDx: 0, slapDz: 1, spinAnim: 0, revenge: null,
    };
    if (p.spectator) { p.alive = false; p.lives = 0; }
    p.prevPx = p.px; p.prevPz = p.pz;
    this.players.set(p.id, p);
    return p;
  }

  simulatedHere(p) { return p.id === this.localId || (this.isHost && p.bot); }

  // ------------------------------------------------------------------ host: match setup
  hostStart() {
    const ids = shuffle([...this.players.values()].filter((p) => p.alive && !p.spectator).map((p) => p.id));
    ids.forEach((id, i) => (i % 2 === 0 ? this.q.L : this.q.R).push(id));
    this.serveEnd = -1;
    this.duel = ids.length === 2;
    this.rebalance(this.serveEnd);
    this.server = this.Q(this.serveEnd)[0];
    const spawn = {};
    for (const end of [-1, 1]) this.Q(end).forEach((id, i) => { spawn[id] = queueSpot(end, i); });
    for (const p of this.players.values()) {
      if (!spawn[p.id]) spawn[p.id] = [(Math.random() - 0.5) * 6, ARENA_Z - 0.4];
      if (this.simulatedHere(p)) this.placePlayer(p, spawn[p.id]);
    }
    this.setPhase('countdown', 3.2);
    return spawn;
  }

  placePlayer(p, [x, z]) {
    p.x = x; p.z = z; p.vx = p.vz = 0;
    const tx = clamp(x, -HL, HL), tz = clamp(z, -HW, HW);
    const d = Math.hypot(tx - x, tz - z) || 1;
    p.px = p.prevPx = x + (tx - x) / d * 0.45; p.pz = p.prevPz = z + (tz - z) / d * 0.45;
    p.buf = [];
  }

  rebalance(E) {
    const all = [...this.q.L, ...this.q.R];
    const n = all.length;
    if (n < 2) return;
    const A = this.Q(E), B = this.Q(-E);
    if (this.duel) {
      while (A.length > 1) B.push(A.pop());
      while (B.length > 1) A.push(B.pop());
      return;
    }
    const want = Math.ceil(n / 2);
    while (A.length > want) B.push(A.pop());
    while (A.length < want) A.push(B.pop());
  }

  removeFromQueues(id) {
    for (const k of ['L', 'R']) { const i = this.q[k].indexOf(id); if (i >= 0) this.q[k].splice(i, 1); }
  }

  queuePos(id) {
    let i = this.q.L.indexOf(id); if (i >= 0) return { end: -1, idx: i };
    i = this.q.R.indexOf(id); if (i >= 0) return { end: 1, idx: i };
    return null;
  }

  setPhase(ph, dur = 0) {
    const prev = this.phase;
    this.phase = ph;
    this.phaseStart = this.now();
    this.phaseEnd = this.phaseStart + dur;
    if (prev !== ph || ph === 'serve') this.onPhaseChange(prev);
  }

  onPhaseChange(prev) {
    this.fx.phase(this.phase, prev, this);
  }

  // ------------------------------------------------------------------ host: referee
  startServe() {
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (alive.length <= 1) {
      this.winner = alive[0] ? alive[0].id : null;
      this.seg = null; this.ball = null;
      this.setPhase('over');
      this.broadcastState();
      return;
    }
    this.duel = alive.length === 2;
    // make sure everybody alive is queued (e.g. after reconnect weirdness)
    for (const p of alive) if (!this.queuePos(p.id)) this.Q(this.q.L.length <= this.q.R.length ? -1 : 1).push(p.id);
    if (this.Q(this.serveEnd).length === 0) this.serveEnd = -this.serveEnd;
    this.rebalance(this.serveEnd);
    this.server = this.Q(this.serveEnd)[0];
    this.seg = null; this.ball = null; this.pending = null;
    this.setPhase('serve');
    this.broadcastState();
  }

  validateHit(pid, seg) {
    if (seg.seq !== this.seq + 1) return false;
    if (this.phase === 'serve') return pid === this.server && !!seg.serve;
    if (this.phase !== 'rally' || !this.seg || !this.ball || this.seg.recv !== pid || seg.serve) return false;
    if (seg.t0 < this.seg.t0) return false;
    const b = this.ball;
    if (b.dead) {
      const td = this.seg.t0 + b.deadStep * DT / T.bt;
      if (seg.t0 > td + 0.04) return false;
    }
    return true;
  }

  acceptHit(pid, seg, fromNet) {
    if (!this.validateHit(pid, seg)) {
      if (fromNet && this.net) this.net.sendTo(pid, { type: 'reject', state: this.stateMsg() });
      return false;
    }
    const E = this.phase === 'serve' ? this.serveEnd : this.seg.need;
    seg.need = -E;
    this.removeFromQueues(pid);
    if (this.duel) this.Q(E).push(pid); else this.Q(-E).push(pid);
    const RQ = this.Q(-E);
    if (RQ[0] === pid) {
      const AQ = this.Q(E);
      if (AQ.length) RQ.unshift(AQ.pop());
    }
    seg.recv = RQ[0] === pid ? null : RQ[0];
    this.seq = seg.seq;
    this.setSeg(seg, !!fromNet);
    this.pending = null;
    const p = this.players.get(pid);
    if (p) p.hitAnim = 1;
    this.fx.hit(seg, p, !fromNet, this);
    if (this.phase !== 'rally') this.setPhase('rally');
    this.broadcastState();
    return true;
  }

  declarePoint() {
    const b = this.ball, seg = this.seg;
    const loserId = b.deadRole === 'hitter' ? seg.hitter : seg.recv;
    const p = this.players.get(loserId);
    let elim = false;
    if (p && p.alive) {
      p.lives = Math.max(0, p.lives - 1);
      if (p.lives <= 0) { p.alive = false; elim = true; this.removeFromQueues(p.id); }
    }
    this.point = { loser: loserId, reason: b.deadReason, elim, lives: p ? p.lives : 0, x: b.x, z: b.z, id: seg.seq };
    this.serveEnd = seg.need;
    this.setPhase('point', POINT_PAUSE + (elim ? 0.8 : 0));
    this.broadcastState();
  }

  autoServe(now) {
    const s = this.players.get(this.server);
    if (!s) return;
    const hb = this.heldBall(now);
    const f = -this.serveEnd;
    const shot = computeShot({ x: hb.x, y: hb.y, z: hb.z, vx: 0, vy: 0, vz: 0, pvx: f * 3, pvz: -hb.z * 2, end: this.serveEnd, spin: 'none', curve: 0, serve: true, assist: 2, spinScale: T.spin, maxSpeed: T.maxSpeed });
    const seg = { ...shot, seq: this.seq + 1, t0: now, hitter: s.id, recv: null, serve: true };
    this.fx.banner('⏰ Auto-serve!', 'small');
    this.acceptHit(s.id, seg, false);
  }

  handleLeave(id) {
    const p = this.players.get(id);
    if (!p) return;
    const wasActive = (this.phase === 'serve' && this.server === id) || (this.phase === 'rally' && this.seg && (this.seg.recv === id));
    p.alive = false; p.lives = 0;
    this.removeFromQueues(id);
    this.players.delete(id);
    this.fx.removed(id);
    if (!this.isHost) return;
    if (this.phase === 'over') return;
    const alive = [...this.players.values()].filter((q) => q.alive);
    if (wasActive || alive.length <= 1) {
      this.point = { loser: null, reason: `${p.name} left`, elim: false, lives: 0, x: 0, z: 0, id: -1 };
      this.setPhase('point', 1.5);
    }
    this.broadcastState();
  }

  hostRules(now) {
    if (this.phase === 'countdown' && now >= this.phaseEnd) this.startServe();
    else if (this.phase === 'point' && now >= this.phaseEnd) this.startServe();
    else if (this.phase === 'serve' && now - this.phaseStart > SERVE_TIMEOUT) this.autoServe(now);
    else if (this.phase === 'rally' && this.ball && this.ball.dead) {
      const td = this.seg.t0 + this.ball.deadStep * DT / T.bt;
      if (now - td > GRACE) this.declarePoint();
    } else if (this.phase === 'rally' && this.seg && !this.seg.recv && this.ball && !this.ball.dead && now - this.seg.t0 > 6) {
      this.ball.dead = true; this.ball.deadRole = 'hitter'; this.ball.deadReason = 'OUT!'; this.ball.deadStep = this.ball.step;
    }
  }

  stateMsg() {
    return {
      type: 'state', phase: this.phase, phaseStart: this.phaseStart, phaseEnd: this.phaseEnd,
      q: this.q, serveEnd: this.serveEnd, server: this.server, seq: this.seq, seg: this.seg,
      duel: this.duel, point: this.point, winner: this.winner,
      lives: [...this.players.values()].map((p) => [p.id, p.lives, p.alive]),
    };
  }

  broadcastState() { if (this.isHost && this.net) this.net.broadcast(this.stateMsg()); }

  // ------------------------------------------------------------------ guest: apply host state
  applyState(st, isReject) {
    if (!isReject && this.pendingHit && st.seq < this.pendingHit && (st.phase === 'rally' || st.phase === 'serve')) return;
    this.pendingHit = 0;
    const prevPhase = this.phase, prevPoint = this.point && this.point.id;
    this.phaseStart = st.phaseStart; this.phaseEnd = st.phaseEnd;
    this.q = st.q; this.serveEnd = st.serveEnd; this.server = st.server; this.seq = st.seq;
    this.duel = st.duel; this.point = st.point; this.winner = st.winner;
    for (const [id, lives, alive] of st.lives) { const p = this.players.get(id); if (p) { p.lives = lives; p.alive = alive; } }
    if (st.seg) {
      const cur = this.seg;
      const same = cur && cur.seq === st.seg.seq && cur.hitter === st.seg.hitter && cur.t0 === st.seg.t0;
      if (!same) {
        this.setSeg(st.seg, true);
        if (!cur || cur.seq !== st.seg.seq) {
          const hp = this.players.get(st.seg.hitter);
          if (hp) hp.hitAnim = 1;
          this.fx.hit(st.seg, hp, false, this);
        }
      } else cur.recv = st.seg.recv;
    } else { this.seg = null; this.ball = null; }
    this.phase = st.phase;
    if (prevPhase !== this.phase || (this.phase === 'point' && prevPoint !== (this.point && this.point.id))) this.onPhaseChange(prevPhase);
  }

  // ------------------------------------------------------------------ ball
  setSeg(seg, smooth) {
    const old = this.ballView.visible ? { x: this.ballView.x, y: this.ballView.y, z: this.ballView.z } : null;
    this.seg = seg;
    this.ball = ballFromSeg(seg);
    this.advanceBall(this.now(), true);
    if (smooth && old) {
      const nv = this.computeBallPos(this.now());
      this.smooth.x = old.x - nv.x; this.smooth.y = old.y - nv.y; this.smooth.z = old.z - nv.z;
      const m = Math.hypot(this.smooth.x, this.smooth.y, this.smooth.z);
      if (m > 1.2) this.smooth.x = this.smooth.y = this.smooth.z = 0;
    } else this.smooth.x = this.smooth.y = this.smooth.z = 0;
  }

  heldBall(now) {
    const s = this.players.get(this.server);
    const z = s ? clamp(s.z, -0.55, 0.55) : 0;
    return { x: this.serveEnd * (HL + 0.2), y: TABLE_H + 0.1 + 0.25 * Math.abs(Math.sin(now * 3.4)), z };
  }

  hitCandidate() {
    if (this.phase !== 'rally' || !this.seg || !this.ball || this.ball.dead || !this.seg.recv) return null;
    const r = this.players.get(this.seg.recv);
    if (r && r.alive && (r.id === this.localId || (this.isHost && r.bot))) return r;
    return null;
  }

  advanceBall(now, silent) {
    let guard = 0;
    while (this.ball && guard++ < 6000) {
      const seg = this.seg, b = this.ball;
      const target = Math.floor((now - seg.t0) * T.bt / DT);
      if (b.step >= target) break;
      stepBall(b, silent ? null : this.evcb);
      if (silent) continue;
      const cand = this.hitCandidate();
      if (cand && hittable(b, T.volley)) {
        const ts = seg.t0 + b.step * DT / T.bt;
        const u = clamp((ts - this.prevNow) / Math.max(1e-4, now - this.prevNow), 0, 1);
        const px = lerp(cand.prevPx, cand.px, u), pz = lerp(cand.prevPz, cand.pz, u);
        // a click "arms" the swing: the paddle then reaches further and hits a clean shot
        const armed = cand.id === this.localId && this.armed(ts);
        if (paddleTouches(px, pz, b.x, b.y, b.z, T.paddleR + (armed ? T.clickR : 0))) {
          this.makeHit(cand, ts, b, false, armed ? this.clickSwing(cand, b, false) : null);
        }
      }
    }
  }

  checkServe(now) {
    if (this.phase !== 'serve' || !this.server) return;
    const s = this.players.get(this.server);
    if (!s || !s.alive || !(s.id === this.localId || (this.isHost && s.bot))) return;
    const hb = this.heldBall(now);
    const f = -this.serveEnd;
    if (s.id === this.localId) {
      if (this.armed(now) && s.x * this.serveEnd > HL - 0.3) {
        for (let k = 1; k <= 4; k++) {
          const u = k / 4;
          const px = lerp(s.prevPx, s.px, u), pz = lerp(s.prevPz, s.pz, u);
          if (paddleTouches(px, pz, hb.x, hb.y, hb.z, T.paddleR + T.clickR)) {
            this.makeHit(s, lerp(this.prevNow, now, u), { x: hb.x, y: hb.y, z: hb.z, vx: 0, vy: 0, vz: 0, need: f }, true, this.clickSwing(s, hb, true));
            return;
          }
        }
      }
      const sw = this.swingInfo();
      if (sw.pvx * f < (T.assist >= 2 ? 0.25 : 0.7)) return;
    } else if (!(s.ai && s.ai.plan && s.ai.plan.serve)) return;
    for (let k = 1; k <= 4; k++) {
      const u = k / 4;
      const px = lerp(s.prevPx, s.px, u), pz = lerp(s.prevPz, s.pz, u);
      if (paddleTouches(px, pz, hb.x, hb.y, hb.z, T.paddleR)) {
        this.makeHit(s, lerp(this.prevNow, now, u), { x: hb.x, y: hb.y, z: hb.z, vx: 0, vy: 0, vz: 0, need: f }, true);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ click = swing
  armSwing(spin, now) {
    this.arm = { from: this.prevNow - 0.02, until: now + SWING_WIN, t: now, spin };
  }

  armed(t) { return !!this.arm && t >= this.arm.from && t <= this.arm.until; }

  // the next player who will receive at that end (for "smart" aiming)
  likelyReceiver(end, exceptId) {
    const id = this.Q(end).find((i) => i !== exceptId);
    return id ? this.players.get(id) : null;
  }

  // A clean, beginner friendly shot for a clicked swing: solid drive with topspin (or a backspin
  // chop with right click), a smash on high balls. A sideways swipe aims, otherwise it goes
  // to the side of the table away from the next receiver.
  clickSwing(p, b, serve) {
    const E = serve ? this.serveEnd : b.need, f = -E;
    const sw = this.swingInfo();
    const spin = this.arm ? this.arm.spin : 'top';
    const push = Math.max(0, sw.pvx * f);
    const high = !serve && b.y > TABLE_H + 0.32;
    let fwd;
    if (serve) fwd = 3.2 + Math.min(2.5, push * 0.25);
    else if (high && spin !== 'back') fwd = 9.5;
    else fwd = (spin === 'back' ? 3.0 : 4.6) + Math.min(4, push * 0.35);
    let pvz;
    if (Math.abs(sw.pvz) > 1.5) pvz = clamp(sw.pvz, -9, 9);
    else {
      const opp = this.likelyReceiver(-E, p.id);
      const zLand = opp && Math.abs(opp.z) > 0.08 ? (opp.z > 0 ? -0.4 : 0.4) : (Math.random() < 0.5 ? -0.35 : 0.35);
      if (serve) {
        const s = 2.7 + 0.42 * fwd;
        pvz = clamp(s * (zLand - b.z) / (HL * 2) / 0.3, -6, 6);
      } else {
        const s = 2.8 + 0.16 * Math.hypot(b.vx || 0, b.vz || 0) + 0.55 * fwd;
        const D = Math.abs(f * 0.9 - b.x) + 0.01;
        pvz = clamp((s * (zLand - b.z) / D - 0.2 * (b.vz || 0)) / 0.3, -9, 9);
      }
    }
    return { pvx: f * fwd, pvz, spin, curve: 0 };
  }

  makeHit(p, t, b, serve, swOverride) {
    const E = serve ? this.serveEnd : b.need; // hitter stands on the side the ball had to land on
    const sw = swOverride || (p.id === this.localId ? this.swingInfo() : (p.ai && p.ai.swing) || { pvx: -E * 3, pvz: 0, spin: 'none', curve: 0 });
    if (p.id === this.localId) this.arm = null;
    const shot = computeShot({
      x: b.x, y: b.y, z: b.z, vx: serve ? 0 : b.vx, vy: serve ? 0 : b.vy, vz: serve ? 0 : b.vz,
      pvx: sw.pvx, pvz: sw.pvz, end: E, spin: sw.spin, curve: sw.curve, serve,
      assist: p.bot ? 0 : T.assist, spinScale: T.spin, maxSpeed: T.maxSpeed,
    });
    const seg = { ...shot, seq: this.seq + 1, t0: t, hitter: p.id, recv: null, serve: !!serve };
    p.hitAnim = 1;
    if (this.isHost) { this.acceptHit(p.id, seg, false); return; }
    // guest: optimistic, the host will confirm or reject
    this.pendingHit = seg.seq;
    this.seq = seg.seq;
    this.setSeg(seg, false);
    if (this.phase === 'serve') { this.phase = 'rally'; }
    this.net.send({ type: 'hit', seg });
    this.fx.hit(seg, p, true, this);
  }

  computeBallPos(now) {
    const b = this.ball;
    const tb = this.seg.t0 + b.step * DT / T.bt;
    const ex = b.frozen ? 0 : clamp(now - tb, 0, 0.03) * T.bt;
    return { x: b.x + b.vx * ex, y: Math.max(0.034, b.y + b.vy * ex), z: b.z + b.vz * ex };
  }

  updateBallView(now, dt) {
    const v = this.ballView;
    const k = Math.exp(-dt / 0.09);
    this.smooth.x *= k; this.smooth.y *= k; this.smooth.z *= k;
    if ((this.phase === 'serve' || this.phase === 'countdown') && this.server) {
      const h = this.heldBall(now);
      v.x = h.x; v.y = h.y; v.z = h.z; v.visible = true; v.held = true;
    } else if (this.ball) {
      const p = this.computeBallPos(now);
      v.x = p.x + this.smooth.x; v.y = p.y + this.smooth.y; v.z = p.z + this.smooth.z;
      v.visible = this.phase !== 'over'; v.held = false;
    } else v.visible = false;
  }

  // ------------------------------------------------------------------ movement
  integrateBody(p, tvx, tvz, dt, ghost) {
    if (p.slideT > 0 && !ghost) {
      // belly slide straight under the table, through everybody's legs
      p.slideT -= dt;
      p.vx = p.slideDir * SLIDE_SPEED;
      p.vz = (clamp(p.z, -0.4, 0.4) - p.z) * 8;
      p.x += p.vx * dt; p.z += p.vz * dt;
      if (p.x * p.slideDir > HL + 0.85 || p.slideT <= 0) { p.slideT = 0; p.vx *= 0.5; }
      p.x = clamp(p.x, -ARENA_X, ARENA_X);
      p.speed = SLIDE_SPEED;
      return;
    }
    if (p.kbT > 0) {
      p.kbT -= dt;
      const kk = Math.max(0, p.kbT) / KNOCK_T;
      tvx = p.kbx * KNOCK_SPEED * (0.3 + kk); tvz = p.kbz * KNOCK_SPEED * (0.3 + kk);
    } else if (p.dashT > 0) { p.dashT -= dt; tvx = p.dashX * DASH_SPEED; tvz = p.dashZ * DASH_SPEED; }
    if (p.dizzyT > 0) { p.dizzyT -= dt; if (!(p.kbT > 0)) { tvx *= 0.35; tvz *= 0.35; } }
    const k = 1 - Math.exp(-14 * dt);
    p.vx += (tvx - p.vx) * k; p.vz += (tvz - p.vz) * k;
    p.x += p.vx * dt; p.z += p.vz * dt;
    if (!ghost) {
      const ex = HL + BODY_R, ez = HW + BODY_R + 0.05;
      if (Math.abs(p.x) < ex && Math.abs(p.z) < ez) {
        const ox = ex - Math.abs(p.x), oz = ez - Math.abs(p.z);
        if (ox < oz) { p.x = Math.sign(p.x || 1) * ex; p.vx = 0; } else { p.z = Math.sign(p.z || 1) * ez; p.vz = 0; }
      }
      const active = this.isActive(p.id);
      for (const o of this.players.values()) {
        if (o === p || !o.alive || o.slideT > 0) continue;
        const dx = p.x - o.x, dz = p.z - o.z;
        const d = Math.hypot(dx, dz), m = BODY_R * 1.85;
        if (d < m && d > 1e-4) {
          let share = this.simulatedHere(o) ? 0.5 : 1;
          if (active) share = 0.1; else if (this.isActive(o.id)) share = 1;
          p.x += dx / d * (m - d) * share; p.z += dz / d * (m - d) * share;
        }
      }
    }
    p.x = clamp(p.x, -ARENA_X, ARENA_X); p.z = clamp(p.z, -ARENA_Z, ARENA_Z);
    p.speed = Math.hypot(p.vx, p.vz);
  }

  isActive(id) {
    return (this.phase === 'serve' && this.server === id) || (this.phase === 'rally' && this.seg && this.seg.recv === id);
  }

  // which end of the table this player has to be at (0 = none)
  targetEnd(p) {
    if (this.phase === 'serve' && this.server === p.id) return this.serveEnd;
    if (this.phase === 'rally' && this.seg && this.seg.recv === p.id) return this.seg.need;
    const qp = this.queuePos(p.id);
    return qp ? qp.end : 0;
  }

  // standing at the wrong end, near the table: you may belly-slide under it to the other side
  canSlide(p) {
    if (!p || !p.alive || p.slideT > 0 || p.kbT > 0 || p.dizzyT > 0 || this.phase === 'over') return false;
    if (this.phase === 'rally' && this.isActive(p.id)) return false;
    const te = this.targetEnd(p);
    if (!te || p.x * te >= 0) return false;
    const ax = Math.abs(p.x);
    return ax > HL - 0.05 && ax < HL + 1.3 && Math.abs(p.z) < HW + 0.25;
  }

  startSlide(p) {
    p.slideT = 1.5; p.slideDir = this.targetEnd(p); p.dashT = 0;
    this.fx.slide(p, this);
  }

  // ------------------------------------------------------------------ slaps
  slappable(o) {
    return !!o && o.alive && !o.spectator && !this.isActive(o.id) && this.nowCache >= o.fxImm && !(o.slideT > 0);
  }

  // nearest player in reach, preferring the one in the direction of the paddle
  slapTarget(p, preferId, strict) {
    let best = null, bs = Infinity;
    const ax = p.px - p.x, az = p.pz - p.z, al = Math.hypot(ax, az) || 1;
    for (const o of this.players.values()) {
      if (o === p || !this.slappable(o)) continue;
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
      if (d > SLAP_R) continue;
      if (preferId && o.id === preferId) return o;
      if (strict) continue;
      const dot = d > 1e-3 ? (dx * ax + dz * az) / (d * al) : 1;
      const sc = d - dot * 0.5;
      if (sc < bs) { bs = sc; best = o; }
    }
    return best;
  }

  // the protected player (whose turn it is) is in reach: tell the slapper why nothing happens
  shieldNear(p) {
    for (const o of this.players.values()) {
      if (o !== p && o.alive && this.isActive(o.id) && Math.hypot(o.x - p.x, o.z - p.z) <= SLAP_R) return o;
    }
    return null;
  }

  trySlap(p, preferId, strict) {
    if (!p || !p.alive || p.slapCd > 0 || p.dizzyT > 0 || p.slideT > 0) return false;
    const o = this.slapTarget(p, preferId, strict);
    if (!o) return false;
    p.slapCd = SLAP_CD;
    let dx = o.x - p.x, dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) { dx = 0; dz = 1; } else { dx /= d; dz /= d; }
    if (this.isHost) this.hostSlap(p.id, o.id, dx, dz, false);
    else {
      this.net.send({ type: 'slap', to: o.id, dx: r3(dx), dz: r3(dz) });
      this.onSlap(p.id, o.id, dx, dz); // predicted: the host confirms to everybody else
    }
    return true;
  }

  // host = referee for slaps too
  hostSlap(fromId, toId, dx, dz, fromNet) {
    const a = this.players.get(fromId), b = this.players.get(toId);
    if (!a || !b || !a.alive || !this.slappable(b)) return;
    if (fromNet) {
      if (Math.hypot(a.x - b.x, a.z - b.z) > SLAP_R + 0.9) return;
      if (this.nowCache < a.lastSlap + SLAP_CD * 0.7) return;
      if (!isFinite(dx) || !isFinite(dz) || Math.hypot(dx, dz) < 0.01) { dx = b.x - a.x; dz = b.z - a.z; }
      const l2 = Math.hypot(dx, dz) || 1; dx /= l2; dz /= l2;
    }
    a.lastSlap = this.nowCache;
    this.onSlap(fromId, toId, dx, dz);
    if (this.net) this.net.broadcast({ type: 'slap', from: fromId, to: toId, dx: r3(dx), dz: r3(dz) });
  }

  // runs on every peer: effects for everybody, knock-back where the victim is simulated
  onSlap(fromId, toId, dx, dz) {
    const a = this.players.get(fromId), b = this.players.get(toId);
    if (!b) return;
    const now = this.nowCache;
    b.fxDizzy = now + DIZZY_T; b.fxImm = now + SLAP_IMMUNE; b.spinAnim = 1;
    if (a) { a.slapAnim = 1; a.slapDx = dx; a.slapDz = dz; a.hitAnim = Math.max(a.hitAnim, 0.7); }
    if (this.simulatedHere(b)) {
      b.kbT = KNOCK_T; b.kbx = dx; b.kbz = dz; b.dizzyT = DIZZY_T;
      b.vx = dx * KNOCK_SPEED * 1.3; b.vz = dz * KNOCK_SPEED * 1.3;
      b.dashT = 0; b.slideT = 0;
      if (b.bot && a && Math.random() < 0.4) b.revenge = { id: a.id, t: now + DIZZY_T + 0.15 + Math.random() * 0.5 };
    }
    this.fx.slap(a, b, this);
  }

  // players standing in the local player's way (they get a 👋 prompt)
  computeBlockers() {
    const p = this.me;
    this.blockers.length = 0;
    if (!p || !p.alive || this.phase === 'over') return;
    const mi = this.moveIntent, ml = Math.hypot(mi.x, mi.z);
    const active = this.isActive(p.id);
    for (const o of this.players.values()) {
      if (o === p || !this.slappable(o)) continue;
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
      if (d > 0.95) continue;
      if ((active && d < 0.9) || (ml > 0.3 && (dx * mi.x + dz * mi.z) / ((d || 1) * ml) > 0.55)) this.blockers.push(o.id);
    }
  }

  updateLocal(dt, input, realT) {
    const p = this.me;
    if (!p) return;
    const now = this.nowCache;
    // keys move you relative to the camera (W = away from the camera)
    const k = input.keys || {};
    const kx = (k.right ? 1 : 0) - (k.left ? 1 : 0), ky = (k.up ? 1 : 0) - (k.down ? 1 : 0);
    const B = input.basis || { fx: 0, fz: -1, rx: 1, rz: 0 };
    let ix = B.rx * kx + B.fx * ky, iz = B.rz * kx + B.fz * ky;
    const len = Math.hypot(ix, iz);
    if (len) { ix /= len; iz /= len; }
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.slapCd = Math.max(0, p.slapCd - dt);
    const te = this.targetEnd(p);
    const switching = p.alive && !!te && p.x * te < HL - 0.2;
    if (switching && !this.isActive(p.id)) this.autoRun = true;
    if (len || !p.alive) this.autoRun = false;
    if (input.dash) {
      input.dash = false;
      // SPACE: slide under the table when you need to change ends, otherwise a quick dash
      if (this.canSlide(p)) this.startSlide(p);
      else if (p.dashCd <= 0 && len && !(p.dizzyT > 0) && !(p.slideT > 0)) { p.dashT = DASH_TIME; p.dashCd = DASH_CD; p.dashX = ix; p.dashZ = iz; this.fx.dash(p); }
    }
    // Auto-walk when you don't touch the keys: Easy walks you everywhere (mouse-only play),
    // every level runs you to the other end after your hit. Keys always take over.
    if (!len && p.alive && this.phase !== 'over') {
      let goal = null;
      if (this.isActive(p.id)) {
        if (T.autoMove && this.phase === 'rally' && this.pred && this.pred.hit) goal = standSpot(this.pred.hit.x, this.pred.hit.z, this.seg.need, p.x, p.z);
        else if (this.phase === 'serve' && (T.autoMove || switching)) goal = [this.serveEnd * (HL + 0.55), clamp(p.z, -0.5, 0.5)];
      } else if (T.autoMove || (T.autoSwitch && this.autoRun)) {
        const qp = this.queuePos(p.id);
        if (qp) {
          goal = queueSpot(qp.end, qp.idx);
          if (T.autoSlide && qp.idx <= 1 && this.canSlide(p)) this.startSlide(p);
        }
      }
      if (goal) {
        const gd = Math.hypot(goal[0] - p.x, goal[1] - p.z);
        if (gd > 0.12) {
          const [wx, wz] = nextWaypoint(p.x, p.z, goal[0], goal[1]);
          const dd = Math.hypot(wx - p.x, wz - p.z) || 1, sp = Math.min(1, gd * 3);
          ix = (wx - p.x) / dd * sp; iz = (wz - p.z) / dd * sp;
        } else if (!switching) this.autoRun = false;
      }
    }
    this.moveIntent.x = ix; this.moveIntent.z = iz;
    // turbo shoes while you change ends
    const speed = T.run * (switching ? TURBO : 1);
    this.integrateBody(p, ix * speed, iz * speed, dt, !p.alive);
    // paddle follows the mouse (within arm reach)
    if (input.mouse) {
      let dx = input.mouse.x - p.x, dz = input.mouse.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > T.reach) { dx *= T.reach / d; dz *= T.reach / d; }
      else if (d < 0.25) { const s = d > 1e-3 ? 0.25 / d : 0; dx = d > 1e-3 ? dx * s : 0; dz = d > 1e-3 ? dz * s : -0.25; }
      p.px = p.x + dx; p.pz = p.z + dz;
    }
    this.hist.push({ t: realT, x: p.px, z: p.pz });
    while (this.hist.length > 2 && realT - this.hist[0].t > 0.3) this.hist.shift();
    // auto paddle height: follows the ball when it's your turn
    const bv = this.ballView;
    let ty = TABLE_H + 0.16;
    if (bv.visible && this.isActive(p.id) && Math.hypot(bv.x - p.px, bv.z - p.pz) < 1.6) ty = clamp(bv.y, TABLE_H - 0.25, TABLE_H + 1.15);
    p.py += (ty - p.py) * Math.min(1, dt * 22);
    this.spinMode = input.spin;

    // LEFT click = swing at the ball (holding it keeps the swing armed)
    // RIGHT click = slap the player in reach; with nobody to slap it swings with backspin
    if (p.alive) {
      if (input.swing) {
        input.swing = false;
        this.armSwing('top', now);
        p.hitAnim = Math.max(p.hitAnim, 0.6);
        this.fx.swing(p);
      }
      if (input.slap) {
        input.slap = false;
        if (!this.trySlap(p)) {
          const sh = this.shieldNear(p);
          if (sh && !this.slapTarget(p)) this.fx.shield(sh, this);
          this.armSwing('back', now);
          p.hitAnim = Math.max(p.hitAnim, 0.6);
          this.fx.swing(p);
        }
      }
      if (this.arm) {
        if ((input.lmb && this.arm.spin === 'top') || (input.rmb && this.arm.spin === 'back')) this.arm.until = Math.max(this.arm.until, now + 0.05);
        else if (now > this.arm.until) {
          // tell beginners why the swing missed
          const pr = this.pred && this.pred.hit;
          // the ball is still coming = clicked too early; it already went by = paddle was too far
          if (pr && this.isActive(p.id) && this.ball && !this.ball.dead) this.fx.early(p, this, now < pr.t ? 'early' : 'far');
          this.arm = null;
        }
      }
    } else { input.swing = input.slap = false; this.arm = null; }
  }

  sampleHist(t) {
    const h = this.hist;
    if (t <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1], b = h[i], u = (t - a.t) / Math.max(1e-5, b.t - a.t);
        return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u) };
      }
    }
    return h[0];
  }

  swingInfo() {
    const h = this.hist;
    const spin = this.spinMode || 'none';
    if (h.length < 3) return { pvx: 0, pvz: 0, curve: 0, spin };
    const tn = h[h.length - 1].t, W = 0.05;
    const a = h[h.length - 1], b = this.sampleHist(tn - W), c = this.sampleHist(tn - 2 * W);
    const v2x = (a.x - b.x) / W, v2z = (a.z - b.z) / W;
    const v1x = (b.x - c.x) / W, v1z = (b.z - c.z) / W;
    let curve = 0;
    const s1 = Math.hypot(v1x, v1z), s2 = Math.hypot(v2x, v2z);
    if (s1 > 1.5 && s2 > 1.5) curve = clamp(Math.atan2(v1x * v2z - v1z * v2x, v1x * v2x + v1z * v2z) / W, -25, 25);
    return { pvx: clamp(v2x, -16, 16), pvz: clamp(v2z, -16, 16), curve, spin };
  }

  // ------------------------------------------------------------------ remote interpolation
  pushRemote(id, t, x, z, px, py, pz, d) {
    const p = this.players.get(id);
    if (!p || this.simulatedHere(p)) return;
    const b = p.buf;
    if (b.length && t <= b[b.length - 1].t) return;
    b.push({ t, x, z, px, py, pz, d });
    if (b.length > 40) b.shift();
  }

  interpRemote(p, rt, dt) {
    const b = p.buf;
    if (!b.length) return;
    while (b.length > 2 && b[1].t <= rt) b.shift();
    let s;
    if (b.length === 1 || rt <= b[0].t) s = b[0];
    else {
      const a = b[0], c = b[1];
      const u = clamp((rt - a.t) / Math.max(1e-4, c.t - a.t), 0, 1.25);
      s = { x: lerp(a.x, c.x, u), z: lerp(a.z, c.z, u), px: lerp(a.px, c.px, u), py: lerp(a.py, c.py, u), pz: lerp(a.pz, c.pz, u), d: c.d };
    }
    const ox = p.x, oz = p.z;
    p.x = s.x; p.z = s.z; p.px = s.px; p.py = s.py; p.pz = s.pz;
    // flags: 1 = dashing, 2 = sliding under the table
    p.dashT = s.d & 1 ? 0.05 : 0;
    p.slideT = s.d & 2 ? 0.05 : 0;
    if (dt > 0) { p.vx = (p.x - ox) / dt; p.vz = (p.z - oz) / dt; p.speed = p.speed * 0.8 + Math.hypot(p.vx, p.vz) * 0.2; }
  }

  // ------------------------------------------------------------------ network in
  onNet(from, m) {
    switch (m.type) {
      case 'in':
        if (this.isHost) this.pushRemote(from, m.t, m.x, m.z, m.px, m.py, m.pz, m.d);
        break;
      case 'snap':
        for (const e of m.p) if (e[0] !== this.localId) this.pushRemote(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7]);
        break;
      case 'hit':
        if (this.isHost) this.acceptHit(from, m.seg, true);
        break;
      case 'state':
        if (!this.isHost) this.applyState(m, false);
        break;
      case 'reject':
        if (!this.isHost) this.applyState(m.state, true);
        break;
      case 'slap':
        if (this.isHost) this.hostSlap(from, m.to, +m.dx, +m.dz, true);
        else if (m.from !== this.localId) this.onSlap(m.from, m.to, m.dx, m.dz);
        break;
    }
  }

  // ------------------------------------------------------------------ main tick
  update(dt, input, realT) {
    const now = this.now();
    this.nowCache = now;
    // remember paddle positions of last frame (for swept hit tests)
    for (const p of this.players.values()) {
      p.prevPx = p.px; p.prevPz = p.pz; p.hitAnim = Math.max(0, p.hitAnim - dt * 3);
      p.slapAnim = Math.max(0, p.slapAnim - dt * 3.2); p.spinAnim = Math.max(0, p.spinAnim - dt * 1.8);
    }

    this.updateLocal(dt, input, realT);
    this.computeBlockers();
    if (this.isHost) for (const p of this.players.values()) if (p.bot) updateBot(this, p, dt, now);
    const rt = now - (this.isHost ? 0.07 : 0.1);
    for (const p of this.players.values()) if (!this.simulatedHere(p)) this.interpRemote(p, rt, dt);

    this.checkServe(now);
    this.advanceBall(now, false);
    this.updatePrediction();
    if (this.isHost) this.hostRules(now);
    this.updateBallView(now, dt);
    this.prevNow = now;

    // network out
    if (this.net) {
      this.netAcc += dt;
      if (this.isHost && this.netAcc >= 0.05) {
        this.netAcc = 0;
        const list = [];
        for (const p of this.players.values()) {
          if (this.simulatedHere(p)) list.push([p.id, r3(now), r3(p.x), r3(p.z), r3(p.px), r3(p.py), r3(p.pz), moveFlags(p)]);
          else if (p.buf.length) { const s = p.buf[p.buf.length - 1]; list.push([p.id, s.t, s.x, s.z, s.px, s.py, s.pz, s.d]); }
        }
        this.net.broadcast({ type: 'snap', p: list });
      } else if (!this.isHost && this.netAcc >= 1 / 30) {
        this.netAcc = 0;
        const p = this.me;
        if (p) this.net.send({ type: 'in', t: r3(now), x: r3(p.x), z: r3(p.z), px: r3(p.px), py: r3(p.py), pz: r3(p.pz), d: moveFlags(p) });
      }
    }
  }

  // exact look-ahead of the incoming ball for the local player (🎯 target + auto-step)
  updatePrediction() {
    const me = this.me;
    const mine = me && me.alive && this.phase === 'rally' && this.seg && this.seg.recv === this.localId && this.ball && !this.ball.dead;
    if (!mine || !(T.guide || T.autoMove)) { this.pred = null; this.predKey = ''; return; }
    const key = this.seg.seq + ':' + this.seg.t0;
    if (key !== this.predKey) { this.predKey = key; this.pred = predictHit(this.ball, this.seg.t0); }
  }

  // ------------------------------------------------------------------ hud helpers
  statusFor(id) {
    const p = this.players.get(id);
    if (!p) return { kind: 'none' };
    if (p.spectator) return { kind: 'spectator' };
    if (!p.alive) return { kind: 'out' };
    const qp = this.queuePos(id);
    if (this.phase === 'serve' && this.server === id) return { kind: 'serve', end: this.serveEnd };
    if (this.phase === 'rally' && this.seg && this.seg.recv === id) return { kind: 'shot', end: this.seg.need };
    if (!qp) return { kind: 'wait' };
    return { kind: 'queue', end: qp.end, idx: qp.idx };
  }
}
