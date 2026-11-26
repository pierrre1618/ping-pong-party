// World units are meters and seconds. Ends: -1 = left (ORANGE end), +1 = right (PURPLE end).
export const TABLE_L = 2.74;
export const TABLE_W = 1.525;
export const TABLE_H = 0.76;
export const NET_H = 0.1525;
export const HL = TABLE_L / 2;
export const HW = TABLE_W / 2;
export const NET_OVER = 0.15; // net overhang past table side

export const BALL_R = 0.034;      // a bit bigger than real, easier to see from the top
export const G = 9.81;
export const DT = 1 / 240;        // fixed physics step (deterministic on every peer)
export const KM = 0.0062;         // magnus coefficient
export const KD = 0.045;          // air drag
export const SPIN_DECAY = 0.35;   // per second
export const E_TABLE = 0.86;
export const E_FLOOR = 0.6;
export const SPIN_GRIP = 1.35;    // how strongly spin grabs the table on bounce (cartoon exaggerated)

export const PADDLE_R = 0.17;     // hit radius of the paddle
export const REACH = 1.0;         // stretchy cartoon arms
export const BODY_R = 0.27;
export const RUN_SPEED = 4.4;
export const DASH_SPEED = 11;
export const DASH_TIME = 0.15;
export const DASH_CD = 0.9;
export const ARENA_X = 4.5;
export const ARENA_Z = 3.0;

// player interaction
export const SLAP_R = 1.15;       // slap reach (body to body)
export const SLAP_CD = 0.9;       // seconds between two slaps
export const KNOCK_T = 0.28;      // knock-back duration
export const KNOCK_SPEED = 6.5;   // knock-back speed
export const DIZZY_T = 0.9;       // slowed down after being slapped
export const SLAP_IMMUNE = 1.6;   // can't be slapped again for this long
export const SLIDE_SPEED = 7.5;   // belly slide under the table
export const TURBO = 1.45;        // run boost while switching ends
export const SWING_WIN = 0.45;    // a click keeps the swing "armed" this long

export const LIVES = 2;
export const MAX_PLAYERS = 10;
export const GRACE = 0.35;        // host waits this long before confirming a dead ball (network slack)
export const BT = 0.85;          // ball time scale (<1 = floaty cartoon slow-mo)
export const SERVE_TIMEOUT = 8;   // auto-serve after this many seconds
export const POINT_PAUSE = 2.4;

export const END_NAME = { '-1': 'ORANGE', '1': 'PURPLE' };
export const END_EMOJI = { '-1': '🟠', '1': '🟣' };
export const END_COLOR = { '-1': '#ff9f1c', '1': '#9b5de5' };

export const COLORS = [
  '#ff5d5d', '#ffc93c', '#2ec4b6', '#3d8bff', '#b15cff',
  '#ff7ac6', '#7ed957', '#ff8a3d', '#18d2ff', '#8e7dff',
];
export const HATS = [
  { id: 'cap', label: '🧢 Cap' },
  { id: 'party', label: '🎉 Party hat' },
  { id: 'crown', label: '👑 Crown' },
  { id: 'propeller', label: '🚁 Propeller' },
  { id: 'tophat', label: '🎩 Top hat' },
  { id: 'beanie', label: '🧶 Beanie' },
  { id: 'antenna', label: '📡 Antenna' },
  { id: 'mohawk', label: '🦔 Mohawk' },
  { id: 'bow', label: '🎀 Bow' },
  { id: 'none', label: '🥚 Bald' },
];
export const BOT_NAMES = ['Robo-Bob', 'Zippy', 'Mr. Paddle', 'Spinny', 'Bouncy', 'Pongo', 'Tiki', 'Waffle', 'Noodle', 'Bubbles', 'Ziggy', 'Pickles'];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
