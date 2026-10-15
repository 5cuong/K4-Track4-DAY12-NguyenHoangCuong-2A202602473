"""Export YOUR models and results to the 3D simulator in viz/.

    python3 scripts/export_viz.py            (from the repo root, after steps 3, 4, 6 and 7 of the lab)

Reads  work/models/{ego,perc,percfix}_<seed>.npz   the models you trained (steps 3 and 7)
       evidence/gate.json, evidence/closedloop.json   your results (steps 4 and 6)
Writes viz/lab_models.js   the weights, for every training seed you ran
       viz/lab_data.js     24 real trajectories to replay as the lead car, and your gate decisions
Both files are generated from YOUR run, so the simulator shows YOUR numbers. They are git-ignored (the weights are 2-3 MB).
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from lab12 import config as C, data, scenarios as S  # noqa: E402

VIZ = ROOT / "viz"
STEMS = ("ego", "perc", "percfix")


def die(msg):
    sys.exit("export_viz: " + msg)


def need(path, hint):
    if not path.exists():
        die(f"{path.relative_to(ROOT)} not found. {hint}")
    return json.loads(path.read_text())


def sig(a):
    """6 significant digits. Some features have a standard deviation ~1e-6: rounding by decimals would turn it into 0 and give NaN."""
    return [float(f"{v:.6g}") for v in np.asarray(a, dtype=np.float64)]


def find_seeds():
    found = []
    for stem in STEMS:
        seeds = {int(p.stem.split("_")[1]) for p in (C.WORK_DIR / "models").glob(f"{stem}_*.npz")}
        if not seeds:
            die(f"no work/models/{stem}_*.npz. " + ("Run step 3 (python3 run_all.py openloop)." if stem != "percfix" else "Run step 7 (python3 run_all.py fix)."))
        found.append(seeds)
    seeds = sorted(set.intersection(*found))
    if not seeds:
        die("ego, perc and percfix models were trained with different seeds. Re-run steps 3 and 7 with the same --student-id and --seeds.")
    return seeds


def models_js(seeds):
    out = {}
    for stem in STEMS:
        out[stem] = {}
        for s in seeds:
            z = np.load(C.WORK_DIR / "models" / f"{stem}_{s}.npz")
            out[stem][str(s)] = {"mu": sig(z["mu"]), "sd": sig(z["sd"]),
                                 "layers": [{"W": np.round(z[f"W{i}"].astype(np.float64), 4).tolist(),
                                             "b": np.round(z[f"b{i}"].astype(np.float64), 4).tolist()} for i in range(3)]}
    body = json.dumps(out, separators=(",", ":"))
    (VIZ / "lab_models.js").write_text(
        "/* lab_models.js - written by scripts/export_viz.py from work/models. Do not edit. */\n"
        "(function (root) { var M = " + body + ";\n  if (typeof module !== \"undefined\" && module.exports) module.exports = M; else root.LAB_MODELS = M; })(this);\n")
    return len(body) / 1e6


def logs_for_viz(sp, n_brake=12, n_calm=12):
    """Held-out real trajectories: the ones where the lead brakes hardest (found with YOUR mine_braking) and some calm ones."""
    logs = data.load_logs()
    _, te = data.split_indices(len(logs), sp["split_seed"])
    events = {e["traj"]: e for e in S.mine_braking(logs)}
    te_set = set(te.tolist())
    braking = sorted((e for i, e in events.items() if i in te_set and logs.n[i] >= 100), key=lambda e: e["peak_decel"])[:n_brake]
    if not braking:
        die("mine_braking found no braking event in the held-out set: check your implementation (step 2).")
    rng = np.random.default_rng(sp["split_seed"])
    calm = [int(i) for i in te if i not in events and logs.n[i] >= 100]
    calm = [int(i) for i in rng.choice(calm, min(n_calm, len(calm)), replace=False)]
    picked = [(e["traj"], True, e["peak_decel"]) for e in braking] + [(i, False, float(np.nanmin(logs.a_lead[i, :logs.n[i]]))) for i in calm]
    out = []
    for i, brake, pk in picked:
        k = int(logs.n[i])
        out.append({"id": int(logs.ids[i]), "brake": brake, "peak_decel": round(pk, 2), "n": k, "gap0": round(float(logs.gap[i, 0]), 2),
                    "lead": np.round(logs.v_lead_s[i, :k].astype(np.float64), 3).tolist(),
                    "ego": np.round(logs.v_ego[i, :k].astype(np.float64), 3).tolist()})
    return out


def main():
    gate = need(C.EVID_DIR / "gate.json", "Run step 6 (python3 run_all.py gate).")
    cl = need(C.EVID_DIR / "closedloop.json", "Run step 4 (python3 run_all.py closedloop).")
    if "PercMLP+" not in gate["decisions"] or "PercMLP+" not in cl["logs"]:
        die("your evidence has no PercMLP+ yet. Run step 7 (python3 run_all.py fix).")
    sp = gate["student"]
    if sp["student_id"] == "demo":
        print("warning: your evidence was produced with the default student id 'demo'. Re-run with --student-id <MSSV> before you submit.")
    seeds = find_seeds()
    VIZ.mkdir(exist_ok=True)
    mb = models_js(seeds)
    payload = {"student": sp, "seeds": seeds, "logs": logs_for_viz(sp),
               "gate": {n: {"release": d["release"], "rules": {k: {"pass": r["pass"], "detail": r["detail"]} for k, r in d["rules"].items()}}
                        for n, d in gate["decisions"].items()},
               "closed_loop": {n: {"rates": v["per_seed_collision_rate"], "brake_slice": v["collision_brake_slice"]["rate"]} for n, v in cl["logs"].items()}}
    (VIZ / "lab_data.js").write_text(
        "/* lab_data.js - written by scripts/export_viz.py. Do not edit. */\n"
        "(function (root) { var D = " + json.dumps(payload, separators=(",", ":")) + ";\n  if (typeof module !== \"undefined\" && module.exports) module.exports = D; else root.LAB_DATA = D; })(this);\n")
    print(f"student {sp['student_id']}: {len(seeds)} training seed(s), {mb:.1f} MB of weights, {len(payload['logs'])} logs")
    print("now:  python3 viz/serve.py   and open http://localhost:8765")


if __name__ == "__main__":
    main()
