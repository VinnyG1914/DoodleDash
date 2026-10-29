/*
 * Game engine. Runs only in the browser of the person who created the game.
 * Players (including the host's own player) talk to it with small JSON messages.
 */
(function () {
  'use strict';
  var DD = window.DD = window.DD || {};
  var CFG = window.DD_CONFIG;
  var SAVE_KEY = 'dd_host_game';
  function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }

  DD.Host = function (me, saved, events) {
    var self = this;
    var g = {
      code: saved ? saved.code : String(Math.floor(100000 + Math.random() * 900000)),
      players: {}, banned: saved ? saved.banned || {} : {},
      settings: Object.assign({ rounds: CFG.defaults.rounds, drawTime: CFG.defaults.drawTime, hints: CFG.defaults.hints,
        packs: DD_WORD_PACKS.map(function (p) { return p.id; }), locked: false }, saved ? saved.settings : {}),
      phase: 'lobby', started: saved ? !!saved.started : false,
      round: saved ? saved.round || 0 : 0, order: saved ? saved.order || [] : [], turnIdx: saved ? saved.turnIdx : -1,
      used: saved ? saved.used || [] : [],
      drawer: '', choices: [], word: '', ops: [], guessed: {}, eligible: {}, revealed: [],
      startAt: 0, endsAt: 0, timers: [], tick: null, stateTimer: null, lastChat: {}, drawerGone: null
    };
    var peer = null, netReady = false, localConn = null, destroyed = false;
    self.game = g;

    /* ------------------------------------------------------------------ players & sending */
    function addPlayer(pid, name, avatar, conn, isHost, score, joinedAt) {
      g.players[pid] = { pid: pid, name: name, avatar: DD.cleanAvatar(avatar), score: score || 0, conn: conn,
        connected: !!conn, host: !!isHost, joinedAt: joinedAt || Date.now() };
      return g.players[pid];
    }
    function send(p, msg) {
      if (p && p.conn && p.conn.open) { try { p.conn.send(msg); } catch (e) { /* closed */ } }
    }
    function broadcast(msg, exceptPid) {
      values(g.players).forEach(function (p) { if (p.pid !== exceptPid) send(p, typeof msg === 'function' ? msg(p) : msg); });
    }
    function connected() { return values(g.players).filter(function (p) { return p.connected; }); }
    function sys(text, kind) { broadcast({ t: 'chat', k: kind || 'sys', text: text }); }

    function hintFor() {
      var out = '';
      for (var i = 0; i < g.word.length; i++) {
        var ch = g.word[i];
        out += /[a-z0-9]/i.test(ch) ? (g.revealed.indexOf(i) >= 0 ? ch : '_') : ch;
      }
      return out;
    }
    function publicState() {
      var showHint = g.phase === 'draw';
      return {
        t: 'state', code: g.code, phase: g.phase, started: g.started, round: g.round, rounds: g.settings.rounds,
        drawer: g.drawer, settings: g.settings, hint: showHint ? hintFor() : '',
        remainingMs: g.endsAt ? Math.max(0, g.endsAt - Date.now()) : 0, totalMs: g.phase === 'draw' ? g.settings.drawTime * 1000 : 0,
        players: values(g.players).sort(function (a, b) { return a.joinedAt - b.joinedAt; }).map(function (p) {
          return { pid: p.pid, name: p.name, avatar: p.avatar, score: p.score, on: p.connected, host: p.host, g: !!g.guessed[p.pid] };
        })
      };
    }
    /* Coalesce state updates: at most one every 120 ms. */
    function pushState() {
      if (g.stateTimer) return;
      g.stateTimer = setTimeout(function () { g.stateTimer = null; broadcast(publicState()); save(); }, 120);
    }
    function sendBoard(p) {
      send(p, { t: 'board', reset: true });
      DD.chunkEdits(DD.opsToEdits(g.ops), 2800).forEach(function (chunk) { send(p, { t: 'draw', e: chunk }); });
    }

    /* ------------------------------------------------------------------ network */
    function openPeer(attempt) {
      if (destroyed) return;
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
      netReady = false;
      events.net('connecting');
      var p = peer = new window.Peer(CFG.peerPrefix + g.code, CFG.peerOptions);
      p.on('open', function () {
        if (p !== peer) return;
        netReady = true;
        DD.Link.listen(p, function (conn) { if (p === peer) onConnection(conn); });
        events.net('ready', g.code);
      });
      p.on('disconnected', function () {
        if (p !== peer || p.destroyed) return;
        events.net('reconnecting');
        setTimeout(function () { if (p === peer && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) { /* ignore */ } } }, 1500);
      });
      p.on('error', function (err) {
        if (p !== peer || destroyed) return;
        var type = err && err.type;
        if (type === 'unavailable-id') {
          if (saved && attempt < 20) { events.net('reclaiming'); setTimeout(function () { if (peer === p) openPeer(attempt + 1); }, 3000); }
          else { g.code = String(Math.floor(100000 + Math.random() * 900000)); saved = null; openPeer(0); }
        } else if (type === 'peer-unavailable') {
          /* a player's page went away; the link closes itself */
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(type) >= 0) {
          events.net('reconnecting');
          setTimeout(function () {
            if (peer !== p || p.destroyed) return;
            if (!netReady) openPeer(attempt + 1); else if (p.disconnected) { try { p.reconnect(); } catch (e) { openPeer(attempt + 1); } }
          }, Math.min(15000, 2000 * (attempt + 1)));
        } else {
          events.net('error', type);
        }
      });
    }

    function onConnection(conn) {
      conn.on('data', function (d) { try { onData(conn, d); } catch (e) { console.error('[host]', e); } });
      conn.on('close', function () { onClose(conn); });
    }
    function onClose(conn) {
      var p = g.players[conn.__pid];
      if (!p || p.conn !== conn) return;
      p.conn = null; p.connected = false;
      sys(p.name + ' left');
      if (g.phase === 'draw' || g.phase === 'choose') {
        if (p.pid === g.drawer) {
          clearTimeout(g.drawerGone);
          g.drawerGone = setTimeout(function () {
            var d = g.players[g.drawer];
            if (d && !d.connected && (g.phase === 'draw' || g.phase === 'choose')) endTurn('drawer-left');
          }, 8000);
        } else checkAllGuessed();
      }
      pushState();
    }

    function onData(conn, d) {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'join') { handleJoin(conn, d); return; }
      var p = g.players[conn.__pid];
      if (!p || p.conn !== conn) return;
      if (d.t === 'guess') handleGuess(p, d.text);
      else if (d.t === 'pick') handlePick(p, d.i);
      else if (d.t === 'draw') handleDraw(p, d.e);
    }

    function cleanName(n) {
      var s = String(n || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, CFG.maxNameLength);
      return s || 'Player';
    }
    function uniqueName(name, pid) {
      var taken = {};
      values(g.players).forEach(function (p) { if (p.pid !== pid) taken[p.name.toLowerCase()] = 1; });
      if (!taken[name.toLowerCase()]) return name;
      for (var k = 2; k < 100; k++) { var c = name.slice(0, CFG.maxNameLength - 2) + ' ' + k; if (!taken[c.toLowerCase()]) return c; }
      return name;
    }

    function handleJoin(conn, d) {
      var pid = String(d.pid || '').slice(0, 40);
      if (!pid || pid === me.pid) return;
      function refuse(t) { try { conn.send({ t: t }); } catch (e) { /* ignore */ } setTimeout(function () { try { conn.close(); } catch (e) { /* ignore */ } }, 800); }
      if (g.banned[pid]) { refuse('kicked'); return; }
      var p = g.players[pid];
      if (p) {
        if (p.conn && p.conn !== conn) { var old = p.conn; old.__pid = null; try { old.send({ t: 'replaced' }); old.close(); } catch (e) { /* ignore */ } }
        p.conn = conn; p.connected = true;
        if (g.phase === 'lobby') { p.name = uniqueName(cleanName(d.name), pid); p.avatar = DD.cleanAvatar(d.avatar); }
        sys(p.name + ' is back');
      } else {
        if (g.settings.locked) { refuse('locked'); return; }
        if (values(g.players).length >= CFG.maxPlayers) { refuse('full'); return; }
        p = addPlayer(pid, uniqueName(cleanName(d.name), pid), d.avatar, conn, false);
        if (g.started && g.order.indexOf(pid) < 0) g.order.push(pid);
        sys(p.name + ' joined', 'join');
      }
      conn.__pid = pid;
      syncPlayer(p);
      pushState();
    }

    function syncPlayer(p) {
      send(p, { t: 'welcome', pid: p.pid, name: p.name, avatar: p.avatar, host: me.pid });
      send(p, publicState());
      if (g.phase === 'choose' && p.pid === g.drawer) send(p, { t: 'choices', words: g.choices, ms: Math.max(0, g.endsAt - Date.now()) });
      if (g.phase === 'draw' || g.phase === 'reveal') {
        sendBoard(p);
        if (p.pid === g.drawer || g.guessed[p.pid]) send(p, { t: 'word', word: g.word });
      }
      if (g.phase === 'draw' && p.pid === g.drawer) clearTimeout(g.drawerGone);
      if (g.phase === 'draw' && p.pid !== g.drawer) g.eligible[p.pid] = true;
    }

    /* ------------------------------------------------------------------ game flow */
    function later(fn, ms) { g.timers.push(setTimeout(fn, ms)); }
    function clearTimers() {
      g.timers.forEach(clearTimeout); g.timers = [];
      clearInterval(g.tick); g.tick = null;
      clearTimeout(g.drawerGone);
    }

    function pickWords() {
      var pool = [];
      DD_WORD_PACKS.forEach(function (pk) {
        if (g.settings.packs.indexOf(pk.id) >= 0) pk.words.forEach(function (w) { pool.push(w); });
      });
      if (!pool.length) DD_WORD_PACKS.forEach(function (pk) { pool = pool.concat(pk.words); });
      var fresh = pool.filter(function (w) { return g.used.indexOf(w) < 0; });
      if (fresh.length < 3) { g.used = []; fresh = pool; }
      return DD.shuffle(fresh).slice(0, 3);
    }

    function startRound() {
      clearTimers();
      g.round++;
      g.order = connected().sort(function (a, b) { return a.joinedAt - b.joinedAt; }).map(function (p) { return p.pid; });
      g.turnIdx = -1;
      showRoundBanner();
    }
    function showRoundBanner() {
      g.phase = 'round'; g.drawer = ''; g.word = ''; g.endsAt = 0; g.guessed = {};
      pushState();
      later(nextTurn, CFG.roundSeconds * 1000);
    }

    function nextTurn() {
      clearTimers();
      g.word = ''; g.guessed = {}; g.revealed = [];
      for (;;) {
        g.turnIdx++;
        if (g.turnIdx >= g.order.length) {
          if (g.round >= g.settings.rounds) { endGame(); return; }
          startRound();
          return;
        }
        var p = g.players[g.order[g.turnIdx]];
        if (p && p.connected) break;
      }
      if (connected().length < 2) { endGame(); return; }
      g.drawer = g.order[g.turnIdx];
      g.phase = 'choose';
      g.choices = pickWords();
      g.endsAt = Date.now() + CFG.chooseSeconds * 1000;
      g.ops = [];
      broadcast({ t: 'board', reset: true });
      send(g.players[g.drawer], { t: 'choices', words: g.choices, ms: CFG.chooseSeconds * 1000 });
      pushState();
      later(function () { if (g.phase === 'choose') beginDrawing(0); }, CFG.chooseSeconds * 1000 + 300);
    }

    function handlePick(p, i) {
      if (g.phase !== 'choose' || p.pid !== g.drawer) return;
      i = parseInt(i, 10);
      beginDrawing(i >= 0 && i < g.choices.length ? i : 0);
    }

    function beginDrawing(i) {
      clearTimers();
      g.word = g.choices[i];
      g.used.push(g.word);
      g.phase = 'draw';
      g.guessed = {}; g.revealed = []; g.eligible = {};
      connected().forEach(function (p) { if (p.pid !== g.drawer) g.eligible[p.pid] = true; });
      g.startAt = Date.now();
      g.endsAt = g.startAt + g.settings.drawTime * 1000;
      send(g.players[g.drawer], { t: 'word', word: g.word });
      pushState();
      var letters = [];
      for (var k = 0; k < g.word.length; k++) if (/[a-z0-9]/i.test(g.word[k])) letters.push(k);
      var maxHints = g.settings.hints ? Math.min(3, Math.floor(letters.length / 3)) : 0;
      var marks = [0.5, 0.7, 0.85].slice(0, maxHints), lastSec = -1;
      letters = DD.shuffle(letters);
      g.tick = setInterval(function () {
        if (g.phase !== 'draw') return;
        var now = Date.now(), frac = (now - g.startAt) / (g.endsAt - g.startAt);
        while (marks.length && frac >= marks[0]) {
          marks.shift();
          var pos = letters.shift();
          if (pos !== undefined) { g.revealed.push(pos); pushState(); }
        }
        var sec = Math.ceil((g.endsAt - now) / 1000);
        if (sec !== lastSec) lastSec = sec;
        if (now >= g.endsAt) endTurn('time');
      }, 250);
    }

    function handleDraw(p, edits) {
      if (g.phase !== 'draw' || p.pid !== g.drawer || !Array.isArray(edits)) return;
      var clean = edits.slice(0, 200).filter(Array.isArray);
      clean.forEach(function (e) { DD.applyEdit(g.ops, e); });
      if (g.ops.length > 3000) g.ops.splice(0, g.ops.length - 3000);
      broadcast({ t: 'draw', e: clean }, p.pid);
    }

    function guessPoints() {
      var frac = Math.max(0, Math.min(1, (g.endsAt - Date.now()) / (g.endsAt - g.startAt)));
      return Math.max(50, Math.round((50 + 450 * frac) / 5) * 5);
    }
    function isClose(guess, word) {
      var a = guess.replace(/ /g, ''), b = word.replace(/ /g, '');
      if (b.length < 4 || a.length < 3) return false;
      return DD.distance(a, b) <= (b.length >= 8 ? 2 : 1);
    }

    function handleGuess(p, text) {
      text = String(text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
      if (!text) return;
      var now = Date.now();
      if (now - (g.lastChat[p.pid] || 0) < 350) return;
      g.lastChat[p.pid] = now;
      var chat = { t: 'chat', k: 'msg', pid: p.pid, name: p.name, text: text };
      if (g.phase !== 'draw') { broadcast(chat); return; }
      var guess = DD.norm(text), word = DD.norm(g.word);
      if (p.pid === g.drawer) {
        if (guess.replace(/ /g, '').indexOf(word.replace(/ /g, '')) >= 0 || isClose(guess, word)) {
          send(p, { t: 'chat', k: 'warn', text: 'You can\'t give the word away!' });
          return;
        }
        broadcast(chat);
        return;
      }
      if (g.guessed[p.pid]) {
        chat.k = 'secret';
        values(g.players).forEach(function (q) { if (q.pid === g.drawer || g.guessed[q.pid]) send(q, chat); });
        return;
      }
      if (guess.replace(/ /g, '') === word.replace(/ /g, '')) {
        var pts = guessPoints();
        g.guessed[p.pid] = pts;
        p.score += pts;
        send(p, { t: 'word', word: g.word });
        send(p, { t: 'you-guessed', pts: pts });
        broadcast({ t: 'chat', k: 'correct', pid: p.pid, name: p.name, text: p.name + ' guessed the word!' });
        pushState();
        checkAllGuessed();
        return;
      }
      broadcast(chat);
      if (isClose(guess, word)) send(p, { t: 'chat', k: 'close', text: '"' + text + '" is close!' });
    }

    function checkAllGuessed() {
      if (g.phase !== 'draw') return;
      var waiting = connected().filter(function (q) { return q.pid !== g.drawer && !g.guessed[q.pid]; });
      var anyGuessers = connected().some(function (q) { return q.pid !== g.drawer; });
      if (!anyGuessers || !waiting.length) later(function () { if (g.phase === 'draw') endTurn(anyGuessers ? 'all' : 'empty'); }, 600);
    }

    function endTurn(reason) {
      if (g.phase !== 'draw' && g.phase !== 'choose') return;
      clearTimers();
      var gains = [], drawer = g.players[g.drawer];
      if (!g.word && g.choices.length) g.word = g.choices[0];
      var correct = Object.keys(g.guessed).length;
      var eligibleN = Math.max(1, Object.keys(g.eligible).length);
      Object.keys(g.guessed).forEach(function (pid) { gains.push([pid, g.guessed[pid]]); });
      if (drawer && correct > 0 && reason !== 'drawer-left') {
        var dp = Math.round((100 + 300 * Math.min(1, correct / eligibleN)) / 5) * 5;
        drawer.score += dp;
        gains.push([drawer.pid, dp]);
      }
      gains.sort(function (a, b) { return b[1] - a[1]; });
      g.phase = 'reveal';
      g.endsAt = 0;
      broadcast({ t: 'reveal', word: g.word, drawer: g.drawer, reason: reason, gains: gains });
      pushState();
      later(nextTurn, CFG.turnEndSeconds * 1000);
    }

    function endGame() {
      clearTimers();
      g.phase = 'end'; g.drawer = ''; g.word = ''; g.endsAt = 0;
      pushState();
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ saving (resume after reload) */
    function save() {
      if (g.phase === 'end' || destroyed) return;
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          code: g.code, savedAt: Date.now(), started: g.started, settings: g.settings, round: g.round, order: g.order,
          turnIdx: g.phase === 'reveal' || g.phase === 'round' ? g.turnIdx : g.turnIdx - 1, banned: g.banned, used: g.used,
          players: values(g.players).map(function (p) { return { pid: p.pid, name: p.name, avatar: p.avatar, score: p.score, joinedAt: p.joinedAt }; })
        }));
      } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ host controls (local only) */
    self.setSettings = function (s) {
      if (g.phase !== 'lobby') { if ('locked' in s) { g.settings.locked = !!s.locked; pushState(); } return; }
      if (s.rounds) g.settings.rounds = Math.max(1, Math.min(6, parseInt(s.rounds, 10) || 2));
      if (s.drawTime) g.settings.drawTime = Math.max(30, Math.min(180, parseInt(s.drawTime, 10) || 80));
      if ('hints' in s) g.settings.hints = !!s.hints;
      if ('locked' in s) g.settings.locked = !!s.locked;
      if (Array.isArray(s.packs)) g.settings.packs = s.packs.filter(function (id) { return DD_WORD_PACKS.some(function (p) { return p.id === id; }); });
      pushState();
    };
    self.start = function () {
      if (g.phase !== 'lobby' || connected().length < 2) return false;
      if (g.started && g.round > 0) {          // resumed game
        showRoundBanner();
        return true;
      }
      g.started = true; g.round = 0;
      values(g.players).forEach(function (p) { p.score = 0; });
      startRound();
      return true;
    };
    self.kick = function (pid) {
      var p = g.players[pid];
      if (!p || p.host) return;
      g.banned[pid] = true;
      send(p, { t: 'kicked' });
      var c = p.conn;
      setTimeout(function () { try { if (c) c.close(); } catch (e) { /* ignore */ } }, 500);
      delete g.players[pid];
      g.order = g.order.filter(function (x) { return x !== pid; });
      sys(p.name + ' was removed');
      if (pid === g.drawer && (g.phase === 'draw' || g.phase === 'choose')) endTurn('drawer-left');
      else checkAllGuessed();
      pushState();
    };
    self.playAgain = function () {
      clearTimers();
      g.phase = 'lobby'; g.started = false; g.round = 0; g.turnIdx = -1; g.order = []; g.used = [];
      values(g.players).forEach(function (p) { p.score = 0; });
      pushState();
    };
    self.close = function () {
      destroyed = true;
      clearTimers();
      try { broadcast({ t: 'closed' }); } catch (e) { /* ignore */ }
      var p = peer; peer = null;
      setTimeout(function () { try { if (p) p.destroy(); } catch (e) { /* ignore */ } }, 700);
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    };
    /* The host's own player talks to the engine through this. */
    self.fromLocal = function (msg) { if (localConn) onData(localConn, msg); };
    self.connectedCount = function () { return connected().length; };

    /* ------------------------------------------------------------------ boot */
    localConn = DD.Link.local(events.local);
    localConn.__pid = me.pid;
    var mine = saved && saved.players.filter(function (p) { return p.pid === me.pid; })[0];
    addPlayer(me.pid, cleanName(me.name), me.avatar, localConn, true, mine ? mine.score : 0, mine ? mine.joinedAt : Date.now());
    if (saved) saved.players.forEach(function (sp) {
      if (sp.pid !== me.pid) { var p = addPlayer(sp.pid, sp.name, sp.avatar, null, false, sp.score, sp.joinedAt); p.connected = false; }
    });
    setTimeout(function () { syncPlayer(g.players[me.pid]); }, 0);
    openPeer(0);
  };

  DD.Host.readSaved = function () {
    try {
      var s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (!s || Date.now() - s.savedAt > 3 * 3600 * 1000) return null;
      return s;
    } catch (e) { return null; }
  };
  DD.Host.dropSaved = function () { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } };
})();
