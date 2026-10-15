/* sim.js — deterministic street scenario for "Phòng phát lại" (Day 12: log replay, open loop, closed loop, reactive agents).
   Pure JS, no DOM: window.ReplaySim in the browser, module.exports in node (for tuning).
   Units: metres, seconds. World frame: x east, z south, y up (three.js). Right-hand traffic.
   Headings are unit vectors [hx, hz]; the right-hand normal of [hx, hz] is [-hz, hx].

   A World is a stepper: step() advances one frame of DT. Every actor except the ego follows a lane path
   (arc length s, lateral offset d). The ego is a kinematic bicycle (x, z, heading, v, steer) so a person can
   drive it anywhere. Others are either "reactive" (IDM + gap acceptance + lights) or "replay" (pose read from a log). */
(function (root) {
  "use strict";
  var DT = 0.05, T_END = 46, NF = Math.round(T_END / DT) + 1, G = 9.81, WB = 2.8;

  // ------------------------------------------------------------------ paths (dense polylines)
  function seg(x0, z0, x1, z1, step) {
    var n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (step || 1))), p = [];
    for (var i = 0; i <= n; i++) p.push([x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n]);
    return p;
  }
  function arc(cx, cz, r, a0, a1, step) {
    var n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / (step || 0.5))), p = [];
    for (var i = 0; i <= n; i++) { var a = a0 + (a1 - a0) * i / n; p.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
    return p;
  }
  function path() {
    var pts = [];
    for (var k = 0; k < arguments.length; k++) {
      var q = arguments[k];
      for (var i = 0; i < q.length; i++) { var l = pts[pts.length - 1]; if (!l || Math.hypot(q[i][0] - l[0], q[i][1] - l[1]) > 1e-6) pts.push(q[i]); }
    }
    var s = [0];
    for (var j = 1; j < pts.length; j++) s.push(s[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    return { pts: pts, s: s, len: s[s.length - 1] };
  }
  function at(P, s, d) {
    s = Math.max(0, Math.min(P.len - 1e-6, s));
    var lo = 0, hi = P.s.length - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (P.s[m] <= s) lo = m; else hi = m; }
    var a = P.pts[lo], b = P.pts[hi], L = P.s[hi] - P.s[lo] || 1, u = (s - P.s[lo]) / L;
    var hx = (b[0] - a[0]) / L, hz = (b[1] - a[1]) / L;
    return { x: a[0] + (b[0] - a[0]) * u - hz * (d || 0), z: a[1] + (b[1] - a[1]) * u + hx * (d || 0), hx: hx, hz: hz };
  }

  // ------------------------------------------------------------------ the map
  // main road east-west (2 lanes each way), a signalised crossroad at x = 330, a bus stop at x = 206 and a zebra at x = 226 just past it.
  var CX = 290, X0 = -600, X1 = 1000;   // crossroad centre; lane paths run far past the visible street so nobody parks at a path end
  var ROAD = { xMin: -140, xMax: 520, half: 7, crossX: CX, crossHalf: 7, walkX: 192, busX: 172, stopE: CX - 9, stopW: CX + 9, stopN: 9, stopS: -9 };
  var LANES = {
    E1: path(seg(X0, 1.75, X1, 1.75, 2)), E2: path(seg(X0, 5.25, X1, 5.25, 2)),
    W1: path(seg(X1, -1.75, X0, -1.75, 2)), W2: path(seg(X1, -5.25, X0, -5.25, 2)),
    NB: path(seg(CX + 1.75, 400, CX + 1.75, -400, 2)), SB: path(seg(CX - 1.75, -400, CX - 1.75, 400, 2)),
    NR: path(seg(CX + 1.75, 70, CX + 1.75, 10), arc(CX + 6.5, 10, 4.75, Math.PI, 1.5 * Math.PI), seg(CX + 6.5, 5.25, X1, 5.25, 2)),
    WALK: path(seg(ROAD.walkX, 9.2, ROAD.walkX, -9.2, 0.25)),
    SWS: path(seg(-60, 8.7, 500, 8.7)), SWN: path(seg(500, -8.7, -60, -8.7))
  };
  // which signal a lane obeys and where its stop line is (arc length)
  function sOf(lane, x) { return lane.charAt(0) === "E" ? x - X0 : X1 - x; }
  var STOP = { E1: ["main", sOf("E", ROAD.stopE)], E2: ["main", sOf("E", ROAD.stopE)], W1: ["main", sOf("W", ROAD.stopW)], W2: ["main", sOf("W", ROAD.stopW)],
               NB: ["cross", 400 - ROAD.stopN], SB: ["cross", 400 - ROAD.stopN], NR: ["cross", 70 - ROAD.stopN] };
  /* Signal plan (s). main: green, amber from SIG.mY, red from SIG.mR, green again from SIG.mG. cross: green SIG.cG..SIG.cY, amber to SIG.cR. */
  var SIG = { mY: 30, mR: 33, cG: 34, cY: 39.5, cR: 41.5, mG: 42.5 };
  function light(sig, t) {
    if (sig === "main") return t < SIG.mY ? "G" : t < SIG.mR ? "Y" : t < SIG.mG ? "R" : "G";
    return t < SIG.cG ? "R" : t < SIG.cY ? "G" : t < SIG.cR ? "Y" : "R";
  }

  var CAR = { len: 4.6, wid: 1.9 }, BUS = { len: 12, wid: 2.55 }, PED = { len: 0.6, wid: 0.6 }, MOTO = { len: 1.9, wid: 0.75 };
  function idm(o) { return Object.assign({ v0: 12.5, T: 1.4, a: 1.6, b: 2.4, s0: 2.0 }, o || {}); }

  /* Scenario knobs (the sweep in chapter 7 and the personality sliders in chapter 6 change these). */
  var DEFAULTS = {
    brkT0: 5.0, brkDecel: 5.0, brkDur: 1.8,     // the lead car brakes hard (something only it can see)
    cutT0: 8.0, cutDur: 2.2, cutV: 13.6, cutDs: -9, cutGap: 3.0, cutBrake: 0,   // the car in the right lane cuts in front of the ego (the bus blocks its lane)
    pedT0: 11.0, pedV: 1.5, pedGap: 3.0,        // the pedestrian behind the bus: earliest start, speed, accepted gap [s]
    busGo: 17.0,                                // the bus pulls out
    tgT: 0.75,                                  // the tailgater's time headway [s]
    mu: 0.8,                                    // road friction (caps braking at mu * g)
    // personality of the reactive drivers (chapter 6)
    // Lab 12 scenes (chapter 8). scene: "" (the street), "brake", "cutin", "log"
    egoV0: 0, leadProf: null, egoProf: null, leadGap0: 12, labCut: null, tgMode: "idm", rearGap: 0,
    kT: 1.0,           // multiplies every other driver's time headway
    kA: 1.0,           // multiplies their comfortable acceleration and braking
    react: 0.0         // their reaction delay [s]
  };
  /* Ego planners. human = the driver who produced the log. */
  var POLICY = { delay: 0.5, cautionV: 6.0, cautionRange: 48, pedBuffer: 2.0, v0: 11.0, T: 1.9, mlpK: 1.0, mlpWin: 10, mlpV: 0 };
  var PLANNERS = {
    idm: { name: "Bộ luật IDM", short: "IDM" },
    percmlp: { name: "PercMLP (nhìn thấy, có độ trễ)", short: "PercMLP" },
    egomlp: { name: "EgoMLP (chỉ nhìn quá khứ của xe ta)", short: "EgoMLP" },
    cv: { name: "Vận tốc không đổi", short: "CV" },
    // Lab 12 planners (trained on real Argoverse car-following logs, see Day12/solution): learned car following + a rule layer for lights and pedestrians
    labcv: { name: "Bài lab · Vận tốc không đổi", short: "CV" },
    labidm: { name: "Bài lab · IDM (luật)", short: "IDM" },
    labego: { name: "Bài lab · EgoMLP (chỉ nhìn quá khứ)", short: "EgoMLP" },
    labperc: { name: "Bài lab · PercMLP (nhìn xe dẫn)", short: "PercMLP" },
    labfix: { name: "Bài lab · PercMLP+ (sau khi sửa)", short: "PercMLP+" }
  };

  function makeActors(p) {
    var A = [];
    function add(o) { o.idx = A.length; o.d = o.d || 0; A.push(o); return o; }
    function E(x) { return x - X0; } function W(x) { return X1 - x; }
    var egoV = p.egoV0 || 11.2;
    add({ id: "ego", name: "xe ta", kind: "ego", dims: CAR, lane: "E1", s: E(0), v: egoV, ctl: "ego", color: "ego" });
    var L1 = add({ id: "L1", name: "xe dẫn", kind: "car", dims: CAR, lane: "E1", s: E(30), v: 11.5, ctl: "idm", p: idm({ v0: 12.2 }), color: "c1",
          brk: { t0: p.brkT0, decel: p.brkDecel, dur: p.brkDur } });
    if (p.leadProf) { L1.s = E(p.leadGap0 + CAR.len); L1.v = p.leadProf[0]; L1.prof = p.leadProf; L1.brk = null; }      // the lead drives a recorded speed profile
    if (p.labCut) { L1.s = E(400); L1.v = 12; L1.brk = null; }                                                         // a cut-in scene: the original lead is out of the way
    var TG = add({ id: "TG", name: "xe bám đuôi", kind: "car", dims: CAR, lane: "E1", s: E(-13), v: 11.4, ctl: "idm", p: idm({ v0: 13.5, T: p.tgT, a: 2.0, b: 3.2, s0: 1.4 }), color: "c3", dark: true });
    if (p.rearGap) TG.s = E(-(CAR.len + p.rearGap));
    if (p.tgMode === "const") { TG.ctl = "const"; TG.v = egoV; }                                                         // a replayed rear car: keeps its logged speed, cannot react
    var C2 = add({ id: "C2", name: "xe chen làn", kind: "car", dims: CAR, lane: "E2", s: E(p.cutDs), v: p.cutV, ctl: "idm", p: idm({ v0: p.cutV, T: 0.9, b: 3.0 }), color: "adv",
          cut: { t0: p.cutT0, dur: p.cutDur, d1: -3.5, gap: p.cutGap, brake: p.cutBrake } });
    if (p.labCut) {   // the lab's cut-in: a slower car already `gap` m ahead in the ego lane at t = 0, holding its speed
      C2.lane = "E1"; C2.s = E(p.labCut.gap + CAR.len); C2.v = egoV - p.labCut.dv; C2.cut = null; C2.d = 0;
      C2.p = idm({ v0: Math.max(0.5, C2.v), T: 0.1, s0: 0, a: 1, b: 3 }); C2.name = "xe cắt vào";
    }
    add({ id: "E5", name: "xe", kind: "car", dims: CAR, lane: "E2", s: E(-46), v: 12, ctl: "idm", p: idm({ v0: 12.5 }), color: "c2" });
    add({ id: "MB", name: "xe máy", kind: "moto", dims: MOTO, lane: "E2", s: E(-70), v: 10.5, d: 1.1, ctl: "idm", p: idm({ v0: 11, T: 1.0, s0: 1.5 }), color: "c4" });
    add({ id: "BUS", name: "xe buýt", kind: "bus", dims: BUS, lane: "E2", s: E(ROAD.busX), v: 0, ctl: "idm", hold: p.busGo, p: idm({ v0: 9, a: 1.0, T: 1.6 }), color: "bus" });
    // oncoming
    [["W1a", "W1", 250, 11.5, "c2"], ["W1b", "W1", 330, 12, "c1"], ["W2a", "W2", 215, 11, "c4"], ["W2b", "W2", 400, 12.5, "c3"],
     ["W1c", "W1", 450, 12, "c2"], ["W2c", "W2", 120, 11.5, "c1"], ["W1d", "W1", 60, 12, "c4"], ["W2d", "W2", 520, 12, "c2"]].forEach(function (w) {
      add({ id: w[0], name: "xe ngược chiều", kind: "car", dims: CAR, lane: w[1], s: W(w[2]), v: w[3], ctl: "idm", p: idm({ v0: w[3] + 0.5 }), color: w[4] });
    });
    // cross traffic waits for its green; NR turns right into the ego's direction
    add({ id: "NR", name: "xe rẽ phải", kind: "car", dims: CAR, lane: "NR", s: 70 - 14.2, v: 0, ctl: "idm", p: idm({ v0: 8.5, a: 1.5 }), color: "c4" });
    add({ id: "N1", name: "xe cắt ngang", kind: "car", dims: CAR, lane: "NB", s: 400 - 22, v: 0, ctl: "idm", p: idm({ v0: 11, a: 1.8 }), color: "c2" });
    add({ id: "N2", name: "xe cắt ngang", kind: "car", dims: CAR, lane: "NB", s: 400 - 60, v: 7, ctl: "idm", p: idm({ v0: 11, a: 1.8 }), color: "c1", dark: true });
    add({ id: "S1", name: "xe cắt ngang", kind: "car", dims: CAR, lane: "SB", s: 400 - 14.2, v: 0, ctl: "idm", p: idm({ v0: 11, a: 1.8 }), color: "c3" });
    add({ id: "S2", name: "xe cắt ngang", kind: "car", dims: CAR, lane: "SB", s: 400 - 21.6, v: 0, ctl: "idm", p: idm({ v0: 11, a: 1.8 }), color: "c2" });
    // people
    add({ id: "P1", name: "người qua đường", kind: "ped", dims: PED, lane: "WALK", s: 0, v: 0, ctl: "walk", t0: p.pedT0, vw: p.pedV, gap: p.pedGap, color: "ped" });
    add({ id: "P2", name: "người đi bộ", kind: "ped", dims: PED, lane: "SWS", s: 150, v: 1.3, ctl: "walk", t0: 0, vw: 1.3, color: "ped" });
    add({ id: "P3", name: "người đi bộ", kind: "ped", dims: PED, lane: "SWN", s: 260, v: 1.2, ctl: "walk", t0: 0, vw: 1.2, color: "ped" });
    add({ id: "P4", name: "người chờ xe buýt", kind: "ped", dims: PED, lane: "SWS", s: 60 + ROAD.busX + 4, v: 0, d: 0.6, ctl: "walk", t0: 1e9, vw: 0, color: "ped" });
    return A;
  }
  var PARKED = [
    { x: CX + 9.6, z: 26, hx: 0, hz: -1, color: "c2" }, { x: CX + 9.6, z: 34, hx: 0, hz: -1, color: "c1", dark: true },
    { x: CX - 9.6, z: -24, hx: 0, hz: 1, color: "c4" }, { x: CX - 9.6, z: 20, hx: 0, hz: 1, color: "c3" }, { x: CX + 9.6, z: -20, hx: 0, hz: -1, color: "c3" }
  ];

  /* speed of a recorded profile (10 Hz samples) at time t; after the last sample it holds the last value */
  function profAt(P, t) { var k = t * 10, i = Math.floor(k), j = Math.min(P.length - 1, i + 1); i = Math.min(P.length - 1, i); return P[i] + (P[j] - P[i]) * (k - Math.floor(k)); }

  // ------------------------------------------------------------------ geometry
  function obb(st, dims) { return { x: st.x, z: st.z, hx: st.hx, hz: st.hz, l: dims.len / 2, w: dims.wid / 2 }; }
  function overlap(a, b) {
    var ax = [[a.hx, a.hz], [-a.hz, a.hx], [b.hx, b.hz], [-b.hz, b.hx]], dx = b.x - a.x, dz = b.z - a.z;
    for (var i = 0; i < 4; i++) {
      var n = ax[i], ra = a.l * Math.abs(n[0] * a.hx + n[1] * a.hz) + a.w * Math.abs(-n[0] * a.hz + n[1] * a.hx);
      var rb = b.l * Math.abs(n[0] * b.hx + n[1] * b.hz) + b.w * Math.abs(-n[0] * b.hz + n[1] * b.hx);
      if (Math.abs(n[0] * dx + n[1] * dz) > ra + rb) return false;
    }
    return true;
  }
  function segHitsBox(x0, z0, x1, z1, b) {
    var rx = x0 - b.x, rz = z0 - b.z, qx = x1 - b.x, qz = z1 - b.z;
    var p = [rx * b.hx + rz * b.hz, -rx * b.hz + rz * b.hx], q = [qx * b.hx + qz * b.hz, -qx * b.hz + qz * b.hx];
    var t0 = 0, t1 = 1, d = [q[0] - p[0], q[1] - p[1]], e = [b.l, b.w];
    for (var k = 0; k < 2; k++) {
      if (Math.abs(d[k]) < 1e-9) { if (Math.abs(p[k]) > e[k]) return false; continue; }
      var u = (-e[k] - p[k]) / d[k], v = (e[k] - p[k]) / d[k]; if (u > v) { var w = u; u = v; v = w; }
      t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) return false;
    }
    return true;
  }
  function idmAcc(P, v, lead, aMin) {
    var ss = P.s0 + Math.max(0, v * P.T + v * (v - lead[1]) / (2 * Math.sqrt(P.a * P.b)));
    var free = 1 - Math.pow(Math.max(0, v) / P.v0, 4);
    var inter = lead[2] < 0 ? 0 : Math.pow(ss / Math.max(lead[0], 0.2), 2);
    return Math.max(aMin, Math.min(P.a, P.a * (free - inter)));
  }

  /* Nearest thing ahead in my corridor. `me` = {x,z,hx,hz,len,wid,idx}; `others` = array of states with dims/kind/v.
     Returns [gap, v_along_my_heading, idx]. Crossing or oncoming cars count, with their speed along my heading (>= 0). */
  function leaderOf(me, others, latPad, skipPed) {
    var best = [1e9, 0, -1], halfL = me.len / 2;
    for (var j = 0; j < others.length; j++) {
      var b = others[j]; if (!b || j === me.idx) continue;
      var rx = b.x - me.x, rz = b.z - me.z, lon = rx * me.hx + rz * me.hz;
      if (lon <= 0 || lon > 110) continue;
      var lat = -rx * me.hz + rz * me.hx, dot = b.hx * me.hx + b.hz * me.hz;
      var bw = Math.abs(dot) > 0.5 ? b.wid / 2 : b.len / 2, bl = Math.abs(dot) > 0.5 ? b.len / 2 : b.wid / 2;
      if (b.kind === "ped") { if (skipPed || Math.abs(lat) > me.wid / 2 + 0.7) continue; var gp = lon - halfL - 1.2; if (gp < best[0]) best = [gp, 0, j]; continue; }
      if (Math.abs(lat) > me.wid / 2 + bw + (latPad == null ? 0.15 : latPad)) continue;
      var g = lon - halfL - bl;
      if (g < best[0]) best = [g, Math.max(0, b.v * dot), j];
    }
    return best;
  }

  /* ------------------------------------------------------------------ what the ego can perceive (shared by the human driver, IDM and PercMLP)
     view = { t, ego: {x,z,hx,hz,v,len,wid,idx:0}, hist: [ego speed at t - 0.05 k, k = 0..60], others: [...] (index aligned with actors),
              occl: function(x0,z0,x1,z1) -> true if a vehicle blocks the line, pedIdx, mu } */
  function percept(view) {
    var e = view.ego, out = { lead: leaderOf(e, view.others, 0.1, true), stop: null, amber: 0, ped: null, pedVis: 0, curbHidden: 0 };
    var dxw = ROAD.walkX - e.x, ped = view.others[view.pedIdx];
    if (ped && e.hx > 0.5) {
      out.pedVis = view.occl(e.x, e.z, ped.x, ped.z) ? 0 : 1;
      out.curbHidden = dxw > 0 && dxw < 48 && view.occl(e.x, e.z, ROAD.walkX, 8.6) ? 1 : 0;
      var walking = ped.v > 0.05 && ped.z > e.z - 2.4 && ped.z < 9.3;
      if (walking && out.pedVis && dxw > -2)
        out.ped = { gap: dxw - e.len / 2 - 2.2, idx: view.pedIdx, tEnter: Math.max(0, (ped.z - (e.z + 1.6)) / Math.max(ped.v, 0.3)), tArrive: (dxw - 3) / Math.max(e.v, 0.5) };
    }
    if (e.hx > 0.5 && e.z > 0 && e.z < 7) {
      var ds = ROAD.stopE - (e.x + e.len / 2), L = light("main", view.t);
      if (ds > -0.3 && ds < 70) { if (L === "R") out.stop = ds; else if (L === "Y") { out.amber = 1; if (ds > e.v * e.v / (2 * 3.2)) out.stop = ds; } }
    }
    return out;
  }
  /* ------------------------------------------------------------------ the two learned planners
     EgoMLP sees only the ego's own speed over the last 2 s (9 numbers). PercMLP sees the same plus 5 numbers from perception:
     gap and speed of the car ahead, distance to a pedestrian about to cross, distance to a stop line it must stop at, amber.
     Both output the ego speed at +0.5, +1.0 ... +3.0 s. Weights come from train.js (imitation of the logged human driver). */
  var HIST_K = [0, 5, 10, 15, 20, 25, 30, 35, 40], VS = 15, DS = 60;
  var FEAT_NAMES = { egomlp: ["v −2,0 s", "v −1,75", "v −1,5", "v −1,25", "v −1,0", "v −0,75", "v −0,5", "v −0,25", "v bây giờ"],
    percmlp: ["v −2,0 s", "v −1,75", "v −1,5", "v −1,25", "v −1,0", "v −0,75", "v −0,5", "v −0,25", "v bây giờ", "khoảng cách xe trước", "vận tốc xe trước", "người qua đường", "vạch dừng", "đèn vàng"] };
  function features(kind, view, pc) {
    var h = view.hist, x = [];
    for (var k = HIST_K.length - 1; k >= 0; k--) x.push(h[Math.min(h.length - 1, HIST_K[k])] / VS);   // oldest first, "now" last
    if (kind === "egomlp") return x;
    pc = pc || percept(view);
    var L = pc.lead, has = L[2] >= 0 && L[0] < DS;
    x.push(has ? Math.max(0, L[0]) / DS : 1, (has ? L[1] : view.ego.v) / VS, pc.ped ? Math.max(0, Math.min(DS, pc.ped.gap)) / DS : 1, pc.stop != null ? Math.max(0, Math.min(DS, pc.stop)) / DS : 1, pc.amber);
    return x;
  }
  var MODELS = (typeof module !== "undefined" && module.exports) ? (function () { try { return require("./models.js"); } catch (e) { return null; } })() : (root.REPLAY_MODELS || null);
  function mlp(M, x) {
    var a = x;
    for (var l = 0; l < M.layers.length; l++) {
      var L = M.layers[l], out = new Array(L.b.length);
      for (var j = 0; j < L.b.length; j++) { var s = L.b[j], w = L.W[j]; for (var i = 0; i < a.length; i++) s += w[i] * a[i]; out[j] = l < M.layers.length - 1 ? Math.tanh(s) : s; }
      a = out;
    }
    return a;
  }
  /* speeds the model predicts at +0.5 .. +3.0 s (m/s), or null if no weights are loaded */
  function predictSpeeds(kind, view, pc) {
    if (!MODELS || !MODELS[kind]) return null;
    var y = mlp(MODELS[kind], features(kind, view, pc)), v = [];
    for (var k = 0; k < y.length; k++) v.push(Math.max(0, y[k] * VS));
    return v;
  }

  /* ------------------------------------------------------------------ ego decision (closed loop, open loop and the planner preview)
     returns { acc, mode, pedVis, lead } — mode: 0 cruise, 1 follow, 2 caution (crosswalk hidden), 3 yield to pedestrian, 4 red light */
    /* ------------------------------------------------------------------ Lab 12 planners
     The MLPs come from the Day 12 lab (numpy -> lab_models.js, written by scripts/export_viz.py): 10 Hz features, ReLU, 128-128 hidden, 30 outputs (speed deltas for 3 s).
       EgoMLP   : own speed over the last 2 s (21 numbers, relative to now) + own speed
       PercMLP  : the same + gap and (lead speed - own speed)
       PercMLP+ : PercMLP after the fix of step 7 (cut-in scenario windows + DAgger)
     The command is the predicted speed change after 0.5 s divided by 0.5 s. They know car following only: lights and pedestrians are
     handled by a rule layer (IDM braking towards the stop line or the pedestrian), the same for every planner except CV. */
  var LAB = (typeof module !== "undefined" && module.exports) ? (function () { try { return require("./lab_models.js"); } catch (e) { return null; } })() : (root.LAB_MODELS || null);
  var LABKEY = { labego: "ego", labperc: "perc", labfix: "percfix" };
  function labMlp(M, x) {
    var a = x.map(function (v, i) { return (v - M.mu[i]) / (M.sd[i] || 1); });
    for (var l = 0; l < M.layers.length; l++) {
      var L = M.layers[l], out = L.b.slice();
      for (var i = 0; i < a.length; i++) { var w = L.W[i], ai = a[i]; for (var j = 0; j < out.length; j++) out[j] += ai * w[j]; }
      if (l < M.layers.length - 1) for (var j2 = 0; j2 < out.length; j2++) if (out[j2] < 0) out[j2] = 0;
      a = out;
    }
    return a;
  }
  function labModel(kind, pol) { var m = LAB && LAB[LABKEY[kind]]; if (!m) return null; var s = pol && pol.labSeed != null ? pol.labSeed : Object.keys(m)[0]; return m[s] || m[Object.keys(m)[0]]; }
  function labDecide(kind, view, pol) {
    var e = view.ego, aMin = -Math.min(9, view.mu * G), pc = percept(view), L = pc.lead, has = L[2] >= 0 && L[0] < 80;
    var gap = has ? L[0] : 80, lv = has ? L[1] : e.v, info = { acc: 0, mode: has ? 1 : 0, pedVis: pc.pedVis, lead: has ? L[2] : -1 };
    var P = { v0: 15, T: 1.2, a: 1.5, b: 2.0, s0: 2.0 };
    if (kind === "labidm") info.acc = idmAcc(P, e.v, has ? [gap, lv, L[2]] : [1e9, e.v, -1], aMin);
    else if (kind === "labcv") return info;
    else {
      var M = labModel(kind, pol);
      if (M) {
        var x = [], v = e.v;
        for (var j = 20; j >= 0; j--) x.push(view.hist[Math.min(view.hist.length - 1, 2 * j)] - v);
        x.push(v); if (kind !== "labego") x.push(gap, lv - v);
        var y = labMlp(M, x);
        info.acc = Math.max(aMin, Math.min(3.0, y[4] / 0.5)); info.pred = y;
      }
    }
    // rule layer: a pedestrian about to cross, or a red light, acts as a stopped car ahead
    var rule = null;
    if (pc.ped && pc.ped.tEnter < pc.ped.tArrive + 2.0 && pc.ped.gap < gap) rule = { gap: pc.ped.gap, mode: 3 };
    if (pc.stop != null && pc.stop < (rule ? rule.gap : gap)) rule = { gap: Math.max(0.1, pc.stop), mode: 4 };
    if (rule) { var ar = idmAcc(P, e.v, [rule.gap, 0, 99], aMin); if (ar < info.acc) { info.acc = ar; info.mode = rule.mode; } }
    return info;
  }
  function decide(kind, view, pol) {
    if (kind.indexOf("lab") === 0) return labDecide(kind, view, pol);
    var e = view.ego, aMin = -Math.min(9, view.mu * G);
    if (kind === "cv") return { acc: 0, mode: 0, pedVis: 0, lead: -1 };
    if (kind === "egomlp" || kind === "percmlp") {
      var pc0 = kind === "percmlp" ? percept(view) : null, vp = predictSpeeds(kind, view, pc0);
      if (vp) return { acc: Math.max(aMin, Math.min(2.5, (vp[0] - e.v) / 0.5)), mode: 0, pedVis: pc0 ? pc0.pedVis : 0, lead: pc0 && pc0.lead[0] < DS ? pc0.lead[2] : -1, pred: vp };
    }
    if (kind === "egomlp") {   // fallback when no weights are loaded: keep the recent speed trend
      var h = view.hist, a1 = (h[0] - h[10]) / (10 * DT);
      return { acc: Math.max(aMin, Math.min(2, a1)), mode: 0, pedVis: 0, lead: -1 };
    }
    var human = kind === "human", pc = percept(view);
    var P = human ? idm({ v0: 12.5, T: 1.2, a: 1.8, b: 3.0, s0: 2.0 }) : kind === "percmlp" ? idm({ v0: 12.5, T: 1.3, a: 1.8, b: 3.0, s0: 2.0 }) : idm({ v0: pol.v0, T: pol.T, a: 1.6, b: 2.6, s0: 2.5 });
    var lead = pc.lead, mode = lead[2] >= 0 && lead[0] < 40 ? 1 : 0;
    if (pc.ped && pc.ped.tEnter < pc.ped.tArrive + (human ? 1.0 : pol.pedBuffer) && pc.ped.gap < lead[0]) { lead = [pc.ped.gap, 0, view.pedIdx]; mode = 3; }
    if (kind === "idm" && pc.curbHidden && !pc.pedVis && mode !== 3) { P.v0 = Math.min(P.v0, pol.cautionV); mode = 2; }
    if (pc.stop != null && pc.stop < lead[0]) { lead = [Math.max(0.1, pc.stop), 0, -2]; mode = 4; }
    var a = idmAcc(P, e.v, lead[2] === -2 ? [lead[0], 0, 99] : lead, aMin);
    return { acc: a, mode: mode, pedVis: pc.pedVis, lead: lead[2] };
  }

  // ------------------------------------------------------------------ the world (a stepper)
  /* opts: { params, ego: "human"|"planner"|"manual"|"track"|"log", planner: "idm"|..., policy,
             others: "reactive"|"replay", log: a finished World's record (for replay or ego "log"), track: Float32Array NF*6 (ego poses),
             takeover: frame at which the ego leaves the log and starts driving itself (needs log), egoBrake: {t0, dur, decel}, tEnd: stop early } */
  function World(opts) {
    opts = opts || {};
    this.opts = opts;
    var p = this.p = Object.assign({}, DEFAULTS, opts.params || {});
    this.pol = Object.assign({}, POLICY, opts.policy || {});
    this.A = makeActors(p); this.N = this.A.length;
    this.F = new Float32Array(NF * this.N * 8);   // x, z, hx, hz, v, a, d, flag
    this.EGO = new Float32Array(NF * 4);          // mode, pedVisible, leader idx, steer
    this.LS = new Int16Array(NF * this.N * 2);    // per other actor: what it reacts to (actor idx, -2 stop line, -1 nothing), and its state
    /* states: 0 free, 1 following, 2 stopping for the light, 3 yielding to a pedestrian, 4 waiting for a gap, 5 changing lane, 6 scripted hard brake, 7 walking */
    this.f = 0; this.marks = []; this.events = []; this.hit = {}; this.done = false; this.red = null; this.off = null;
    this.tk = opts.log && opts.takeover ? opts.takeover : 0; this.nfMax = opts.tEnd ? Math.min(NF, Math.round(opts.tEnd / DT) + 1) : NF;
    this.aMin = -Math.min(9, p.mu * G);
    var e = at(LANES.E1, -X0, 0);
    this.ego = { x: e.x, z: e.z, th: 0, v: this.A[0].v, steer: 0, a: 0 };
    this.vh = []; for (var k = 0; k <= 60; k++) this.vh.push(this.ego.v);   // ego speed history (newest first)
    this.hist = [];                                                     // recent state arrays (perception delay)
    this.replay = opts.others === "replay" && opts.log ? opts.log : null;
    this.pedIdx = 0; for (var i = 0; i < this.N; i++) if (this.A[i].id === "P1") this.pedIdx = i;
  }
  World.prototype.state = function (a) { return at(LANES[a.lane], a.s, a.d); };
  World.prototype.logPose = function (L, f, i) { var k = (f * L.N + i) * 8; return { x: L.F[k], z: L.F[k + 1], hx: L.F[k + 2], hz: L.F[k + 3], v: L.F[k + 4], a: L.F[k + 5], d: L.F[k + 6], flag: L.F[k + 7] }; };
  World.prototype.egoState = function () {
    var g = this.ego, md = this.f < this.tk ? "log" : this.opts.ego, f = this.f;
    if (md === "log" && this.opts.log) { var q = this.logPose(this.opts.log, f, 0); return { x: q.x, z: q.z, hx: q.hx, hz: q.hz, v: q.v }; }
    if (md === "track" && this.opts.track) { var T = this.opts.track, k = Math.min(f, NF - 1) * 6; return { x: T[k], z: T[k + 1], hx: T[k + 2], hz: T[k + 3], v: T[k + 4] }; }
    return { x: g.x, z: g.z, hx: Math.cos(g.th), hz: Math.sin(g.th), v: g.v };
  };
  World.prototype.occluder = function (sts) {
    var A = this.A, self = this;
    return function (x0, z0, x1, z1, skip) {
      for (var j = 1; j < A.length; j++) { if (A[j].kind === "ped" || j === skip) continue; if (segHitsBox(x0, z0, x1, z1, obb(sts[j], A[j].dims))) return true; }
      return false;
    };
  };
  /* cmd (manual ego only): { acc: m/s^2, steer: -1..1 } */
  World.prototype.step = function (cmd) {
    if (this.f >= this.nfMax) { this.done = true; return; }
    var f = this.f, t = f * DT, A = this.A, N = this.N, p = this.p, self = this;
    if (this.tk && f === this.tk) {   // take over from the log: start from exactly where the logged ego was
      var q0 = this.logPose(this.opts.log, f, 0); this.ego = { x: q0.x, z: q0.z, th: Math.atan2(q0.hz, q0.hx), v: q0.v, steer: 0, a: q0.a };
    }
    var sts = new Array(N), acc = new Array(N).fill(0);
    var es = this.egoState(); sts[0] = es; A[0].v = es.v;
    for (var i = 1; i < N; i++) {
      if (this.replay) { var q = this.logPose(this.replay, f, i); sts[i] = q; A[i].v = q.v; }
      else sts[i] = this.state(A[i]);
    }
    for (var i0 = 0; i0 < N; i0++) { var s0 = sts[i0]; s0.len = A[i0].dims.len; s0.wid = A[i0].dims.wid; s0.kind = A[i0].kind === "ego" ? "car" : A[i0].kind === "moto" ? "car" : A[i0].kind; s0.v = A[i0].v; s0.idx = i0; }
    this.hist.unshift(sts); if (this.hist.length > 40) this.hist.pop();
    var occl = this.occluder(sts);
    function perceived(delay) { var k = Math.min(self.hist.length - 1, Math.round(delay / DT)); return self.hist[k]; }

    // ---------------- other actors
    var LS = this.LS;
    function mark(i, lead, code) { var k = (f * N + i) * 2; LS[k] = lead; LS[k + 1] = code; }
    if (this.replay) { var off = f * N * 2; for (var q2 = 2; q2 < N * 2; q2++) LS[off + q2] = this.replay.LS ? this.replay.LS[off + q2] : 0; }
    if (!this.replay) {
      var seen = perceived(p.react);
      for (var i1 = 1; i1 < N; i1++) {
        var a = A[i1], st = sts[i1];
        if (a.ctl === "walk") {
          if (a.started == null && t >= a.t0 && (a.gap == null || this.pedGateOK(a, i1, sts, t))) { a.started = t; if (a.id === "P1") this.marks.push({ t: t, k: "ped" }); }
          a.v = a.started != null && a.s < LANES[a.lane].len - 0.1 ? a.vw : 0;
          mark(i1, -1, a.v > 0 ? 7 : (a.gap != null && t >= a.t0 && a.started == null ? 4 : 0));
          continue;
        }
        if (a.ctl === "const") { acc[i1] = 0; mark(i1, -1, 0); continue; }
        if (a.hold != null && t < a.hold) { a.v = 0; mark(i1, -1, 0); continue; }
        if (a.kind === "bus" && !a.going) { if (this.crosswalkBusy(st, a, sts)) { a.v = 0; mark(i1, this.pedIdx, 4); continue; } a.going = true; this.marks.push({ t: t, k: "bus" }); }
        if (a.lane === "NR" && !a.going && light("cross", t) === "G") {
          if (!this.mergeFree(sts, t)) { a.v = 0; acc[i1] = 0; mark(i1, -1, 4); continue; }
          a.going = true;
        }
        var view = seen.slice(); view[i1] = st;          // others as I perceived them (delay), myself now
        var P = Object.assign({}, a.p, { T: a.p.T * p.kT, a: a.p.a * p.kA, b: a.p.b * p.kA });
        var me = { x: st.x, z: st.z, hx: st.hx, hz: st.hz, len: a.dims.len, wid: a.dims.wid, idx: i1 };
        var lead = leaderOf(me, view, 0.15, true);
        // pedestrians on the zebra (everyone yields)
        var pd = sts[this.pedIdx], P1 = A[this.pedIdx];
        if (P1.v > 0 && Math.abs(st.hx) > 0.7) {
          var laneZ = st.z, inConf = pd.z > laneZ - 2.4 && pd.z < laneZ + 4.5;
          var dw = (ROAD.walkX - st.x) * st.hx;
          if (inConf && dw > -1 && dw < 40) { var gpd = dw - a.dims.len / 2 - 2.2; if (gpd < lead[0]) lead = [Math.max(0.1, gpd), 0, this.pedIdx]; }
        }
        // a pedestrian standing in my path (anywhere)
        var lp = leaderOf(me, view, 0.15, false); if (lp[2] >= 0 && A[lp[2]].kind === "ped" && lp[0] < lead[0]) lead = lp;
        // traffic lights
        var sl = STOP[a.lane];
        if (sl) {
          var dsl = sl[1] - (a.s + a.dims.len / 2), L = light(sl[0], t);
          if (dsl < -0.3) a.amber = null;
          else if (dsl < 70) {
            if (L === "Y" && a.amber == null) a.amber = dsl > a.v * a.v / (2 * 3.2) ? "stop" : "go";
            if (L === "G") a.amber = null;
            if (L === "R" || (L === "Y" && a.amber === "stop")) { if (dsl < lead[0]) lead = [Math.max(0.1, dsl), 0, 99]; }
          }
        }
        acc[i1] = idmAcc(P, a.v, lead, this.aMin);
        var code = lead[2] === 99 ? 2 : lead[2] === this.pedIdx ? 3 : lead[2] >= 0 && lead[0] < 50 ? 1 : 0;
        mark(i1, lead[2] === 99 ? -2 : lead[0] < 50 ? lead[2] : -1, code);
        if (a.cut) {
          var c = a.cut;
          if (c.start == null && t >= c.t0 && this.cutGateOK(a, i1, st, sts)) { c.start = t; this.marks.push({ t: t, k: "cut" }); }
          var u = c.start == null ? 0 : Math.min(1, (t - c.start) / c.dur);
          if (c.start != null && u < 1 && !this.mergeClear(a, i1, st, sts)) { c.start += DT; u = Math.min(1, (t - c.start) / c.dur); }   // pause a merge that is blocked
          a.d = c.d1 * (1 - Math.cos(Math.PI * u)) / 2;
          if (u >= 1 && c.tDone == null) c.tDone = t;
          if (c.brake > 0 && c.tDone != null && t < c.tDone + 2.0) acc[i1] = Math.max(this.aMin, Math.min(acc[i1], -c.brake));   // brakes right after merging
          if (c.start == null && t >= c.t0) mark(i1, LS[(f * N + i1) * 2], 4);
          if (u > 0 && u < 1) { mark(i1, LS[(f * N + i1) * 2], 5); } // while merging, also watch the car ahead in the target lane
          if (u > 0 && u < 1) {
            var tgt = { x: st.x - st.hz * (c.d1 - a.d), z: st.z + st.hx * (c.d1 - a.d), hx: st.hx, hz: st.hz, len: a.dims.len, wid: a.dims.wid, idx: i1 };
            var l2 = leaderOf(tgt, view, 0.0, true); acc[i1] = Math.min(acc[i1], idmAcc(P, a.v, l2, this.aMin));
          }
        }
        if (a.brk && Math.abs(t - a.brk.t0) < DT / 2) this.marks.push({ t: t, k: "brk" });
        if (a.brk && t >= a.brk.t0 && t < a.brk.t0 + a.brk.dur) mark(i1, -1, 6);
        if (a.brk && t >= a.brk.t0 && t < a.brk.t0 + a.brk.dur) acc[i1] = Math.max(this.aMin, Math.min(acc[i1], -a.brk.decel));
        if (a.prof) { acc[i1] = Math.max(this.aMin, Math.min(3.0, (profAt(a.prof, t + DT) - a.v) / DT)); mark(i1, -1, 0); }
      }
    }

    // ---------------- ego
    var md = f < this.tk ? "log" : this.opts.ego, eg = this.ego, eInfo = { mode: 0, pedVis: 0, lead: -1 };
    if (md === "human" || md === "planner") {
      var kind = md === "human" ? "human" : (this.opts.planner || "idm");
      var dl = kind === "percmlp" ? this.pol.delay : kind === "idm" ? (this.pol.idmDelay || 0) : 0, pv = perceived(dl).slice(); pv[0] = es;
      var vw = { t: t, ego: { x: es.x, z: es.z, hx: es.hx, hz: es.hz, v: eg.v, a: eg.a, len: CAR.len, wid: CAR.wid, idx: 0 }, hist: this.vh, others: pv,
                 occl: function (x0, z0, x1, z1) { return occl(x0, z0, x1, z1, self.pedIdx); }, pedIdx: this.pedIdx, mu: p.mu };
      eInfo = decide(kind, vw, this.pol);
      acc[0] = eInfo.acc;
      if (this.opts.params && this.opts.params.egoProf && t < 2.0 - 1e-9) acc[0] = Math.max(this.aMin, Math.min(3.0, (profAt(this.opts.params.egoProf, t + DT) - eg.v) / DT));
      eg.cmdSteer = Math.max(-0.5, Math.min(0.5, -0.05 * (eg.z - 1.75) - 0.6 * eg.th));
    } else if (md === "manual") {
      acc[0] = cmd ? Math.max(this.aMin, Math.min(3.0, cmd.acc)) : 0;
      var smax = Math.min(0.5, 4.0 / (eg.v + 2));
      var target = cmd ? cmd.steer * smax : 0;
      if (cmd && cmd.assist && Math.abs(cmd.steer) < 0.01 && Math.abs(Math.cos(eg.th)) > 0.7) {   // lane-keeping assist: steer to the nearest lane centre
        var east = Math.cos(eg.th) > 0, zl = [-5.25, -1.75, 1.75, 5.25].reduce(function (b, c) { return Math.abs(c - eg.z) < Math.abs(b - eg.z) ? c : b; }, 99);
        var dth = Math.atan2(Math.sin(eg.th - (east ? 0 : Math.PI)), Math.cos(eg.th - (east ? 0 : Math.PI)));
        target = Math.max(-smax, Math.min(smax, (east ? -1 : 1) * 0.05 * (eg.z - zl) - 0.6 * dth));
      }
      eg.cmdSteer = eg.steer + Math.max(-1.2 * DT, Math.min(1.2 * DT, target - eg.steer));
    } else if (md === "log" || md === "track") {
      acc[0] = md === "log" ? this.logPose(this.opts.log, f, 0).a : this.opts.track[Math.min(f, NF - 1) * 6 + 5];
    }
    if (this.opts.egoVmax && md !== "log" && md !== "track" && eg.v > this.opts.egoVmax) acc[0] = Math.min(acc[0], -1.2);
    var eb = this.opts.egoBrake;
    if (eb && md !== "log" && md !== "track" && t >= eb.t0 && t < eb.t0 + eb.dur) { acc[0] = Math.max(this.aMin, Math.min(acc[0], -eb.decel)); if (eg.v < 0.05) acc[0] = 0; }
    var ek = f * 4; this.EGO[ek] = eInfo.mode; this.EGO[ek + 1] = eInfo.pedVis; this.EGO[ek + 2] = eInfo.lead; this.EGO[ek + 3] = eg.steer || 0;

    // ---------------- write the frame
    for (var i2 = 0; i2 < N; i2++) {
      var s2 = sts[i2], k2 = (f * N + i2) * 8;
      this.F[k2] = s2.x; this.F[k2 + 1] = s2.z; this.F[k2 + 2] = s2.hx; this.F[k2 + 3] = s2.hz; this.F[k2 + 4] = A[i2].v;
      this.F[k2 + 5] = this.replay && i2 > 0 ? s2.a : acc[i2]; this.F[k2 + 6] = this.replay && i2 > 0 ? s2.d : A[i2].d;
      this.F[k2 + 7] = this.replay && i2 > 0 ? s2.flag : (A[i2].kind === "ped" ? (A[i2].v > 0 ? 1 : 0) : (acc[i2] < -1.5 ? 1 : 0));
    }
    // collisions: every pair that touches the ego, and vehicle-vehicle / vehicle-pedestrian pairs
    for (var u1 = 0; u1 < N; u1++) for (var u2 = u1 + 1; u2 < N; u2++) {
      var b1 = A[u1], b2 = A[u2]; if (b1.kind === "ped" && b2.kind === "ped") continue;
      var key = u1 + "|" + u2; if (this.hit[key]) continue;
      if (Math.abs(sts[u1].x - sts[u2].x) > 14 || Math.abs(sts[u1].z - sts[u2].z) > 14) continue;
      if (overlap(obb(sts[u1], b1.dims), obb(sts[u2], b2.dims))) {
        this.hit[key] = 1;
        // which of the two was driven by a log that cannot react? (a hit where the replayed actor is the one moving into us)
        var rp = !!this.replay;
        this.events.push({ type: "hit", t: t, f: f, a: b1.id, b: b2.id, ia: u1, ib: u2, x: (sts[u1].x + sts[u2].x) / 2, z: (sts[u1].z + sts[u2].z) / 2, replay: rp, ego: u1 === 0 });
      }
    }
    // ego red-light violation: crossing the stop line on red
    if (!this.red && es.hx > 0.5 && es.z > 0 && es.z < 7 && es.x + CAR.len / 2 > ROAD.stopE && es.x + CAR.len / 2 - es.v * DT <= ROAD.stopE + 0.01 && light("main", t) === "R") {
      this.red = { t: t, f: f }; this.events.push({ type: "red", t: t, f: f, a: "ego", b: "đèn", x: ROAD.stopE, z: 1.75, ego: true });
    }
    // ego leaves the carriageway (not inside the crossroad)
    if (!this.off && Math.abs(es.z) > ROAD.half + 0.4 && Math.abs(es.x - CX) > ROAD.crossHalf + 1) {
      this.off = { t: t, f: f }; this.events.push({ type: "off", t: t, f: f, a: "ego", b: "lề đường", x: es.x, z: es.z, ego: true });
    }

    // ---------------- integrate to t + dt
    if (f < NF - 1) {
      for (var i3 = 1; i3 < N; i3++) {
        if (this.replay) continue;
        var a3 = A[i3]; if (a3.ctl === "walk") { a3.s += a3.v * DT; continue; }
        a3.v = Math.max(0, a3.v + acc[i3] * DT); a3.s += a3.v * DT;
      }
      if (md !== "log" && md !== "track") {
        eg.a = (eg.v > 0 || acc[0] > 0) ? acc[0] : 0;
        eg.v = Math.max(0, eg.v + eg.a * DT);
        eg.steer = eg.cmdSteer || 0;
        eg.th += eg.v / WB * Math.tan(eg.steer) * DT;
        eg.x += eg.v * Math.cos(eg.th) * DT; eg.z += eg.v * Math.sin(eg.th) * DT;
      } else { eg.v = es.v; }
      this.vh.unshift(md === "log" || md === "track" ? es.v : eg.v); this.vh.pop();
    }
    this.f++;
    if (this.f >= this.nfMax) this.done = true;
  };
  World.prototype.pedGateOK = function (a, i, sts, t) {
    var ps = sts[i], occl = this.occluder(sts);
    for (var j = 0; j < this.N; j++) {
      var b = this.A[j]; if (b.kind === "ped" || j === i) continue;
      var sb = sts[j]; if (Math.abs(sb.hx) < 0.7 || Math.abs(sb.z) > 7) continue;
      var dx = ROAD.walkX - sb.x; if (dx * sb.hx <= 0 || Math.abs(dx) > 90) continue;
      var tta = (Math.abs(dx) - b.dims.len / 2) / Math.max(b.v, 0.5);
      // only the bus is tall enough to hide a car from a person
      var hidden = false; for (var k = 0; k < this.N; k++) if (this.A[k].kind === "bus" && k !== j && segHitsBox(ps.x, ps.z, sb.x, sb.z, obb(sts[k], this.A[k].dims))) hidden = true;
      if (tta < a.gap && !hidden) return false;
    }
    return true;
  };
  World.prototype.crosswalkBusy = function (st, a, sts) {
    var dw = (ROAD.walkX - st.x) * st.hx; if (dw < -a.dims.len / 2 || dw > 30) return false;
    var P1 = this.A[this.pedIdx], pd = sts[this.pedIdx];
    return P1.v > 0 && pd.z > st.z - 2.6 && pd.z < 9.3;
  };
  World.prototype.mergeFree = function (sts, t) {   // the right-turner waits for a gap in E2 east of the crossroad
    for (var j = 0; j < this.N; j++) {
      var b = this.A[j], sb = sts[j]; if (b.kind === "ped" || b.lane === "NR" || sb.hx < 0.7 || sb.z < 3 || sb.z > 7.3) continue;
      var dq = 336.5 - sb.x; if (dq > -6 && dq < 60 && (dq - b.dims.len / 2) / Math.max(b.v, 0.5) < 3.5) return false;
    }
    return true;
  };
  World.prototype.cutGateOK = function (a, i, st, sts) {
    for (var j = 0; j < this.N; j++) {
      var b = this.A[j]; if (j === i || b.kind === "ped") continue;
      var sb = sts[j]; if (sb.hx * st.hx + sb.hz * st.hz < 0.7) continue;
      var rx = sb.x - st.x, rz = sb.z - st.z, lon = rx * st.hx + rz * st.hz, lat = -rx * st.hz + rz * st.hx;
      if (Math.abs(lat - a.cut.d1) > 1.6) continue;
      var half = (a.dims.len + b.dims.len) / 2;
      if (lon <= 0 && -lon - half < a.cut.gap + Math.max(0, b.v - a.v) * 0.8) return false;
      if (lon > 0 && lon - half < 3) return false;
    }
    return true;
  };
  World.prototype.mergeClear = function (a, i, st, sts) {
    for (var j = 0; j < this.N; j++) {
      var b = this.A[j]; if (j === i || b.kind === "ped") continue;
      var sb = sts[j]; if (sb.hx * st.hx + sb.hz * st.hz < 0.7) continue;
      var rx = sb.x - st.x, rz = sb.z - st.z, lon = rx * st.hx + rz * st.hz, lat = -rx * st.hz + rz * st.hx;
      if (Math.abs(lat - (a.cut.d1 - a.d)) > 1.6) continue;
      var half = (a.dims.len + b.dims.len) / 2;
      if (lon > 0 && lon - half < 0.8) return false;
      if (lon <= 0 && -lon - half < 0.3) return false;
    }
    return true;
  };
  /* a finished run as a compact record (what the viewer plays and what replay reads) */
  World.prototype.record = function () {
    return { N: this.N, F: this.F, EGO: this.EGO, LS: this.LS, events: this.events, marks: this.marks, nf: this.f, params: this.p, opts: this.opts,
             actors: this.A.map(function (a) { return { id: a.id, name: a.name, kind: a.kind, dims: a.dims, color: a.color, dark: !!a.dark, lane: a.lane }; }) };
  };
  function run(opts) { var w = new World(opts); while (!w.done) w.step(); return w.record(); }
  /* the ego's poses from a record, padded to NF frames (standing still after the last recorded frame) */
  function egoTrack(R) {
    var T = new Float32Array(NF * 6), nf = R.nf || NF;
    for (var f = 0; f < NF; f++) {
      var g = Math.min(f, nf - 1), k = g * R.N * 8;
      T[f * 6] = R.F[k]; T[f * 6 + 1] = R.F[k + 1]; T[f * 6 + 2] = R.F[k + 2]; T[f * 6 + 3] = R.F[k + 3];
      T[f * 6 + 4] = f < nf ? R.F[k + 4] : 0; T[f * 6 + 5] = f < nf ? R.F[k + 5] : 0;
    }
    return T;
  }

  // ------------------------------------------------------------------ the ego's view at frame f of any record (what a planner saw, or would see)
  function viewAt(R, f, dl) {
    var N = R.N, F = R.F, A = R.actors, fo = Math.max(0, f - (dl || 0)), others = [], pedIdx = 0;
    for (var i = 0; i < N; i++) {
      var g = i === 0 ? f : fo, k = (g * N + i) * 8; if (A[i].id === "P1") pedIdx = i;
      others.push({ x: F[k], z: F[k + 1], hx: F[k + 2], hz: F[k + 3], v: F[k + 4], a: F[k + 5], len: A[i].dims.len, wid: A[i].dims.wid, kind: A[i].kind === "ego" || A[i].kind === "moto" ? "car" : A[i].kind, idx: i });
    }
    var hist = []; for (var h = 0; h <= 60; h++) hist.push(F[(Math.max(0, f - h) * N) * 8 + 4]);
    var occl = function (x0, z0, x1, z1) { for (var j = 1; j < N; j++) { if (A[j].kind === "ped") continue; if (segHitsBox(x0, z0, x1, z1, obb(others[j], A[j].dims))) return true; } return false; };
    return { t: f * DT, ego: others[0], hist: hist, others: others, occl: occl, pedIdx: pedIdx, mu: R.params.mu };
  }
  /* everything the side panel shows about a learned planner at frame f: its input vector and the speeds it predicts */
  function modelIO(kind, R, f, pol) {
    pol = Object.assign({}, POLICY, pol || {});
    var v = viewAt(R, f, kind === "percmlp" ? Math.round(pol.delay / DT) : 0), pc = percept(v);
    return { x: features(kind === "egomlp" ? "egomlp" : "percmlp", v, pc), names: FEAT_NAMES[kind === "egomlp" ? "egomlp" : "percmlp"], pred: predictSpeeds(kind, v, pc), pc: pc, view: v };
  }

  // ------------------------------------------------------------------ open-loop evaluation
  /* At every k-th frame of the log: put the ego exactly where the log says, let the planner plan 3 s ahead
     (learned planners: their predicted speeds; IDM and CV: a rollout against constant-velocity predictions of everyone else),
     and measure how far that plan is from what the log ego actually did. */
  /* the 3 s plan a planner makes at frame f of record R (from wherever the ego is in R): 16 points every 0.2 s, plus the predicted speeds */
  function planAt(planner, R, f, pol) {
    pol = Object.assign({}, POLICY, pol || {});
    var N = R.N, H = 60, dl = planner === "percmlp" ? Math.round(pol.delay / DT) : 0;
    var v0 = viewAt(R, f, dl), e0 = v0.ego, plan = [[e0.x, e0.z]], speeds = [e0.v], sp = (planner === "egomlp" || planner === "percmlp") ? predictSpeeds(planner, v0) : null;
    if (sp) {
      var knots = [e0.v].concat(sp), x = e0.x, z = e0.z;
      for (var s = 1; s <= H; s++) {
        var tau = s * DT, kk = Math.min(5, Math.floor(tau / 0.5)), u = (tau - kk * 0.5) / 0.5, vv = knots[kk] + (knots[kk + 1] - knots[kk]) * u;
        x += vv * e0.hx * DT; z += vv * e0.hz * DT; if (s % 4 === 0) { plan.push([x, z]); speeds.push(vv); }
      }
    } else {
      var oth = v0.others.map(function (o) { return Object.assign({}, o); }), x2 = e0.x, z2 = e0.z, vv2 = e0.v, a2 = e0.a, hist = v0.hist.slice(), tt = f * DT;
      var occ = function (xa, za, xb, zb) { for (var j = 1; j < N; j++) { if (oth[j].kind === "ped") continue; if (segHitsBox(xa, za, xb, zb, obb(oth[j], R.actors[j].dims))) return true; } return false; };
      for (var s2 = 1; s2 <= H; s2++) {
        var ego = { x: x2, z: z2, hx: e0.hx, hz: e0.hz, v: vv2, a: a2, len: CAR.len, wid: CAR.wid, idx: 0 }; oth[0] = ego;
        var d = decide(planner, { t: tt, ego: ego, hist: hist, others: oth, occl: occ, pedIdx: v0.pedIdx, mu: R.params.mu }, pol);
        a2 = (vv2 > 0 || d.acc > 0) ? d.acc : 0; vv2 = Math.max(0, vv2 + a2 * DT); x2 += vv2 * e0.hx * DT; z2 += vv2 * e0.hz * DT; tt += DT; hist.unshift(vv2); hist.pop();
        for (var j2 = 1; j2 < N; j2++) { var o = oth[j2]; o.x += o.hx * o.v * DT; o.z += o.hz * o.v * DT; }
        if (s2 % 4 === 0) { plan.push([x2, z2]); speeds.push(vv2); }
      }
    }
    return { plan: plan, speeds: speeds, view: v0 };
  }
  function openLoop(log, planner, pol, every) {
    every = every || 4;
    var N = log.N, H = 60, out = { t: [], e1: [], e2: [], e3: [], plans: {}, speeds: {} }, nf = log.nf || NF;
    for (var f = 20; f + H < nf; f += every) {
      var P = planAt(planner, log, f, pol), plan = P.plan;
      var L = function (s3) { var k = ((f + s3) * N) * 8, pl = plan[s3 / 4]; return Math.hypot(log.F[k] - pl[0], log.F[k + 1] - pl[1]); };
      out.t.push(f * DT); out.e1.push(L(20)); out.e2.push(L(40)); out.e3.push(L(60));
      out.plans[f] = plan; out.speeds[f] = P.speeds;
    }
    function mean(a) { var s4 = 0; a.forEach(function (x) { s4 += x; }); return s4 / Math.max(1, a.length); }
    out.l2 = [mean(out.e1), mean(out.e2), mean(out.e3)]; out.avg = (out.l2[0] + out.l2[1] + out.l2[2]) / 3;
    return out;
  }

  // ------------------------------------------------------------------ closed-loop metrics
  function egoMetrics(R, log) {
    var N = R.N, F = R.F, hits = R.events.filter(function (e) { return e.type === "hit" && e.ego; }), red = R.events.filter(function (e) { return e.type === "red"; })[0];
    var dev = new Float32Array(NF), ttcMin = 1e9, gapMin = 1e9, decMax = 0, tgGap = 1e9, TG = -1, LD = -1;
    R.actors.forEach(function (a, i) { if (a.id === "TG") TG = i; });
    var nf = R.nf || NF;
    for (var f = 0; f < nf; f++) {
      var k = f * N * 8, ex = F[k], ez = F[k + 1], ev = F[k + 4];
      if (log) { var kl = f * log.N * 8; dev[f] = Math.hypot(ex - log.F[kl], ez - log.F[kl + 1]); }
      decMax = Math.max(decMax, -F[k + 5]);
      for (var i = 1; i < N; i++) {
        var kb = (f * N + i) * 8, rx = F[kb] - ex, rz = F[kb + 1] - ez, lon = rx * F[k + 2] + rz * F[k + 3], lat = -rx * F[k + 3] + rz * F[k + 2];
        if (R.actors[i].kind === "ped") continue;
        if (Math.abs(lat) < 2.0 && lon > 0 && lon < 60) {
          var gap = lon - R.actors[i].dims.len / 2 - CAR.len / 2; gapMin = Math.min(gapMin, gap);
          var dv = ev - F[kb + 4] * (F[kb + 2] * F[k + 2] + F[kb + 3] * F[k + 3]); if (dv > 0.2 && gap > 0) ttcMin = Math.min(ttcMin, gap / dv);
        }
        if (i === TG && Math.abs(lat) < 2.0 && lon < 0) tgGap = Math.min(tgGap, -lon - CAR.len);
      }
    }
    var x0 = F[0], xEnd = F[(nf - 1) * N * 8], lx = log ? log.F[(nf - 1) * log.N * 8] : xEnd;
    var progress = Math.max(0, Math.min(1.2, (xEnd - x0) / Math.max(1, lx - x0)));
    var off = R.events.filter(function (e) { return e.type === "off"; })[0];
    var score = Math.min(1, progress) * (hits.length ? 0 : 1) * (red ? 0.7 : 1) * (off ? 0.5 : 1) * (ttcMin < 1.5 ? 0.8 : 1) * (decMax > 6 ? 0.9 : 1);
    return { hits: hits, red: red, off: off, dev: dev, ttcMin: ttcMin, gapMin: gapMin, decMax: decMax, tgGap: tgGap, progress: progress, score: score };
  }

  var api = { DT: DT, T_END: T_END, NF: NF, ROAD: ROAD, LANES: LANES, PARKED: PARKED, CAR: CAR, BUS: BUS, DEFAULTS: DEFAULTS, POLICY: POLICY, PLANNERS: PLANNERS,
              light: light, SIG: SIG, at: at, viewAt: viewAt, percept: percept, features: features, predictSpeeds: predictSpeeds, modelIO: modelIO, planAt: planAt, FEAT_NAMES: FEAT_NAMES, POLICY_IDM: null,
              setModels: function (m) { MODELS = m; }, setLab: function (m) { LAB = m; }, hasLab: function () { return !!LAB; }, labPredict: function (kind, seed, x) { return labMlp(LAB[LABKEY[kind]][seed], x); }, hasModels: function () { return !!MODELS; }, World: World, run: run, egoTrack: egoTrack, openLoop: openLoop, egoMetrics: egoMetrics, overlap: overlap, obb: obb, segHitsBox: segHitsBox };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ReplaySim = api;
})(this);
