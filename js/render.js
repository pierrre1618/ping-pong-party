import * as THREE from '../vendor/three.module.min.js';
import {
  TABLE_L, TABLE_W, TABLE_H, NET_H, HL, HW, NET_OVER, BALL_R, PADDLE_R, RUN_SPEED,
  END_COLOR, clamp, lerp,
} from './constants.js';
import { nextWaypoint, queueSpot } from './bots.js';
import { hittable } from './physics.js';
import { T } from './tune.js';

const INK = 0x24193d;
const D2R = Math.PI / 180;
export const CAM_MODES = ['behind', 'table', 'first'];
const wrapA = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

// ---------------------------------------------------------------- helpers
function makeGradient() {
  const data = new Uint8Array([90, 170, 255]);
  const t = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
const GRAD = makeGradient();
const matCache = new Map();
function toon(color, opts = {}) {
  if (opts.unique || opts.params) return new THREE.MeshToonMaterial({ color, gradientMap: GRAD, ...(opts.params || {}) });
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshToonMaterial({ color, gradientMap: GRAD }));
  return matCache.get(color);
}
function outlineMat(thick) {
  const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.thick = { value: thick };
    sh.vertexShader = 'uniform float thick;\n' + sh.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normal * thick;');
  };
  m.customProgramCacheKey = () => 'outline';
  return m;
}
const OUT_THIN = outlineMat(0.012);
const OUT_MED = outlineMat(0.018);
function withOutline(mesh, mat = OUT_MED) {
  const o = new THREE.Mesh(mesh.geometry, mat);
  o.raycast = () => {};
  mesh.add(o);
  return mesh;
}
function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
function lighten(hex, k) { const c = new THREE.Color(hex); c.lerp(new THREE.Color('#ffffff'), k); return '#' + c.getHexString(); }
function darken(hex, k) { const c = new THREE.Color(hex); c.lerp(new THREE.Color('#000000'), k); return '#' + c.getHexString(); }
function angLerp(a, b, t) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }
function heartPath(g, x, y, s) {
  g.beginPath();
  g.moveTo(x, y + s * 0.3);
  g.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
  g.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.75, x, y + s);
  g.bezierCurveTo(x, y + s * 0.75, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
  g.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
  g.closePath();
}

// ---------------------------------------------------------------- character
const HAT_COLORS = ['#ff4d6d', '#ffd23f', '#3bceac', '#5465ff', '#ff9f1c', '#ffffff'];

function buildHat(type, color) {
  const g = new THREE.Group();
  const accent = HAT_COLORS[(color.charCodeAt(2) + type.length) % HAT_COLORS.length];
  const top = 0.86;
  switch (type) {
    case 'cap': {
      const dome = mesh(new THREE.SphereGeometry(0.205, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon(accent), 0, top - 0.12, 0);
      dome.scale.y = 0.75;
      const brim = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.025, 18), toon(accent), 0, top - 0.11, 0.17);
      brim.scale.set(1, 1, 0.8);
      g.add(withOutline(dome, OUT_THIN), withOutline(brim, OUT_THIN));
      break;
    }
    case 'party': {
      const cone = mesh(new THREE.ConeGeometry(0.11, 0.3, 18), toon(accent), 0, top + 0.1, 0);
      cone.rotation.z = 0.15;
      const pom = mesh(new THREE.SphereGeometry(0.045, 10, 8), toon(lighten(accent, 0.5)), -0.035, top + 0.26, 0);
      g.add(withOutline(cone, OUT_THIN), withOutline(pom, OUT_THIN));
      break;
    }
    case 'crown': {
      const band = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 14, 1, true), toon('#ffcf33', { params: { side: THREE.DoubleSide } }), 0, top + 0.01, 0);
      g.add(withOutline(band, OUT_THIN));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const sp = mesh(new THREE.ConeGeometry(0.035, 0.09, 6), toon('#ffcf33'), Math.cos(a) * 0.12, top + 0.09, Math.sin(a) * 0.12);
        g.add(sp);
        const gem = mesh(new THREE.SphereGeometry(0.02, 8, 6), toon('#ff3e6c'), Math.cos(a) * 0.132, top + 0.01, Math.sin(a) * 0.132);
        g.add(gem);
      }
      break;
    }
    case 'propeller': {
      const dome = mesh(new THREE.SphereGeometry(0.17, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), toon(accent), 0, top - 0.06, 0);
      dome.scale.y = 0.6;
      const stick = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6), toon('#333344'), 0, top + 0.06, 0);
      const prop = new THREE.Group(); prop.position.y = top + 0.12; prop.name = 'prop';
      prop.add(withOutline(mesh(new THREE.BoxGeometry(0.34, 0.012, 0.06), toon('#ff4d6d')), OUT_THIN));
      prop.add(withOutline(mesh(new THREE.BoxGeometry(0.06, 0.012, 0.34), toon('#ffd23f')), OUT_THIN));
      g.add(withOutline(dome, OUT_THIN), stick, prop);
      break;
    }
    case 'tophat': {
      const brim = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 20), toon('#2b2b3a'), 0, top - 0.02, 0);
      const cyl = mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.24, 18), toon('#2b2b3a'), 0, top + 0.1, 0);
      const band = mesh(new THREE.CylinderGeometry(0.133, 0.133, 0.05, 18), toon('#ff4d6d'), 0, top + 0.02, 0);
      g.add(withOutline(brim, OUT_THIN), withOutline(cyl, OUT_THIN), band);
      break;
    }
    case 'beanie': {
      const dome = mesh(new THREE.SphereGeometry(0.215, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon(accent), 0, top - 0.14, 0);
      dome.scale.y = 0.85;
      const rim = mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 20), toon(lighten(accent, 0.4)), 0, top - 0.13, 0);
      rim.rotation.x = Math.PI / 2;
      const pom = mesh(new THREE.SphereGeometry(0.065, 10, 8), toon(lighten(accent, 0.5)), 0, top + 0.07, 0);
      g.add(withOutline(dome, OUT_THIN), rim, withOutline(pom, OUT_THIN));
      break;
    }
    case 'antenna': {
      const stick = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.25, 6), toon('#333344'), 0, top + 0.1, 0);
      const tip = mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: '#fff35c' }), 0, top + 0.24, 0);
      tip.name = 'tip';
      g.add(stick, withOutline(tip, OUT_THIN));
      break;
    }
    case 'mohawk': {
      for (let i = 0; i < 5; i++) {
        const c = mesh(new THREE.ConeGeometry(0.045, 0.16 - Math.abs(i - 2) * 0.02, 8), toon(accent), 0, top + 0.03, -0.14 + i * 0.07);
        c.rotation.x = (i - 2) * 0.25;
        g.add(withOutline(c, OUT_THIN));
      }
      break;
    }
    case 'bow': {
      const l = mesh(new THREE.ConeGeometry(0.07, 0.14, 10), toon('#ff6fb5'), -0.08, 0, 0); l.rotation.z = -Math.PI / 2;
      const r = mesh(new THREE.ConeGeometry(0.07, 0.14, 10), toon('#ff6fb5'), 0.08, 0, 0); r.rotation.z = Math.PI / 2;
      const c = mesh(new THREE.SphereGeometry(0.04, 10, 8), toon('#ff3d9a'));
      const bow = new THREE.Group(); bow.add(withOutline(l, OUT_THIN), withOutline(r, OUT_THIN), c);
      bow.position.set(0.1, top - 0.02, 0.05); bow.rotation.z = 0.4;
      g.add(bow);
      break;
    }
    default: break;
  }
  return g;
}

// web fonts may arrive after the first labels were drawn: redraw them once they are ready
let FONT_GEN = 0;
try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { FONT_GEN++; }); } catch (_) { /* ignore */ }

// name pill + hearts in one canvas (one sprite, so they never overlap at any distance)
const LABEL_W = 256, LABEL_H = 104;
function drawLabel(g, name, color, lives, max, ghost) {
  const w = LABEL_W;
  g.clearRect(0, 0, w, LABEL_H);
  g.font = 'bold 34px Fredoka, "Trebuchet MS", sans-serif';
  const tw = Math.min(w - 12, g.measureText(name).width + 34);
  roundRect(g, (w - tw) / 2, 4, tw, 52, 26);
  g.fillStyle = color; g.fill();
  g.lineWidth = 5; g.strokeStyle = '#24193d'; g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = '#24193d'; g.strokeText(name, w / 2, 31, w - 40);
  g.fillStyle = '#ffffff'; g.fillText(name, w / 2, 31, w - 40);
  if (ghost) { g.font = '38px sans-serif'; g.fillText('👻', w / 2, 84); return; }
  const s = 32, gap = 8, total = max * s + (max - 1) * gap;
  for (let i = 0; i < max; i++) {
    const x = (w - total) / 2 + i * (s + gap) + s / 2;
    heartPath(g, x, 64, s);
    g.fillStyle = i < lives ? '#ff3b5c' : '#5a5170';
    g.fill();
    g.lineWidth = 4; g.strokeStyle = '#24193d'; g.stroke();
    if (i < lives) { g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(x - 8, 74, 4, 0, 7); g.fill(); }
  }
}

// sprite with a constant size on screen, anchored by its bottom edge
function screenSprite(map, order) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false, transparent: true, sizeAttenuation: false }));
  s.center.set(0.5, 0);
  s.renderOrder = order;
  return s;
}

let YOU_TEX = null, SLAP_TEX = null;
function youTex() {
  return YOU_TEX || (YOU_TEX = canvasTex(160, 128, (g, w) => {
    g.font = 'bold 44px "Lilita One", Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#24193d'; g.strokeText('YOU', w / 2, 30); g.fillStyle = '#ffffff'; g.fillText('YOU', w / 2, 30);
    g.beginPath(); g.moveTo(w / 2 - 34, 62); g.lineTo(w / 2 + 34, 62); g.lineTo(w / 2, 118); g.closePath();
    g.fillStyle = '#ffe14d'; g.fill(); g.lineWidth = 7; g.stroke();
  }));
}
function slapTex() {
  return SLAP_TEX || (SLAP_TEX = canvasTex(192, 128, (g, w) => {
    roundRect(g, 8, 76, w - 16, 44, 20);
    g.fillStyle = '#ff4d8d'; g.fill(); g.lineWidth = 5; g.strokeStyle = '#24193d'; g.stroke();
    g.font = 'bold 26px Fredoka, "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.fillText('RIGHT CLICK', w / 2, 99);
    g.font = '64px sans-serif'; g.fillText('👋', w / 2, 40);
  }));
}

class Character {
  constructor(p, r) {
    this.r = r;
    this.id = p.id;
    this.root = new THREE.Group();
    this.pivot = new THREE.Group();
    this.root.add(this.pivot);
    this.solids = []; // parts hidden when the character is faded (it stands between you and the camera)
    const bodyMat = toon(p.color, { unique: true, params: { transparent: true } });
    this.bodyMat = bodyMat;
    const body = mesh(new THREE.CapsuleGeometry(0.24, 0.34, 8, 18), bodyMat, 0, 0.47, 0);
    withOutline(body);
    this.solids.push(body.children[0]);
    this.body = body;
    this.pivot.add(body);
    const belly = mesh(new THREE.SphereGeometry(0.17, 16, 12), toon(lighten(p.color, 0.45), { unique: true, params: { transparent: true } }), 0, 0.4, 0.12);
    belly.scale.set(1, 1.15, 0.6);
    this.bellyMat = belly.material;
    this.pivot.add(belly);
    // eyes
    const white = toon('#ffffff'), black = new THREE.MeshBasicMaterial({ color: '#1a1030' });
    for (const sx of [-1, 1]) {
      const eye = mesh(new THREE.SphereGeometry(0.072, 14, 10), white, sx * 0.088, 0.68, 0.19);
      eye.scale.set(1, 1.2, 0.8);
      withOutline(eye, OUT_THIN);
      const pup = mesh(new THREE.SphereGeometry(0.036, 10, 8), black, sx * 0.084, 0.69, 0.245);
      const hi = mesh(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshBasicMaterial({ color: '#ffffff' }), sx * 0.075, 0.705, 0.275);
      this.pivot.add(eye, pup, hi);
      const cheek = mesh(new THREE.CircleGeometry(0.035, 12), new THREE.MeshBasicMaterial({ color: '#ff8fab', transparent: true, opacity: 0.7 }), sx * 0.15, 0.58, 0.2);
      cheek.rotation.y = sx * 0.6;
      this.pivot.add(cheek);
      this.solids.push(eye, pup, hi, cheek);
    }
    this.hat = buildHat(p.hat || 'none', p.color);
    this.pivot.add(this.hat);
    this.solids.push(this.hat);
    // feet
    this.feet = [];
    for (const sx of [-1, 1]) {
      const f = mesh(new THREE.SphereGeometry(0.075, 12, 8), toon(darken(p.color, 0.45)), sx * 0.11, 0.05, 0.03);
      f.scale.set(1, 0.6, 1.4);
      withOutline(f, OUT_THIN);
      this.root.add(f);
      this.feet.push(f);
    }
    // halo for ghosts
    this.halo = mesh(new THREE.TorusGeometry(0.15, 0.025, 8, 24), new THREE.MeshBasicMaterial({ color: '#fff27a' }), 0, 1.05, 0);
    this.halo.rotation.x = Math.PI / 2; this.halo.visible = false;
    this.pivot.add(this.halo);
    // dizzy sparkles after a slap (yellow diamonds: never round, so never confused with the ball)
    this.stars = new THREE.Group();
    const starMat = new THREE.MeshBasicMaterial({ color: '#ffe14d' });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), starMat);
      s.position.set(Math.cos(a) * 0.22, 0, Math.sin(a) * 0.22);
      this.stars.add(s);
    }
    this.stars.position.y = 1.02; this.stars.visible = false;
    this.root.add(this.stars);
    // floor: a disc in the player's color, a white ring for you, a yellow ring for whoever must hit
    this.colorDisc = new THREE.Mesh(new THREE.CircleGeometry(0.34, 32), new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.5, depthWrite: false }));
    this.colorDisc.rotation.x = -Math.PI / 2; this.colorDisc.position.y = 0.009;
    this.meRing = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.4, 36), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false }));
    this.meRing.rotation.x = -Math.PI / 2; this.meRing.position.y = 0.012;
    this.turnRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 36), new THREE.MeshBasicMaterial({ color: '#ffe14d', transparent: true, opacity: 0.9, depthWrite: false }));
    this.turnRing.rotation.x = -Math.PI / 2; this.turnRing.position.y = 0.014;
    this.root.add(this.colorDisc, this.meRing, this.turnRing);
    // name + hearts label (constant size on screen), YOU arrow, slap prompt
    this.name = p.name; this.color = p.color;
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = LABEL_W; this.labelCanvas.height = LABEL_H;
    this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTex.colorSpace = THREE.SRGBColorSpace;
    this.label = screenSprite(this.labelTex, 10);
    this.root.add(this.label);
    this.labelKey = '';
    this.youTag = null;
    this.slapTag = screenSprite(slapTex(), 12);
    this.slapTag.visible = false;
    this.root.add(this.slapTag);
    // arm + glove + paddle live in world space
    this.arm = mesh(new THREE.CylinderGeometry(0.032, 0.032, 1, 8).translate(0, 0.5, 0), toon(darken(p.color, 0.15)));
    this.glove = mesh(new THREE.SphereGeometry(0.042, 10, 8), toon(darken(p.color, 0.15)));
    this.glove.scale.set(1, 0.7, 1.3);
    this.paddle = new THREE.Group();
    const blade = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.022, 26), toon('#e63946'), 0, 0, 0);
    withOutline(blade, OUT_THIN);
    const back = mesh(new THREE.CylinderGeometry(0.148, 0.148, 0.006, 26), toon('#22223b'), 0, -0.013, 0);
    const handle = mesh(new THREE.BoxGeometry(0.04, 0.03, 0.13), toon('#c98b4a'), 0, 0, -0.19);
    withOutline(handle, OUT_THIN);
    this.paddle.add(blade, back, handle);
    this.paddle.rotation.order = 'YXZ';
    r.scene.add(this.root, this.arm, this.glove, this.paddle);
    this.phase = Math.random() * 10;
    this.yaw = 0;
    this.ghostT = Math.random() * 10;
    this.isGhost = null;
    this.fade = 0; this.fadeWant = false;
    this.dustAcc = 0;
  }

  dispose() {
    this.r.scene.remove(this.root, this.arm, this.glove, this.paddle);
  }

  setGhost(on) {
    if (this.isGhost === on) return;
    this.isGhost = on;
    this.halo.visible = on;
    this.arm.visible = this.glove.visible = this.paddle.visible = !on;
    this.body.castShadow = !on;
  }

  update(p, game, dt, t, isMe, winner) {
    const r = this.r;
    const ghost = !p.alive;
    const firstPerson = isMe && r.effMode === 'first';
    const sliding = !ghost && p.slideT > 0;
    this.setGhost(ghost);
    this.root.visible = !firstPerson;
    this.root.position.set(p.x, 0, p.z);
    // fade when standing between you and the camera
    this.fade += ((this.fadeWant ? 1 : 0) - this.fade) * Math.min(1, dt * 10);
    const op = ghost ? 0.45 : 1 - 0.72 * this.fade;
    this.bodyMat.opacity = op; this.bellyMat.opacity = op;
    this.bodyMat.depthWrite = this.bellyMat.depthWrite = op > 0.99;
    const solid = this.fade < 0.5;
    for (const m of this.solids) m.visible = solid;
    for (const f of this.feet) f.visible = !ghost && solid && !sliding;

    // facing: look at the ball when it's near / our turn, otherwise at the table
    const bv = game.ballView;
    let fx, fz;
    if (sliding) { fx = p.vx; fz = p.vz; }
    else if (bv.visible && (game.isActive(p.id) || Math.hypot(bv.x - p.x, bv.z - p.z) < 2.2)) { fx = bv.x - p.x; fz = bv.z - p.z; }
    else { fx = clamp(p.x, -HL, HL) - p.x; fz = clamp(p.z, -HW, HW) - p.z; }
    if (ghost) { fx = -p.x * 0.2 + Math.sin(t * 0.7 + this.ghostT); fz = 1; }
    if (Math.hypot(fx, fz) > 0.01) this.yaw = angLerp(this.yaw, Math.atan2(fx, fz), Math.min(1, dt * (sliding ? 20 : 10)));
    if (winner) this.yaw += dt * 6;
    if (p.spinAnim > 0) this.yaw += dt * 22 * p.spinAnim; // spun around by a slap
    this.root.rotation.y = this.yaw;

    // run cycle
    const sp = ghost ? 0 : clamp(p.speed / RUN_SPEED, 0, 1.6);
    this.phase += dt * (4 + sp * 12) * (sp > 0.05 ? 1 : 0.2);
    const bob = Math.abs(Math.sin(this.phase)) * 0.07 * Math.min(1, sp);
    const squash = 1 + p.hitAnim * 0.18;
    let dashStretch = p.dashT > 0 ? 1.25 : 1;
    this.pivot.scale.set(squash / Math.sqrt(dashStretch), (1 / squash) * (1 + 0.04 * Math.sin(this.phase * 2) * sp), squash * dashStretch);
    // lean towards motion (in local space)
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const lvx = p.vx * cy - p.vz * sy, lvz = p.vx * sy + p.vz * cy;
    this.pivot.rotation.x = lerp(this.pivot.rotation.x, sliding ? 1.35 : clamp(lvz / RUN_SPEED, -1, 1) * 0.22, Math.min(1, dt * (sliding ? 25 : 10)));
    this.pivot.rotation.z = lerp(this.pivot.rotation.z, sliding ? 0 : clamp(-lvx / RUN_SPEED, -1, 1) * 0.22, Math.min(1, dt * 10));
    const dizzy = !ghost && game.nowCache < p.fxDizzy;
    if (dizzy) this.pivot.rotation.z += Math.sin(t * 15) * 0.12;
    if (ghost) {
      this.ghostT += dt;
      this.pivot.position.y = 0.35 + Math.sin(this.ghostT * 2.2) * 0.08;
      this.pivot.rotation.z = Math.sin(this.ghostT * 1.3) * 0.15;
    } else if (sliding) {
      this.pivot.position.y = lerp(this.pivot.position.y, 0.22, Math.min(1, dt * 25));
    } else {
      this.pivot.position.y = bob + (winner ? Math.abs(Math.sin(t * 8)) * 0.25 : 0);
    }
    this.feet[0].position.z = 0.03 + Math.sin(this.phase) * 0.1 * Math.min(1, sp);
    this.feet[1].position.z = 0.03 - Math.sin(this.phase) * 0.1 * Math.min(1, sp);
    this.feet[0].position.y = 0.05 + Math.max(0, Math.sin(this.phase)) * 0.05 * Math.min(1, sp);
    this.feet[1].position.y = 0.05 + Math.max(0, -Math.sin(this.phase)) * 0.05 * Math.min(1, sp);
    const prop = this.hat.getObjectByName('prop');
    if (prop) prop.rotation.y += dt * (6 + sp * 25);
    const tip = this.hat.getObjectByName('tip');
    if (tip) tip.material.color.setHSL((t * 0.5) % 1, 1, 0.65);
    // dizzy sparkles
    this.stars.visible = dizzy;
    if (dizzy) { this.stars.rotation.y += dt * 9; this.stars.position.y = 1.0 + Math.sin(t * 9) * 0.03; }
    // dust: turbo run & belly slide (sandy, never white/orange like the ball)
    if (!ghost && (sliding || p.speed > T.run * 1.2)) {
      this.dustAcc += dt;
      if (this.dustAcc > (sliding ? 0.035 : 0.06)) {
        this.dustAcc = 0;
        r.emit('puff', p.x - p.vx * 0.05 + (Math.random() - 0.5) * 0.15, 0.06, p.z - p.vz * 0.05 + (Math.random() - 0.5) * 0.15,
          { color: '#e3cf9f', vy: 0.4 + Math.random() * 0.4, size: 0.05, grow: 0.28, life: 0.35, opacity: 0.8 });
      }
    }

    // label: name + hearts, constant size on screen, above the head
    const U = r.uiU;
    const lives = ghost ? -2 : p.lives;
    const key = lives + ':' + FONT_GEN;
    if (key !== this.labelKey) {
      this.labelKey = key;
      drawLabel(this.labelCanvas.getContext('2d'), this.name, this.color, p.lives, 2, ghost);
      this.labelTex.needsUpdate = true;
    }
    const headY = ghost ? 1.45 : sliding ? 0.75 : 1.12;
    // seen from behind you're obviously the one at the bottom: your own label would only hide the ball
    const ownView = isMe && r.effMode !== 'table';
    this.label.visible = !ownView;
    this.label.position.y = headY;
    this.label.scale.set(U * LABEL_W / LABEL_H, U, 1);
    // big bouncing "YOU" arrow
    if (isMe && !this.youTag) {
      this.youTag = screenSprite(youTex(), 11);
      this.root.add(this.youTag);
    }
    if (this.youTag) {
      this.youTag.visible = isMe && !ownView;
      const yh = U * 0.95;
      this.youTag.scale.set(yh * 1.25, yh, 1);
      this.youTag.position.y = headY;
      this.youTag.center.y = -(U / yh) - 0.05 - Math.abs(Math.sin(t * 5)) * 0.18;
    }
    // 👋 prompt over players who stand in your way
    const blocking = !isMe && game.blockers.includes(p.id);
    this.slapTag.visible = blocking;
    if (blocking) {
      const sh = U * (1.05 + Math.sin(t * 10) * 0.08);
      this.slapTag.scale.set(sh * 1.5, sh, 1);
      this.slapTag.position.y = headY;
      this.slapTag.center.y = -(U / sh) - 0.05;
    }
    // rings
    this.meRing.visible = isMe;
    const active = game.isActive(p.id);
    this.turnRing.visible = active;
    if (active) {
      const s = 1 + Math.sin(t * 10) * 0.08;
      this.turnRing.scale.set(s, s, s);
    }
    if (isMe) this.meRing.material.opacity = 0.55 + Math.sin(t * 4) * 0.25;
    this.colorDisc.visible = !ghost;

    if (ghost) return;
    // paddle (world space)
    const psc = T.paddleR / 0.17;
    this.paddle.scale.setScalar(psc);
    let ppx = p.px, ppy = p.py, ppz = p.pz;
    if (p.slapAnim > 0) {
      // slap: a wide sweep of the racket towards the victim
      const u = 1 - p.slapAnim;
      const ang = Math.atan2(p.slapDx, p.slapDz) + (u * 2 - 1) * 1.25;
      ppx = p.x + Math.sin(ang) * 0.72; ppz = p.z + Math.cos(ang) * 0.72; ppy = 0.95;
    }
    const dx = ppx - p.x, dz = ppz - p.z;
    const dl = Math.hypot(dx, dz) || 1;
    const nx = dx / dl, nz = dz / dl;
    this.paddle.position.set(ppx, ppy, ppz);
    this.paddle.rotation.y = Math.atan2(nx, nz);
    if (p.slapAnim > 0) { this.paddle.rotation.x = 0; this.paddle.rotation.z = Math.PI / 2; }
    else {
      this.paddle.rotation.x = 0.5 + p.hitAnim * 0.5;
      this.paddle.rotation.z = Math.sin(this.phase) * 0.05;
    }
    // stretchy arm from the shoulder to the handle (hidden in first person: it would cross the view)
    this.arm.visible = !firstPerson;
    const sh = new THREE.Vector3(p.x + nx * 0.16, 0.55 + this.pivot.position.y, p.z + nz * 0.16);
    const hand = new THREE.Vector3(ppx - nx * 0.25 * psc, ppy, ppz - nz * 0.25 * psc);
    const dir = hand.clone().sub(sh);
    const len = dir.length();
    this.arm.position.copy(sh);
    this.arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.arm.scale.set(1, Math.max(0.01, len), 1);
    this.glove.position.copy(hand);
  }
}

// ---------------------------------------------------------------- renderer
export class Renderer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#9ee6ff');
    this.scene.fog = new THREE.Fog('#9ee6ff', 22, 40);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
    this.camTarget = new THREE.Vector3(0, 0.3, 0.2);
    this.camBase = new THREE.Vector3();
    // camera rig: 'behind' (default, behind your end of the table), 'table' (whole table), 'first'
    this.camMode = 'behind'; this.effMode = 'table';
    this.camYaw = Math.PI; this.camYawV = 0; this.camEnd = 0; this.camWant = 0; this.camWantT = 0; this.camSide = 1;
    this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3(); this.camFov = 38; this.camReady = false;
    this.tablePos = new THREE.Vector3(); this.tableLook = this.camTarget.clone();
    this.basis = { fx: 0, fz: -1, rx: 1, rz: 0 };   // ground directions of the screen (for WASD)
    this.uiU = 0.04;                                   // label size (constant on screen)
    this._P = new THREE.Vector3(); this._L = new THREE.Vector3();
    this.chars = new Map();
    this.particles = [];
    this.pool = {};
    this.shake = 0;
    this.trail = [];
    this.raycaster = new THREE.Raycaster();
    this.paddlePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TABLE_H + 0.12));
    this.buildLights();
    this.buildWorld();
    this.buildTable();
    this.buildBall();
    this.buildGuides();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#6a9a55', 1.25));
    const sun = new THREE.DirectionalLight('#fff3dc', 1.7);
    sun.position.set(-4, 11, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -8; c.right = 8; c.top = 7; c.bottom = -7; c.near = 1; c.far = 30;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
  }

  buildWorld() {
    const rnd = seeded(7);
    // grass
    const grassTex = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#86d45f'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(60,150,50,.35)' : 'rgba(190,240,120,.35)';
        const x = rnd() * w, y = rnd() * h;
        g.beginPath(); g.ellipse(x, y, 2 + rnd() * 5, 1 + rnd() * 3, rnd() * 3, 0, 7); g.fill();
      }
    });
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(14, 14);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), toon('#ffffff', { params: { map: grassTex } }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // court rug
    const CW = 9.9, CH = 7.1, PX = 100; // px per meter
    const courtTex = canvasTex(CW * PX, CH * PX, (g, w, h) => {
      g.fillStyle = '#fff1cf'; g.fillRect(0, 0, w, h);
      const tile = 0.6 * PX;
      for (let y = 0; y < h; y += tile) for (let x = 0; x < w; x += tile) {
        if (((x / tile) + (y / tile)) % 2 === 0) { g.fillStyle = '#ffe4ad'; g.fillRect(x, y, tile, tile); }
      }
      const cx = w / 2, cy = h / 2;
      // end zones
      const zoneW = (CW / 2 - HL - 0.12) * PX;
      for (const [side, col] of [[-1, END_COLOR['-1']], [1, END_COLOR['1']]]) {
        g.globalAlpha = 0.33;
        g.fillStyle = col;
        const x0 = side < 0 ? 0.25 * PX : w - 0.25 * PX - zoneW;
        roundRect(g, x0, 0.25 * PX, zoneW, h - 0.5 * PX, 40); g.fill();
        g.globalAlpha = 0.6;
        // chevrons pointing at the table
        g.strokeStyle = col; g.lineWidth = 18; g.lineCap = 'round'; g.lineJoin = 'round';
        for (let i = 0; i < 3; i++) {
          const ax = side < 0 ? x0 + zoneW - 70 - i * 70 : x0 + 70 + i * 70;
          g.beginPath();
          g.moveTo(ax + side * 25, cy - 60); g.lineTo(ax - side * 25, cy); g.lineTo(ax + side * 25, cy + 60);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
      // circle under the table
      g.beginPath(); g.ellipse(cx, cy, (HL + 1.0) * PX, (HW + 0.9) * PX, 0, 0, 7);
      g.fillStyle = 'rgba(255,255,255,.55)'; g.fill();
      g.lineWidth = 10; g.strokeStyle = 'rgba(255,170,90,.6)'; g.setLineDash([40, 30]); g.stroke(); g.setLineDash([]);
      // border
      roundRect(g, 8, 8, w - 16, h - 16, 60);
      g.lineWidth = 16; g.strokeStyle = '#ffffff'; g.stroke();
      roundRect(g, 26, 26, w - 52, h - 52, 46);
      g.lineWidth = 6; g.strokeStyle = 'rgba(255,140,80,.55)'; g.stroke();
    });
    const shape = new THREE.Shape();
    const rr = 0.6, x0 = -CW / 2, y0 = -CH / 2;
    shape.moveTo(x0 + rr, y0); shape.lineTo(x0 + CW - rr, y0); shape.quadraticCurveTo(x0 + CW, y0, x0 + CW, y0 + rr);
    shape.lineTo(x0 + CW, y0 + CH - rr); shape.quadraticCurveTo(x0 + CW, y0 + CH, x0 + CW - rr, y0 + CH);
    shape.lineTo(x0 + rr, y0 + CH); shape.quadraticCurveTo(x0, y0 + CH, x0, y0 + CH - rr);
    shape.lineTo(x0, y0 + rr); shape.quadraticCurveTo(x0, y0, x0 + rr, y0);
    const cg = new THREE.ShapeGeometry(shape, 8);
    const pos = cg.attributes.position, uv = cg.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + CW / 2) / CW, (pos.getY(i) + CH / 2) / CH);
    const court = new THREE.Mesh(cg, toon('#ffffff', { params: { map: courtTex } }));
    court.rotation.x = -Math.PI / 2; court.position.y = 0.004; court.receiveShadow = true;
    this.scene.add(court);
    const rim = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), new THREE.MeshBasicMaterial({ color: '#e0a35a' }));
    rim.rotation.x = -Math.PI / 2; rim.position.y = 0.002; rim.scale.set(1.012, 1.016, 1);
    this.scene.add(rim);

    // trees, bushes and flowers around
    const treeSpots = [];
    while (treeSpots.length < 60) {
      const x = (rnd() - 0.5) * 30, z = (rnd() - 0.5) * 22;
      if (Math.abs(x) < CW / 2 + 0.9 && Math.abs(z) < CH / 2 + 0.9) continue;
      if (Math.abs(x) > 13 || Math.abs(z) > 10) continue;
      treeSpots.push([x, z]);
    }
    const leafCols = ['#4cb944', '#3fa34d', '#7ccc4f', '#2e9e5b', '#9bd35a'];
    for (const [x, z] of treeSpots) {
      if (rnd() < 0.55) {
        const t = new THREE.Group();
        const trunk = mesh(new THREE.CylinderGeometry(0.12, 0.18, 1.2, 8), toon('#9c6b3f'), 0, 0.6, 0);
        t.add(withOutline(trunk, OUT_THIN));
        const col = leafCols[(rnd() * leafCols.length) | 0];
        const n = 2 + ((rnd() * 2) | 0);
        for (let k = 0; k < n; k++) {
          const s = 0.9 - k * 0.2 + rnd() * 0.2;
          const leaf = mesh(new THREE.IcosahedronGeometry(s, 0), toon(col), (rnd() - 0.5) * 0.4, 1.5 + k * 0.55, (rnd() - 0.5) * 0.4);
          leaf.rotation.set(rnd(), rnd(), rnd());
          t.add(withOutline(leaf, OUT_MED));
        }
        t.position.set(x, 0, z);
        t.scale.setScalar(0.8 + rnd() * 0.5);
        t.traverse((o) => { o.castShadow = false; });
        this.scene.add(t);
      } else {
        const b = new THREE.Group();
        const col = leafCols[(rnd() * leafCols.length) | 0];
        for (let k = 0; k < 3; k++) {
          const s = 0.35 + rnd() * 0.25;
          const m = mesh(new THREE.SphereGeometry(s, 12, 8), toon(col), (k - 1) * 0.35, s * 0.7, (rnd() - 0.5) * 0.3);
          b.add(withOutline(m, OUT_THIN));
        }
        if (rnd() < 0.6) {
          for (let k = 0; k < 4; k++) {
            const fl = mesh(new THREE.SphereGeometry(0.06, 8, 6), toon(['#ff6b9a', '#ffe14d', '#ff9ec7', '#b388ff'][k]), (rnd() - 0.5) * 0.9, 0.55 + rnd() * 0.2, (rnd() - 0.5) * 0.5);
            b.add(fl);
          }
        }
        b.position.set(x, 0, z);
        b.traverse((o) => { o.castShadow = false; });
        this.scene.add(b);
      }
    }
    for (let i = 0, n = 0; n < 220 && i < 5000; i++) {
      const fx = (rnd() - 0.5) * 30, fz = (rnd() - 0.5) * 22;
      if (Math.abs(fx) < CW / 2 + 0.2 && Math.abs(fz) < CH / 2 + 0.2) continue;
      n++;
      const fl = new THREE.Mesh(new THREE.CircleGeometry(0.05 + rnd() * 0.04, 6), new THREE.MeshBasicMaterial({ color: ['#ff6b9a', '#ffe14d', '#c77dff', '#b388ff', '#ff9ec7'][(rnd() * 5) | 0] }));
      fl.rotation.x = -Math.PI / 2;
      fl.position.set(fx, 0.01, fz);
      this.scene.add(fl);
    }
    // bunting along the far side
    const flagCols = ['#ff4d6d', '#ffd23f', '#3bceac', '#5465ff', '#ff9f1c', '#b15cff'];
    const poleXs = [-4.9, -1.65, 1.65, 4.9];
    const PZ = -CH / 2 - 0.35;
    for (const px of poleXs) {
      const pole = mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.7, 8), toon('#ffffff'), px, 0.85, PZ);
      this.scene.add(withOutline(pole, OUT_THIN));
      const top = mesh(new THREE.SphereGeometry(0.1, 10, 8), toon('#ff4d6d'), px, 1.75, PZ);
      this.scene.add(top);
    }
    const flagGeo = new THREE.BufferGeometry();
    flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.11, 0, 0, 0.11, 0, 0, 0, -0.26, 0], 3));
    flagGeo.computeVertexNormals();
    for (let s = 0; s < poleXs.length - 1; s++) {
      const a = poleXs[s], b = poleXs[s + 1];
      const n = 11;
      for (let i = 1; i < n; i++) {
        const u = i / n;
        const x = lerp(a, b, u);
        const y = 1.62 - Math.sin(u * Math.PI) * 0.3;
        const f = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: flagCols[(i + s) % flagCols.length], side: THREE.DoubleSide }));
        f.position.set(x, y, PZ);
        this.scene.add(f);
      }
    }
  }

  buildTable() {
    const g = new THREE.Group();
    const top = mesh(new THREE.BoxGeometry(TABLE_L, 0.04, TABLE_W), toon('#2f7de1'), 0, TABLE_H - 0.02, 0);
    top.receiveShadow = true;
    const outl = new THREE.Mesh(new THREE.BoxGeometry(TABLE_L + 0.04, 0.08, TABLE_W + 0.04), new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide }));
    outl.position.y = TABLE_H - 0.03;
    g.add(top, outl);
    const white = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const lw = 0.025, ly = TABLE_H + 0.0015;
    const lines = [
      [TABLE_L, lw, 0, HW - lw / 2], [TABLE_L, lw, 0, -HW + lw / 2],
      [lw, TABLE_W, HL - lw / 2, 0], [lw, TABLE_W, -HL + lw / 2, 0],
      [TABLE_L, 0.008, 0, 0],
    ];
    for (const [w, d, x, z] of lines) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), white);
      m.rotation.x = -Math.PI / 2; m.position.set(x, ly, z);
      g.add(m);
    }
    const skirt = mesh(new THREE.BoxGeometry(TABLE_L - 0.1, 0.07, TABLE_W - 0.1), toon('#1d4f96'), 0, TABLE_H - 0.075, 0);
    g.add(skirt);
    const legMat = toon('#ffcf33');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = mesh(new THREE.CylinderGeometry(0.04, 0.05, TABLE_H - 0.08, 10), legMat, sx * (HL - 0.28), (TABLE_H - 0.08) / 2, sz * (HW - 0.15));
      g.add(withOutline(leg, OUT_THIN));
      const foot = mesh(new THREE.SphereGeometry(0.07, 10, 8), toon('#ff6b6b'), sx * (HL - 0.28), 0.04, sz * (HW - 0.15));
      foot.scale.y = 0.6;
      g.add(foot);
    }
    // net
    const netTex = canvasTex(256, 32, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
      for (let x = 0; x <= w; x += 6) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      for (let y = 0; y <= h; y += 6) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    });
    const netW = TABLE_W + NET_OVER * 2;
    const net = new THREE.Mesh(new THREE.PlaneGeometry(netW, NET_H), new THREE.MeshBasicMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, color: '#1b1530', opacity: 0.85 }));
    net.rotation.y = Math.PI / 2; net.position.set(0, TABLE_H + NET_H / 2, 0);
    const band = mesh(new THREE.BoxGeometry(0.014, 0.022, netW), toon('#ffffff'), 0, TABLE_H + NET_H - 0.011, 0);
    withOutline(band, OUT_THIN);
    g.add(net, band);
    for (const sz of [-1, 1]) {
      const post = mesh(new THREE.CylinderGeometry(0.018, 0.018, NET_H + 0.03, 8), toon('#333344'), 0, TABLE_H + (NET_H + 0.03) / 2 - 0.02, sz * (netW / 2));
      g.add(withOutline(post, OUT_THIN));
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    outl.castShadow = false;
    this.scene.add(g);
  }

  buildBall() {
    const tex = canvasTex(128, 64, (g, w, h) => {
      g.fillStyle = '#ff8a00'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff'; g.fillRect(0, h * 0.42, w, h * 0.16);
      g.beginPath(); g.arc(w * 0.25, h * 0.22, 7, 0, 7); g.fill();
      g.beginPath(); g.arc(w * 0.75, h * 0.78, 7, 0, 7); g.fill();
    });
    const VR = BALL_R * 1.8;
    // drawn on top of everything: in a top-down party game you must never lose the ball
    this.ball = mesh(new THREE.SphereGeometry(VR, 22, 16), toon('#ffffff', { params: { map: tex, depthTest: false } }));
    const bo = outlineMat(0.011);
    bo.depthTest = false;
    withOutline(this.ball, bo);
    this.ball.children[0].renderOrder = 30;
    this.ball.renderOrder = 31;
    this.ball.castShadow = false;
    this.scene.add(this.ball);
    // glow halo so the ball pops from the top
    const glowTex = canvasTex(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,200,80,1)'); gr.addColorStop(0.4, 'rgba(255,160,40,.55)'); gr.addColorStop(1, 'rgba(255,140,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    this.glow.scale.set(0.36, 0.36, 1);
    this.glow.renderOrder = 29;
    this.scene.add(this.glow);
    // blob shadow
    const shTex = canvasTex(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(20,10,40,.8)'); gr.addColorStop(0.6, 'rgba(20,10,40,.35)'); gr.addColorStop(1, 'rgba(20,10,40,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    this.ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    // "hit me" ring under the ball when it's your shot
    this.hitRing = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 28), new THREE.MeshBasicMaterial({ color: '#ffe14d', transparent: true, depthWrite: false }));
    this.hitRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.hitRing);
    // trail ribbon
    const N = 26;
    this.trailN = N;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    tg.setIndex(idx);
    this.trailMesh = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.trailMesh.frustumCulled = false;
    this.scene.add(this.trailMesh);
    this.trailColor = new THREE.Color('#ffffff');
  }

  buildGuides() {
    // floor arrow telling the local player where to run
    const s = new THREE.Shape();
    s.moveTo(0, 0.42); s.lineTo(0.3, 0.05); s.lineTo(0.12, 0.05); s.lineTo(0.12, -0.32); s.lineTo(-0.12, -0.32); s.lineTo(-0.12, 0.05); s.lineTo(-0.3, 0.05); s.closePath();
    const geo = new THREE.ShapeGeometry(s);
    geo.rotateX(-Math.PI / 2);
    this.arrow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }));
    this.arrow.position.y = 0.02;
    const ao = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.9, depthWrite: false }));
    ao.scale.setScalar(1.25); ao.position.y = -0.002; ao.position.z = 0.01;
    this.arrow.add(ao);
    this.arrow.renderOrder = 2;
    this.scene.add(this.arrow);
    // spot marker
    this.spot = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.27, 30), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false }));
    this.spot.rotation.x = -Math.PI / 2; this.spot.position.y = 0.015;
    this.scene.add(this.spot);
    // 🎯 where-to-hit target (Easy/Normal): floor rings + a ghost ball at the ideal hit point
    this.target = new THREE.Group();
    const tRing = (r0, r1, col, op, top = true) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, depthTest: !top }));
      m.rotation.x = -Math.PI / 2; m.renderOrder = top ? 25 : 1; return m;
    };
    // drawn at paddle height and on top of everything: "put your paddle on it"
    this.targetOuter = tRing(0.3, 0.39, '#ffe14d', 0.95);
    this.target.add(tRing(0.39, 0.43, '#24193d', 0.8), this.targetOuter, tRing(0.26, 0.3, '#24193d', 0.6), tRing(0.13, 0.2, '#ff4d8d', 0.95), tRing(0, 0.05, '#ffe14d', 0.95));
    this.scene.add(this.target);
    this.targetFloor = tRing(0.08, 0.14, '#ffe14d', 0.7, false);
    this.scene.add(this.targetFloor);
    this.ghostBall = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.8, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.55, depthWrite: false, depthTest: false }));
    this.ghostBall.renderOrder = 26;
    this.scene.add(this.ghostBall);
    this.ghostLine = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: '#ffe14d', transparent: true, opacity: 0.7 }));
    this.scene.add(this.ghostLine);
    this.bounceMark = tRing(0.05, 0.09, '#ffffff', 0.9);
    this.scene.add(this.bounceMark);
    // mouse cursor dot
    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.075, 20), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false, depthTest: false }));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 20;
    this.scene.add(this.cursor);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // whole-table view: closest camera that still shows the whole court
    const cam = new THREE.PerspectiveCamera(38, w / h, 0.1, 120);
    const tilt = 0.56;
    const dir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
    const pts = [];
    for (const x of [-4.75, 4.75]) for (const z of [-3.15, 3.25]) pts.push(new THREE.Vector3(x, 0, z));
    pts.push(new THREE.Vector3(0, 1.85, -3.05), new THREE.Vector3(-4.6, 1.85, -3.05), new THREE.Vector3(4.6, 1.85, -3.05));
    let lo = 4, hi = 60;
    for (let i = 0; i < 30; i++) {
      const d = (lo + hi) / 2;
      cam.position.copy(this.camTarget).addScaledVector(dir, d);
      cam.lookAt(this.camTarget);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      let ok = true;
      for (const p of pts) { const v = p.clone().project(cam); if (Math.abs(v.x) > 0.97 || Math.abs(v.y) > 0.95) { ok = false; break; } }
      if (ok) hi = d; else lo = d;
    }
    this.tablePos.copy(this.camTarget).addScaledVector(dir, hi);
  }

  setCameraMode(m) { if (CAM_MODES.includes(m)) { this.camMode = m; this.camEnd = 0; } }
  cycleCamera() { this.setCameraMode(CAM_MODES[(CAM_MODES.indexOf(this.camMode) + 1) % CAM_MODES.length]); return this.camMode; }

  // ---------------------------------------------------------------- camera
  updateCamera(game, dt, t) {
    const me = game && game.localId ? game.me : null;
    let mode = this.camMode;
    if (!me || !me.alive || me.spectator) mode = 'table'; // ghosts and spectators watch the whole table
    this.effMode = mode;
    const P = this._P, L = this._L, asp = this.camera.aspect;
    let fov = 38;
    if (mode === 'table') { P.copy(this.tablePos); L.copy(this.tableLook); this.camEnd = 0; }
    else {
      // The camera sits behind the end of the table where you have to be. When that changes
      // (you just hit), it waits a moment, then swings around the side you run on.
      const want = game.targetEnd(me) || this.camEnd || (me.x < 0 ? -1 : 1);
      if (!this.camEnd) { this.camEnd = this.camWant = want; this.camYaw = want < 0 ? Math.PI : 0; this.camYawV = 0; }
      if (want !== this.camWant) { this.camWant = want; this.camWantT = t; this.camSide = (me.z + me.vz * 0.3) >= 0 ? 1 : -1; }
      if (this.camWant !== this.camEnd && t - this.camWantT > 0.45) this.camEnd = this.camWant;
      let d = wrapA((this.camEnd < 0 ? Math.PI : 0) - this.camYaw);
      if (Math.abs(d) > 2.6) {
        const goal = this.camSide * Math.PI / 2, ad = Math.abs(d);
        d = Math.abs(wrapA(this.camYaw + ad / 2 - goal)) <= Math.abs(wrapA(this.camYaw - ad / 2 - goal)) ? ad : -ad;
      }
      const K = 6.5; // critically damped spring: smooth start, no overshoot
      this.camYawV += (K * K * d - 2 * K * this.camYawV) * dt;
      this.camYaw = wrapA(this.camYaw + this.camYawV * dt);
      const ux = Math.cos(this.camYaw), uz = Math.sin(this.camYaw), vx = -uz, vz = ux;
      if (mode === 'behind') {
        fov = Math.max(50, 2 * Math.atan(Math.tan(28 * D2R) / asp) / D2R);
        const half = fov * D2R / 2;
        const along = me.x * ux + me.z * uz, lat = me.x * vx + me.z * vz;
        const A0 = HL + 0.35, A = Math.max(along, A0 - 0.05), extra = Math.max(0, A - A0);
        const R = A0 + 2.55 + extra * 1.1, H = 2.55 + extra * 0.3;
        const latF = clamp(lat, -2.4, 2.4) * 0.5;
        // look at the table, but always tilt enough to keep your own feet on screen
        let pitch = Math.atan2(H - TABLE_H, R - 0.35);
        pitch = Math.max(pitch, Math.atan2(H, Math.max(0.5, R - A)) - half + 0.09);
        P.set(ux * R + vx * latF, H, uz * R + vz * latF);
        const c = Math.cos(pitch) * 4;
        L.set(P.x - ux * c, P.y - Math.sin(pitch) * 4, P.z - uz * c);
      } else {
        // first person: eyes above your head, always looking at the middle of the table
        fov = Math.max(64, 2 * Math.atan(Math.tan(34 * D2R) / asp) / D2R);
        const lx = -me.x, lz = -me.z;
        const ll = Math.hypot(lx, lz) || 1, far = Math.max(ll, 1.7);
        // a bit above and behind your head, so the paddle is not glued to your nose
        P.set(me.x - lx / ll * 0.45, 1.55, me.z - lz / ll * 0.45);
        L.set(me.x + lx / ll * far, TABLE_H + 0.05, me.z + lz / ll * far);
      }
    }
    const k = this.camReady ? 1 - Math.exp(-dt * (mode === 'first' ? 14 : 9)) : 1;
    this.camReady = true;
    this.camPos.lerp(P, k); this.camLook.lerp(L, k);
    this.camFov += (fov - this.camFov) * k;
    this.camera.fov = this.camFov;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
    this.camBase.copy(this.camPos);
    // screen directions on the ground, so W/A/S/D always match what you see
    let fx = this.camLook.x - this.camPos.x, fz = this.camLook.z - this.camPos.z;
    const fl = Math.hypot(fx, fz);
    if (fl < 1e-3) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
    this.basis.fx = fx; this.basis.fz = fz; this.basis.rx = -fz; this.basis.rz = fx;
    // labels: about 46 px tall whatever the camera
    const hpx = this.renderer.domElement.clientHeight || window.innerHeight;
    this.uiU = clamp(46 / hpx, 0.035, 0.07) * 2 * Math.tan(this.camFov * D2R / 2);
  }

  // fade the players standing between the camera and you (behind view) or right in your face (first person)
  updateFades(game) {
    const me = game.me;
    const mode = this.effMode;
    for (const [id, c] of this.chars) {
      let f = false;
      const p = game.players.get(id);
      if (p && me && me.alive && id !== game.localId && mode !== 'table') {
        const cx = this.camPos.x, cz = this.camPos.z;
        const ox = p.x - cx, oz = p.z - cz;
        if (mode === 'behind') {
          const mx = me.x - cx, mz = me.z - cz, ml2 = mx * mx + mz * mz || 1;
          const u = (ox * mx + oz * mz) / ml2;
          if (u > 0 && u < 1.05) { const ex = ox - mx * u, ez = oz - mz * u; if (ex * ex + ez * ez < 0.3) f = true; }
          if (ox * ox + oz * oz < 1.6) f = true;
          // you are still running to your end: clear the view between the camera and the table
          const ux = Math.cos(this.camYaw), uz = Math.sin(this.camYaw);
          if (me.x * ux + me.z * uz < HL && p.x * ux + p.z * uz > HL - 0.1 &&
              Math.abs((p.x - cx) * -uz + (p.z - cz) * ux) < 1.3) f = true;
        } else if (ox * ox + oz * oz < 0.8) f = true;
      }
      c.fadeWant = f;
    }
  }

  mouseToWorld(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.paddlePlane, out)) return null;
    return { x: out.x, z: out.z };
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return { x: -9999, y: -9999 }; // behind the camera
    const r = this.canvas.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * r.width + r.left, y: (-v.y * 0.5 + 0.5) * r.height + r.top };
  }

  // ---------------------------------------------------------------- particles
  getParticle(kind) {
    const pool = this.pool[kind] || (this.pool[kind] = []);
    let m = pool.pop();
    if (!m) {
      let geo;
      if (kind === 'puff') geo = new THREE.SphereGeometry(1, 10, 8);
      else if (kind === 'spark') geo = new THREE.OctahedronGeometry(1, 0);
      else if (kind === 'ring') { geo = new THREE.RingGeometry(0.8, 1, 32); geo.rotateX(-Math.PI / 2); }
      else geo = new THREE.PlaneGeometry(1, 0.6);
      m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      m.userData.kind = kind;
    }
    m.visible = true;
    this.scene.add(m);
    return m;
  }

  emit(kind, x, y, z, o = {}) {
    const m = this.getParticle(kind);
    m.position.set(x, y, z);
    m.material.color.set(o.color || '#ffffff');
    m.material.opacity = o.opacity ?? 1;
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    if (kind === 'ring') m.rotation.set(0, 0, 0);
    const p = {
      m, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, life: o.life || 0.6, t: 0,
      size: o.size || 0.05, grow: o.grow ?? 0, g: o.g ?? 0, drag: o.drag ?? 0, spin: o.spin || 0, op: o.opacity ?? 1,
    };
    m.scale.setScalar(p.size);
    this.particles.push(p);
  }

  burst(x, y, z, color, n = 12, speed = 2.5) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 0.9;
      const s = speed * (0.5 + Math.random() * 0.7);
      this.emit('spark', x, y, z, { color, vx: Math.cos(a) * s * Math.cos(e), vy: Math.sin(e) * s + 0.5, vz: Math.sin(a) * s * Math.cos(e), life: 0.45 + Math.random() * 0.25, size: 0.035, g: 6, spin: 8 });
    }
  }

  ringPulse(x, y, z, color, size = 0.3, life = 0.4) {
    this.emit('ring', x, y + 0.004, z, { color, size: 0.05, grow: size / life, life, opacity: 0.9 });
  }

  dust(x, z, n = 6) {
    for (let i = 0; i < n; i++) {
      this.emit('puff', x + (Math.random() - 0.5) * 0.3, 0.08, z + (Math.random() - 0.5) * 0.3, { color: '#ffffff', vy: 0.5 + Math.random() * 0.6, vx: (Math.random() - 0.5), vz: (Math.random() - 0.5), size: 0.07, grow: 0.25, life: 0.5, opacity: 0.85 });
    }
  }

  confetti(n = 160) {
    const cols = ['#ff4d6d', '#ffd23f', '#3bceac', '#5465ff', '#ff9f1c', '#b15cff', '#ffffff'];
    for (let i = 0; i < n; i++) {
      this.emit('confetti', (Math.random() - 0.5) * 9, 3 + Math.random() * 3, (Math.random() - 0.5) * 6, {
        color: cols[i % cols.length], vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 2,
        size: 0.09, g: 2.2, drag: 1.4, spin: 6 + Math.random() * 6, life: 3 + Math.random() * 2,
      });
    }
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.t += dt;
      if (p.t >= p.life) {
        p.m.visible = false; this.scene.remove(p.m);
        this.pool[p.m.userData.kind].push(p.m);
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= p.g * dt;
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy *= dr; p.vz *= dr;
      p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
      if (p.m.position.y < 0.01) { p.m.position.y = 0.01; p.vy = 0; p.vx *= 0.8; p.vz *= 0.8; }
      if (p.spin) { p.m.rotation.x += p.spin * dt; p.m.rotation.y += p.spin * 0.7 * dt; }
      const u = p.t / p.life;
      if (p.grow) p.m.scale.setScalar(p.size + p.grow * p.t);
      else if (p.m.userData.kind === 'spark') p.m.scale.setScalar(p.size * (1 - u));
      p.m.material.opacity = p.op * (p.m.userData.kind === 'confetti' ? Math.min(1, (1 - u) * 4) : 1 - u);
    }
  }

  addShake(a) { this.shake = Math.max(this.shake, a); }

  removeChar(id) {
    const c = this.chars.get(id);
    if (c) { c.dispose(); this.chars.delete(id); }
  }

  clearChars() { for (const id of [...this.chars.keys()]) this.removeChar(id); this.camEnd = 0; }

  // ---------------------------------------------------------------- frame
  frame(game, dt, t, mouseWorld) {
    this.updateCamera(game, dt, t);
    if (game) {
      for (const p of game.players.values()) if (!this.chars.has(p.id)) this.chars.set(p.id, new Character(p, this));
      for (const id of [...this.chars.keys()]) if (!game.players.has(id)) this.removeChar(id);
      this.updateFades(game);
      for (const p of game.players.values()) {
        this.chars.get(p.id).update(p, game, dt, t, p.id === game.localId, game.phase === 'over' && game.winner === p.id);
      }
      this.updateBall(game, dt, t);
      this.updateGuides(game, t, mouseWorld);
    } else {
      this.ball.visible = this.glow.visible = this.ballShadow.visible = this.hitRing.visible = this.trailMesh.visible = false;
      this.arrow.visible = this.spot.visible = this.cursor.visible = false;
      this.target.visible = this.ghostBall.visible = this.ghostLine.visible = this.bounceMark.visible = this.targetFloor.visible = false;
    }
    this.updateParticles(dt);
    // camera shake
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const s = this.shake * this.shake * 0.25;
    this.camera.position.set(this.camBase.x + (Math.random() - 0.5) * s, this.camBase.y + (Math.random() - 0.5) * s, this.camBase.z + (Math.random() - 0.5) * s);
    this.renderer.render(this.scene, this.camera);
  }

  updateBall(game, dt, t) {
    const v = game.ballView;
    const vis = v.visible;
    this.ball.visible = this.glow.visible = this.ballShadow.visible = vis;
    if (!vis) { this.trail.length = 0; this.trailMesh.visible = false; this.hitRing.visible = false; return; }
    this.ball.position.set(v.x, v.y, v.z);
    this.glow.position.set(v.x, v.y, v.z);
    const b = game.ball;
    if (b && !v.held) {
      this.ball.rotation.x += b.wx * dt * 0.06; this.ball.rotation.y += b.wy * dt * 0.06; this.ball.rotation.z += b.wz * dt * 0.06;
    } else this.ball.rotation.y += dt * 3;
    const over = Math.abs(v.x) <= HL && Math.abs(v.z) <= HW && v.y >= TABLE_H - 0.02;
    const sy = over ? TABLE_H + 0.003 : 0.008;
    const hgt = Math.max(0, v.y - sy);
    this.ballShadow.position.set(v.x, sy, v.z);
    const ss = 0.09 + hgt * 0.05;
    this.ballShadow.scale.set(ss, ss, 1);
    this.ballShadow.material.opacity = clamp(1 - hgt * 0.5, 0.25, 1);
    // hit ring for the local player
    const meTurn = game.isActive(game.localId) && (v.held || (b && hittable(b, T.volley)));
    this.hitRing.visible = meTurn;
    if (meTurn) {
      this.hitRing.position.set(v.x, sy + 0.002, v.z);
      const k = 1 + Math.sin(t * 12) * 0.15;
      this.hitRing.scale.set(k, k, k);
    }
    // trail
    const fx = game.seg && game.seg.fx;
    let col = '#ffffff';
    if (fx) {
      if (fx.smash) col = '#ffe14d';
      else if (fx.curve) col = '#ff5cf0';
      else if (fx.spin === 'top') col = '#ff6a3d';
      else if (fx.spin === 'back') col = '#3dc8ff';
    }
    this.trailColor.lerp(new THREE.Color(col), Math.min(1, dt * 10));
    const tr = this.trail;
    if (!v.held && b) {
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last.x - v.x, last.y - v.y, last.z - v.z) > 0.012) tr.push({ x: v.x, y: v.y, z: v.z, t });
      while (tr.length > this.trailN || (tr.length && t - tr[0].t > 0.3)) tr.shift();
    } else tr.length = 0;
    this.trailMesh.visible = tr.length > 2;
    if (tr.length > 2) {
      const pos = this.trailMesh.geometry.attributes.position, colA = this.trailMesh.geometry.attributes.color;
      const n = tr.length;
      for (let i = 0; i < this.trailN; i++) {
        const k = Math.min(i, n - 1);
        const p = tr[k], q = tr[Math.min(k + 1, n - 1)], o = tr[Math.max(k - 1, 0)];
        let dx = q.x - o.x, dz = q.z - o.z;
        const dl = Math.hypot(dx, dz) || 1;
        const u = k / (n - 1);
        const w = BALL_R * 1.9 * u;
        const px = -dz / dl * w, pz = dx / dl * w;
        pos.setXYZ(i * 2, p.x + px, p.y, p.z + pz);
        pos.setXYZ(i * 2 + 1, p.x - px, p.y, p.z - pz);
        const a = u * u * 0.9;
        colA.setXYZ(i * 2, this.trailColor.r * a, this.trailColor.g * a, this.trailColor.b * a);
        colA.setXYZ(i * 2 + 1, this.trailColor.r * a, this.trailColor.g * a, this.trailColor.b * a);
      }
      pos.needsUpdate = true; colA.needsUpdate = true;
    }
  }

  updateGuides(game, t, mouseWorld) {
    const me = game.me;
    this.arrow.visible = false; this.spot.visible = false;
    // 🎯 target
    const pr = T.guide && game.pred;
    const hit = pr && pr.hit && game.nowCache < pr.hit.t + 0.25 ? pr.hit : null;
    this.target.visible = this.ghostBall.visible = this.ghostLine.visible = this.targetFloor.visible = !!hit;
    if (hit) {
      this.target.scale.setScalar(this.effMode === 'first' ? 0.45 : 1);
      const over = Math.abs(hit.x) <= HL && Math.abs(hit.z) <= HW;
      const gy = over ? TABLE_H + 0.004 : 0.016;
      this.target.position.set(hit.x, hit.y - 0.02, hit.z);
      this.targetFloor.position.set(hit.x, gy, hit.z);
      const k = 1 + Math.sin(t * 9) * 0.12;
      this.targetOuter.scale.set(k, k, k);
      this.ghostBall.position.set(hit.x, hit.y, hit.z);
      this.ghostLine.position.set(hit.x, gy, hit.z);
      this.ghostLine.scale.set(1, Math.max(0.01, hit.y - gy), 1);
    }
    const bm = pr && pr.bounce && game.ball && game.ball.stage === 0 ? pr.bounce : null;
    this.bounceMark.visible = !!bm;
    if (bm) { this.bounceMark.position.set(bm.x, TABLE_H + 0.005, bm.z); const k = 1 + Math.sin(t * 14) * 0.2; this.bounceMark.scale.set(k, k, k); }
    this.cursor.visible = !!(me && me.alive && mouseWorld);
    if (this.cursor.visible) this.cursor.position.set(mouseWorld.x, TABLE_H + 0.12, mouseWorld.z);
    if (!me || !me.alive || game.phase === 'over') return;
    const st = game.statusFor(me.id);
    let goal = null;
    if (st.kind === 'queue') goal = queueSpot(st.end, st.idx);
    else if (st.kind === 'serve') goal = [st.end * (HL + 0.55), clamp(me.z, -0.5, 0.5)];
    if (!goal) return;
    const d = Math.hypot(goal[0] - me.x, goal[1] - me.z);
    const atEnd = me.x * st.end > HL - 0.1;
    if (st.kind === 'queue' && atEnd && d < 1.6) return;
    if (d < 0.5) return;
    const col = END_COLOR[String(st.end)];
    this.spot.visible = true;
    this.spot.material.color.set(col);
    this.spot.position.set(goal[0], 0.015, goal[1]);
    const k = 1 + Math.sin(t * 6) * 0.12; this.spot.scale.set(k, k, k);
    const [wx, wz] = nextWaypoint(me.x, me.z, goal[0], goal[1]);
    const dx = wx - me.x, dz = wz - me.z, dl = Math.hypot(dx, dz) || 1;
    const off = 0.75 + Math.sin(t * 8) * 0.08;
    this.arrow.visible = true;
    this.arrow.material.color.set(col);
    this.arrow.position.set(me.x + dx / dl * off, 0.02, me.z + dz / dl * off);
    this.arrow.rotation.y = Math.atan2(-dx, -dz);
  }
}
