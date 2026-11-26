// Peer-to-peer networking with PeerJS (WebRTC data channels).
// The free public PeerJS broker is only used for the initial handshake (exchanging the room code);
// all game traffic then flows directly browser <-> browser. The host is the hub (star topology).
const PREFIX = 'pp-tournante-v1-';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

export function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0];
  return s;
}
export const cleanCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function needPeer() {
  if (!window.Peer) throw new Error('PeerJS failed to load');
}

export class HostNet {
  constructor(h) {
    this.h = h; // { onJoin(id, meta) -> bool, onMessage(id, msg), onLeave(id) }
    this.conns = new Map();
    this.counter = 0;
    this.peer = null;
    this.code = null;
  }

  start(tries = 4) {
    needPeer();
    return new Promise((resolve, reject) => {
      const code = makeCode();
      const peer = new window.Peer(PREFIX + code, PEER_OPTS);
      let opened = false;
      peer.on('open', () => { opened = true; this.peer = peer; this.code = code; resolve(code); });
      peer.on('error', (e) => {
        if (!opened) {
          peer.destroy();
          if (e.type === 'unavailable-id' && tries > 0) this.start(tries - 1).then(resolve, reject);
          else reject(e);
        } else console.warn('peer error', e.type, e);
      });
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (_) { /* ignore */ } }, 1000); });
      peer.on('connection', (conn) => this.accept(conn));
    });
  }

  accept(conn) {
    const id = 'p' + (++this.counter);
    let opened = false;
    conn.on('open', () => {
      if (opened) return; // PeerJS can fire 'open' twice for one connection: join only once
      opened = true;
      this.conns.set(id, conn);
      const ok = this.h.onJoin(id, conn.metadata || {});
      if (!ok) setTimeout(() => conn.close(), 500);
    });
    conn.on('data', (m) => { if (m && typeof m === 'object') this.h.onMessage(id, m); });
    const gone = () => {
      if (this.conns.get(id) === conn) { this.conns.delete(id); this.h.onLeave(id); }
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  sendTo(id, msg) {
    const c = this.conns.get(id);
    if (c && c.open) { try { c.send(msg); } catch (e) { console.warn(e); } }
  }

  broadcast(msg, except) {
    for (const [id, c] of this.conns) if (id !== except && c.open) { try { c.send(msg); } catch (e) { console.warn(e); } }
  }

  kick(id) { const c = this.conns.get(id); if (c) c.close(); }

  close() { try { this.peer && this.peer.destroy(); } catch (_) { /* ignore */ } this.conns.clear(); }
}

export class GuestNet {
  constructor(h) {
    this.h = h; // { onMessage(msg), onClose(reason) }
    this.peer = null; this.conn = null; this.closed = false;
  }

  join(code, meta) {
    needPeer();
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(PEER_OPTS);
      this.peer = peer;
      let done = false;
      const fail = (msg) => { if (!done) { done = true; reject(new Error(msg)); try { peer.destroy(); } catch (_) { /* ignore */ } } };
      const timer = setTimeout(() => fail('Could not reach that room (timeout). Check the code and your connection.'), 15000);
      peer.on('error', (e) => {
        if (!done) fail(e.type === 'peer-unavailable' ? `Room "${code}" not found. Is the host still in the lobby?` : `Network error: ${e.type}`);
        else console.warn('peer error', e.type);
      });
      peer.on('open', () => {
        if (this.conn) return; // 'open' fires again after a broker reconnect: keep the first connection
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json', metadata: meta });
        this.conn = conn;
        conn.on('open', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
        conn.on('data', (m) => { if (m && typeof m === 'object') this.h.onMessage(m); });
        const closed = () => { if (!this.closed) { this.closed = true; this.h.onClose('Connection to host lost'); } };
        conn.on('close', closed);
        conn.on('error', closed);
      });
    });
  }

  send(msg) { if (this.conn && this.conn.open) { try { this.conn.send(msg); } catch (e) { console.warn(e); } } }

  close() { this.closed = true; try { this.peer && this.peer.destroy(); } catch (_) { /* ignore */ } }
}
