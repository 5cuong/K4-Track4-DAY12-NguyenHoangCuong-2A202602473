/* app.js — "Phòng phát lại · Bài lab Day 12": three.js street scene (ReplaySim) in which the models of the Day 12 lab drive.
   One panel only: pick a planner, a training seed and a scene (lead car brakes, the lab's cut-in, or a real Argoverse log),
   see all five planners side by side, the gap over time, and the release gate of the lab. Models and data come from
   lab_models.js / lab_data.js (scripts/export_viz.py). */
(function () {
  "use strict";
  var S = window.ReplaySim, T = window.THREE;
  if (!S || !T) { document.getElementById("body").innerHTML = "<p>Không tải được thư viện 3D. Mở lại trang khi có mạng.</p>"; return; }
  var DT = S.DT, T_END = S.T_END, NF = S.NF, ROAD = S.ROAD, CX = ROAD.crossX, SIG = S.SIG;
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash(a, b, c) { var h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function fmt(x, d) { return (+x).toFixed(d == null ? 1 : d).replace(".", ","); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function ease(u) { u = clamp(u, 0, 1); return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ================================================================== palette (CSS tokens -> three colours and canvas strings)
  var KEYS = ["sc-bg", "sc-ground", "sc-road", "sc-mark", "sc-walk", "sc-yel", "sc-bldg", "sc-bldg2", "sc-edge", "sc-glass", "sc-tree", "sc-trunk", "sc-sky",
    "sc-gnd-light", "sc-cab", "sc-wheel", "sc-off", "car-1", "car-2", "car-3", "car-4", "car-dark", "bus", "ego", "adv", "ped", "scan", "scan-live", "plan",
    "blue", "teal", "purple", "gold", "green", "grey", "hit", "amber", "ink", "ink-2", "ink-3", "line", "chip", "panel-solid"];
  var PAL = {}, CSS = {}, MATS = {}, onTheme = [];
  function readPal() { var cs = getComputedStyle(document.documentElement); KEYS.forEach(function (k) { var v = cs.getPropertyValue("--" + k).trim() || "#888"; CSS[k] = v; PAL[k] = new T.Color(v); }); }
  function isDark() { return PAL["sc-bg"].getHSL({}).l < .3; }
  function mat(key, opts, Type) { var m = new (Type || T.MeshLambertMaterial)(Object.assign({}, opts || {})); (MATS[key] = MATS[key] || []).push(m); if (PAL[key]) m.color.copy(PAL[key]); return m; }
  function applyPal() { readPal(); Object.keys(MATS).forEach(function (k) { MATS[k].forEach(function (m) { m.color.copy(PAL[k]); }); }); onTheme.forEach(function (f) { f(); }); plotDirty = true; }
  readPal();

  // ================================================================== renderer, scene, lights
  var stage = $("stage"), labelsEl = $("labels");
  var renderer = new T.WebGLRenderer({ antialias: true });
  var PR = Math.min(window.devicePixelRatio || 1, 1.5), slowAcc = 0;
  renderer.setPixelRatio(PR);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
  stage.insertBefore(renderer.domElement, labelsEl);
  var scene = new T.Scene(); scene.background = new T.Color(); scene.fog = new T.Fog(0xffffff, 150, 560);
  var camera = new T.PerspectiveCamera(38, 1, 0.3, 2500);
  var hemi = new T.HemisphereLight(0xffffff, 0x888888, 0.75); scene.add(hemi);
  var sun = new T.DirectionalLight(0xffffff, 0.75); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); var shc = sun.shadow.camera; shc.left = -70; shc.right = 70; shc.top = 70; shc.bottom = -70; shc.near = 10; shc.far = 400;
  sun.shadow.bias = -0.0008; scene.add(sun); scene.add(sun.target);
  function applyEnv() {
    var dark = isDark();
    scene.background.copy(PAL["sc-bg"]); scene.fog.color.copy(PAL["sc-bg"]); renderer.setClearColor(PAL["sc-bg"]);
    hemi.color.copy(PAL["sc-sky"]); hemi.groundColor.copy(PAL["sc-gnd-light"]); hemi.intensity = dark ? 0.62 : 0.52;
    sun.color.set(0xffffff); sun.intensity = dark ? 0.55 : 0.6;
  }
  onTheme.push(applyEnv);

  // ================================================================== camera rig: orbit around the ego, chase behind it, or free; one target per split view
  var rig = { tx: 0, tz: 2, dist: 70, yaw: 3.3, pitch: 0.62, mode: "follow", lead: 8 }, tween = null;
  var VT = [{ x: 0, z: 0, snap: true }, { x: 0, z: 0, snap: true }];
  function camTo(p, dur) {
    var from = { dist: rig.dist, yaw: rig.yaw, pitch: rig.pitch, lead: rig.lead }, to = Object.assign({}, from, p);
    var dy = to.yaw - from.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); to.yaw = from.yaw + dy;
    tween = { from: from, to: to, t0: performance.now(), dur: REDUCED ? 1 : (dur || 1400) };
  }
  function stepTween() {
    if (!tween) return;
    var u = ease((performance.now() - tween.t0) / tween.dur);
    ["dist", "yaw", "pitch", "lead"].forEach(function (k) { rig[k] = tween.from[k] + (tween.to[k] - tween.from[k]) * u; });
    if (u >= 1) tween = null;
  }
  function placeCamera(dtReal, ego, vi) {
    var V = VT[vi];
    if (rig.mode === "free") { V.x = rig.tx; V.z = rig.tz; }
    else if (ego) {
      var gx = ego.x + ego.hx * rig.lead, gz = ego.z + ego.hz * rig.lead, k = V.snap ? 1 : 1 - Math.exp(-dtReal * 6);
      V.x += (gx - V.x) * k; V.z += (gz - V.z) * k; V.snap = false;
      if (rig.mode === "chase" && vi === 0 && !tween) { var want = Math.atan2(-ego.hz, -ego.hx), d = Math.atan2(Math.sin(want - rig.yaw), Math.cos(want - rig.yaw)); rig.yaw += d * (1 - Math.exp(-dtReal * 3)); }
    }
    var cp = Math.cos(rig.pitch);
    camera.position.set(V.x + rig.dist * cp * Math.cos(rig.yaw), rig.dist * Math.sin(rig.pitch), V.z + rig.dist * cp * Math.sin(rig.yaw));
    camera.lookAt(V.x, 1, V.z);
  }
  function setCam(m) {
    if (m === "free") { rig.tx = VT[0].x; rig.tz = VT[0].z; }
    rig.mode = m; var b = $("camBtn"); b.textContent = m === "follow" ? "theo xe" : m === "chase" ? "sau xe" : "tự do";
    if (m === "chase") camTo({ dist: 20, pitch: 0.3, lead: 6 }, 900);
  }
  (function pointer() {
    var el = renderer.domElement, ptrs = {}, last = null, pinch = 0;
    el.addEventListener("pointerdown", function (e) { ptrs[e.pointerId] = [e.clientX, e.clientY]; el.setPointerCapture(e.pointerId); last = [e.clientX, e.clientY]; tween = null; });
    el.addEventListener("pointermove", function (e) {
      if (!ptrs[e.pointerId]) return;
      var ids = Object.keys(ptrs);
      if (ids.length === 2) {
        ptrs[e.pointerId] = [e.clientX, e.clientY];
        var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) rig.dist = clamp(rig.dist * pinch / d, 6, 420); pinch = d; return;
      }
      var dx = e.clientX - last[0], dy = e.clientY - last[1]; last = [e.clientX, e.clientY]; ptrs[e.pointerId] = last;
      if (e.shiftKey || e.buttons === 2) {
        if (rig.mode !== "free") setCam("free");
        var s = rig.dist * 0.0016, cy = Math.cos(rig.yaw), sy = Math.sin(rig.yaw);
        rig.tx += (sy * dx + cy * dy) * s; rig.tz += (-cy * dx + sy * dy) * s;
      } else { if (rig.mode === "chase") setCam("follow"); rig.yaw += dx * 0.006; rig.pitch = clamp(rig.pitch + dy * 0.004, 0.06, 1.48); }
    });
    function up(e) { delete ptrs[e.pointerId]; pinch = 0; }
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    el.addEventListener("wheel", function (e) { e.preventDefault(); tween = null; rig.dist = clamp(rig.dist * Math.exp(e.deltaY * 0.0012), 6, 420); }, { passive: false });
  })();

  // ================================================================== static world
  var BOX = new T.BoxGeometry(1, 1, 1), PLANE = new T.PlaneGeometry(1, 1); PLANE.rotateX(-Math.PI / 2);
  var world = new T.Group(); scene.add(world);
  var XA = -220, XB = 660;
  var ground = new T.Mesh(new T.PlaneGeometry(1800, 1200).rotateX(-Math.PI / 2), mat("sc-ground")); ground.receiveShadow = true; ground.position.x = 220; world.add(ground);
  var roadMat = mat("sc-road"), walkMat = mat("sc-walk");
  function flat(x0, x1, z0, z1, y, m) { var o = new T.Mesh(PLANE, m); o.scale.set(x1 - x0, 1, z1 - z0); o.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); o.receiveShadow = true; world.add(o); return o; }
  function walkBox(x0, x1, z0, z1) { var o = new T.Mesh(BOX, walkMat); o.scale.set(x1 - x0, 0.16, z1 - z0); o.position.set((x0 + x1) / 2, 0.08, (z0 + z1) / 2); o.receiveShadow = true; world.add(o); }
  flat(XA, XB, -ROAD.half, ROAD.half, 0.02, roadMat);
  flat(CX - 7, CX + 7, -320, 320, 0.021, roadMat);
  [[XA, CX - 10.5], [CX + 10.5, XB]].forEach(function (r) { walkBox(r[0], r[1], 7, 10.8); walkBox(r[0], r[1], -10.8, -7); });
  [[-320, -7], [7, 320]].forEach(function (r) { walkBox(CX - 10.5, CX - 7, r[0], r[1]); walkBox(CX + 7, CX + 10.5, r[0], r[1]); });
  var marks = [], ymarks = [];
  function dashes(x0, x1, z, len, gap, w, skip, out) { for (var x = x0; x < x1; x += len + gap) { if (skip && x + len > skip[0] && x < skip[1]) continue; (out || marks).push([x + len / 2, z, len, w]); } }
  var skipX = [CX - 9.5, CX + 9.5];
  dashes(XA, XB, 3.5, 3, 6, 0.15, skipX); dashes(XA, XB, -3.5, 3, 6, 0.15, skipX);
  dashes(XA, XB, 6.8, 9, 0.001, 0.16, skipX); dashes(XA, XB, -6.8, 9, 0.001, 0.16, skipX);
  dashes(XA, XB, 0.12, 9, 0.001, 0.12, skipX, ymarks); dashes(XA, XB, -0.12, 9, 0.001, 0.12, skipX, ymarks);
  for (var zz = -6.5; zz <= 6.6; zz += 1.0) marks.push([ROAD.walkX, zz, 3, 0.5]);                 // zebra
  marks.push([ROAD.stopE + 0.2, 3.5, 0.35, 7]); marks.push([ROAD.stopW - 0.2, -3.5, 0.35, 7]);    // stop lines on the main road
  marks.push([CX + 3.5, ROAD.stopN + 0.2, 7, 0.35]); marks.push([CX - 3.5, -ROAD.stopN - 0.2, 7, 0.35]);
  [[-320, -9], [9, 320]].forEach(function (r) { for (var z = r[0]; z < r[1]; z += 9) ymarks.push([CX, z + 1.5, 0.12, 3]); });
  // bus bay box
  [[ROAD.busX - 9, 6.95, 18, 0.12], [ROAD.busX - 9, 3.6, 18, 0.12]].forEach(function (b) { marks.push([b[0] + b[2] / 2, b[1], b[2], b[3]]); });
  function instStrips(list, m) {
    var im = new T.InstancedMesh(PLANE, m, list.length), o = new T.Object3D();
    list.forEach(function (d, i) { o.position.set(d[0], 0.035, d[1]); o.scale.set(d[2], 1, d[3]); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
    im.receiveShadow = true; world.add(im); return im;
  }
  instStrips(marks, mat("sc-mark", {}, T.MeshBasicMaterial));
  instStrips(ymarks, mat("sc-yel", {}, T.MeshBasicMaterial));
  // the words "BUS" are left to the reader; a yellow kerb marks the stop
  flat(ROAD.busX - 9, ROAD.busX + 9, 7.0, 7.3, 0.17, mat("sc-yel", {}, T.MeshBasicMaterial));

  // buildings: deterministic blocks; they are LiDAR targets and appear in the scanned map
  var BLD = [];
  (function genBuildings() {
    var r = rng(23);
    [1, -1].forEach(function (side) {
      var x = XA + 10;
      while (x < XB - 10) {
        var w = 10 + r() * 22;
        if (x + w > CX - 14 && x < CX + 14) { x = CX + 14 + r() * 3; continue; }
        var depth = 12 + r() * 22, h = 6 + Math.pow(r(), 1.7) * 26, z0 = side > 0 ? 13 + r() * 3 : -13 - r() * 3 - depth;
        BLD.push({ x0: x, x1: x + w - 1.8, z0: z0, z1: z0 + depth, h: h, glass: r() < 0.2, tone: r() < 0.5 });
        x += w;
      }
    });
    [-42, -74, 44, 76, 108, -106].forEach(function (zc, i) {
      BLD.push({ x0: CX - 32, x1: CX - 13, z0: zc - 13, z1: zc + 13, h: 9 + 7 * (i % 2), glass: i === 1, tone: true });
      BLD.push({ x0: CX + 13, x1: CX + 33, z0: zc - 13, z1: zc + 13, h: 11 + 6 * (i % 3), glass: false, tone: false });
    });
  })();
  var bldMat = new T.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
  var bldMesh = new T.InstancedMesh(BOX, bldMat, BLD.length); bldMesh.castShadow = true; bldMesh.receiveShadow = true; world.add(bldMesh);
  (function () { var o = new T.Object3D(); BLD.forEach(function (b, i) { o.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2); o.scale.set(b.x1 - b.x0, b.h, b.z1 - b.z0); o.updateMatrix(); bldMesh.setMatrixAt(i, o.matrix); }); })();
  function colorBuildings() { BLD.forEach(function (b, i) { bldMesh.setColorAt(i, b.glass ? PAL["sc-glass"] : b.tone ? PAL["sc-bldg"] : PAL["sc-bldg2"]); }); if (bldMesh.instanceColor) bldMesh.instanceColor.needsUpdate = true; }
  colorBuildings(); onTheme.push(colorBuildings);
  var edgeMat = mat("sc-edge", { transparent: true, opacity: 0.85 }, T.LineBasicMaterial), bldEdges;
  (function edges() {
    var p = [];
    BLD.forEach(function (b) {
      var X = [b.x0, b.x1], Z = [b.z0, b.z1], Y = [0, b.h];
      function L(a, c) { p.push(a[0], a[1], a[2], c[0], c[1], c[2]); }
      for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) L([X[i], 0, Z[j]], [X[i], b.h, Z[j]]);
      Y.forEach(function (y) { L([X[0], y, Z[0]], [X[1], y, Z[0]]); L([X[0], y, Z[1]], [X[1], y, Z[1]]); L([X[0], y, Z[0]], [X[0], y, Z[1]]); L([X[1], y, Z[0]], [X[1], y, Z[1]]); });
      if (b.glass) for (var y = 3.5; y < b.h; y += 3.5) { L([X[0], y, Z[0]], [X[1], y, Z[0]]); L([X[0], y, Z[1]], [X[1], y, Z[1]]); }
    });
    var g = new T.BufferGeometry(); g.setAttribute("position", new T.Float32BufferAttribute(p, 3));
    bldEdges = new T.LineSegments(g, edgeMat); world.add(bldEdges);
  })();
  var TREES = [];
  [9.8, -9.8].forEach(function (z) { for (var x = XA + 5; x < XB; x += 14) {
    if (Math.abs(x - CX) < 16 || Math.abs(x - ROAD.walkX) < 7 || (z > 0 && x > ROAD.busX - 12 && x < ROAD.busX + 12)) continue; TREES.push([x + (z > 0 ? 5 : 0), z]); } });
  var crown = new T.InstancedMesh(new T.IcosahedronGeometry(1.7, 0), mat("sc-tree"), TREES.length);
  var trunk = new T.InstancedMesh(new T.CylinderGeometry(0.16, 0.2, 2.6, 6), mat("sc-trunk"), TREES.length);
  (function () { var o = new T.Object3D(), r = rng(5); TREES.forEach(function (t, i) { var s = 0.8 + r() * 0.5; o.position.set(t[0], 3.4 * s + 0.4, t[1]); o.scale.set(s, s * 1.15, s); o.rotation.y = r() * 6; o.updateMatrix(); crown.setMatrixAt(i, o.matrix); o.position.set(t[0], 1.3, t[1]); o.scale.set(1, 1, 1); o.updateMatrix(); trunk.setMatrixAt(i, o.matrix); }); })();
  crown.castShadow = trunk.castShadow = true; world.add(crown); world.add(trunk);
  (function shelter() { var m = mat("sc-edge"), g = new T.Group(); [[ROAD.busX - 4, 10.1], [ROAD.busX + 4, 10.1]].forEach(function (p) { var post = new T.Mesh(BOX, m); post.scale.set(0.12, 2.6, 0.12); post.position.set(p[0], 1.3, p[1]); g.add(post); });
    var roof = new T.Mesh(BOX, mat("sc-bldg2")); roof.scale.set(9, 0.15, 1.8); roof.position.set(ROAD.busX, 2.65, 9.8); roof.castShadow = true; g.add(roof);
    var sign = new T.Mesh(BOX, mat("sc-yel")); sign.scale.set(0.5, 0.5, 0.08); sign.position.set(ROAD.busX - 6, 2.6, 8.0); g.add(sign);
    var sp = new T.Mesh(BOX, m); sp.scale.set(0.08, 2.4, 0.08); sp.position.set(ROAD.busX - 6, 1.2, 8.0); g.add(sp); world.add(g); })();

  // traffic lights: one pole per approach, three lamps that follow the signal plan
  var TL = [];
  (function lights() {
    var poleMat = mat("sc-cab"), defs = [
      { sig: "main", x: CX - 9.6, z: 8.4, face: [-1, 0] }, { sig: "main", x: CX + 9.6, z: -8.4, face: [1, 0] },
      { sig: "cross", x: CX + 8.4, z: 9.6, face: [0, 1] }, { sig: "cross", x: CX - 8.4, z: -9.6, face: [0, -1] }];
    var lampG = new T.SphereGeometry(0.15, 12, 8);
    defs.forEach(function (d) {
      var g = new T.Group(), pole = new T.Mesh(new T.CylinderGeometry(0.09, 0.11, 4.6, 8), poleMat); pole.position.y = 2.3; g.add(pole);
      var head = new T.Mesh(BOX, poleMat); head.scale.set(0.42, 1.25, 0.42); head.position.y = 4.9; g.add(head);
      var lamps = {};
      [["R", 5.3], ["Y", 4.9], ["G", 4.5]].forEach(function (l) {
        var m = new T.MeshBasicMaterial({ color: 0x333333 }), s = new T.Mesh(lampG, m);
        s.position.set(d.face[0] * 0.22, l[1], d.face[1] * 0.22); g.add(s); lamps[l[0]] = m;
      });
      g.position.set(d.x, 0, d.z); g.traverse(function (o) { if (o.isMesh) o.castShadow = true; }); world.add(g);
      TL.push({ sig: d.sig, lamps: lamps, state: null });
    });
  })();
  function paintLights(t, force) {
    TL.forEach(function (L) {
      var s = S.light(L.sig, t); if (s === L.state && !force) return; L.state = s;
      L.lamps.R.color.copy(s === "R" ? PAL.ego : PAL["sc-off"]); L.lamps.Y.color.copy(s === "Y" ? PAL.amber : PAL["sc-off"]); L.lamps.G.color.copy(s === "G" ? PAL.green : PAL["sc-off"]);
    });
  }
  onTheme.push(function () { paintLights(st.t, true); });

  // ================================================================== actor meshes
  var WHEEL = new T.CylinderGeometry(0.34, 0.34, 0.26, 14); WHEEL.rotateX(Math.PI / 2);
  var colorKey = { ego: "ego", c1: "car-1", c2: "car-2", c3: "car-3", c4: "car-4", adv: "adv", bus: "bus", ped: "ped" };
  function carMesh(key, kind) {
    var g = new T.Group(), body, cab, L = kind === "bus" ? 12 : 4.5, W = kind === "bus" ? 2.5 : 1.86;
    if (kind === "bus") {
      body = new T.Mesh(BOX, mat(key)); body.scale.set(L, 2.5, W); body.position.y = 1.65; g.add(body);
      cab = new T.Mesh(BOX, mat("sc-cab")); cab.scale.set(L - 1.2, 0.8, W + 0.02); cab.position.set(0.2, 2.15, 0); g.add(cab);
    } else {
      body = new T.Mesh(BOX, mat(key)); body.scale.set(L, 0.72, W); body.position.y = 0.66; g.add(body);
      cab = new T.Mesh(BOX, mat("sc-cab")); cab.scale.set(2.3, 0.6, W - 0.2); cab.position.set(-0.3, 1.32, 0); g.add(cab);
      var top = new T.Mesh(BOX, mat(key)); top.scale.set(2.0, 0.08, W - 0.26); top.position.set(-0.35, 1.66, 0); g.add(top);
    }
    var wx = kind === "bus" ? [4.2, -3.8] : [1.45, -1.45], wz = W / 2 - 0.12;
    wx.forEach(function (x) { [-1, 1].forEach(function (s) { var w = new T.Mesh(WHEEL, mat("sc-wheel")); w.position.set(x, 0.34, s * wz); w.userData.noShadow = true; g.add(w); }); });
    var blM = new T.MeshBasicMaterial({ color: 0x40191a });
    [-1, 1].forEach(function (s) { var bl = new T.Mesh(BOX, blM); bl.scale.set(0.08, kind === "bus" ? 0.3 : 0.16, 0.4); bl.position.set(-L / 2 - 0.03, kind === "bus" ? 1.0 : 0.8, s * (W / 2 - 0.32)); bl.userData.noShadow = true; g.add(bl); });
    g.userData.brake = blM;
    if (key === "ego") {
      var puck = new T.Mesh(new T.CylinderGeometry(0.32, 0.36, 0.3, 20), mat("sc-cab")); puck.position.set(-0.25, 1.86, 0); g.add(puck);
      var ring = new T.Mesh(new T.TorusGeometry(0.34, 0.035, 6, 24).rotateX(Math.PI / 2), mat("scan-live", {}, T.MeshBasicMaterial)); ring.position.set(-0.25, 1.9, 0); g.add(ring);
    }
    g.traverse(function (o) { if (o.isMesh) o.castShadow = !o.userData.noShadow; });
    return g;
  }
  function motoMesh(key) {
    var g = new T.Group();
    var b = new T.Mesh(BOX, mat(key)); b.scale.set(1.7, 0.5, 0.45); b.position.y = 0.55; g.add(b);
    [0.65, -0.65].forEach(function (x) { var w = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, 0.12, 12).rotateX(Math.PI / 2), mat("sc-wheel")); w.position.set(x, 0.3, 0); g.add(w); });
    var r = new T.Mesh(new T.CylinderGeometry(0.18, 0.22, 0.75, 8), mat("sc-cab")); r.position.set(-0.15, 1.15, 0); g.add(r);
    var h = new T.Mesh(new T.SphereGeometry(0.2, 10, 8), mat("gold")); h.position.set(-0.1, 1.68, 0); g.add(h);
    g.traverse(function (o) { if (o.isMesh) o.castShadow = true; });
    return g;
  }
  function pedMesh() {
    var g = new T.Group(), m = mat("ped");
    var b = new T.Mesh(new T.CylinderGeometry(0.2, 0.24, 1.05, 10), m); b.position.y = 0.95; g.add(b);
    var h = new T.Mesh(new T.SphereGeometry(0.17, 12, 10), m); h.position.y = 1.62; g.add(h);
    var l1 = new T.Mesh(BOX, mat("sc-cab")); l1.scale.set(0.14, 0.5, 0.14); l1.position.set(0, 0.25, 0.1); g.add(l1);
    var l2 = l1.clone(); l2.position.z = -0.1; g.add(l2); g.userData.legs = [l1, l2];
    g.traverse(function (o) { if (o.isMesh) o.castShadow = true; });
    return g;
  }
  function meshFor(a) { return a.kind === "ped" ? pedMesh() : a.kind === "moto" ? motoMesh(colorKey[a.color]) : carMesh(a.kind === "ego" ? "ego" : a.dark ? "car-dark" : colorKey[a.color], a.kind); }
  function ghostify(o, opacity) { o.traverse(function (m) { if (m.isMesh) { m.material = m.material.clone(); m.material.transparent = true; m.material.opacity = opacity; m.material.depthWrite = false; m.castShadow = false; } }); return o; }

  // ================================================================== the recorded drive and the runs derived from it
  var LOG = S.run({ ego: "human", others: "reactive" });          // the drive we "recorded" on the street
  var ACT = LOG.actors, NA = ACT.length, IDX = {}; ACT.forEach(function (a, i) { IDX[a.id] = i; });
  var actorObj = ACT.map(function (a) { var o = meshFor(a); scene.add(o); return o; });
  S.PARKED.forEach(function (p) { var o = carMesh(p.dark ? "car-dark" : colorKey[p.color], "car"); o.position.set(p.x, 0, p.z); o.rotation.y = Math.atan2(-p.hz, p.hx); scene.add(o); });
  var CACHE = {};
  function cached(key, fn) { if (!CACHE[key]) CACHE[key] = fn(); return CACHE[key]; }
  function pose(R, i, t) {
    var nf = R.nf || NF, x = t / DT, f = Math.min(Math.max(0, nf - 2), Math.max(0, Math.floor(x))), u = nf < 2 ? 0 : clamp(x - f, 0, 1), N = R.N, F = R.F;
    var a = (f * N + i) * 8, b = (Math.max(0, Math.min(f + 1, nf - 1)) * N + i) * 8;
    var hx = F[a + 2] + (F[b + 2] - F[a + 2]) * u, hz = F[a + 3] + (F[b + 3] - F[a + 3]) * u, hl = Math.hypot(hx, hz) || 1;
    return { x: F[a] + (F[b] - F[a]) * u, z: F[a + 1] + (F[b + 1] - F[a + 1]) * u, hx: hx / hl, hz: hz / hl, v: F[a + 4] + (F[b + 4] - F[a + 4]) * u, acc: F[a + 5], flag: F[a + 7], f: f };
  }
  function place(o, a, p, t) {
    o.position.set(p.x, 0, p.z); o.rotation.y = Math.atan2(-p.hz, p.hx);
    if (o.userData.brake) { var on = p.acc < -1.2; if (o.userData.bOn !== on) { o.userData.brake.color.setHex(on ? 0xff2a1f : 0x40191a); o.userData.bOn = on; } }
    if (a.kind === "ped" && o.userData.legs) { var sw = p.v > 0.05 ? Math.sin(t * 9 + a.id.length) * 0.35 : 0; o.userData.legs[0].rotation.z = sw; o.userData.legs[1].rotation.z = -sw; }
  }

  // ================================================================== trails (tracks), plan ribbon, hit rings
  function makeTrail(key, opacity, dashed) {
    var g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(new Float32Array(NF * 3), 3)); g.setDrawRange(0, 0);
    var m = dashed ? mat(key, { dashSize: 1.2, gapSize: 0.9, transparent: true, opacity: opacity }, T.LineDashedMaterial) : mat(key, { transparent: true, opacity: opacity }, T.LineBasicMaterial);
    var l = new T.Line(g, m); l.frustumCulled = false; l.visible = false; scene.add(l); return { line: l, R: null, n: 0, dashed: dashed };
  }
  function fillTrail(tr, R, i, y) {
    var a = tr.line.geometry.attributes.position.array, nf = R.nf || NF;
    for (var f = 0; f < NF; f++) { var g = Math.min(f, nf - 1), k = (g * R.N + i) * 8; a[f * 3] = R.F[k]; a[f * 3 + 1] = y; a[f * 3 + 2] = R.F[k + 1]; }
    tr.line.geometry.attributes.position.needsUpdate = true; if (tr.dashed) tr.line.computeLineDistances();
    tr.R = R; tr.nfFilled = nf;
  }
  function showTrail(tr, R, i, y, t) {
    if (!R) { tr.line.visible = false; return; }
    if (tr.R !== R || tr.nfFilled !== (R.nf || NF)) fillTrail(tr, R, i, y);
    tr.line.geometry.setDrawRange(0, Math.max(0, Math.min(R.nf || NF, Math.floor(t / DT) + 1))); tr.line.visible = true;
  }
  var trEgo = makeTrail("ego", 0.95);
  var ringG = new T.TorusGeometry(2.4, 0.16, 8, 40).rotateX(Math.PI / 2), hitRings = [];
  for (var hr = 0; hr < 8; hr++) { var rm = new T.Mesh(ringG, mat("hit", { transparent: true, opacity: 0.9 }, T.MeshBasicMaterial)); rm.visible = false; scene.add(rm); hitRings.push(rm); }
  // attention: what each reactive driver is reacting to right now (a line from its bumper to the thing), coloured by why
  var ATT_N = 48, attGeo = new T.BufferGeometry();
  attGeo.setAttribute("position", new T.BufferAttribute(new Float32Array(ATT_N * 6), 3)); attGeo.setAttribute("color", new T.BufferAttribute(new Float32Array(ATT_N * 6), 3));
  var attLines = new T.LineSegments(attGeo, new T.LineBasicMaterial({ vertexColors: true })); attLines.frustumCulled = false; attLines.visible = false; scene.add(attLines);
  var ATT_COL = { 1: "teal", 2: "ego", 3: "gold", 4: "purple", 5: "purple" };
  // the safe gap the reactive tailgater wants to keep (IDM s*), painted on the road ahead of it
  var gapBar = new T.Mesh(PLANE, new T.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false })); gapBar.visible = false; scene.add(gapBar);

  // ================================================================== labels overlay (projected per view)
  var LBL = [], lblPool = [], lblUsed = 0;
  function label(x, y, z, text, cls) { LBL.push([x, y, z, text, cls]); }
  function flushLabels(rect) {
    var v = new T.Vector3();
    LBL.forEach(function (L) {
      v.set(L[0], L[1], L[2]).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.05) return;
      var el = lblPool[lblUsed]; if (!el) { el = document.createElement("div"); labelsEl.appendChild(el); lblPool.push(el); }
      lblUsed++;
      var cn = "lbl" + (L[4] ? " " + L[4] : ""); if (el.className !== cn) el.className = cn; if (el.textContent !== L[3]) el.textContent = L[3];
      el.style.left = (rect.x + (v.x + 1) / 2 * rect.w).toFixed(1) + "px"; el.style.top = (rect.y + (1 - v.y) / 2 * rect.h).toFixed(1) + "px"; el.style.display = "";
    });
    LBL = [];
  }
  function endLabels() { for (var i = lblUsed; i < lblPool.length; i++) lblPool[i].style.display = "none"; lblUsed = 0; }

  // ================================================================== app state
  var st = { ch: 0, t: 0, playing: !REDUCED, speed: 1, labels: true };
  // the lab: which planner drives, in which scene
  st.lab = { pl: "labperc", seed: 0, scene: "brake", decel: 6, gap: 10, dv: 11, v0: 14, log: 0, rear: "reactive" };
  var plotDirty = true, lastPlotT = -1;

  // ================================================================== plots (one canvas per chapter, redrawn on change)
  var MONO = "", PB = { cv: null, off: document.createElement("canvas"), A: null, P: null, t: 0, drawn: 0 };
  function plotSetup(cv) {
    var dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 360, H = Math.round(W * 200 / 380);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    var g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    return { g: g, W: W, H: H, dpr: dpr, cv: cv };
  }
  function axes(P, x0, x1, y0, y1, xt, yt, xl, yl) {
    var g = P.g, L = 40, Rm = 10, Tm = 10, B = 26, w = P.W - L - Rm, h = P.H - Tm - B;
    var fx = function (x) { return L + (x - x0) / (x1 - x0) * w; }, fy = function (y) { return Tm + (1 - (clamp(y, y0, y1) - y0) / (y1 - y0)) * h; };
    g.font = "600 10px " + (MONO || (MONO = getComputedStyle(document.body).getPropertyValue("--f-mono"))); g.lineWidth = 1;
    g.strokeStyle = CSS.line; g.fillStyle = CSS["ink-3"]; g.textAlign = "right"; g.textBaseline = "middle";
    yt.forEach(function (y) { g.beginPath(); g.moveTo(L, fy(y)); g.lineTo(L + w, fy(y)); g.stroke(); g.fillText(fmt(y, Math.abs(y) < 10 && y % 1 ? 1 : 0), L - 5, fy(y)); });
    g.textAlign = "center"; g.textBaseline = "top";
    xt.forEach(function (x) { g.fillText(fmt(x, 0), fx(x), Tm + h + 4); });
    g.textAlign = "left"; g.fillText(xl, L, Tm + h + 15); g.save(); g.translate(10, Tm + h / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.textBaseline = "top"; g.fillText(yl, 0, -6); g.restore();
    return { fx: fx, fy: fy, L: L, T: Tm, w: w, h: h };
  }
  function series(P, A, xs, ys, color, width, dash, n) {
    var g = P.g; g.strokeStyle = color; g.lineWidth = width || 1.5; g.setLineDash(dash || []); g.beginPath();
    var first = true, m = n == null ? xs.length : n;
    for (var i = 0; i < m; i++) { var y = ys[i]; if (y == null || isNaN(y)) { first = true; continue; } var X = A.fx(xs[i]), Y = A.fy(y); if (first) { g.moveTo(X, Y); first = false; } else g.lineTo(X, Y); }
    g.stroke(); g.setLineDash([]);
  }
  function playhead(P, A, t) { var g = P.g; g.strokeStyle = CSS.ink; g.globalAlpha = 0.5; g.lineWidth = 1; g.beginPath(); g.moveTo(A.fx(t), A.T); g.lineTo(A.fx(t), A.T + A.h); g.stroke(); g.globalAlpha = 1; }
  function xMark(P, A, x, y, color) { var g = P.g, X = A.fx(x), Y = A.fy(y); g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.moveTo(X - 4, Y - 4); g.lineTo(X + 4, Y + 4); g.moveTo(X + 4, Y - 4); g.lineTo(X - 4, Y + 4); g.stroke(); }
  var TT = []; for (var tf = 0; tf < NF; tf++) TT.push(tf * DT);
  function colOf(R, i, k) { var out = new Array(R.nf || NF), N = R.N; for (var f = 0; f < out.length; f++) out[f] = R.F[(f * N + i) * 8 + k]; return out; }
  // x–t (space–time) diagram of everyone on the main road
  // ================================================================== chapters
  function seg(id, opts, cur, aria) { return '<div class="seg" id="' + id + '" role="group" aria-label="' + aria + '">' + opts.map(function (o) { return '<button type="button" data-v="' + o[0] + '" aria-pressed="' + (o[0] === cur) + '"' + (o[2] ? " disabled" : "") + ">" + o[1] + "</button>"; }).join("") + "</div>"; }
  // ================================================================== chapter 8 support: the models of the Day 12 lab, driving in this street
  var LD = window.LAB_DATA || null;
  var LABPL = [["labidm", "IDM"], ["labcv", "CV"], ["labego", "EgoMLP"], ["labperc", "PercMLP"], ["labfix", "PercMLP+"]];
  var LABLEARN = { labego: 1, labperc: 1, labfix: 1 };
  var LABCOL = { labidm: "teal", labcv: "ink-3", labego: "purple", labperc: "blue", labfix: "green" };
  var LABSCENE = { brake: "xe dẫn phanh gấp", cutin: "xe cắt vào", log: "log Argoverse thật" };
  var LAB_T = 14;
  function labSeeds(pl) { return LABLEARN[pl] ? LD.seeds.map(function (_, i) { return i; }) : [0]; }   // one run per training seed for the learned planners
  function labReady() { return !!(LD && S.hasLab()); }
  function labParams() {
    var s = st.lab, p = { pedT0: 1e9, busGo: 1e9, cutT0: 99, tgMode: s.rear === "replay" ? "const" : "idm", react: s.rear === "reactive" ? 0.6 : 0, tgT: 1.4 }, v0 = 11.2;
    if (s.scene === "brake") { p.brkDecel = s.decel; p.brkDur = 2.4; }
    else if (s.scene === "cutin") { v0 = s.v0; p.brkT0 = 99; p.egoV0 = v0; p.labCut = { gap: s.gap, dv: Math.min(s.dv, v0 - 0.5) }; }
    else { var L = LD.logs[s.log]; v0 = L.ego[0]; p.brkT0 = 99; p.egoV0 = v0; p.leadProf = L.lead; p.egoProf = L.ego; p.leadGap0 = L.gap0; }
    p.rearGap = 2 + v0 * 1.4;
    return p;
  }
  function labKey() { var s = st.lab; return [s.scene, s.decel, s.gap, s.dv, s.v0, s.log, s.rear].join("|"); }
  var LABORDER = [];
  function labExec(pl, seed, params) {
    var R = S.run({ params: params, ego: "planner", planner: pl, policy: { labSeed: LD.seeds[seed] }, others: "reactive", tEnd: LAB_T });
    R.m = S.egoMetrics(R, null); return R;
  }
  function labRun(pl, seed) {
    var key = "lab|" + pl + "|" + (LABLEARN[pl] ? seed : 0) + "|" + labKey();
    if (!CACHE[key]) {
      CACHE[key] = labExec(pl, seed, labParams()); LABORDER.push(key);
      if (LABORDER.length > 90) LABORDER.splice(0, 40).forEach(function (k) { delete CACHE[k]; });     // a run record is ~0.7 MB: keep memory bounded while a slider is dragged
    }
    return CACHE[key];
  }
  function labAllRun() {
    var el = $("labAll"), n = LD.logs.length, i = 0, res = {}, keep = st.lab.scene;
    if (!el) return; var btn = $("bLabAll"); if (btn) btn.disabled = true;
    LABPL.forEach(function (p) { res[p[0]] = labSeeds(p[0]).map(function () { return [0, 0]; }); });
    function one() {
      if (st.ch !== CH.length - 1) return;
      if (i < n) {
        var L = LD.logs[i], saved = st.lab.log, scene = st.lab.scene; st.lab.scene = "log"; st.lab.log = i;
        LABPL.forEach(function (p) { labSeeds(p[0]).forEach(function (sd, k) {
          var o = labOutcome(labExec(p[0], sd, labParams())); if (o.front) { res[p[0]][k][0]++; if (L.brake) res[p[0]][k][1]++; } }); });
        st.lab.log = saved; st.lab.scene = scene; i++;
        el.innerHTML = '<span class="note">đang chạy ' + i + " / " + n + " log…</span>"; setTimeout(one, 0); return;
      }
      var nb = LD.logs.filter(function (l) { return l.brake; }).length;
      el.innerHTML = '<table class="tbl"><tr><th>Bộ điều khiển</th><th>log bị đâm (trên ' + n + ")</th><th>trong số " + nb + " log có phanh</th></tr>" + LABPL.map(function (p) {
        var a = res[p[0]], tot = a.map(function (x) { return x[0]; }), br = a.map(function (x) { return x[1]; }), r = function (v) { var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v); return lo === hi ? lo : lo + " … " + hi; };
        return "<tr><td>" + p[1] + "</td><td" + (Math.max.apply(null, tot) ? ' style="color:var(--hit);font-weight:700"' : "") + ">" + r(tot) + (a.length > 1 ? " (qua 5 seed)" : "") + "</td><td>" + r(br) + "</td></tr>";
      }).join("") + "</table>";
      if (btn) btn.disabled = false;
    }
    setTimeout(one, 20);
  }
  function labOutcome(R) {
    // (only for a REPLAYED rear car) it drives THROUGH the ego after its (fake) hit and then looks like a car ahead: whatever happens after that is not the planner's doing, so only count what happens before it
    var front = false, rear = false, tRear = Infinity, replayed = !!(R.opts && R.opts.params && R.opts.params.tgMode === "const");
    R.m.hits.forEach(function (h) { if ((h.a === "ego" ? h.b : h.a) === "TG") { rear = true; if (replayed) tRear = Math.min(tRear, h.t); } });
    R.m.hits.forEach(function (h) { if ((h.a === "ego" ? h.b : h.a) !== "TG" && h.t < tRear) front = true; });
    var gaps = labFrontGap(R).filter(function (x, f) { return x != null && f * DT < tRear; });
    return { front: front, rear: rear, gap: gaps.length ? Math.min.apply(null, gaps) : null, ttc: R.m.ttcMin, dec: R.m.decMax };
  }
  function labSummary() {
    return cached("labsum|" + labKey(), function () {
      return LABPL.map(function (p) {
        var seeds = labSeeds(p[0]), os = seeds.map(function (sd) { return labOutcome(labRun(p[0], sd)); });
        var gs = os.map(function (o) { return o.gap == null ? 99 : o.gap; });
        return { pl: p[0], name: p[1], n: os.length, front: os.filter(function (o) { return o.front; }).length, rear: os.filter(function (o) { return o.rear; }).length,
                 gmin: Math.min.apply(null, gs), gmax: Math.max.apply(null, gs) };
      });
    });
  }
  function labFrontGap(R) {
    var out = new Array(R.nf || NF), N = R.N;
    for (var f = 0; f < out.length; f++) {
      var ke = f * N * 8, ex = R.F[ke], ez = R.F[ke + 1], hx = R.F[ke + 2], hz = R.F[ke + 3], best = null;
      for (var i = 1; i < N; i++) {
        if (R.actors[i].kind === "ped" || R.actors[i].id === "TG") continue;      // the rear car is not "ahead", even after it drove through us
        var kb = (f * N + i) * 8, rx = R.F[kb] - ex, rz = R.F[kb + 1] - ez, lon = rx * hx + rz * hz, lat = -rx * hz + rz * hx;
        if (lon > 0 && lon < 60 && Math.abs(lat) < 2.0) { var g = lon - R.actors[i].dims.len / 2 - S.CAR.len / 2; if (best == null || g < best) best = g; }
      }
      out[f] = best;
    }
    return out;
  }
  function fmtGap(x) { return x == null ? "–" : x <= 0 ? "đâm" : fmt(x); }
  function labTable() {
    var el = $("labTbl"); if (!el) return; var rows = labSummary();
    el.innerHTML = "<tr><th>Bộ điều khiển</th><th>đâm xe trước</th><th>xe sau đâm ta</th><th>cách xe trước, nhỏ nhất (m)</th></tr>" + rows.map(function (r) {
      var cnt = function (k) { return r.n > 1 ? k + " / " + r.n + " seed" : (k ? "có" : "không"); }, hot = function (k) { return k ? ' style="color:var(--hit);font-weight:700"' : ""; };
      var g = r.n > 1 && Math.abs(r.gmax - r.gmin) > 0.05 ? fmtGap(r.gmin) + " … " + fmtGap(r.gmax) : fmtGap(r.gmin);
      return '<tr' + (r.pl === st.lab.pl ? ' class="sel"' : "") + "><td>" + r.name + "</td><td" + hot(r.front) + ">" + cnt(r.front) + "</td><td" + hot(r.rear) + ">" + cnt(r.rear) + "</td><td>" + g + "</td></tr>";
    }).join("");
  }
  function labRead() {
    var el = $("labRead"); if (!el) return; var s = st.lab, R = labRun(s.pl, s.seed), o = labOutcome(R), tg = tgGap(R).filter(function (x) { return x != null; });
    var first = R.m.hits[0], who = first && (first.a === "TG" || first.b === "TG") ? "xe sau đâm ta" : "ta đâm xe phía trước", res = first ? '<span class="c-hit">' + who + " ở " + fmt(first.t) + " s</span>" : '<span class="c-green">không va chạm</span>';
    el.innerHTML = '<span class="h">' + S.PLANNERS[s.pl].name + (LABLEARN[s.pl] ? " · seed " + (s.seed + 1) : "") + "</span>" +
      "<span>kết quả</span><b>" + res + "</b><span>cách xe trước, nhỏ nhất</span><b>" + fmtGap(o.gap) + (o.gap != null && o.gap > 0 ? " m" : "") + "</b>" +
      "<span>TTC nhỏ nhất</span><b>" + (o.ttc > 1e8 ? "–" : fmt(o.ttc) + " s") + "</b><span>phanh mạnh nhất</span><b>" + fmt(o.dec) + " m/s²</b>" +
      "<span>cách xe sau, nhỏ nhất</span><b>" + (tg.length ? (Math.min.apply(null, tg) <= 0 ? "đâm" : fmt(Math.min.apply(null, tg)) + " m") : "–") + "</b>";
  }
  function labInsight() {
    var el = $("labInsight"); if (!el) return; var s = st.lab, rows = labSummary(), by = {}; rows.forEach(function (r) { by[r.pl] = r; });
    var k = function (p) { return by[p].front + "/" + by[p].n; }, t;
    var n = by.labperc.n;
    if (s.scene === "brake") t = "<b>Xe dẫn phanh " + fmt(s.decel) + " m/s²:</b> EgoMLP đâm " + k("labego") + " seed, PercMLP " + k("labperc") + ", PercMLP+ " + k("labfix") + ", IDM " + k("labidm") + ". EgoMLP chỉ nhìn quá khứ tốc độ của chính nó, không thấy xe dẫn; các bộ còn lại có nhìn xe dẫn. Đổi xe sau sang “phát lại”: xe sau không biết ta vừa phanh nên đâm vào đuôi, một “va chạm giả” (cột “xe sau đâm ta”). Sau cú đâm giả đó, các va chạm về sau không được tính vào cột “đâm xe trước”.";
    else if (s.scene === "cutin") t = "<b>Xe cắt vào:</b> một xe chậm hơn xuất hiện cách " + fmt(s.gap) + " m, tiến gần " + fmt(Math.min(s.dv, s.v0 - 0.5)) + " m/s (họ kịch bản của bài lab: khoảng cách × tốc độ tiến gần). Kết quả trên " + n + " seed: PercMLP đâm " + k("labperc") + ", PercMLP+ đâm " + k("labfix") + ", EgoMLP " + k("labego") + ", IDM " + k("labidm") + ". Log thật không chứa ca nào gắt như vậy; PercMLP+ được huấn luyện thêm trên họ kịch bản này rồi học ở các trạng thái tự đi vào (bước 7).";
    else t = "<b>Log thật #" + LD.logs[s.log].id + ":</b> xe dẫn lái đúng tốc độ của một quỹ đạo Argoverse" + (LD.logs[s.log].brake ? " (có đoạn xe dẫn phanh " + fmt(-LD.logs[s.log].peak_decel) + " m/s²)" : "") + ". Hai giây đầu xe ta lặp lại người lái, rồi bộ điều khiển cầm lái, giống bước 4 của bài lab. Ở log đang chọn: EgoMLP đâm " + k("labego") + " seed, PercMLP " + k("labperc") + ", PercMLP+ " + k("labfix") + ", IDM " + k("labidm") + ". Bấm “Chạy cả log” để thử trên toàn bộ.";
    el.innerHTML = t;
  }
  function labGateTable() {
    var G = LD.gate, names = ["const-vel", "EgoMLP", "PercMLP", "PercMLP+"], rules = Object.keys(G["PercMLP"].rules);
    return '<table class="tbl"><tr><th>Ứng viên</th>' + rules.map(function (r) { return "<th>" + r.split("_")[0] + "</th>"; }).join("") + "<th>Cổng</th></tr>" + names.map(function (n) {
      var d = G[n]; return "<tr><td>" + n + "</td>" + rules.map(function (r) { var ok = d.rules[r].pass; return '<td style="color:var(--' + (ok ? "green" : "hit") + ')" title="' + d.rules[r].detail.replace(/"/g, "'") + '">' + (ok ? "✓" : "✗") + "</td>"; }).join("") +
        '<td style="font-weight:700;color:var(--' + (d.release ? "green" : "hit") + ')">' + (d.release ? "PHÁT HÀNH" : "CHẶN") + "</td></tr>";
    }).join("") + "</table>";
  }
  function labRefresh(restart) {
    if (!labReady()) return; var s = st.lab;
    Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-scene]"), function (el) { el.hidden = el.dataset.scene !== s.scene; });
    Array.prototype.forEach.call($("sLabSeed").children, function (b) { b.disabled = !LABLEARN[s.pl]; });
    labTable(); labRead(); labInsight();
    var lg = $("oLabLg"); if (lg) { var L = LD.logs[s.log]; lg.textContent = "#" + L.id + (L.brake ? " · phanh " + fmt(-L.peak_decel) + " m/s²" : " · êm"); }
    if (restart) { st.t = 0; st.playing = !REDUCED; syncPlay(); resetToasts(); }
    plotDirty = true; drawTicks();
  }

  var CH = [
    { key: "lab", short: "8", cam: { dist: 34, yaw: 3.45, pitch: 0.78, lead: 10 }, mode: function () { return "Bài lab · " + S.PLANNERS[st.lab.pl].short + " · " + LABSCENE[st.lab.scene]; },
      html: function () {
        if (!labReady()) return '<div class="eyebrow">Chương 8 · Bài lab</div><h2>Chưa nạp được dữ liệu của bài lab</h2><p>Trang cần <span class="k">lab_models.js</span> và <span class="k">lab_data.js</span> (model và log của bạn). Chạy xong các bước 3, 4, 6, 7 của bài lab, rồi <span class="k">python3 scripts/export_viz.py</span> và tải lại trang.</p>';
        var s = st.lab;
        return '<div class="eyebrow">Chương 8 · Bài lab</div><h2>Các model của bài lab lái trong phố này</h2>' +
          '<p>Các model ở đây được huấn luyện trên <b>log lái xe thật</b> (Argoverse 2: ' + "9.610 cặp xe dẫn và xe theo sau, 10 Hz) bằng bài lab Day 12. Chúng chỉ biết <b>bám xe</b>; đèn đỏ và người qua đường do một lớp luật lo, vì log không có hai thứ đó. Cảnh 3D hiển thị bộ điều khiển đang chọn; bảng so cả năm bộ cùng lúc.</p>" +
          '<div class="lab">Bộ điều khiển</div>' + seg("sLabPl", LABPL, s.pl, "Bộ điều khiển") +
          '<div class="lab">Seed huấn luyện (mỗi seed là một lần huấn luyện khác của cùng model)</div>' + seg("sLabSeed", LD.seeds.map(function (_, i) { return [i, String(i + 1)]; }), s.seed, "Seed") +
          '<div class="lab">Cảnh</div>' + seg("sLabScene", [["brake", "Xe dẫn phanh gấp"], ["cutin", "Xe cắt vào"], ["log", "Log thật"]], s.scene, "Cảnh") +
          '<div class="ctl" data-scene="brake"><div class="sl"><span>Xe dẫn phanh</span><output id="oLabDc">' + fmt(s.decel) + ' m/s²</output><input type="range" id="sLabDc" min="3" max="9" step="0.5" value="' + s.decel + '"></div></div>' +
          '<div class="ctl" data-scene="cutin"><div class="sl"><span>Tốc độ xe ta</span><output id="oLabV0">' + fmt(s.v0) + ' m/s</output><input type="range" id="sLabV0" min="8" max="15" step="1" value="' + s.v0 + '"></div>' +
          '<div class="sl"><span>Khoảng cách tới xe cắt vào</span><output id="oLabGp">' + fmt(s.gap) + ' m</output><input type="range" id="sLabGp" min="3" max="40" step="1" value="' + s.gap + '"></div>' +
          '<div class="sl"><span>Tốc độ tiến gần (xe ta nhanh hơn xe cắt vào)</span><output id="oLabDv">' + fmt(s.dv) + ' m/s</output><input type="range" id="sLabDv" min="2" max="14" step="1" value="' + s.dv + '"></div></div>' +
          '<div class="ctl" data-scene="log"><div class="sl"><span>Log Argoverse làm xe dẫn</span><output id="oLabLg">–</output><input type="range" id="sLabLg" min="0" max="' + (LD.logs.length - 1) + '" step="1" value="' + s.log + '"></div></div>' +
          '<div class="ctl" data-scene="log"><div class="row"><button class="btn" type="button" id="bLabAll">Chạy cả ' + LD.logs.length + ' log, cả năm bộ</button></div><div id="labAll"></div></div>' +
          '<div class="lab">Xe bám đuôi (xe ngay sau xe ta)</div>' + seg("sLabRear", [["replay", "Phát lại (không phản ứng)"], ["reactive", "Phản ứng (IDM, trễ 0,6 s)"]], s.rear, "Xe sau") +
          '<div class="lab">Cả năm bộ điều khiển, cùng cảnh</div><table class="tbl" id="labTbl"></table>' +
          '<div class="read" id="labRead"></div><div class="insight" id="labInsight"></div>' +
          '<canvas class="plot" id="plot" aria-label="Khoảng cách tới xe phía trước theo thời gian"></canvas><div class="legend" id="labLeg"></div>' +
          '<div class="lab">Cổng phát hành của bài lab (mã sinh viên ' + LD.student.student_id + ')</div>' + labGateTable() +
          '<p class="note">R1 phát lại tái lập · R2 va chạm trên log · R3 lát cắt xe dẫn phanh · R4 lưới cắt vào · R5 ổn định giữa seed · R6 xe sau phản ứng · R7 độ phủ. Rê chuột lên một dấu để xem số đo. PercMLP+ qua cổng nghĩa là không kém IDM, chưa phải tốt hơn.</p>' +
          '<div class="try"><b>Thử:</b> cảnh “Xe cắt vào”, 14 m/s, cách 10 m, tiến gần 11 m/s: bộ nào đâm, bộ nào không? Rồi so PercMLP với PercMLP+ ở từng seed. Kết quả là của các model bạn đã huấn luyện, nên có thể khác ví dụ trong lời giảng.</div>';
      },
      plot: function (P, t) {
        var A = axes(P, 0, LAB_T, -5, 40, [0, 4, 8, 12], [0, 10, 20, 30, 40], "thời gian (s)", "cách xe trước (m)"), g = P.g;
        g.strokeStyle = CSS.hit; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(A.L, A.fy(0)); g.lineTo(A.L + A.w, A.fy(0)); g.stroke(); g.globalAlpha = 1;
        LABPL.forEach(function (p) {
          var R = labRun(p[0], st.lab.seed); series(P, A, TT, labFrontGap(R), CSS[LABCOL[p[0]]], p[0] === st.lab.pl ? 2.6 : 1.1, p[0] === "labcv" ? [3, 3] : null, R.nf || NF);
          R.m.hits.filter(function (e) { return e.a !== "TG" && e.b !== "TG"; }).slice(0, 1).forEach(function (e) { xMark(P, A, e.t, 0, CSS.hit); });
        });
        return A;
      } }
  ];

  // ---------------------------------------------------------------- which run is on screen
  function curRun() { return labReady() ? labRun(st.lab.pl, st.lab.seed) : LOG; }
  function tMax() { var R = curRun(); return ((R.nf || NF) - 1) * DT; }
  function marksOf(R) { return R.marks || []; }
  function tgGap(R) {
    var out = new Array(R.nf || NF), it = IDX.TG, N = R.N;
    for (var f = 0; f < out.length; f++) {
      var ke = f * N * 8, kt = (f * N + it) * 8, dz = Math.abs(R.F[ke + 1] - R.F[kt + 1]), dx = R.F[ke] - R.F[kt];
      out[f] = dz < 2.2 && dx > -4.6 && dx < 60 ? dx - 4.6 : null;
    }
    return out;
  }

  // ---------------------------------------------------------------- what is on screen: one view
  function viewsFor() {
    return labReady() ? [{ R: labRun(st.lab.pl, st.lab.seed), attention: true, egoAttention: true, gapBar: st.lab.rear === "reactive" }] : [{ R: LOG }];
  }
  function layoutViews(n) {
    var W = stage.clientWidth, H = stage.clientHeight;
    if (n === 1) return [{ x: 0, y: 0, w: W, h: H }];
    var rail = document.querySelector(".rail"), overlay = getComputedStyle(rail).position === "absolute";
    var x0 = overlay ? Math.round(rail.getBoundingClientRect().right - stage.getBoundingClientRect().left + 10) : 0, h = overlay ? H - 84 : H, w = W - x0;
    if (w > h * 1.1) { var hw = Math.floor((w - 6) / 2); return [{ x: x0, y: 0, w: hw, h: h }, { x: x0 + hw + 6, y: 0, w: w - hw - 6, h: h }]; }
    var hh = Math.floor((h - 6) / 2); return [{ x: x0, y: 0, w: w, h: hh }, { x: x0, y: hh + 6, w: w, h: h - hh - 6 }];
  }

  // ---------------------------------------------------------------- reactive agents: attention lines, state labels, the tailgater's safe gap
  function drawAttention(R, t, ego, egoToo) {
    var f = clamp(Math.round(t / DT), 0, (R.nf || NF) - 1), N = R.N, pa = attGeo.attributes.position.array, ca = attGeo.attributes.color.array, n = 0;
    function seg2(x0, z0, x1, z1, col) { if (n >= ATT_N) return; pa.set([x0, 1.2, z0, x1, 1.2, z1], n * 6); ca.set([col.r, col.g, col.b, col.r, col.g, col.b], n * 6); n++; }
    function target(i, lead, p) {
      if (lead >= 0) { var q = pose(R, lead, t); return [q.x, q.z]; }
      var ln = ACT[i].lane.charAt(0);
      return ln === "E" ? [ROAD.stopE, p.z] : ln === "W" ? [ROAD.stopW, p.z] : [p.x, ACT[i].lane === "SB" ? -ROAD.stopN : ROAD.stopN];
    }
    if (R.LS) for (var i = 1; i < N; i++) {
      var k = (f * N + i) * 2, lead = R.LS[k], code = R.LS[k + 1]; if (!ATT_COL[code] || (lead < 0 && lead !== -2)) continue;
      var p = pose(R, i, t); if (Math.abs(p.x - ego.x) > 80 || Math.abs(p.z - ego.z) > 60) continue;
      var a = ACT[i], tg = target(i, lead, p);
      seg2(p.x + p.hx * a.dims.len / 2, p.z + p.hz * a.dims.len / 2, tg[0], tg[1], PAL[ATT_COL[code]]);
    }
    if (egoToo && R.EGO) { var le = R.EGO[f * 4 + 2]; if (le >= 0 || le === -2) { var tg2 = le >= 0 ? (function () { var q = pose(R, le, t); return [q.x, q.z]; })() : [ROAD.stopE, ego.z]; seg2(ego.x + ego.hx * 2.3, ego.z + ego.hz * 2.3, tg2[0], tg2[1], PAL.ego); } }
    attGeo.setDrawRange(0, n * 2); attGeo.attributes.position.needsUpdate = true; attGeo.attributes.color.needsUpdate = true; attLines.visible = n > 0;
  }
  function stateLabels(R, t, ego) {
    var f = clamp(Math.round(t / DT), 0, (R.nf || NF) - 1), N = R.N, n = 0;
    for (var i = 1; i < N && n < 7; i++) {
      var a = ACT[i], code = R.LS ? R.LS[(f * N + i) * 2 + 1] : 0, p = pose(R, i, t), txt = null;
      if (Math.hypot(p.x - ego.x, p.z - ego.z) > 55) continue;
      if (code === 4) txt = a.kind === "ped" ? "chờ qua đường" : a.id === "BUS" ? "chờ người đi bộ" : "chờ khe hở";
      else if (code === 7 && a.id === "P1") txt = "đang qua đường";
      else if (code === 3) txt = "nhường người đi bộ";
      else if (code === 5) txt = "đang chen làn";
      else if (code === 2 && p.v > 0.3) txt = "dừng vì đèn";
      if (a.kind !== "ped" && p.acc < -2) txt = (txt ? txt + " · " : "") + "phanh " + fmt(-p.acc) + " m/s²";
      if (txt) { label(p.x, heightOf(a) + 1.1, p.z, (a.id === "TG" ? "bám đuôi: " : "") + txt, "state"); n++; }
    }
  }
  function heightOf(a) { return a.kind === "bus" ? 3.0 : a.kind === "ped" ? 1.8 : a.kind === "moto" ? 1.8 : 1.7; }
  function drawGapBar(R, t, ego) {
    var p = pose(R, IDX.TG, t), gap = ego.x - p.x - S.CAR.len;
    if (Math.abs(p.z - ego.z) > 2 || gap < -S.CAR.len || gap > 50) { gapBar.visible = false; return; }
    var P = { T: 1.4, a: 2.0, b: 3.2, s0: 1.4 };   // the rear driver of the lab scenes (see labParams: tgT = 1.4 s, calibrated on the logs)
    var sStar = P.s0 + Math.max(0, p.v * P.T + p.v * (p.v - ego.v) / (2 * Math.sqrt(P.a * P.b))), ok = gap >= sStar;
    gapBar.scale.set(Math.max(0.3, sStar), 1, 1.7); gapBar.position.set(p.x + S.CAR.len / 2 + sStar / 2, 0.07, p.z); gapBar.material.color.copy(ok ? PAL.teal : PAL.hit); gapBar.visible = true;
    label(p.x + S.CAR.len / 2 + sStar / 2, 0.6, p.z + 2.6, "muốn ≥ " + fmt(sStar) + " m · đang " + fmt(Math.max(0, gap)) + " m", ok ? "plan" : "hit");
  }

  // ---------------------------------------------------------------- binding
  var bodyEl = $("body");
  function go() {
    var c = CH[0]; st.ch = 0;
    bodyEl.innerHTML = c.html(); bodyEl.scrollTop = 0;
    bind(c);
    setCam("follow"); camTo(c.cam, 1300); VT[0].snap = VT[1].snap = true;
    st.t = 0; st.playing = !REDUCED;
    resetToasts(); plotDirty = true; drawTicks(); syncPlay();
  }
  function bind() {
    function segBind(id, fn) { var el = $(id); if (!el) return; Array.prototype.forEach.call(el.querySelectorAll("button"), function (b) { b.onclick = function () { Array.prototype.forEach.call(el.querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", x === b); }); fn(b.dataset.v); plotDirty = true; drawTicks(); }; }); }
    if (!labReady()) return;
    segBind("sLabPl", function (v) { st.lab.pl = v; labRefresh(true); });
    segBind("sLabSeed", function (v) { st.lab.seed = +v; labRefresh(true); });
    segBind("sLabScene", function (v) { st.lab.scene = v; labRefresh(true); });
    segBind("sLabRear", function (v) { st.lab.rear = v; labRefresh(true); });
    [["sLabDc", "decel", "oLabDc", " m/s²"], ["sLabV0", "v0", "oLabV0", " m/s"], ["sLabGp", "gap", "oLabGp", " m"], ["sLabDv", "dv", "oLabDv", " m/s"], ["sLabLg", "log", null, ""]].forEach(function (c3) {
      $(c3[0]).oninput = function () { st.lab[c3[1]] = +this.value; if (c3[2]) $(c3[2]).textContent = fmt(st.lab[c3[1]]) + c3[3]; clearTimeout(st.lbT); st.lbT = setTimeout(function () { labRefresh(true); }, 200); };
    });
    $("bLabAll").onclick = labAllRun;
    labRefresh(false);
  }

  // ---------------------------------------------------------------- transport bar
  var playBtn = $("play"), timeEl = $("time"), treadEl = $("tread");
  function syncPlay() { playBtn.textContent = st.playing ? "❚❚" : "▶"; playBtn.setAttribute("aria-label", st.playing ? "Dừng" : "Chạy"); }
  function togglePlay() {
    if (!st.playing && st.t >= tMax() - 0.01) st.t = 0;
    st.playing = !st.playing; syncPlay();
  }
  playBtn.onclick = togglePlay;
  $("restart").onclick = function () { st.t = 0; resetToasts(); st.playing = true; syncPlay(); };
  var SPEEDS = [0.5, 1, 2, 4];
  $("speed").onclick = function () { st.speed = SPEEDS[(SPEEDS.indexOf(st.speed) + 1) % SPEEDS.length]; this.textContent = String(st.speed).replace(".", ",") + "×"; };
  timeEl.addEventListener("input", function () { st.t = clamp(+timeEl.value, 0, tMax()); resetToasts(); });
  $("camBtn").onclick = function () { setCam(rig.mode === "follow" ? "chase" : rig.mode === "chase" ? "free" : "follow"); if (rig.mode === "follow") camTo(CH[st.ch].cam, 900); };
  $("themeBtn").onclick = function () { var r = document.documentElement, cur = r.getAttribute("data-theme"); var dark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches; r.setAttribute("data-theme", dark ? "light" : "dark"); applyPal(); };
  if (window.matchMedia) { var mq = window.matchMedia("(prefers-color-scheme: dark)"); if (mq.addEventListener) mq.addEventListener("change", applyPal); }
  new MutationObserver(function () { applyPal(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  function drawTicks() {
    var el = $("ticks"), VS = viewsFor(), out = [], T_RUN = LAB_T;
    VS.forEach(function (v) { (v.R.events || []).forEach(function (e) { if (e.ego) out.push([e.t, "var(--hit)"]); }); });
    el.innerHTML = out.map(function (o) { return '<i style="left:' + (o[0] / T_RUN * 100).toFixed(2) + "%;background:" + o[1] + '"></i>'; }).join("");
  }

  // ---------------------------------------------------------------- toasts for ego events during playback
  var toastT = 0, lastT = 0, seen = {};
  function resetToasts() { seen = {}; lastT = st.t; }
  function toast(msg) { var el = $("toast"); el.textContent = msg; el.hidden = false; toastT = performance.now() + 3400; }
  function eventToasts(VIEWS) {
    if (st.t < lastT) { seen = {}; }
    VIEWS.forEach(function (v, vi) {
      (v.R.events || []).forEach(function (e, i) {
        var k = vi + ":" + i; if (!e.ego || seen[k] || e.t > st.t || e.t < lastT - 0.001) return; seen[k] = 1;
        var pre = VIEWS.length > 1 ? (vi === 0 ? "Bên trái: " : "Bên phải: ") : "", replay = v.R.opts && v.R.opts.others === "replay";
        if (e.type === "hit") toast(pre + "va chạm xe ta – " + ACT[e.ib].name + " lúc " + fmt(e.t) + " s" + (replay ? " (xe phát lại không phanh: va chạm ảo)" : ""));
        else if (e.type === "red") toast(pre + "xe ta vượt đèn đỏ lúc " + fmt(e.t) + " s");
        else if (e.type === "off") toast(pre + "xe ta ra khỏi lòng đường lúc " + fmt(e.t) + " s");
      });
    });
    lastT = st.t;
  }

  // ---------------------------------------------------------------- frame loop
  function resize() { var w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); plotDirty = true; }
  window.addEventListener("resize", resize);
  var last = performance.now(), uiT = 0;
  function frame(now) {
    var dtReal = Math.min(0.1, (now - last) / 1000); last = now;
    // adaptive resolution: if frames stay slower than ~40 fps for a second, render fewer pixels
    if (dtReal > 0.025) slowAcc += dtReal; else slowAcc = Math.max(0, slowAcc - dtReal * 0.5);
    if (slowAcc > 1 && PR > 1) { PR = Math.max(1, PR - 0.25); renderer.setPixelRatio(PR); resize(); slowAcc = 0; }
    var c = CH[0];
    if (st.playing) { var tm = tMax(); st.t += dtReal * st.speed; if (st.t >= tm) { st.t = tm; st.playing = false; syncPlay(); } }
    var t = st.t, VIEWS = viewsFor(), RECT = layoutViews(VIEWS.length), egoLast = null, Wc = stage.clientWidth, Hc = stage.clientHeight;
    stepTween(); paintLights(t);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc); renderer.clear();
    VIEWS.forEach(function (v, vi) {
      var R = v.R, rect = RECT[vi];
      for (var i = 0; i < NA; i++) place(actorObj[i], ACT[i], pose(R, i, t), t);
      var ego = pose(R, 0, t); egoLast = ego;
      showTrail(trEgo, R, 0, 0.12, t);
      if (v.attention) { drawAttention(R, t, ego, v.egoAttention); stateLabels(R, t, ego); } else attLines.visible = false;
      if (v.gapBar) drawGapBar(R, t, ego); else gapBar.visible = false;
      var hits = (R.events || []).filter(function (e) { return e.type === "hit" && e.ego && e.t <= t + 1e-6; });
      hitRings.forEach(function (rm, n) { var e = hits[n]; rm.visible = !!e; if (e) { rm.position.set(e.x, 0.3, e.z); var s = 1 + 0.15 * Math.sin(now / 160); rm.scale.set(s, 1, s); } });
      hits.forEach(function (e) { label(e.x, 4.6, e.z, "va chạm", "hit"); });
      label(ego.x, 2.6, ego.z, "xe ta", "ego");
      if (st.labels) ["L1", "TG", "C2", "BUS", "P1", "NR", "MB"].forEach(function (id) { var q = pose(R, IDX[id], t); if (Math.hypot(q.x - ego.x, q.z - ego.z) < 60) label(q.x, ACT[IDX[id]].kind === "bus" ? 3.6 : 2.4, q.z, ACT[IDX[id]].name, ""); });
      sun.position.set(ego.x + 40, 90, ego.z + 30); sun.target.position.set(ego.x, 0, ego.z);
      placeCamera(dtReal, ego, vi);
      camera.aspect = rect.w / Math.max(1, rect.h); camera.updateProjectionMatrix();
      renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc);
      renderer.render(scene, camera);
      flushLabels(rect);
    });
    endLabels();
    var ego = egoLast;
    // HUD + transport (throttled)
    if (now - uiT > 80) {
      uiT = now;
      $("hudV").textContent = Math.round(ego.v * 3.6);
      var mh = c.mode(); if (mh !== st.lastMode) { $("hudMode").innerHTML = mh; st.lastMode = mh; }
      timeEl.value = t; treadEl.textContent = fmt(t) + " s";
      if (toastT && now > toastT) { $("toast").hidden = true; toastT = 0; }
    }
    eventToasts(VIEWS);
    var cv = $("plot");
    if (cv && c.plot) {
      var rebuild = plotDirty || PB.cv !== cv;
      if (rebuild) {   // data changed: draw the series once and keep a copy
        var P = plotSetup(cv), A = c.plot(P, t);
        PB.off.width = cv.width; PB.off.height = cv.height; PB.off.getContext("2d").drawImage(cv, 0, 0);
        PB.cv = cv; PB.P = P; PB.A = A; PB.t = now; plotDirty = false;
      }
      if (PB.A && (rebuild || (Math.abs(t - lastPlotT) > 0.04 && now - PB.drawn > 60))) {   // time moved: blit + playhead only
        var g2 = cv.getContext("2d"); g2.setTransform(1, 0, 0, 1, 0, 0); g2.clearRect(0, 0, cv.width, cv.height); g2.drawImage(PB.off, 0, 0);
        g2.setTransform(PB.P.dpr, 0, 0, PB.P.dpr, 0, 0); playhead(PB.P, PB.A, t); lastPlotT = t; PB.drawn = now;
      }
    }
    requestAnimationFrame(frame);
  }
  // ---------------------------------------------------------------- boot
  applyPal(); resize();
  timeEl.max = LAB_T;
  go();
  window.__replayLab = { egoX: function () { return actorObj[0].position.x; }, pr: function () { return PR; } };   // read-only probe for automated checks
  requestAnimationFrame(frame);
})();
