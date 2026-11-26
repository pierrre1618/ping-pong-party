// Difficulty levels. The host picks one and it is sent to every peer at match start,
// because ball time-scale must be identical everywhere (deterministic simulation).
export const LEVELS = {
  easy: {
    label: '🙂 Easy',
    bt: 0.66,         // ball time scale: slower, floatier ball
    paddleR: 0.29,    // hit radius (big cartoon paddle)
    clickR: 0.34,     // extra reach when you CLICK to swing
    reach: 1.18,      // arm length
    run: 5.0,         // run speed
    assist: 2,        // 2 = your shots always land on the table
    volley: true,     // hitting before the bounce is allowed
    spin: 0.6,        // spin/curve strength
    maxSpeed: 7.5,    // fastest possible shot
    guide: true,      // show the 🎯 target where to hit
    autoMove: true,   // character steps towards the ball when you don't press keys
    autoSwitch: true, // after your hit you run to the other end by yourself
    autoSlide: true,  // ...and slide under the table when you are needed soon
    botSkill: 0.7,    // bots are clumsier
  },
  normal: {
    label: '😎 Normal',
    bt: 0.76, paddleR: 0.23, clickR: 0.27, reach: 1.08, run: 4.7, assist: 1, volley: true, spin: 0.85,
    maxSpeed: 9.5, guide: true, autoMove: false, autoSwitch: true, autoSlide: false, botSkill: 0.85,
  },
  pro: {
    label: '🔥 Pro',
    bt: 0.85, paddleR: 0.17, clickR: 0.2, reach: 1.0, run: 4.4, assist: 0, volley: false, spin: 1,
    maxSpeed: 11.5, guide: false, autoMove: false, autoSwitch: true, autoSlide: false, botSkill: 1,
  },
};

export const T = { level: 'easy', ...LEVELS.easy };

export function setLevel(name) {
  const lv = LEVELS[name] ? name : 'easy';
  Object.assign(T, LEVELS[lv], { level: lv });
  return lv;
}
