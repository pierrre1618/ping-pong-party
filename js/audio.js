// Tiny synthesized sound kit (no audio files needed).
let ctx = null, master = null, muted = false, noiseBuf = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) { ctx = null; }
}

export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.55; }
export const isMuted = () => muted;

function tone(type, f0, f1, dur, vol, delay = 0) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, vol, freq, q = 1, delay = 0, type = 'bandpass', sweepTo) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t); s.stop(t + dur + 0.02);
}

export const sfx = {
  paddle(power = 0.5) {
    const p = Math.min(1, power);
    tone('sine', 900 + p * 500, 380, 0.07, 0.5 + p * 0.3);
    noise(0.03, 0.35 + p * 0.3, 2500, 1.2);
    if (p > 0.75) noise(0.18, 0.25, 1800, 0.7, 0, 'bandpass', 400);
  },
  table(v = 2) {
    const k = Math.min(1, v / 4);
    tone('sine', 1500, 700, 0.045, 0.22 + 0.25 * k);
    noise(0.02, 0.2 * k + 0.05, 4200, 2);
  },
  floor(v = 2) { tone('sine', 520, 260, 0.06, Math.min(0.25, 0.05 + v * 0.05)); },
  net() { tone('triangle', 200, 90, 0.12, 0.35); noise(0.08, 0.15, 600, 0.8); },
  whoosh() { noise(0.22, 0.25, 400, 0.6, 0, 'bandpass', 2400); },
  lifeLost() {
    tone('sawtooth', 420, 300, 0.22, 0.18);
    tone('sawtooth', 320, 180, 0.4, 0.18, 0.22);
  },
  elim() {
    tone('square', 300, 280, 0.15, 0.13); tone('square', 250, 240, 0.15, 0.13, 0.17);
    tone('square', 200, 60, 0.6, 0.15, 0.34);
  },
  beep(hi) { tone('square', hi ? 1046 : 523, hi ? 1046 : 523, hi ? 0.35 : 0.12, 0.12); },
  win() {
    [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone('square', f, f, i === 5 ? 0.5 : 0.13, 0.12, i * 0.13));
    noise(1.2, 0.08, 3000, 0.4, 0.2, 'highpass');
  },
  pop() { tone('sine', 400, 1200, 0.09, 0.25); },
  boing() { tone('sine', 180, 520, 0.18, 0.3); tone('sine', 520, 200, 0.2, 0.2, 0.15); },
  turn() { tone('sine', 880, 880, 0.08, 0.15); tone('sine', 1320, 1320, 0.12, 0.15, 0.09); },
  swing() { noise(0.12, 0.16, 700, 0.8, 0, 'bandpass', 2200); },
  slap() {
    noise(0.08, 0.75, 2600, 0.7, 0, 'highpass');
    tone('triangle', 260, 90, 0.13, 0.35);
    [0.12, 0.2, 0.28].forEach((d, i) => tone('sine', 1500 - i * 180, 1350 - i * 180, 0.07, 0.07, d)); // dizzy "tweet tweet"
  },
  slide() { noise(0.42, 0.22, 900, 0.7, 0, 'bandpass', 300); tone('sine', 300, 760, 0.22, 0.14); },
};
