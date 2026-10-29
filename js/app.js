/* Doodle Dash app: screens, joining, and the game view. The same page serves the host and every player. */
(function () {
  'use strict';
  var CFG = window.DD_CONFIG, S = DD.Sound, esc = DD.esc;
  var PREF_KEY = 'dd_profile', ME_KEY = 'dd_me';
  function $(id) { return document.getElementById(id); }
  function rnd(list) { return list[Math.floor(Math.random() * list.length)]; }
  var isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  /* ------------------------------------------------------------------ identity */
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  var myPid = '';
  try { myPid = localStorage.getItem(ME_KEY) || ''; } catch (e) { myPid = ''; }
  if (!myPid) { myPid = 'u' + DD.newId(); try { localStorage.setItem(ME_KEY, myPid); } catch (e) { /* ignore */ } }
  var avatar = DD.cleanAvatar({ id: DD.AVATAR_SRC[prefs.id] ? prefs.id : rnd(DD.AVATARS), c: prefs.c || rnd(DD.COLORS) });
  var avTab = Math.max(0, DD.AVATAR_GROUPS.findIndex(function (gr) { return gr.items.some(function (it) { return it.id === avatar.id; }); }));
  var myName = prefs.name || '';

  /* ------------------------------------------------------------------ session state */
  var mode = '';                 // 'host' | 'player'
  var engine = null;             // DD.Host when this device is hosting
  var pin = '', joined = false, finished = false;
  var peer = null, conn = null, retryTimer = null, connectTimer = null, netTries = 0, wakeLock = null;
  var st = null;                 // latest public state from the host
  var myWord = '', choices = null, choicesUntil = 0, lastReveal = null, lastPhase = '', lastDrawer = '';
  var timerEnd = 0, timerTotal = 0, lastTickSec = -1, hostNet = '';
  var board = new DD.Board($('board'));

  /* ------------------------------------------------------------------ screens */
  function show(name) {
    document.querySelectorAll('.screen').forEach(function (el) {
      var on = el.id === 'scr-' + name;
      if (on && el.hidden) { el.hidden = false; el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
      else if (!on) el.hidden = true;
    });
    document.body.setAttribute('data-screen', name);
    if (name !== 'game') window.scrollTo(0, 0);
  }
  function message(html, buttons) {
    $('msg-body').innerHTML = html + (buttons ? '<div class="msg-actions">' + buttons + '</div>' : '');
    show('msg');
  }
  function confirmBox(html, yesText) {
    return new Promise(function (resolve) {
      var d = $('dlg');
      $('dlg-body').innerHTML = html;
      $('dlg-yes').textContent = yesText || 'OK';
      function done(v) { $('dlg-yes').onclick = $('dlg-no').onclick = null; d.close(); resolve(v); }
      $('dlg-yes').onclick = function () { done(true); };
      $('dlg-no').onclick = function () { done(false); };
      d.showModal();
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-go]');
    if (b) goHome();
  });

  /* Keep the game screen exactly the visible height, also while the phone keyboard is open. */
  function fitViewport() {
    var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
    if (document.body.getAttribute('data-screen') === 'game') window.scrollTo(0, 0);
  }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
  window.addEventListener('resize', fitViewport);
  fitViewport();

  /* ------------------------------------------------------------------ home */
  function goHome() {
    leaveGame(true);
    renderResume();
    show('home');
  }
  function renderResume() {
    var s = DD.Host.readSaved(), box = $('resume-box');
    if (!s || !s.started) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div><b>Your game was interrupted</b><br><small>PIN ' + esc(s.code) + ' · ' + s.players.length + ' players · round ' +
      Math.max(1, s.round) + ' of ' + s.settings.rounds + '</small></div>' +
      '<div class="row"><button class="go small" id="rs-go">Resume</button><button class="soft small" id="rs-drop">Discard</button></div>';
    $('rs-go').onclick = function () { S.unlock(); startHosting(s); };
    $('rs-drop').onclick = function () { DD.Host.dropSaved(); box.hidden = true; };
  }
  $('btn-create').onclick = function () { S.unlock(); openProfile('create'); };
  $('btn-join').onclick = function () { S.unlock(); goPin(''); };
  function muteIcon() { $('btn-mute').textContent = S.isMuted() ? '🔇' : '🔊'; }
  $('btn-mute').onclick = function () { S.unlock(); S.setMuted(!S.isMuted()); muteIcon(); };

  /* ------------------------------------------------------------------ PIN */
  function goPin(err) {
    show('pin');
    $('pin-err').textContent = err || '';
    $('in-pin').value = pin || '';
    setTimeout(function () { $('in-pin').focus(); }, 50);
  }
  $('in-pin').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });
  $('in-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') onPin(); });
  $('btn-pin').onclick = onPin;
  function onPin() {
    var p = $('in-pin').value.replace(/\D/g, '');
    if (p.length !== 6) { flashErr('pin-err', 'Enter the 6-digit PIN from the person who made the game.'); return; }
    pin = p;
    openProfile('join');
  }
  function flashErr(id, msg) { var e = $(id); e.textContent = ''; void e.offsetWidth; e.textContent = msg; }

  /* ------------------------------------------------------------------ profile */
  var profMode = 'join';
  function openProfile(m, err) {
    profMode = m;
    $('btn-prof').textContent = m === 'create' ? 'Create game' : 'Join game';
    $('btn-prof').disabled = false;
    $('prof-pin-lbl').innerHTML = m === 'join' ? 'Game PIN <b>' + esc(pin) + '</b> · <a href="#" id="prof-pin-change">change</a>' : '';
    if (m === 'join') $('prof-pin-change').onclick = function (e) { e.preventDefault(); goPin(''); };
    $('in-name').value = myName;
    renderPicker(true);
    $('prof-err').textContent = err || '';
    show('profile');
    if (!myName && !isTouch) setTimeout(function () { $('in-name').focus(); }, 50);
  }
  $('prof-back').onclick = function () { if (profMode === 'join') goPin(''); else goHome(); };
  function renderPicker(full) {
    if (full) {
      $('av-tabs').innerHTML = DD.AVATAR_GROUPS.map(function (gr, i) {
        return '<button type="button" data-tab="' + i + '" class="' + (i === avTab ? 'sel' : '') + '">' + esc(gr.name) + '</button>';
      }).join('');
      var grp = DD.AVATAR_GROUPS[avTab] || { items: [] };
      $('av-grid').innerHTML = grp.items.map(function (it, k) {
        return '<button type="button" data-id="' + esc(it.id) + '" style="animation-delay:' + (k * 0.02) + 's;background:' + avatar.c + '" class="' +
          (it.id === avatar.id ? 'sel' : '') + '"><img alt="" draggable="false" src="' + esc(it.src) + '"></button>';
      }).join('');
      $('col-grid').innerHTML = DD.COLORS.map(function (c) {
        return '<button type="button" data-c="' + c + '" style="background:' + c + '" class="' + (c === avatar.c ? 'sel' : '') + '" aria-label="colour"></button>';
      }).join('');
    } else {
      $('av-grid').querySelectorAll('button').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-id') === avatar.id); b.style.background = avatar.c; });
      $('col-grid').querySelectorAll('button').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-c') === avatar.c); });
    }
    $('prof-preview').innerHTML = DD.avatarHTML(avatar, 'big bounce');
  }
  $('av-tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) { avTab = +b.getAttribute('data-tab'); renderPicker(true); } });
  $('av-grid').addEventListener('click', function (e) { var b = e.target.closest('[data-id]'); if (b) { avatar.id = b.getAttribute('data-id'); renderPicker(false); S.pop(); } });
  $('col-grid').addEventListener('click', function (e) { var b = e.target.closest('[data-c]'); if (b) { avatar.c = b.getAttribute('data-c'); renderPicker(false); } });
  $('in-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); onProfile(); } });
  $('btn-prof').onclick = onProfile;
  function onProfile() {
    S.unlock();
    var n = $('in-name').value.replace(/\s+/g, ' ').trim().slice(0, CFG.maxNameLength);
    if (!n) { flashErr('prof-err', 'Pick a nickname first.'); $('in-name').focus(); return; }
    myName = n;
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ name: n, id: avatar.id, c: avatar.c })); } catch (e) { /* ignore */ }
    $('in-name').blur();
    if (profMode === 'create') { DD.Host.dropSaved(); startHosting(null); }
    else joinGame();
  }

  /* ------------------------------------------------------------------ hosting */
  function startHosting(saved) {
    leaveGame(true);
    mode = 'host'; finished = false; joined = true;
    if (saved) {
      var mine = saved.players.filter(function (p) { return p.pid === myPid; })[0];
      if (mine) { myName = mine.name; avatar = DD.cleanAvatar(mine.avatar); }
    }
    message('<div class="spinner"></div><h2>Opening your game…</h2>', '<button class="soft" data-go="home">Cancel</button>');
    engine = new DD.Host({ pid: myPid, name: myName, avatar: avatar }, saved, {
      local: onMsg,
      net: function (status, code) {
        var n = $('net');
        n.hidden = false;
        n.className = 'net ' + (status === 'ready' ? 'ok' : 'bad');
        n.textContent = { ready: 'Online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', reclaiming: 'Getting your PIN back…', error: 'Connection problem' }[status] || status;
        hostNet = status;
        if (status === 'ready') pin = code;
        if (st) render();
      }
    });
    keepAwake();
  }
  function keepAwake() {
    if (!('wakeLock' in navigator) || mode !== 'host') return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }, function () { /* not allowed */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (mode === 'host' && engine) keepAwake();
    if (mode === 'player' && joined && !finished && (!conn || !conn.open)) { clearTimeout(retryTimer); connect(); }
  });

  /* ------------------------------------------------------------------ joining (players) */
  function joinGame() {
    leaveGame(true);
    mode = 'player'; finished = false; joined = false; netTries = 0;
    message('<div class="spinner"></div><h2>Joining game ' + esc(pin) + '…</h2>', '<button class="soft" data-go="home">Cancel</button>');
    connect();
  }
  function connect() {
    clearTimeout(retryTimer);
    if (finished || mode !== 'player') return;
    if (!peer || peer.destroyed) {
      var pp = peer = new window.Peer(CFG.peerPrefix + 'p-' + DD.newId(), CFG.peerOptions);
      pp.on('open', function () { if (pp === peer) dial(); });
      pp.on('error', function (e) { if (pp === peer) onPeerError(e); });
      pp.on('disconnected', function () {
        if (pp !== peer || pp.destroyed || finished) return;
        setTimeout(function () { if (pp === peer && !pp.destroyed && pp.disconnected) { try { pp.reconnect(); } catch (e) { /* ignore */ } } }, 1000);
      });
    } else if (peer.open) dial();
    else retryTimer = setTimeout(connect, 1500);
  }
  function dial() {
    if (finished) return;
    if (conn) { var old = conn; conn = null; try { old.close(); } catch (e) { /* ignore */ } }
    var c = conn = DD.Link.dial(peer, CFG.peerPrefix + pin), opened = false;
    clearTimeout(connectTimer);
    connectTimer = setTimeout(function () {
      if (opened || c !== conn) return;
      conn = null; try { c.close(); } catch (e) { /* ignore */ }
      if (!joined) failJoin('The game didn\'t answer. Check the PIN, and that the person who made it still has it open.');
      else lost();
    }, 15000);
    c.on('open', function () {
      if (c !== conn) return;
      opened = true; clearTimeout(connectTimer);
      c.send({ t: 'join', pid: myPid, name: myName, avatar: avatar });
    });
    c.on('data', function (d) { if (c === conn) onMsg(d); });
    c.on('close', function () { if (c === conn) { conn = null; lost(); } });
  }
  function onPeerError(e) {
    var type = e && e.type;
    if (conn && conn.open) return;
    if (!conn && type === 'peer-unavailable') return;
    clearTimeout(connectTimer);
    var dead = conn; conn = null;
    try { if (dead) dead.close(); } catch (er) { /* ignore */ }
    if (type === 'peer-unavailable') {
      if (!joined) { finished = true; destroyPeer(); goPin('No game found with PIN ' + pin + '. Check the number.'); }
      else lost();
    } else if (!joined && netTries < 5) {
      netTries++;
      destroyPeer();
      retryTimer = setTimeout(connect, 1500 * netTries);
    } else if (!joined) failJoin('Couldn\'t reach the game service. Check your internet and try again.');
    else lost();
  }
  function failJoin(msg) {
    finished = true; destroyPeer();
    openProfile('join', msg);
  }
  function lost() {
    if (finished) return;
    if (!joined) { failJoin('Connection to the game failed. Try again.'); return; }
    $('reconnect').hidden = false;
    $('reconnect-text').textContent = 'Connection lost. Reconnecting…';
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 2000);
  }
  function destroyPeer() {
    var p = peer; peer = null;
    try { if (p) p.destroy(); } catch (e) { /* ignore */ }
  }
  $('btn-give-up').onclick = function () { goHome(); };

  function toHost(msg) {
    if (engine) engine.fromLocal(msg);
    else if (conn && conn.open) { try { conn.send(msg); } catch (e) { /* ignore */ } }
  }

  /* Tear down whatever game this device is in. */
  function leaveGame(silent) {
    finished = true;
    clearTimeout(retryTimer); clearTimeout(connectTimer);
    if (engine) { engine.close(); engine = null; }
    if (conn) { try { conn.close(); } catch (e) { /* ignore */ } conn = null; }
    destroyPeer();
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    $('reconnect').hidden = true;
    $('net').hidden = true;
    mode = ''; st = null; joined = false; myWord = ''; hostNet = ''; choices = null; lastReveal = null; lastPhase = ''; lastDrawer = '';
    $('chat-log').innerHTML = '';
    board.reset(); board.setEnabled(false);
  }

  /* ------------------------------------------------------------------ messages from the host */
  function onMsg(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'welcome':
        joined = true; netTries = 0;
        $('reconnect').hidden = true;
        myName = d.name; avatar = DD.cleanAvatar(d.avatar);
        break;
      case 'state': onState(d); break;
      case 'choices': choices = d.words; choicesUntil = Date.now() + d.ms; renderOverlay(); break;
      case 'word': myWord = d.word; renderTop(); break;
      case 'board': if (d.reset) board.reset(); break;
      case 'draw': board.receive(d.e || []); break;
      case 'chat': addChat(d); break;
      case 'you-guessed':
        S.correct();
        flash('🎉 You got it! +' + DD.fmt(d.pts));
        break;
      case 'reveal':
        lastReveal = d;
        S.end();
        renderOverlay();
        break;
      case 'kicked': bye('The host removed you from this game.'); break;
      case 'closed': bye('The host closed the game. Thanks for playing!'); break;
      case 'locked': bye('This game is locked. Ask the host to unlock it so you can join.'); break;
      case 'full': bye('This game is full.'); break;
      case 'replaced': bye('You joined this game from another tab, so this one was disconnected.'); break;
    }
  }
  function bye(text) {
    finished = true; destroyPeer();
    $('reconnect').hidden = true;
    message('<div class="big-emoji">👋</div><h2>' + esc(text) + '</h2>', '<button class="primary" data-go="home">Back to start</button>');
  }

  function onState(d) {
    var prev = st;
    st = d;
    if (d.phase === 'choose' || d.phase === 'round' || d.phase === 'lobby' || d.phase === 'end') myWord = '';
    if (d.phase !== 'choose') choices = null;
    if (d.phase !== lastPhase) {
      if (d.phase === 'round') S.start();
      if (d.phase === 'choose') { lastReveal = null; myWord = ''; }
      if (d.phase === 'draw') lastTickSec = -1;
      if (d.phase === 'end') S.fanfare();
    }
    if (d.remainingMs) { timerEnd = Date.now() + d.remainingMs; timerTotal = d.phase === 'draw' ? d.totalMs : CFG.chooseSeconds * 1000; }
    else { timerEnd = 0; }
    if (prev && prev.phase === 'lobby' && d.phase === 'lobby') {
      var before = prev.players.length, after = d.players.length;
      if (after > before) S.join();
    }
    lastPhase = d.phase; lastDrawer = d.drawer;
    render();
  }

  function me() { return st && st.players.filter(function (p) { return p.pid === myPid; })[0]; }
  function playerById(pid) { return st && st.players.filter(function (p) { return p.pid === pid; })[0]; }
  function amHost() { return mode === 'host'; }

  function render() {
    if (!st) return;
    if (st.phase === 'lobby') { renderLobby(); show('lobby'); return; }
    if (st.phase === 'end') { renderEnd(); show('end'); return; }
    if (document.body.getAttribute('data-screen') !== 'game') { show('game'); fitViewport(); }
    renderTop(); renderPlayers(); renderOverlay(); renderTools();
  }

  /* ------------------------------------------------------------------ lobby */
  var DRAW_TIMES = [60, 80, 100, 120];
  function renderLobby() {
    var online = !amHost() || hostNet === 'ready';
    $('lb-pin').textContent = online ? (st.code || pin) : '······';
    $('lb-share').disabled = $('lb-copy').disabled = !online;
    $('lb-phone-tip').hidden = !(amHost() && isTouch);
    var n = st.players.filter(function (p) { return p.on; }).length;
    $('lb-count').textContent = n;
    $('lb-kick-hint').textContent = amHost() && st.players.length > 1 ? '· tap a player to remove them' : '';
    var box = $('lb-players'), seen = {};
    st.players.forEach(function (p) {
      seen[p.pid] = 1;
      var el = box.querySelector('[data-pid="' + CSS.escape(p.pid) + '"]');
      var html = DD.avatarHTML(p.avatar) + '<span class="nm">' + esc(p.name) + (p.pid === myPid ? ' <small>(you)</small>' : '') + '</span>' +
        (p.host ? '<span class="crown" title="Host">👑</span>' : '');
      if (!el) { el = document.createElement('div'); el.setAttribute('data-pid', p.pid); box.appendChild(el); }
      if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
      el.className = 'chip' + (p.on ? '' : ' off') + (amHost() && !p.host ? ' kickable' : '');
    });
    box.querySelectorAll('[data-pid]').forEach(function (el) { if (!seen[el.getAttribute('data-pid')]) el.remove(); });

    var s = st.settings, host = st.players.filter(function (p) { return p.host; })[0];
    var packs = DD_WORD_PACKS.map(function (pk) {
      var on = s.packs.indexOf(pk.id) >= 0;
      return '<button type="button" class="pack' + (on ? ' on' : '') + '" data-pack="' + pk.id + '"' + (amHost() ? '' : ' disabled') + '>' + pk.icon + ' ' + esc(pk.name) + '</button>';
    }).join('');
    if (amHost()) {
      $('lb-settings').innerHTML =
        '<div class="sec-title">Game settings</div>' +
        '<div class="set-row"><span>Rounds</span><div class="stepper"><button type="button" data-rounds="-1">−</button><b>' + s.rounds + '</b><button type="button" data-rounds="1">+</button></div></div>' +
        '<div class="set-row"><span>Drawing time</span><div class="opts">' + DRAW_TIMES.map(function (t) {
          return '<button type="button" class="opt' + (s.drawTime === t ? ' on' : '') + '" data-time="' + t + '">' + t + 's</button>';
        }).join('') + '</div></div>' +
        '<div class="set-row"><span>Letter hints</span>' + toggle('hints', s.hints) + '</div>' +
        '<div class="set-row"><span>Lock room <small>nobody new can join</small></span>' + toggle('locked', s.locked) + '</div>' +
        '<div class="set-col"><span>Words</span><div class="packs">' + packs + '</div></div>';
    } else {
      $('lb-settings').innerHTML = '<div class="sec-title">Game settings</div>' +
        '<div class="set-row"><span>Rounds</span><b>' + s.rounds + '</b></div>' +
        '<div class="set-row"><span>Drawing time</span><b>' + s.drawTime + 's</b></div>' +
        '<div class="set-row"><span>Letter hints</span><b>' + (s.hints ? 'On' : 'Off') + '</b></div>' +
        (s.locked ? '<div class="set-row"><span>Room</span><b>🔒 Locked</b></div>' : '') +
        '<div class="set-col"><span>Words</span><div class="packs">' + packs + '</div></div>';
    }
    var foot = $('lb-foot');
    if (amHost()) {
      var can = n >= 2 && online;
      foot.innerHTML = '<button class="go big' + (can ? ' ready' : '') + '" id="lb-start"' + (can ? '' : ' disabled') + '>' +
        (st.started ? '▶ Continue game' : '▶ Start game') + '</button>' +
        '<div class="foot-note">' + (!online ? 'Getting your game online…' : can ? 'Everyone in? Let\'s go!' : 'Waiting for at least one more player… Share the PIN!') + '</div>';
      $('lb-start').onclick = function () { S.unlock(); if (!engine.start()) DD.toast('You need at least 2 players.'); };
    } else {
      foot.innerHTML = '<div class="waiting-host">' + (host ? DD.avatarHTML(host.avatar, 'sm') : '') +
        '<span class="dots">Waiting for ' + esc(host ? host.name : 'the host') + ' to start</span></div>';
    }
  }
  function toggle(name, on) {
    return '<button type="button" class="toggle' + (on ? ' on' : '') + '" data-toggle="' + name + '"' + (amHost() ? '' : ' disabled') + '><i></i></button>';
  }
  $('lb-settings').addEventListener('click', function (e) {
    if (!amHost() || !st) return;
    var s = st.settings, b;
    if ((b = e.target.closest('[data-rounds]'))) engine.setSettings({ rounds: s.rounds + parseInt(b.getAttribute('data-rounds'), 10) });
    else if ((b = e.target.closest('[data-time]'))) engine.setSettings({ drawTime: parseInt(b.getAttribute('data-time'), 10) });
    else if ((b = e.target.closest('[data-toggle]'))) { var k = b.getAttribute('data-toggle'), o = {}; o[k] = !s[k]; engine.setSettings(o); }
    else if ((b = e.target.closest('[data-pack]'))) {
      var id = b.getAttribute('data-pack'), packs = s.packs.slice(), i = packs.indexOf(id);
      if (i >= 0) { if (packs.length === 1) { DD.toast('Keep at least one word pack.'); return; } packs.splice(i, 1); } else packs.push(id);
      engine.setSettings({ packs: packs });
    }
  });
  $('lb-players').addEventListener('click', function (e) {
    var el = e.target.closest('[data-pid]');
    if (!el || !amHost()) return;
    var p = playerById(el.getAttribute('data-pid'));
    if (!p || p.host) return;
    kickPrompt(p);
  });
  function kickPrompt(p) {
    confirmBox(DD.avatarHTML(p.avatar, 'med') + '<h3>Remove ' + esc(p.name) + '?</h3><p>They won\'t be able to come back into this game.</p>', 'Remove').then(function (ok) {
      if (ok && engine) engine.kick(p.pid);
    });
  }
  function inviteLink() { return new URL('.', location.href).href + '?pin=' + (st ? st.code : pin); }
  $('lb-share').onclick = function () {
    var link = inviteLink(), text = 'Join my Doodle Dash game! PIN ' + (st ? st.code : pin);
    if (navigator.share) { navigator.share({ title: 'Doodle Dash', text: text, url: link }).catch(function () { /* cancelled */ }); return; }
    DD.copyText(text + ' ' + link).then(function (ok) { DD.toast(ok ? 'Invite copied. Paste it in your chat.' : link, ok ? 2500 : 8000); });
  };
  $('lb-copy').onclick = function () {
    DD.copyText(inviteLink()).then(function (ok) { DD.toast(ok ? 'Link copied.' : inviteLink(), ok ? 2000 : 8000); });
  };
  $('lb-leave').onclick = function () {
    if (amHost()) {
      confirmBox('<h3>Close this game?</h3><p>Everyone in the lobby will be disconnected.</p>', 'Close game').then(function (ok) { if (ok) goHome(); });
    } else goHome();
  };

  /* ------------------------------------------------------------------ game view */
  function renderTop() {
    if (!st) return;
    $('g-round').textContent = 'Round ' + Math.max(1, st.round) + '/' + st.rounds;
    var w = $('g-word'), isDrawer = st.drawer === myPid;
    if (st.phase === 'draw' && myWord) {
      w.className = 'g-word known';
      w.innerHTML = '<small>' + (isDrawer ? 'Draw this' : 'You guessed it') + '</small><span>' + esc(myWord) + '</span>';
    } else if (st.phase === 'draw' && st.hint) {
      var letters = st.hint.replace(/[^a-z0-9_]/gi, '').length;
      w.className = 'g-word';
      w.innerHTML = '<small>Guess the word · ' + letters + ' letters</small><span class="hint">' +
        st.hint.split('').map(function (c) { return c === ' ' ? '<i class="gap"></i>' : '<b>' + (c === '_' ? '' : esc(c)) + '</b>'; }).join('') + '</span>';
    } else if (st.phase === 'choose') {
      var d = playerById(st.drawer);
      w.className = 'g-word';
      w.innerHTML = '<small>' + (isDrawer ? 'Your turn to draw!' : 'Next up') + '</small><span>' + esc(isDrawer ? 'Pick a word' : (d ? d.name : '') + ' is choosing') + '</span>';
    } else {
      w.className = 'g-word';
      w.innerHTML = '';
    }
  }

  function renderPlayers() {
    var ranked = st.players.slice().sort(function (a, b) { return b.score - a.score; });
    $('g-players').innerHTML = st.players.map(function (p) {
      var rank = ranked.indexOf(p) + 1;
      var cls = 'pl' + (p.on ? '' : ' off') + (p.g ? ' got' : '') + (p.pid === st.drawer ? ' drawing' : '') + (p.pid === myPid ? ' me' : '');
      var badge = p.pid === st.drawer ? '<span class="badge">✏️</span>' : p.g ? '<span class="badge">✔</span>' : '';
      return '<div class="' + cls + '" data-pid="' + esc(p.pid) + '"><span class="rk">#' + rank + '</span>' + DD.avatarHTML(p.avatar, 'sm') + badge +
        '<span class="pn">' + esc(p.name) + (p.host ? ' 👑' : '') + '</span><span class="ps">' + DD.fmt(p.score) + '</span></div>';
    }).join('');
  }
  $('g-players').addEventListener('click', function (e) {
    var el = e.target.closest('[data-pid]');
    if (!el || !amHost()) return;
    var p = playerById(el.getAttribute('data-pid'));
    if (p && !p.host) kickPrompt(p);
  });

  function renderOverlay() {
    if (!st) return;
    var ov = $('overlay'), html = '', isDrawer = st.drawer === myPid, d = playerById(st.drawer);
    if (st.phase === 'round') {
      html = '<div class="ov-card pop"><div class="ov-small">Get ready</div><div class="ov-big">Round ' + st.round + '<small> of ' + st.rounds + '</small></div></div>';
    } else if (st.phase === 'choose') {
      if (isDrawer && choices) {
        html = '<div class="ov-card pop"><div class="ov-small">Your turn! Choose a word to draw</div><div class="choices">' +
          choices.map(function (w, i) { return '<button type="button" class="choice" data-pick="' + i + '" style="animation-delay:' + (i * 0.08) + 's">' + esc(w) + '</button>'; }).join('') +
          '</div><div class="ov-small"><span id="choose-left"></span></div></div>';
      } else {
        html = '<div class="ov-card pop">' + (d ? DD.avatarHTML(d.avatar, 'med') : '') + '<div class="ov-mid"><span class="dots">' + esc(d ? d.name : 'Someone') + ' is choosing a word</span></div></div>';
      }
    } else if (st.phase === 'reveal') {
      var r = lastReveal;
      if (r) {
        var why = { all: 'Everyone guessed it! 🎉', time: 'Time\'s up!', 'drawer-left': 'The artist left the game.', empty: 'Nobody left to guess.' }[r.reason] || '';
        var gains = r.gains.length ? r.gains.map(function (x) {
          var p = playerById(x[0]);
          return p ? '<div class="gain">' + DD.avatarHTML(p.avatar, 'sm') + '<span>' + esc(p.name) + (x[0] === r.drawer ? ' <small>✏️ artist</small>' : '') + '</span><b>+' + DD.fmt(x[1]) + '</b></div>' : '';
        }).join('') : '<div class="gain none">Nobody guessed it this time 😅</div>';
        html = '<div class="ov-card pop"><div class="ov-small">' + why + '</div><div class="ov-small">The word was</div><div class="ov-word">' + esc(r.word) + '</div><div class="gains">' + gains + '</div></div>';
      } else html = '<div class="ov-card pop"><div class="ov-mid"><span class="dots">Next turn coming up</span></div></div>';
    }
    ov.hidden = !html;
    if (ov.getAttribute('data-h') !== html) { ov.innerHTML = html; ov.setAttribute('data-h', html); }
  }
  $('overlay').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pick]');
    if (!b || !st || st.phase !== 'choose') return;
    S.pop();
    $('overlay').querySelectorAll('[data-pick]').forEach(function (x) { x.disabled = true; x.classList.toggle('picked', x === b); });
    toHost({ t: 'pick', i: parseInt(b.getAttribute('data-pick'), 10) });
  });

  function flash(text) {
    var f = $('flash');
    f.textContent = text;
    f.hidden = false;
    f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { f.hidden = true; }, 2600);
  }

  /* Drawing tools (only for the artist) */
  var tool = { mode: 'pen', color: '#000000', size: DD.SIZES[1] };
  $('palette').innerHTML = DD.PALETTE.map(function (c) { return '<button type="button" data-color="' + c + '" style="background:' + c + '" aria-label="colour"></button>'; }).join('');
  $('sizes').innerHTML = DD.SIZES.map(function (s, i) { return '<button type="button" data-size="' + s + '" title="Size"><i style="width:' + (6 + i * 5) + 'px;height:' + (6 + i * 5) + 'px"></i></button>'; }).join('');
  function syncTools() {
    board.setTool(tool);
    $('palette').querySelectorAll('[data-color]').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-color') === tool.color); });
    $('sizes').querySelectorAll('[data-size]').forEach(function (b) { b.classList.toggle('sel', +b.getAttribute('data-size') === tool.size); b.querySelector('i').style.background = tool.mode === 'eraser' ? '#999' : tool.color; });
    $('modes').querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-mode') === tool.mode); });
  }
  $('palette').addEventListener('click', function (e) { var b = e.target.closest('[data-color]'); if (b) { tool.color = b.getAttribute('data-color'); if (tool.mode === 'eraser') tool.mode = 'pen'; syncTools(); } });
  $('sizes').addEventListener('click', function (e) { var b = e.target.closest('[data-size]'); if (b) { tool.size = +b.getAttribute('data-size'); if (tool.mode === 'fill') tool.mode = 'pen'; syncTools(); } });
  $('modes').addEventListener('click', function (e) { var b = e.target.closest('[data-mode]'); if (b) { tool.mode = b.getAttribute('data-mode'); syncTools(); } });
  $('t-undo').onclick = function () { board.undo(); };
  $('t-clear').onclick = function () {
    if (board.isEmpty()) return;
    confirmBox('<h3>Clear the whole drawing?</h3>', 'Clear').then(function (ok) { if (ok) board.clear(); });
  };
  board.onEdits = function (edits) { toHost({ t: 'draw', e: edits }); };
  syncTools();

  function renderTools() {
    var drawing = st.phase === 'draw' && st.drawer === myPid;
    $('tools').hidden = !drawing;
    board.setEnabled(drawing);
    document.body.classList.toggle('is-drawer', st.drawer === myPid && (st.phase === 'draw' || st.phase === 'choose'));
    var inp = $('chat-in');
    var guessed = (me() || {}).g;
    inp.placeholder = st.phase !== 'draw' ? 'Say something…' : st.drawer === myPid ? 'Chat (you can\'t say the word)…' : guessed ? 'Chat with others who got it…' : 'Type your guess…';
  }

  /* Chat */
  function addChat(d) {
    var log = $('chat-log'), el = document.createElement('div'), p = d.pid ? playerById(d.pid) : null;
    el.className = 'msg k-' + d.k;
    if (d.k === 'msg' || d.k === 'secret') {
      el.innerHTML = (p ? DD.avatarHTML(p.avatar, 'xs') : '') + '<b>' + esc(d.name) + '</b> ' + esc(d.text);
      if (d.pid !== myPid) S.chat();
    } else if (d.k === 'correct') {
      el.innerHTML = (p ? DD.avatarHTML(p.avatar, 'xs') : '') + '✔ ' + esc(d.text);
      if (d.pid !== myPid) S.other();
    } else {
      el.textContent = d.text;
      if (d.k === 'close') S.close();
    }
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(el);
    while (log.children.length > 150) log.removeChild(log.firstChild);
    if (atBottom || d.pid === myPid) log.scrollTop = log.scrollHeight;
  }
  $('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('chat-in'), text = inp.value.trim();
    if (!text) return;
    toHost({ t: 'guess', text: text });
    inp.value = '';
  });

  /* Timer ring + countdown, every frame */
  var RING = 2 * Math.PI * 19;
  (function loop() {
    requestAnimationFrame(loop);
    if (!st || document.body.getAttribute('data-screen') !== 'game') return;
    var bar = $('g-timer-bar'), num = $('g-timer-num'), box = $('g-timer');
    if (!timerEnd || (st.phase !== 'draw' && st.phase !== 'choose')) { box.classList.add('idle'); num.textContent = ''; bar.style.strokeDashoffset = 0; return; }
    box.classList.remove('idle');
    var rem = Math.max(0, timerEnd - Date.now()), sec = Math.ceil(rem / 1000);
    num.textContent = sec;
    bar.style.strokeDasharray = RING;
    bar.style.strokeDashoffset = (RING * (1 - rem / Math.max(1, timerTotal))).toFixed(1);
    box.classList.toggle('low', st.phase === 'draw' && sec <= 10);
    if (st.phase === 'draw' && sec !== lastTickSec) { if (sec <= 10 && sec > 0) S.tick(); lastTickSec = sec; }
    var cl = $('choose-left');
    if (cl) cl.textContent = Math.max(0, Math.ceil((choicesUntil - Date.now()) / 1000)) + 's left';
  })();

  /* ------------------------------------------------------------------ end screen */
  function renderEnd() {
    var r = st.players.slice().sort(function (a, b) { return b.score - a.score; });
    $('podium').innerHTML = [1, 0, 2].map(function (ix) {
      var p = r[ix];
      if (!p) return '<div class="pod"></div>';
      return '<div class="pod p' + (ix + 1) + '" style="animation-delay:' + ({ 2: 0.2, 1: 0.6, 0: 1.1 })[ix] + 's">' + (ix === 0 ? '<div class="crown-big">👑</div>' : '') +
        DD.avatarHTML(p.avatar, ix === 0 ? 'huge' : 'big') + '<div class="nm">' + esc(p.name) + '</div><div class="pts">' + DD.fmt(p.score) + ' pts</div>' +
        '<div class="block">' + (ix + 1) + '</div></div>';
    }).join('');
    $('final-list').innerHTML = r.slice(3).map(function (p, k) {
      return '<div class="final-row"><b>' + (k + 4) + '</b>' + DD.avatarHTML(p.avatar, 'sm') + '<span class="fr-name">' + esc(p.name) + '</span><span>' + DD.fmt(p.score) + '</span></div>';
    }).join('');
    $('end-actions').innerHTML = amHost()
      ? '<button class="go big" id="end-again">🔁 Play again</button><button class="soft" id="end-close">Close game</button>'
      : '<div class="waiting-host"><span class="dots">Waiting for the host</span></div><button class="soft" data-go="home">Leave</button>';
    if (amHost()) {
      $('end-again').onclick = function () { engine.playAgain(); };
      $('end-close').onclick = function () { goHome(); };
    }
    if (r[0] && r[0].pid === myPid) DD.confetti(5000);
  }

  window.addEventListener('beforeunload', function (e) {
    if (mode === 'host' && st && st.phase !== 'lobby' && st.phase !== 'end') { e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------------------------------------------ start */
  muteIcon();
  DD.Backdrop.set('party');
  var params = new URLSearchParams(location.search);
  var startPin = (params.get('pin') || '').replace(/\D/g, '').slice(0, 6);
  if (startPin.length === 6) { pin = startPin; openProfile('join'); }
  else { renderResume(); show('home'); }

  // Automated tests only.
  window.__dd = { get state() { return st; }, get word() { return myWord; }, get choices() { return choices; }, get engine() { return engine; }, board: board };
})();
