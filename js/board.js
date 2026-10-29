/*
 * Drawing board.
 *
 * Everything is drawn on a fixed 1000x750 picture (so every phone and laptop shows exactly the
 * same drawing, and the fill bucket gives the same result everywhere), then scaled to the screen.
 *
 * A drawing is a list of operations:
 *   stroke {t:'s', id, c:'#rrggbb', w:size, p:[x,y,x,y,...]}   fill {t:'f', id, c, x, y}
 * Live changes travel as small edits:
 *   ['ds', id, c, w, x, y]  start a stroke     ['dp', id, x, y, x, y...]  more points
 *   ['de', id]              end of stroke      ['df', id, c, x, y]        fill
 *   ['du']                  undo last          ['dc']                     clear
 */
(function () {
  'use strict';
  var DD = window.DD = window.DD || {};
  var W = 1000, H = 750;
  DD.BOARD_W = W; DD.BOARD_H = H;

  DD.PALETTE = ['#000000', '#5c5c5c', '#a8a8a8', '#ffffff', '#e21b3c', '#ff7a1a', '#ffd23f', '#3fbf3f',
    '#1a7f37', '#2bc4f2', '#1368ce', '#7b3fe4', '#ff6ec7', '#8b4a23', '#f2c29b', '#6b0f1a'];
  DD.SIZES = [4, 10, 22, 44];

  function clampInt(v, lo, hi) { v = Math.round(+v || 0); return v < lo ? lo : v > hi ? hi : v; }
  function okColor(c) { return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '#000000'; }
  function okId(id) { return String(id || '').slice(0, 24); }

  /* Apply one live edit to a plain list of operations (used by the host to keep the official copy). */
  DD.applyEdit = function (ops, e) {
    if (!Array.isArray(e)) return;
    var k = e[0], last;
    if (k === 'ds') ops.push({ t: 's', id: okId(e[1]), c: okColor(e[2]), w: clampInt(e[3], 1, 80), p: [clampInt(e[4], -50, W + 50), clampInt(e[5], -50, H + 50)] });
    else if (k === 'dp') {
      last = ops[ops.length - 1];
      if (!last || last.t !== 's' || last.id !== okId(e[1]) || last.p.length > 6000) return;
      for (var i = 2; i + 1 < e.length; i += 2) last.p.push(clampInt(e[i], -50, W + 50), clampInt(e[i + 1], -50, H + 50));
    } else if (k === 'df') ops.push({ t: 'f', id: okId(e[1]), c: okColor(e[2]), x: clampInt(e[3], 0, W - 1), y: clampInt(e[4], 0, H - 1) });
    else if (k === 'du') ops.pop();
    else if (k === 'dc') ops.length = 0;
  };
  /* Turn a list of operations back into edits, cut into pieces that fit in one network message. */
  DD.opsToEdits = function (ops) {
    var out = [];
    ops.forEach(function (o) {
      if (o.t === 'f') { out.push(['df', o.id, o.c, o.x, o.y]); return; }
      out.push(['ds', o.id, o.c, o.w, o.p[0], o.p[1]]);
      for (var i = 2; i < o.p.length; i += 240) out.push(['dp', o.id].concat(o.p.slice(i, i + 240)));
      out.push(['de', o.id]);
    });
    return out;
  };
  DD.chunkEdits = function (edits, maxChars) {
    var chunks = [], cur = [], size = 0;
    edits.forEach(function (e) {
      var s = JSON.stringify(e).length + 1;
      if (cur.length && size + s > maxChars) { chunks.push(cur); cur = []; size = 0; }
      cur.push(e); size += s;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
  };

  /* ---------------- Rendering helpers ---------------- */
  function mid(ax, ay, bx, by) { return [(ax + bx) / 2, (ay + by) / 2]; }
  function styleStroke(g, o) {
    g.strokeStyle = o.c; g.fillStyle = o.c; g.lineWidth = o.w; g.lineCap = 'round'; g.lineJoin = 'round';
  }
  /* Draw the part of stroke o between point index a (exclusive start) and b; b === n draws the tail too. */
  function drawStrokePart(g, o, from, to, finished) {
    var p = o.p, n = p.length / 2;
    styleStroke(g, o);
    if (n === 1) {
      if (from === 0 && to >= 1) { g.beginPath(); g.arc(p[0], p[1], o.w / 2, 0, Math.PI * 2); g.fill(); }
      return;
    }
    g.beginPath();
    for (var k = Math.max(1, from); k < to; k++) {
      var x0 = p[2 * k - 2], y0 = p[2 * k - 1], x1 = p[2 * k], y1 = p[2 * k + 1];
      var m1 = mid(x0, y0, x1, y1);
      if (k === 1) { g.moveTo(x0, y0); g.lineTo(m1[0], m1[1]); continue; }
      var m0 = mid(p[2 * k - 4], p[2 * k - 3], x0, y0);
      g.moveTo(m0[0], m0[1]);
      g.quadraticCurveTo(x0, y0, m1[0], m1[1]);
    }
    if (finished && to >= n && n >= 2) {
      var lm = mid(p[2 * n - 4], p[2 * n - 3], p[2 * n - 2], p[2 * n - 1]);
      g.moveTo(lm[0], lm[1]); g.lineTo(p[2 * n - 2], p[2 * n - 1]);
    }
    g.stroke();
  }

  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  /* Scan-line flood fill with a tolerance, then grow the area by 1 px so it tucks under antialiased edges. */
  function floodFill(g, x, y, color) {
    var img = g.getImageData(0, 0, W, H), d = img.data, start = (y * W + x) * 4;
    var sr = d[start], sg = d[start + 1], sb = d[start + 2], col = hex(color), TOL = 60;
    if (Math.abs(sr - col[0]) + Math.abs(sg - col[1]) + Math.abs(sb - col[2]) < 8) return;
    var mask = new Uint8Array(W * H), stack = [x, y];
    function match(i) {
      var j = i * 4;
      return !mask[i] && Math.abs(d[j] - sr) + Math.abs(d[j + 1] - sg) + Math.abs(d[j + 2] - sb) <= TOL;
    }
    while (stack.length) {
      var py = stack.pop(), px = stack.pop(), i = py * W + px;
      while (px > 0 && match(i - 1)) { px--; i--; }
      var up = false, down = false;
      for (; px < W && match(i); px++, i++) {
        mask[i] = 1;
        if (py > 0) { if (match(i - W)) { if (!up) { stack.push(px, py - 1); up = true; } } else up = false; }
        if (py < H - 1) { if (match(i + W)) { if (!down) { stack.push(px, py + 1); down = true; } } else down = false; }
      }
    }
    for (var yy = 0; yy < H; yy++) {
      for (var xx = 0; xx < W; xx++) {
        var ii = yy * W + xx;
        var paint = mask[ii] === 1 || (xx > 0 && mask[ii - 1] === 1) || (xx < W - 1 && mask[ii + 1] === 1) ||
          (yy > 0 && mask[ii - W] === 1) || (yy < H - 1 && mask[ii + W] === 1);
        if (paint) { var q = ii * 4; d[q] = col[0]; d[q + 1] = col[1]; d[q + 2] = col[2]; d[q + 3] = 255; }
      }
    }
    g.putImageData(img, 0, 0);
  }

  /* ---------------- The board widget ---------------- */
  DD.Board = function (canvas) {
    var self = this;
    var art = document.createElement('canvas');
    art.width = W; art.height = H;
    var ag = art.getContext('2d', { willReadFrequently: true });
    var view = canvas.getContext('2d');
    var ops = [], drawn = {}, finished = {};
    var queue = [];           // remote edits waiting to be played back smoothly
    var dirty = true, raf = 0;
    var tool = { mode: 'pen', color: '#000000', size: 10 };
    var enabled = false, active = null, pending = [], flushTimer = null, idSeq = 0;
    self.onEdits = null;      // called with an array of edits made on this device

    function clearArt() { ag.fillStyle = '#ffffff'; ag.fillRect(0, 0, W, H); }
    clearArt();

    function replay() {
      clearArt();
      ops.forEach(function (o) {
        if (o.t === 'f') floodFill(ag, o.x, o.y, o.c);
        else drawStrokePart(ag, o, 0, o.p.length / 2, finished[o.id] !== false);
        if (o.t === 's') drawn[o.id] = o.p.length / 2;
      });
      dirty = true;
    }

    /* Apply an edit to the picture right now. */
    function applyNow(e) {
      var k = e[0], last;
      if (k === 'ds') {
        DD.applyEdit(ops, e);
        last = ops[ops.length - 1];
        finished[last.id] = false; drawn[last.id] = 1;
        drawStrokePart(ag, last, 0, 1, false);
      } else if (k === 'dp') {
        last = ops[ops.length - 1];
        if (!last || last.t !== 's' || last.id !== okId(e[1])) return;
        var before = last.p.length / 2;
        DD.applyEdit(ops, e);
        var after = last.p.length / 2;
        if (before === 1) { /* first segment replaces the dot */ }
        drawStrokePart(ag, last, before, after, false);
        drawn[last.id] = after;
      } else if (k === 'de') {
        last = ops[ops.length - 1];
        if (!last || last.t !== 's' || last.id !== okId(e[1])) return;
        finished[last.id] = true;
        var n = last.p.length / 2;
        drawStrokePart(ag, last, n, n, true);
      } else if (k === 'df') {
        DD.applyEdit(ops, e);
        last = ops[ops.length - 1];
        floodFill(ag, last.x, last.y, last.c);
      } else if (k === 'du') {
        if (!ops.length) return;
        DD.applyEdit(ops, e);
        replay();
      } else if (k === 'dc') {
        DD.applyEdit(ops, e);
        replay();
      }
      dirty = true;
    }

    /* Remote edits: points are played back over ~a quarter second so drawing looks live, not jumpy. */
    function frame() {
      raf = requestAnimationFrame(frame);
      if (queue.length) {
        var pts = 0;
        queue.forEach(function (e) { if (e[0] === 'dp') pts += (e.length - 2) / 2; });
        var budget = Math.max(4, Math.ceil(pts / 14));
        while (queue.length && budget > 0) {
          var e = queue[0];
          if (e[0] === 'dp' && (e.length - 2) / 2 > budget) {
            applyNow(e.slice(0, 2 + budget * 2));
            queue[0] = [e[0], e[1]].concat(e.slice(2 + budget * 2));
            budget = 0;
          } else {
            queue.shift();
            applyNow(e);
            budget -= e[0] === 'dp' ? (e.length - 2) / 2 : 1;
          }
        }
      }
      if (dirty) {
        dirty = false;
        view.imageSmoothingQuality = 'high';
        view.drawImage(art, 0, 0, canvas.width, canvas.height);
      }
    }
    raf = requestAnimationFrame(frame);

    function fit() {
      var r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
    }
    if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas);
    window.addEventListener('resize', fit);
    fit();

    /* ---------- Local drawing (pointer input) ---------- */
    function toBoard(ev) {
      var r = canvas.getBoundingClientRect();
      return [Math.round((ev.clientX - r.left) / r.width * W), Math.round((ev.clientY - r.top) / r.height * H)];
    }
    function emit(e) { pending.push(e); if (!flushTimer) flushTimer = setTimeout(flush, 60); }
    function flush() {
      flushTimer = null;
      if (!pending.length) return;
      var out = pending; pending = [];
      // merge consecutive point edits of the same stroke
      var merged = [];
      out.forEach(function (e) {
        var prev = merged[merged.length - 1];
        if (e[0] === 'dp' && prev && prev[0] === 'dp' && prev[1] === e[1] && prev.length < 400) merged[merged.length - 1] = prev.concat(e.slice(2));
        else merged.push(e);
      });
      if (self.onEdits) self.onEdits(merged);
    }
    function local(e) { flushQueue(); applyNow(e); emit(e); }
    function flushQueue() { while (queue.length) applyNow(queue.shift()); }
    function newStrokeId() { return 'k' + Date.now().toString(36).slice(-5) + (idSeq++).toString(36); }

    canvas.addEventListener('pointerdown', function (ev) {
      if (!enabled || ev.button > 0) return;
      ev.preventDefault();
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      var pt = toBoard(ev);
      if (tool.mode === 'fill') {
        if (pt[0] >= 0 && pt[0] < W && pt[1] >= 0 && pt[1] < H) local(['df', newStrokeId(), tool.color, pt[0], pt[1]]);
        return;
      }
      active = { id: newStrokeId(), last: pt, pointer: ev.pointerId };
      local(['ds', active.id, tool.mode === 'eraser' ? '#ffffff' : tool.color, tool.mode === 'eraser' ? Math.max(tool.size, 22) : tool.size, pt[0], pt[1]]);
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!active || ev.pointerId !== active.pointer) return;
      ev.preventDefault();
      var list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      if (!list.length) list = [ev];
      var e = ['dp', active.id];
      list.forEach(function (ce) {
        var pt = toBoard(ce), dx = pt[0] - active.last[0], dy = pt[1] - active.last[1];
        if (dx * dx + dy * dy < 9) return;
        e.push(pt[0], pt[1]);
        active.last = pt;
      });
      if (e.length > 2) local(e);
    });
    function up(ev) {
      if (!active || (ev && ev.pointerId !== active.pointer)) return;
      local(['de', active.id]);
      active = null;
      flush();
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);

    /* ---------- Public API ---------- */
    self.setEnabled = function (on) {
      enabled = !!on;
      canvas.classList.toggle('can-draw', enabled);
      if (!enabled && active) up();
    };
    self.setTool = function (t) { Object.keys(t).forEach(function (k) { tool[k] = t[k]; }); canvas.setAttribute('data-tool', tool.mode); };
    self.getTool = function () { return tool; };
    self.undo = function () { if (enabled && ops.length) { local(['du']); flush(); } };
    self.clear = function () { if (enabled && ops.length) { local(['dc']); flush(); } };
    self.isEmpty = function () { return !ops.length; };
    self.receive = function (edits) { edits.forEach(function (e) { if (Array.isArray(e)) queue.push(e); }); };
    self.reset = function () {
      queue = []; ops = []; drawn = {}; finished = {}; active = null; pending = [];
      clearTimeout(flushTimer); flushTimer = null;
      clearArt(); dirty = true;
    };
    self.snapshotPNG = function () { return art.toDataURL('image/png'); };
    self.opsCount = function () { return ops.length; };
  };
})();
