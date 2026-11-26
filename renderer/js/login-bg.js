/* Beabots login background: aurora layers + animated "workflow network" canvas.
   Purely decorative; does not touch the form or login.js. */
(function () {
  var amb = document.querySelector(".ambient");
  if (!amb) return;

  amb.insertAdjacentHTML(
    "afterbegin",
    '<div class="bg-aurora" aria-hidden="true"><i></i><i></i><i></i></div>' +
    '<canvas class="bg-net" aria-hidden="true"></canvas>' +
    '<div class="bg-beam" aria-hidden="true"></div>' +
    '<div class="bg-vignette" aria-hidden="true"></div>'
  );

  var canvas = amb.querySelector(".bg-net");
  var ctx = canvas.getContext("2d");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var W = 0, H = 0, dpr = 1, nodes = [], packets = [], links = [], rgb = "45,212,191", raf = 0;
  var LINK = 150;

  function readAccent() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    var m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) {
      var n = parseInt(m[1], 16);
      rgb = ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = amb.clientWidth; H = amb.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var count = Math.max(18, Math.min(80, Math.round((W * H) / 17000)));
    nodes = [];
    for (var i = 0; i < count; i++) {
      nodes.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28,
        r: 1 + Math.random() * 1.6, ph: Math.random() * 6.28
      });
    }
    packets = [];
    if (reduce) frame(0);
  }

  // Fades the network near the card so the form stays the focus.
  function fade(x, y) {
    var e = Math.hypot((x - W / 2) / (Math.min(W, 520) * 0.5), (y - H / 2) / (Math.min(H, 560) * 0.5));
    return 0.3 + 0.7 * Math.min(1, e);
  }

  function spawnPacket() {
    if (!links.length) return;
    var l = links[(Math.random() * links.length) | 0];
    packets.push({ a: l[0], b: l[1], t: 0, s: 0.006 + Math.random() * 0.008 });
  }

  function frame(time) {
    ctx.clearRect(0, 0, W, H);
    var i, j, a, b;

    if (!reduce) {
      for (i = 0; i < nodes.length; i++) {
        a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < -20) a.x = W + 20; else if (a.x > W + 20) a.x = -20;
        if (a.y < -20) a.y = H + 20; else if (a.y > H + 20) a.y = -20;
      }
    }

    links.length = 0;
    ctx.lineWidth = 1;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          var d = Math.sqrt(d2);
          var al = (1 - d / LINK) * 0.42 * fade((a.x + b.x) / 2, (a.y + b.y) / 2);
          ctx.strokeStyle = "rgba(" + rgb + "," + al.toFixed(3) + ")";
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          links.push([i, j]);
        }
      }
    }

    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      var pulse = 0.55 + 0.45 * Math.sin(time / 900 + a.ph);
      var f = fade(a.x, a.y);
      ctx.fillStyle = "rgba(" + rgb + "," + (0.18 * pulse * f).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r * 3.4, 0, 6.2832); ctx.fill();
      ctx.fillStyle = "rgba(" + rgb + "," + (0.85 * f).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill();
    }

    if (!reduce) {
      if (packets.length < 7 && Math.random() < 0.05) spawnPacket();
      for (i = packets.length - 1; i >= 0; i--) {
        var p = packets[i], na = nodes[p.a], nb = nodes[p.b];
        p.t += p.s;
        var ddx = na.x - nb.x, ddy = na.y - nb.y;
        if (p.t >= 1 || ddx * ddx + ddy * ddy > LINK * LINK) { packets.splice(i, 1); continue; }
        var px = na.x + (nb.x - na.x) * p.t, py = na.y + (nb.y - na.y) * p.t;
        var pf = fade(px, py);
        ctx.fillStyle = "rgba(" + rgb + "," + (0.25 * pf).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(px, py, 7, 0, 6.2832); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255," + (0.9 * pf).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(px, py, 2, 0, 6.2832); ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }
  }

  // Gentle pointer parallax on the aurora layer.
  if (!reduce && window.matchMedia("(pointer: fine)").matches) {
    window.addEventListener("pointermove", function (e) {
      amb.style.setProperty("--px", ((e.clientX / window.innerWidth - 0.5) * -28).toFixed(1));
      amb.style.setProperty("--py", ((e.clientY / window.innerHeight - 0.5) * -22).toFixed(1));
    }, { passive: true });
  }

  // Pause when the tab is hidden.
  document.addEventListener("visibilitychange", function () {
    if (reduce) return;
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(frame);
  });

  // Re-read the accent color when the theme toggles.
  new MutationObserver(function () { readAccent(); if (reduce) frame(0); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  var rt;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(resize, 150); });

  readAccent();
  resize();
  if (!reduce) raf = requestAnimationFrame(frame);
})();
