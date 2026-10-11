"""The lab as seven steps. Each step reads what it needs, prints what it found, writes evidence/*.json (+ a figure)."""
import json
import time

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from . import agents as A
from . import augment
from . import config as C
from . import data, gate, models, replay as R, scenarios as S, sim
from . import planners as P
from .stats import rate, wasserstein1

PLANNERS = ["const-vel", "IDM", "EgoMLP", "PercMLP"]
LEARNED = ["EgoMLP", "PercMLP", "PercMLP+"]      # PercMLP+ = PercMLP after step 7 (fix and re-gate)


# ---------------------------------------------------------------- shared context
class Ctx:
    def __init__(self, student_id=None, n_seeds=5, quick=False):
        self.sp = C.student_params(student_id)
        self.n_seeds = 2 if quick else n_seeds
        self.quick = quick
        self.logs = data.load_logs()
        self.train, self.test = data.split_indices(len(self.logs), self.sp["split_seed"])
        if quick:                                              # a faster, rougher run for debugging
            self.train, self.test = self.train[:2500], self.test[:1000]
        C.EVID_DIR.mkdir(exist_ok=True)
        C.WORK_DIR.mkdir(exist_ok=True)
        (C.WORK_DIR / "models").mkdir(exist_ok=True)

    @property
    def seeds(self):
        return [self.sp["model_seed"] + k for k in range(self.n_seeds)]

    def save(self, name, obj):
        obj = {"student": self.sp, **obj}
        (C.EVID_DIR / f"{name}.json").write_text(json.dumps(obj, indent=2, default=_jsonable))
        print(f"  -> evidence/{name}.json")

    def load_ev(self, name):
        return json.loads((C.EVID_DIR / f"{name}.json").read_text())

    def planner(self, name, seed=None):
        if name == "const-vel":
            return P.ConstVel()
        if name == "IDM":
            return P.IDM()
        stem = {"EgoMLP": "ego", "PercMLP": "perc", "PercMLP+": "percfix"}[name]
        return P.LearnedPlanner(models.Learned.load(C.WORK_DIR / "models" / f"{stem}_{seed}.npz"), name)

    def instances(self, name):
        """[(seed or None, planner)]: deterministic planners once, learned planners once per training seed."""
        if name in LEARNED:
            return [(s, self.planner(name, s)) for s in self.seeds]
        return [(None, self.planner(name))]

    def brake_mask(self):
        """Per trajectory of the whole log set: does the lead brake (mined event)?"""
        ev = S.mine_braking(self.logs)
        m = np.zeros(len(self.logs), bool)
        m[[e["traj"] for e in ev]] = True
        return m


def _jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    raise TypeError(type(o))


def _hdr(title):
    print(f"\n=== {title} " + "=" * max(0, 70 - len(title)))


# ---------------------------------------------------------------- step 0: data
def step_data(ctx_args):
    _hdr("STEP 0 · data: download, audit, clean")
    data.prepare()


# ---------------------------------------------------------------- step 1: replay
def step_replay(ctx):
    _hdr("STEP 1 · replay: write a log, replay it, compare with a tolerance")
    n_seg = 200 if ctx.quick else 600
    idx = ctx.test[:n_seg]
    path = C.WORK_DIR / "replay_log.jsonl"
    R.write_log(path, ctx.logs, idx)
    segs = R.read_log(path)
    mb = path.stat().st_size / 1e6
    print(f"  log: {len(segs)} segments, {mb:.1f} MB ({path.name})")

    golden, _ = R.replay(segs, lambda: R.IDMStream())                       # v1 = the reference
    again, _ = R.replay(segs, lambda: R.IDMStream())
    rerun = R.compare_with_tol(golden, again)
    refactor = R.compare_with_tol(golden, R.replay(segs, lambda: R.IDMStream(dtype=np.float32, variant="refactored"))[0])
    aeb = R.compare_with_tol(golden, R.replay(segs, lambda: R.IDMStream(aeb_ttc=1.5))[0])
    fast, st_f = R.replay(segs, lambda: R.IDMStream(), mode="fastest")
    real, st_r = R.replay(segs, lambda: R.IDMStream(), mode="realtime", spike_prob=0.01)
    cmp_fast, cmp_real = R.compare_with_tol(golden, fast), R.compare_with_tol(golden, real)
    summ = R.summation_order_demo()

    print(f"  re-run of the same code      : {rerun['differ_beyond_tol']}/{len(segs)} segments differ, "
          f"{rerun['not_bit_identical']} not bit-identical")
    print(f"  refactor (float32, reordered): {refactor['differ_beyond_tol']}/{len(segs)} differ beyond tol, "
          f"but {refactor['not_bit_identical']} are not bit-identical (max diff {refactor['max_abs_diff']:.1e})")
    print(f"  behaviour change (add AEB)   : {aeb['differ_beyond_tol']}/{len(segs)} segments differ -> open them: {aeb['differing_segments'][:5]}")
    print(f"  'fastest' replay             : {st_f['late']} late, {st_f['dropped']} dropped frames (deadlines do not exist)")
    print(f"  real-time replay             : {st_r['late']} late + {st_r['dropped']} dropped of {st_r['frames']} frames; "
          f"{cmp_real['differ_beyond_tol']}/{len(segs)} segments change")
    print(f"  (0.1+0.2)+0.3 = {summ['(0.1+0.2)+0.3']!r}   0.1+(0.2+0.3) = {summ['0.1+(0.2+0.3)']!r}")
    ctx.save("replay", {
        "n_segments": len(segs), "log_mb": round(mb, 1),
        "rerun_identical": rerun["not_bit_identical"] == 0, "rerun": rerun,
        "refactor_float32": refactor, "behaviour_change_aeb": aeb,
        "fastest": {**st_f, **cmp_fast}, "realtime": {**st_r, **cmp_real},
        "summation_order_demo": summ,
        "note": "tolerance atol=1e-3 rtol=1e-3 on the commanded acceleration [m/s^2]; log values are rounded to 4 decimals",
    })


# ---------------------------------------------------------------- step 2: scenarios
def step_scenarios(ctx):
    _hdr("STEP 2 · scenarios: mine the logs, build the grid, validate the simulator")
    logs, v_ego = ctx.logs, ctx.sp["v_ego"]
    ttc12, ad12 = float(S.ttc(12, 5)), float(S.required_decel(12, 5))
    print(f"  worked example: gap 12 m, closing 5 m/s -> TTC = {ttc12:.2f} s, required decel = {ad12:.2f} m/s^2")

    events = S.mine_braking(logs)
    ev_gap = np.array([e["gap_m"] for e in events])
    ev_clos = np.array([max(e["closing_m_s"], 0) for e in events])
    ev_dec = np.array([e["peak_decel"] for e in events])
    print(f"  mined {len(events)} lead-braking events out of {len(logs)} trajectories ({len(events)/len(logs)*100:.1f} %); "
          f"peak lead decel p50 {np.median(ev_dec):.1f}, p99 {np.percentile(ev_dec, 1):.1f} m/s^2")
    h_lim = S.human_brake_limit(logs)

    gaps, dvs = S.grid_from_logs(logs, v_ego)
    grid_req = S.required_decel(*np.meshgrid(gaps, dvs))
    beyond = float((grid_req > h_lim).mean())
    print(f"  hardest braking any logged human applied (99.9th percentile): {h_lim:.1f} m/s^2; the actuator can do {C.B_MAX:.0f}")
    print(f"  grid {len(gaps)} gaps x {len(dvs)} closing speeds = {len(gaps)*len(dvs)} cells; {beyond*100:.0f} % of the grid "
          f"needs braking harder than any logged human ever did")

    # validate the simulator: a planner that brakes at the limit must collide exactly where contact is unavoidable
    val = {}
    for tr in (0.0, 0.6):
        un = S.unavoidable(gaps, dvs, tr)
        r = sim.rollout_cutin(P.FullBrake(), v_ego, gaps, dvs, tr)
        G, DV = np.meshgrid(gaps, dvs)
        margin = np.abs(G - (DV * tr + DV ** 2 / (2 * C.B_MAX))) / np.maximum(G, 1e-9)
        far = margin > 0.05                                    # ignore cells within 5 % of the frontier (time step)
        val[f"t_react_{tr}"] = {"unavoidable_area": float(un.mean()), "full_brake_collision_area": float(r["front"].mean()),
                                "mismatch_cells_away_from_frontier": int((r["front"] != un)[far].sum()), "cells": int(far.sum())}
        print(f"  validation t_react={tr}: full-brake collides in {r['front'].mean()*100:.1f} % of cells, "
              f"physics says {un.mean()*100:.1f} % unavoidable; mismatching cells away from the frontier: "
              f"{val[f't_react_{tr}']['mismatch_cells_away_from_frontier']}")

    grids = {}
    for name in ("const-vel", "IDM"):
        for tr in (0.0, 0.6):
            r = sim.rollout_cutin(ctx.planner(name), v_ego, gaps, dvs, tr)
            un = S.unavoidable(gaps, dvs, tr)
            grids[f"{name}_t_react_{tr}"] = {"collision_area": float(r["front"].mean()), "unavoidable_area": float(un.mean()),
                                             "attributable_area": float((r["front"] & ~un).mean())}
    print(f"  IDM, t_react 0.0 -> 0.6 s: collision area {grids['IDM_t_react_0.0']['collision_area']*100:.1f} % -> "
          f"{grids['IDM_t_react_0.6']['collision_area']*100:.1f} %")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), sharey=True)
    for ax, tr in zip(axes, (0.0, 0.6)):
        r = sim.rollout_cutin(ctx.planner("IDM"), v_ego, gaps, dvs, tr)
        im = ax.imshow(np.clip(r["min_ttc"], 0, 6), origin="lower", aspect="auto", cmap="viridis_r",
                       extent=[gaps[0], gaps[-1], dvs[0], dvs[-1]])
        ax.contour(gaps, dvs, r["front"].astype(float), levels=[0.5], colors="red")
        ax.contour(gaps, dvs, S.unavoidable(gaps, dvs, tr).astype(float), levels=[0.5], colors="cyan", linestyles="--")
        ax.scatter(ev_gap, ev_clos, s=4, c="white", alpha=0.35, label="mined log events")
        ax.set_title(f"IDM, t_react={tr} s", fontsize=10)
        ax.set_xlabel("gap at cut-in [m]")
        ax.set_xlim(gaps[0], gaps[-1])
        ax.set_ylim(dvs[0], dvs[-1])
    axes[0].set_ylabel("closing speed [m/s]")
    axes[0].legend(loc="upper right", fontsize=7)
    fig.suptitle("red line = collision boundary, cyan dashed = physically unavoidable", fontsize=9, y=1.0)
    fig.colorbar(im, ax=axes, label="min TTC [s]")
    fig.savefig(C.EVID_DIR / "scenarios_idm.png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    ctx.save("scenarios", {
        "worked_example": {"ttc_s": ttc12, "required_decel": ad12},
        "mined": {"events": len(events), "share": len(events) / len(logs), "peak_decel_p50": float(np.median(ev_dec)),
                  "peak_decel_p99": float(np.percentile(ev_dec, 1)), "human_brake_limit_p99.9": h_lim},
        "grid": {"v_ego": v_ego, "gap_range": [float(gaps[0]), float(gaps[-1])], "dv_range": [float(dvs[0]), float(dvs[-1])],
                 "share_beyond_human_brake_limit": beyond},
        "validation_full_brake_vs_physics": val, "baseline_grids": grids,
        "coverage": {"mined_events": len(events), "grid_cells": int(len(gaps) * len(dvs))},
    })


# ---------------------------------------------------------------- step 3: open loop
def step_openloop(ctx):
    _hdr("STEP 3 · open loop: score the planners by replaying held-out logs")
    t0 = time.time()
    Xe, Xp, Y, _, _ = models.build_windows(ctx.logs, ctx.train)
    Xte, Xtp, Yt, Bt, _ = models.build_windows(ctx.logs, ctx.test)
    print(f"  train windows {len(Y)}, test windows {len(Yt)}; 'lead brakes within 3 s' slice = {Bt.mean()*100:.1f} % of test windows")
    res = {"const-vel": [models.l2_summary(np.zeros_like(Yt), Yt, Bt)],
           "IDM": [models.l2_summary(P.idm_forecast(P.IDM(), Xtp[:, 21], Xtp[:, 22], Xtp[:, 21] + Xtp[:, 23]), Yt, Bt)],
           "EgoMLP": [], "PercMLP": []}
    for s in ctx.seeds:
        ego = models.fit("ego", Xe, Y, seed=s)
        perc = models.fit("perc", Xp, Y, seed=s)
        ego.save(C.WORK_DIR / "models" / f"ego_{s}.npz")
        perc.save(C.WORK_DIR / "models" / f"perc_{s}.npz")
        res["EgoMLP"].append(models.l2_summary(ego.predict(Xte), Yt, Bt))
        res["PercMLP"].append(models.l2_summary(perc.predict(Xtp), Yt, Bt))
        print(f"  seed {s}: trained both ({time.time()-t0:.0f} s)")

    summary = {k: {"all_mean": float(np.mean([r["all"] for r in v])), "all_std": float(np.std([r["all"] for r in v])),
                   "brake_slice_mean": float(np.mean([r["brake_slice"] for r in v]))} for k, v in res.items()}
    print(f"  {'planner':10s} {'L2 all [m]':>12s} {'L2 brake slice':>16s}")
    for k, v in summary.items():
        print(f"  {k:10s} {v['all_mean']:8.3f} ±{v['all_std']:.3f} {v['brake_slice_mean']:12.3f}")
    ctx.save("openloop", {"per_seed": res, "summary": summary, "slice_share": float(Bt.mean()),
                          "windows": {"train": len(Y), "test": len(Yt)}})


# ---------------------------------------------------------------- evaluation helpers (shared by steps 4, 5, 7)
def _eval_logs(ctx, name, brake_te):
    """Closed loop on the held-out logs, one run per training seed. The headline numbers are the WORST seed."""
    rows = []
    for seed, p in ctx.instances(name):
        r = sim.rollout_logs(p, ctx.logs, ctx.test)
        rows.append({"seed": seed, "collision": rate(r["collision"]), "collision_brake_slice": rate(r["collision"][brake_te]),
                     "median_min_gap": float(np.median(r["min_gap"])), "median_peak_brake": float(np.median(r["peak_brake"]))})
    rates = [x["collision"]["rate"] for x in rows]
    worst = rows[int(np.argmax(rates))]
    return {**worst, "per_seed_collision_rate": rates, "per_seed": rows, "mean_collision_rate": float(np.mean(rates))}


def _eval_noise(ctx, name, gap_std=1.0, v_std=0.5):
    rr = [sim.rollout_logs(p, ctx.logs, ctx.test, obs_noise=(gap_std, v_std), rng=np.random.default_rng(0))["collision"].mean()
          for _, p in ctx.instances(name)]
    return {"gap_std_m": gap_std, "lead_speed_std_m_s": v_std, "per_seed_collision_rate": [float(x) for x in rr]}


def _eval_grid(ctx, name, gaps, dvs, tr):
    un = S.unavoidable(gaps, dvs, tr)
    rows = []
    for _, p in ctx.instances(name):
        f = sim.rollout_cutin(p, ctx.sp["v_ego"], gaps, dvs, tr)["front"]
        rows.append({"collision_area": float(f.mean()), "attributable_area": float((f & ~un).mean())})
    w = max(rows, key=lambda x: x["attributable_area"])
    return {**w, "unavoidable_area": float(un.mean()), "per_seed_attributable": [x["attributable_area"] for x in rows]}


def _eval_rear(ctx, name, gaps, dvs, tr, rear_idm, rear_gap):
    per = [A.rear_comparison([p], ctx.sp["v_ego"], gaps, dvs, tr, rear_idm, rear_gap)[p.name] for _, p in ctx.instances(name)]
    return max(per, key=lambda d: d["reactive"]["any"])


# ---------------------------------------------------------------- step 4: closed loop
def step_closedloop(ctx):
    _hdr("STEP 4 · closed loop: let each planner drive against the replayed lead")
    logs, test = ctx.logs, ctx.test
    b_te = ctx.brake_mask()[test]
    human = sim.human_baseline(logs, test)
    print(f"  {len(test)} held-out trajectories, {b_te.sum()} of them with a braking lead; human median min gap {np.median(human['min_gap']):.1f} m")

    out = {}
    for name in PLANNERS:
        out[name] = _eval_logs(ctx, name, b_te)
        rates, worst = out[name]["per_seed_collision_rate"], out[name]
        spread = f"{min(rates)*100:.1f}..{max(rates)*100:.1f} %" if len(rates) > 1 else f"{rates[0]*100:.1f} %"
        print(f"  {name:10s} collisions: {spread:14s} (worst seed CI95 [{worst['collision']['ci95'][0]*100:.1f}, "
              f"{worst['collision']['ci95'][1]*100:.1f}]); on braking-lead trajectories {worst['collision_brake_slice']['rate']*100:.1f} %")

    noise = {}
    for name in ("IDM", "PercMLP"):                              # what the planner perceives gets noise, the physics stays exact
        noise[name] = _eval_noise(ctx, name)
        rr = noise[name]["per_seed_collision_rate"]
        print(f"  with perception noise (gap ±1 m, lead speed ±0.5 m/s) {name:8s}: {min(rr)*100:.1f}..{max(rr)*100:.1f} %")

    gaps, dvs = S.grid_from_logs(logs, ctx.sp["v_ego"])
    grid = {}
    for tr in (0.0, 0.6):
        grid[f"t_react_{tr}"] = {n: _eval_grid(ctx, n, gaps, dvs, tr) for n in PLANNERS}
        g = grid[f"t_react_{tr}"]
        print(f"  cut-in grid t_react={tr}: unavoidable {g['IDM']['unavoidable_area']*100:.1f} %; avoidable-but-collides (worst seed): "
              + ", ".join(f"{n} {g[n]['attributable_area']*100:.1f} %" for n in PLANNERS))

    ol = ctx.load_ev("openloop")["summary"]
    l2 = {n: ol[n]["all_mean"] for n in PLANNERS}
    cl = {n: out[n]["mean_collision_rate"] for n in PLANNERS}
    rank_l2 = {n: i + 1 for i, n in enumerate(sorted(PLANNERS, key=l2.get))}
    rank_cl = {n: i + 1 for i, n in enumerate(sorted(PLANNERS, key=cl.get))}
    flips = [(a, b) for i, a in enumerate(PLANNERS) for b in PLANNERS[i + 1:] if (l2[a] - l2[b]) * (cl[a] - cl[b]) < 0]
    print("\n  planner     open-loop L2   rank | closed-loop collisions   rank")
    for n in PLANNERS:
        print(f"  {n:10s} {l2[n]:8.3f} m    {rank_l2[n]}   | {cl[n]*100:12.1f} %         {rank_cl[n]}")
    print(f"  pairs whose order flips between the two scorings: {flips or 'none'}")

    fig, ax = plt.subplots(figsize=(5.8, 4.4))
    for n in PLANNERS:
        ax.scatter(l2[n], cl[n] * 100, s=60)
        ax.annotate(n, (l2[n], cl[n] * 100), textcoords="offset points", xytext=(6, 4))
    ax.set_xlabel("open-loop L2 [m] (lower is better)")
    ax.set_ylabel("closed-loop collision rate [%] (lower is better)")
    ax.set_title("The two scores disagree")
    fig.savefig(C.EVID_DIR / "openloop_vs_closedloop.png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    ctx.save("closedloop", {"logs": out, "noise": noise, "grid": grid,
                            "ranking": {"open_loop_L2": l2, "closed_loop_collision": cl, "rank_open": rank_l2,
                                        "rank_closed": rank_cl, "order_flips": flips},
                            "held_out_trajectories": len(test), "braking_lead_trajectories": int(b_te.sum()),
                            "human_median_min_gap": float(np.median(human["min_gap"]))})


# ---------------------------------------------------------------- step 5: reactive agents
def step_agents(ctx):
    _hdr("STEP 5 · reactive agents: does the verdict change when the others react?")
    logs, v_ego = ctx.logs, ctx.sp["v_ego"]
    sub = ctx.train[:3000]
    best_T, table, med_h = A.calibrate_idm(logs, sub)
    base = sim.rollout_logs(P.ConstVel(), logs, sub, collect_headway=True)
    w_const = wasserstein1(base["headway"], sim.human_baseline(logs, sub)["headway"])
    print(f"  logged humans keep a median time headway of {med_h:.2f} s")
    print("  IDM driver, realism = distance between headway distributions (lower is better): "
          + ", ".join(f"T={t}: {w:.2f}" for t, w in table.items()))
    print(f"  -> calibrated T = {best_T} s (W1 {table[best_T]:.2f}); a driver that never reacts scores {w_const:.2f}")

    rear_idm = P.IDM(v0=20.0, T=best_T, name="rear driver")
    rear_gap = 2.0 + v_ego * best_T
    gaps, dvs = S.grid_from_logs(logs, v_ego)
    comp = {}
    for tr in (0.0, 0.6):
        rows = {n: _eval_rear(ctx, n, gaps, dvs, tr, rear_idm, rear_gap) for n in PLANNERS}
        comp[f"rear_comparison_t_react_{tr}"] = rows
        print(f"  t_react={tr}: share of the cut-in grid with ANY collision (front or rear)")
        print(f"    {'planner':10s} {'rear car replays':>18s} {'rear car reacts':>18s}   (rear collisions: replay / react)")
        for n, d in rows.items():
            print(f"    {n:10s} {d['replay']['any']*100:17.1f} % {d['reactive']['any']*100:17.1f} %   "
                  f"{d['replay']['rear']*100:5.1f} % / {d['reactive']['rear']*100:.1f} %")
    ctx.save("agents", {"calibration": {"best_T": best_T, "wasserstein_by_T": {str(k): v for k, v in table.items()},
                                        "never_reacting_agent_W1": w_const, "human_median_headway_s": med_h},
                        "rear_gap_m": rear_gap, "rear_reaction_delay_s": 0.6, **comp})


# ---------------------------------------------------------------- step 6: gate
def step_gate(ctx):
    _hdr("STEP 6 · release gate")
    ev = {k: ctx.load_ev(k) for k in ("replay", "scenarios", "closedloop", "agents")}
    ev["closed_loop"] = ev.pop("closedloop")
    candidates = [n for n in ev["closed_loop"]["logs"] if n != "IDM"]
    decisions = {}
    for cand in candidates:
        release, rules = gate.evaluate(cand, "IDM", ev)
        decisions[cand] = {"release": release, "rules": rules}
        print(f"\n  candidate {cand}: {'RELEASE' if release else 'BLOCK'}")
        for k, v in rules.items():
            print(f"    [{'pass' if v['pass'] else 'FAIL'}] {k:26s} {v['detail']}")
    ctx.save("gate", {"baseline": "IDM", "decisions": decisions, "rules": gate.RULES})
    return decisions


# ---------------------------------------------------------------- step 7: fix and re-gate
def step_fix(ctx, syn_scenarios=20000, dagger_rounds=2):
    """The gate blocked PercMLP. Two causes show in the evidence: it fails in cut-ins the logs never contain (R4, R6)
    and its small imitation errors accumulate in closed loop (R2). Fix 1: add windows from the cut-in scenario family.
    Fix 2: DAgger, i.e. learn at the states the planner itself visits. Then run the same gate again."""
    _hdr("STEP 7 · fix and re-gate: scenario windows + learning at the states the planner visits")
    t0 = time.time()
    Xe, Xp, Y, _, _ = models.build_windows(ctx.logs, ctx.train)
    Xte, Xtp, Yt, Bt, _ = models.build_windows(ctx.logs, ctx.test)
    Xs, Ys = augment.cutin_windows(syn_scenarios, np.random.default_rng(ctx.sp["split_seed"]))
    print(f"  logs {len(Y)} windows + {len(Ys)} windows from {syn_scenarios} simulated cut-ins")
    for s in ctx.seeds:
        X, YY = np.concatenate([Xp, Xs]), np.concatenate([Y, Ys])
        m = models.fit("perc", X, YY, seed=s)
        for _ in range(dagger_rounds):
            Xd, Yd = augment.dagger_windows(P.LearnedPlanner(m, "tmp"), ctx.logs, ctx.train)
            X, YY = np.concatenate([X, Xd]), np.concatenate([YY, Yd])
            m = models.fit("perc", X, YY, seed=s)
        m.save(C.WORK_DIR / "models" / f"percfix_{s}.npz")
        print(f"  seed {s}: trained with {dagger_rounds} DAgger rounds, {len(YY)} windows ({time.time()-t0:.0f} s)")

    name = "PercMLP+"
    cl, ag, ol = ctx.load_ev("closedloop"), ctx.load_ev("agents"), ctx.load_ev("openloop")
    b_te = ctx.brake_mask()[ctx.test]
    cl["logs"][name] = _eval_logs(ctx, name, b_te)
    cl["noise"][name] = _eval_noise(ctx, name)
    gaps, dvs = S.grid_from_logs(ctx.logs, ctx.sp["v_ego"])
    for tr in (0.0, 0.6):
        cl["grid"][f"t_react_{tr}"][name] = _eval_grid(ctx, name, gaps, dvs, tr)
    rear_idm = P.IDM(v0=20.0, T=ag["calibration"]["best_T"], name="rear driver")
    for tr in (0.0, 0.6):
        ag[f"rear_comparison_t_react_{tr}"][name] = _eval_rear(ctx, name, gaps, dvs, tr, rear_idm, ag["rear_gap_m"])
    l2s = [models.l2_summary(models.Learned.load(C.WORK_DIR / "models" / f"percfix_{s}.npz").predict(Xtp), Yt, Bt) for s in ctx.seeds]
    ol["summary"][name] = {"all_mean": float(np.mean([r["all"] for r in l2s])), "all_std": float(np.std([r["all"] for r in l2s])),
                           "brake_slice_mean": float(np.mean([r["brake_slice"] for r in l2s]))}
    ctx.save("closedloop", cl)
    ctx.save("agents", ag)
    ctx.save("openloop", ol)

    a, b = cl["logs"]["PercMLP"], cl["logs"][name]
    g0, g1 = cl["grid"]["t_react_0.6"]["PercMLP"], cl["grid"]["t_react_0.6"][name]
    print(f"\n  {'':10s} {'PercMLP':>12s} {'PercMLP+':>12s}")
    print(f"  {'open-loop L2 [m]':20s} {ol['summary']['PercMLP']['all_mean']:12.3f} {ol['summary'][name]['all_mean']:12.3f}")
    print(f"  {'collisions on logs':20s} {min(a['per_seed_collision_rate'])*100:5.1f}..{max(a['per_seed_collision_rate'])*100:.1f} %"
          f" {min(b['per_seed_collision_rate'])*100:5.1f}..{max(b['per_seed_collision_rate'])*100:.1f} %")
    print(f"  {'cut-in grid (0.6 s)':20s} {g0['attributable_area']*100:11.1f}% {g1['attributable_area']*100:11.1f}%")
    # the fix was trained on cut-ins up to 16 m/s: does it hold at a cruise speed it never saw (and the logs never contain)?
    v_out = 20.0
    g_out, d_out = S.grid_from_logs(ctx.logs, v_out)
    un_out = S.unavoidable(g_out, d_out, 0.6)
    held_out = {}
    for n in ("IDM", "PercMLP", name):
        held_out[n] = [float((sim.rollout_cutin(p, v_out, g_out, d_out, 0.6)["front"] & ~un_out).mean()) for _, p in ctx.instances(n)]
        print(f"  held-out cruise speed {v_out:.0f} m/s (training saw <= 16): {n:9s} avoidable-but-collides "
              f"{min(held_out[n])*100:.1f}..{max(held_out[n])*100:.1f} % of the grid")
    decisions = step_gate(ctx)
    ctx.save("fix", {"synthetic_scenarios": syn_scenarios, "dagger_rounds": dagger_rounds,
                     "decision_PercMLP+": decisions[name]["release"], "seconds": round(time.time() - t0),
                     "held_out_cruise_speed": {"v_ego": v_out, "attributable_area_per_seed": held_out}})


STEPS = {"data": step_data, "replay": step_replay, "scenarios": step_scenarios, "openloop": step_openloop,
         "closedloop": step_closedloop, "agents": step_agents, "gate": step_gate, "fix": step_fix}
