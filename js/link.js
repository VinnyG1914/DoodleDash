/*
 * Game connections relayed through the PeerJS server's secure WebSocket (port 443).
 *
 * Why not direct WebRTC: company networks and VPNs block it, but everyone can reach the PeerJS
 * server. Facts about the public server 0.peerjs.com (measured Oct 2026):
 *  - it only forwards CANDIDATE-shaped messages: payload {candidate:{...}, type, connectionId}.
 *    Anything else is dropped and the sender is disconnected. Extra fields pass through untouched.
 *  - messages up to ~8 KB pass, ~30 KB do not.
 *  - ~15-18 messages/second from one socket are fine; ~30/s gets the socket closed.
 * So every browser sends at most RATE messages per second, and everything waiting for the same
 * player is bundled into one message.
 *
 * Connections look like PeerJS DataConnections: .open, .peer, .send(obj), .close(),
 * events 'open', 'data', 'close'.
 */
(function () {
  'use strict';
  var DD = window.DD = window.DD || {};
  var RATE = 13;           // server messages per second, per browser (18/s measured safe, 30/s is cut off)
  var MAX_CHARS = 5800;    // per bundle (JSON), well under the server's limit
  var PING_MS = 5000;      // keep-alive when idle
  var DEAD_MS = 20000;     // nothing heard for this long = connection lost
  var HELLO_MS = 1500;     // a dialling player repeats "hi" until the host answers

  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev, arg) {
    (this._h[ev] || []).slice().forEach(function (fn) {
      try { fn(arg); } catch (e) { console.error('[link]', e); }
    });
  };

  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function wire(peer, dst, msg) {
    if (peer.destroyed || !peer.socket) return false;
    var payload = { candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 }, type: 'data',
      connectionId: 'dd_' + (msg.id || 'x'), dd: 1, m: msg };
    try { peer.socket.send({ type: 'CANDIDATE', dst: dst, payload: payload }); return true; } catch (e) { return false; }
  }

  function Conn(peer, remote, id) {
    Emitter.call(this);
    this._p = peer;
    this.peer = remote;
    this.id = id;
    this.open = false;
    this.seen = Date.now();
    this.lastSent = Date.now();
    this.out = [];
    this.since = 0;
    this._done = false;
    this._hello = null;
  }
  Conn.prototype = Object.create(Emitter.prototype);
  Conn.prototype.send = function (data) {
    if (!this.open) throw new Error('Connection is not open');
    if (!this.out.length) this.since = Date.now();
    this.out.push(data);
  };
  Conn.prototype.backlog = function () { return this.out.length; };
  Conn.prototype.close = function () {
    if (this._done) return;
    wire(this._p, this.peer, { k: 'bye', id: this.id });
    this._end();
  };
  Conn.prototype._end = function () {
    if (this._done) return;
    this._done = true;
    this.open = false;
    this.out = [];
    clearInterval(this._hello);
    var st = this._p.__dd;
    if (st && st.conns[this.peer] === this) delete st.conns[this.peer];
    this.emit('close');
  };

  function state(peer) {
    if (peer.__dd) return peer.__dd;
    var st = peer.__dd = { conns: {}, onConn: null, ctrl: [], timer: null, pumpTimer: null };
    peer.socket.on('message', function (m) {
      if (!m || !m.src) return;
      if (m.type === 'EXPIRE' || m.type === 'LEAVE') {
        if (st.conns[m.src] && st.conns[m.src].open) st.conns[m.src]._end();
        return;
      }
      if (!m.payload || m.payload.dd !== 1) return;
      try { if (peer._lostMessages) peer._lostMessages.delete(m.payload.connectionId); } catch (e) { /* ignore */ }
      handle(peer, st, m.src, m.payload.m || {});
    });
    st.timer = setInterval(function () { tick(peer, st); }, 1000);
    st.pumpTimer = setInterval(function () { pump(peer, st); }, Math.round(1000 / RATE));
    return st;
  }

  function ctrl(st, dst, msg) { st.ctrl.push({ dst: dst, m: msg }); }

  /* One server message per call: control messages first, then the player who has waited longest. */
  function pump(peer, st) {
    if (peer.destroyed) { stop(st); return; }
    if (peer.disconnected || !peer.open) return;
    if (st.ctrl.length) {
      var x = st.ctrl.shift();
      wire(peer, x.dst, x.m);
      return;
    }
    var best = null;
    Object.keys(st.conns).forEach(function (k) {
      var c = st.conns[k];
      if (c.open && c.out.length && (!best || c.since < best.since)) best = c;
    });
    if (!best) return;
    var items = [], size = 80;
    while (best.out.length) {
      var s = JSON.stringify(best.out[0]).length + 1;
      if (s > MAX_CHARS) { console.warn('[link] message too big, dropped'); best.out.shift(); continue; }
      if (items.length && size + s > MAX_CHARS) break;
      items.push(best.out.shift());
      size += s;
    }
    if (!items.length) return;
    var now = Date.now();
    wire(peer, best.peer, { k: 'd', id: best.id, b: items });
    best.lastSent = now;
    best.since = now;
  }

  function stop(st) {
    clearInterval(st.timer); clearInterval(st.pumpTimer);
    Object.keys(st.conns).forEach(function (k) { st.conns[k]._end(); });
  }

  function handle(peer, st, src, m) {
    var c = st.conns[src];
    if (m.k === 'hi') {
      if (!st.onConn || !m.id) return;
      if (c && c.open && c.id === m.id) { c.seen = Date.now(); ctrl(st, src, { k: 'ok', id: m.id }); return; }
      if (c) c._end();
      c = new Conn(peer, src, String(m.id).slice(0, 40));
      c.open = true;
      st.conns[src] = c;
      st.onConn(c);
      ctrl(st, src, { k: 'ok', id: c.id });
      return;
    }
    if (!c || c.id !== m.id) {
      if (m.k !== 'bye' && m.id) ctrl(st, src, { k: 'bye', id: m.id });
      return;
    }
    c.seen = Date.now();
    if (m.k === 'ok') {
      if (!c.open) { c.open = true; clearInterval(c._hello); c.emit('open'); }
    } else if (m.k === 'd') {
      if (!c.open) return;
      (Array.isArray(m.b) ? m.b : [m.d]).forEach(function (d) { if (c.open) c.emit('data', d); });
    } else if (m.k === 'bye') {
      c._end();
    }
  }

  function tick(peer, st) {
    if (peer.destroyed) { stop(st); return; }
    var now = Date.now();
    Object.keys(st.conns).forEach(function (k) {
      var c = st.conns[k];
      if (!c || !c.open) return;
      if (now - c.seen > DEAD_MS) { c._end(); return; }
      if (!c.out.length && now - c.lastSent >= PING_MS) { c.lastSent = now; ctrl(st, c.peer, { k: 'ping', id: c.id }); }
    });
  }

  DD.Link = {
    /* Host: onConn(conn) runs for every player that dials in. */
    listen: function (peer, onConn) { state(peer).onConn = onConn; },
    /* Player: dial the host. 'open' fires once the host answers. */
    dial: function (peer, hostId) {
      var st = state(peer);
      if (st.conns[hostId]) st.conns[hostId]._end();
      var c = new Conn(peer, hostId, newId());
      st.conns[hostId] = c;
      function hello() { if (!c._done && !c.open) ctrl(st, hostId, { k: 'hi', id: c.id }); }
      hello();
      c._hello = setInterval(hello, HELLO_MS);
      return c;
    },
    /* The host's own player: an in-page connection with no network. */
    local: function (onData) {
      var c = new Emitter();
      c.open = true;
      c.peer = 'local';
      c.send = function (d) { setTimeout(function () { onData(d); }, 0); };
      c.close = function () { c.open = false; };
      c.backlog = function () { return 0; };
      return c;
    }
  };
})();
