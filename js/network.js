import { NET } from './config.js';

// PeerJS (WebRTC) networking. No game server: the public PeerJS broker is
// only used for signalling, after which host and client talk directly.
//
// The host registers the peer id `NET.idPrefix + roomCode`; the prefix keeps
// our short numeric codes from colliding with other apps on the shared broker.
//
// Both sides get a `Link`: { id, send(msg), close(), rtt }. The link runs its
// own heartbeat (ping/pong) so a silently dropped connection is detected even
// when WebRTC never fires a 'close' event (common when a tab is killed).
//
// A host accepts up to `maxClients` players (3 for a 2v2 room); one leaving
// closes only their link, the room stays up.

const MAX_ID_RETRIES = 5;

function requirePeer() {
  if (typeof window.Peer !== 'function') {
    throw new Error('PeerJS yüklenemedi. İnternet bağlantını kontrol et.');
  }
  return window.Peer;
}

function randomCode() {
  const min = 10 ** (NET.codeLength - 1);
  return String(min + Math.floor(Math.random() * 9 * min));
}

export function isValidCode(code) {
  return /^\d{4,6}$/.test(code);
}

const ERROR_TEXT = {
  'peer-unavailable': 'Oda bulunamadı. Kodu kontrol et.',
  'network': 'Sinyal sunucusuna ulaşılamadı.',
  'server-error': 'Sinyal sunucusu hatası.',
  'socket-error': 'Sinyal sunucusu bağlantısı koptu.',
  'socket-closed': 'Sinyal sunucusu bağlantısı kapandı.',
  'browser-incompatible': 'Tarayıcın WebRTC desteklemiyor.',
  'webrtc': 'WebRTC bağlantısı kurulamadı.',
};
const errorText = (err) => ERROR_TEXT[err?.type] || `Bağlantı hatası (${err?.type || 'bilinmiyor'})`;

/**
 * Wrap an open DataConnection with heartbeat, safe send and a single
 * close notification. `onClose(reason)` fires once for remote/abnormal
 * closes; a local `close()` does not trigger it. A client link owns its
 * peer and destroys it on close; host links share the room's peer.
 */
function createLink(peer, conn, { onData, onClose }, ownsPeer = true) {
  let closed = false;
  let closing = false;
  let lastRecv = performance.now();
  let rtt = 0;

  const send = (msg) => {
    if (closed || !conn.open) return;
    try { conn.send(msg); } catch { /* channel closing; heartbeat will catch it */ }
  };

  function shutdown(reason, notify) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { conn.close(); } catch { /* already closed */ }
    if (ownsPeer) {
      try { peer.destroy(); } catch { /* already destroyed */ }
    }
    if (notify && !closing) onClose(reason);
  }

  conn.on('data', (msg) => {
    lastRecv = performance.now();
    if (!msg || typeof msg !== 'object') return; // ignore malformed payloads
    switch (msg.t) {
      case 'ping': send({ t: 'pong', ts: msg.ts }); return;
      case 'pong': if (typeof msg.ts === 'number') rtt = performance.now() - msg.ts; return;
      case 'bye': shutdown('left', true); return;
      default: onData(msg);
    }
  });
  conn.on('close', () => shutdown('closed', true));
  conn.on('error', () => shutdown('error', true));

  const heartbeat = setInterval(() => {
    if (performance.now() - lastRecv > NET.timeoutMs) shutdown('timeout', true);
    else send({ t: 'ping', ts: performance.now() });
  }, NET.pingMs);

  return {
    send,
    close() {
      if (closed || closing) return;
      closing = true;
      send({ t: 'bye' });
      // Give the goodbye a moment to flush before tearing the channel down.
      setTimeout(() => shutdown('local', false), 100);
    },
    get rtt() { return rtt; },
  };
}

/**
 * Create a room. Callbacks:
 *  onCode(code)               room is registered, show the code
 *  onConnected(link)          a client joined; link is ready to use
 *  onData(link, msg)          message from a client
 *  onClose(link, reason)      that client left / connection lost
 *  onError(text)              fatal setup error
 * `maxClients` caps the room; `room.locked = true` refuses newcomers (match
 * running). Returns { cancel(), locked } to abort or leave.
 */
export function hostRoom(handlers, maxClients = 1) {
  const Peer = requirePeer();
  let peer = null;
  const links = new Set();
  let nextId = 1;
  let cancelled = false;
  const room = {
    locked: false,
    cancel() {
      cancelled = true;
      for (const l of links) l.close();
      links.clear();
      // Let the goodbyes flush before the shared peer goes away.
      setTimeout(() => peer?.destroy(), 150);
    },
  };

  function attempt(tries) {
    const code = randomCode();
    const p = new Peer(NET.idPrefix + code, { debug: 1 });
    peer = p;

    p.on('open', () => !cancelled && handlers.onCode(code));

    p.on('connection', (conn) => {
      const refuse = () => cancelled || room.locked || links.size >= maxClients;
      conn.on('open', () => {
        // Room full or match running: politely refuse.
        if (refuse()) {
          conn.send({ t: 'full' });
          setTimeout(() => conn.close(), 200);
          return;
        }
        const link = createLink(p, conn, {
          onData: (msg) => handlers.onData(link, msg),
          onClose: (reason) => {
            links.delete(link);
            handlers.onClose(link, reason);
          },
        }, false);
        link.id = nextId++;
        links.add(link);
        handlers.onConnected(link);
      });
    });

    // Losing the broker only stops new players from finding the room (open
    // P2P channels stay up), so always try to re-register.
    p.on('disconnected', () => {
      if (!cancelled && !p.destroyed) p.reconnect();
    });

    p.on('error', (err) => {
      if (cancelled || links.size) return; // link-level failures arrive via onClose
      if (err.type === 'unavailable-id' && tries < MAX_ID_RETRIES) {
        p.destroy();
        attempt(tries + 1); // code collision: pick another
        return;
      }
      p.destroy();
      handlers.onError(errorText(err));
    });
  }

  attempt(0);
  return room;
}

/**
 * Join a room by code. Same callbacks as hostRoom (minus onCode).
 * Returns { cancel() }.
 */
export function joinRoom(code, handlers) {
  const Peer = requirePeer();
  const peer = new Peer({ debug: 1 });
  let link = null;
  let done = false;

  const fail = (text) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    peer.destroy();
    handlers.onError(text);
  };

  const timer = setTimeout(() => fail('Bağlantı zaman aşımına uğradı.'), NET.connectTimeoutMs);

  peer.on('open', () => {
    const conn = peer.connect(NET.idPrefix + code, { reliable: true, serialization: 'json' });
    conn.on('open', () => {
      if (done) return conn.close();
      done = true;
      clearTimeout(timer);
      link = createLink(peer, conn, {
        onClose: handlers.onClose,
        onData(msg) {
          if (msg.t === 'full') {
            handlers.onClose('full');
            link.close();
            return;
          }
          handlers.onData(msg);
        },
      });
      handlers.onConnected(link);
    });
  });

  peer.on('error', (err) => {
    if (link) return;
    fail(errorText(err));
  });

  return {
    cancel() {
      if (link) link.close();
      else { done = true; clearTimeout(timer); peer.destroy(); }
    },
  };
}
