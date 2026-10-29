/* Shared helpers: avatars, backgrounds, sounds, confetti, small utilities. */
(function () {
  'use strict';
  var DD = window.DD = window.DD || {};

  DD.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  DD.fmt = function (n) { return Number(n || 0).toLocaleString('en-GB'); };
  DD.newId = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); };
  DD.ordinal = function (n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  DD.shuffle = function (a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };

  /* ---------------- Avatars (image files listed in js/avatars.js) ---------------- */
  DD.AVATAR_GROUPS = window.TQ_AVATAR_GROUPS || [];
  DD.AVATARS = [];
  DD.AVATAR_SRC = {};
  DD.AVATAR_GROUPS.forEach(function (g) {
    g.items.forEach(function (it) { DD.AVATARS.push(it.id); DD.AVATAR_SRC[it.id] = it.src; });
  });
  DD.COLORS = ['#7b3fe4', '#1368ce', '#0aa3a3', '#26890c', '#d89e00', '#e05a00',
    '#e21b3c', '#d63384', '#ff8fb1', '#8fd3ff', '#455a64', '#2b2440'];
  DD.cleanAvatar = function (a) {
    a = a || {};
    return { id: DD.AVATAR_SRC[a.id] ? a.id : (DD.AVATARS[0] || ''), c: DD.COLORS.indexOf(a.c) >= 0 ? a.c : DD.COLORS[0] };
  };
  DD.avatarHTML = function (a, cls) {
    a = DD.cleanAvatar(a);
    var src = DD.AVATAR_SRC[a.id] || '';
    return '<span class="avatar ' + (cls || '') + '" style="--av:' + a.c + '">' +
      (src ? '<img alt="" draggable="false" src="' + DD.esc(src) + '">' : '') + '</span>';
  };

  /* ---------------- Backgrounds (photos in assets/bg, Unsplash licence) ---------------- */
  DD.THEMES = ['galaxy', 'night-sky', 'summit', 'beach', 'highlands', 'lake', 'mountain-lake', 'city', 'party', 'arcade'];
  DD.themeURL = function (id) { return 'assets/bg/' + (DD.THEMES.indexOf(id) >= 0 ? id : 'party') + '.jpg'; };
  DD.Backdrop = (function () {
    var layers = null, cur = 0, want = '';
    function init() {
      var root = document.getElementById('backdrop');
      root.innerHTML = '<div class="bd-img"></div><div class="bd-img"></div><div class="bd-shade"></div><div class="bd-glow"></div>';
      layers = root.querySelectorAll('.bd-img');
    }
    return {
      set: function (id) {
        if (!layers) init();
        var url = DD.themeURL(id);
        if (url === want) return;
        want = url;
        var img = new Image();
        img.onload = function () {
          if (want !== url) return;
          var next = layers[1 - cur];
          next.style.backgroundImage = 'url("' + url + '")';
          next.classList.remove('kb'); void next.offsetWidth;
          next.classList.add('on', 'kb');
          layers[cur].classList.remove('on');
          cur = 1 - cur;
        };
        img.src = url;
      }
    };
  })();

  DD.countUp = function (el, from, to, ms) {
    if (!el) return;
    var t0 = performance.now();
    ms = ms || 900;
    (function step(now) {
      var k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = DD.fmt(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  };

  /* ---------------- Sound: synthesised with Web Audio, no files ---------------- */
  DD.Sound = (function () {
    var ctx = null, master = null, muted = false;
    try { muted = localStorage.getItem('dd_muted') === '1'; } catch (e) { /* ignore */ }
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0.45;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(midi, start, dur, type, vol) {
      var c = ac();
      if (!c || muted) return;
      var o = c.createOscillator(), g = c.createGain(), t = c.currentTime + (start || 0);
      o.type = type || 'sine';
      o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.05);
    }
    return {
      isMuted: function () { return muted; },
      setMuted: function (m) { muted = !!m; try { localStorage.setItem('dd_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ } },
      unlock: function () { ac(); },
      pop: function () { tone(76, 0, 0.12, 'sine', 0.22); tone(83, 0.07, 0.15, 'sine', 0.18); },
      join: function () { tone(72, 0, 0.12, 'triangle', 0.2); tone(79, 0.09, 0.18, 'triangle', 0.2); },
      tick: function () { tone(93, 0, 0.05, 'square', 0.06); },
      chat: function () { tone(88, 0, 0.06, 'sine', 0.08); },
      close: function () { tone(70, 0, 0.12, 'triangle', 0.15); tone(68, 0.1, 0.16, 'triangle', 0.15); },
      correct: function () { [72, 76, 79, 84].forEach(function (m, i) { tone(m, i * 0.07, 0.28, 'triangle', 0.2); }); },
      other: function () { tone(79, 0, 0.12, 'triangle', 0.14); tone(84, 0.08, 0.2, 'triangle', 0.14); },
      start: function () { [60, 67, 72].forEach(function (m, i) { tone(m, i * 0.09, 0.3, 'triangle', 0.18); }); },
      end: function () { tone(57, 0, 0.9, 'triangle', 0.18); tone(64, 0.02, 0.8, 'sine', 0.12); },
      drum: function () { tone(40, 0, 0.18, 'sine', 0.33); },
      fanfare: function () {
        [[60, 0], [64, 0.15], [67, 0.3], [72, 0.45]].forEach(function (x) { tone(x[0], x[1], 0.3, 'triangle', 0.22); });
        [72, 76, 79].forEach(function (m) { tone(m, 0.65, 1.4, 'triangle', 0.15); });
      }
    };
  })();

  /* ---------------- Confetti ---------------- */
  DD.confetti = function (durationMs) {
    var cv = document.createElement('canvas');
    cv.className = 'confetti';
    document.body.appendChild(cv);
    var g = cv.getContext('2d'), W, H, parts = [], end = Date.now() + (durationMs || 4000);
    function size() { W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
    size();
    window.addEventListener('resize', size);
    var cols = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#ffffff', '#ff7ac6', '#7af7ff'];
    (function frame() {
      if (Date.now() < end) for (var i = 0; i < 5; i++) {
        parts.push({ x: Math.random() * W, y: -20, vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, r: Math.random() * 3,
          vr: (Math.random() - 0.5) * 0.3, w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, c: cols[(Math.random() * cols.length) | 0] });
      }
      g.clearRect(0, 0, W, H);
      parts = parts.filter(function (p) { return p.y < H + 30; });
      parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
      });
      if (parts.length || Date.now() < end) requestAnimationFrame(frame);
      else { window.removeEventListener('resize', size); cv.remove(); }
    })();
  };

  DD.toast = function (msg, ms) {
    document.querySelectorAll('.toast').forEach(function (old) { old.remove(); });
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 400); }, ms || 3000);
  };

  DD.copyText = function (text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    }
    return Promise.resolve(fallback());
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
  };

  /* Normalise a guess or a word for comparing: lower case, no accents/punctuation, single spaces. */
  DD.norm = function (s) {
    s = String(s || '').toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  };
  /* Edit distance, capped (only needed for "is close"). */
  DD.distance = function (a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };
})();
