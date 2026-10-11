"""Step 5: reactive agents. Calibrate an IDM driver on the logged humans, then see how the verdict on a planner changes
when the vehicle behind it replays its log (does not react) versus reacts."""
import numpy as np

from . import config as C
from . import sim
from .planners import IDM
from .stats import wasserstein1


def calibrate_idm(logs, idx, T_grid=(0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 2.0, 2.4), v0=20.0):
    """Pick the IDM time headway T whose simulated headway distribution is closest (Wasserstein-1) to the logged
    humans' headway distribution, when the IDM driver follows the same replayed leads."""
    human = sim.human_baseline(logs, idx)["headway"]
    table = {}
    for T in T_grid:
        r = sim.rollout_logs(IDM(v0=v0, T=T), logs, idx, collect_headway=True)
        table[T] = wasserstein1(r["headway"], human)
    best = min(table, key=table.get)
    return best, table, float(np.median(human))


def rear_comparison(planners, v_ego, gaps, dvs, t_react, rear_idm, rear_gap):
    """For each planner: share of the (gap x dv) grid with a front collision, a rear collision under a REPLAYED rear
    vehicle and under a REACTIVE one. Returns {planner name: {...}}."""
    out = {}
    for p in planners:
        row = {}
        for mode in ("replay", "reactive"):
            agent = sim.RearAgent(mode, gap=rear_gap, idm=rear_idm, delay_s=0.6)
            r = sim.rollout_cutin(p, v_ego, gaps, dvs, t_react, rear=agent)
            row[mode] = {"front": float(r["front"].mean()), "rear": float(r["rear"].mean()),
                         "any": float((r["front"] | r["rear"]).mean())}
        out[p.name] = row
    return out
