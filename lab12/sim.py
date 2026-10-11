"""Closed-loop simulators (1-D, longitudinal, dt = 0.1 s, vectorised over many situations at once).

rollout_logs   : the lead vehicle is REPLAYED from a real log; the planner drives the follower (closed loop).
                 For the first 2 s (HANDOVER) the logged human is replayed so the planner has a history, then it takes over.
rollout_cutin  : a parameterised cut-in scenario on a (gap x closing-speed) grid, optionally with a rear vehicle that
                 is either replayed (does not react) or reactive (an IDM driver with a reaction delay).
"""
from dataclasses import dataclass

import numpy as np

from . import config as C
from .data import _ffill
from .planners import IDM, clip_cmd


def _advance(v, x, a, active):
    """One explicit step with trapezoid position update. Rows not `active` stay frozen."""
    v_new = np.maximum(0.0, v + a * C.DT)
    x_new = x + 0.5 * (v + v_new) * C.DT
    return np.where(active, v_new, v), np.where(active, x_new, x)


def _ttc(gap, closing):
    return np.where(closing > 1e-3, gap / np.maximum(closing, 1e-3), np.inf)


# ---------------------------------------------------------------- closed loop on logs
def rollout_logs(planner, logs, idx, obs_noise=(0.0, 0.0), rng=None, latency=0, collect_headway=False, record=None):
    """Drive the follower with `planner` against the replayed lead of trajectories `idx`.

    obs_noise = (gap std [m], lead-speed std [m/s]) added to what the planner perceives (not to the physics).
    latency   = command delay in steps. Returns per-trajectory arrays: collision, min_gap, min_ttc, peak_brake.
    collect_headway = also return every simulated time headway (gap / speed, moving frames only), to compare with the log.
    record    = a list: every 2nd step the (hist_rel, v, gap, lead_speed) the planner saw are appended for the rows still
                driving. Used to learn from the states the planner itself visits (see augment.dagger_windows).
    """
    H, L = C.H, C.VEH_LEN
    n = logs.n[idx]
    M = len(idx)
    pos_l, v_l, v_ls = (_ffill(a[idx], n) for a in (logs.pos_lead, logs.v_lead, logs.v_lead_s))
    v_e, pos_e = (_ffill(a[idx], n) for a in (logs.v_ego, logs.pos_ego))
    x, v, hist = pos_e[:, H].copy(), v_e[:, H].copy(), v_e[:, :H + 1].copy()
    col = np.zeros(M, bool)
    min_gap = pos_l[:, H] - x - L
    min_ttc = np.full(M, np.inf)
    peak = np.zeros(M)
    queue = [np.zeros(M)] * latency
    gs, vs = obs_noise
    headway = []
    for t in range(H, logs.T - 1):
        active = (t + 1 < n) & ~col
        if not active.any():
            break
        g, vl = pos_l[:, t] - x - L, v_l[:, t]
        if gs or vs:
            g, vl = g + rng.normal(0, gs, M), vl + rng.normal(0, vs, M)
        a = clip_cmd(planner.act(hist - hist[:, -1:], v, g, vl))
        if record is not None and (t - H) % 2 == 0:
            record.append(((hist - hist[:, -1:])[active], v[active].copy(), g[active].copy(), vl[active].copy()))
        if latency:
            queue.append(a)
            a = queue.pop(0)
        v, x = _advance(v, x, a, active)
        hist = np.where(active[:, None], np.concatenate([hist[:, 1:], v[:, None]], 1), hist)
        g_new = pos_l[:, t + 1] - x - L
        min_gap = np.where(active, np.minimum(min_gap, g_new), min_gap)
        min_ttc = np.where(active, np.minimum(min_ttc, _ttc(g_new, v - v_ls[:, t + 1])), min_ttc)
        peak = np.where(active, np.maximum(peak, -a), peak)
        col |= active & (g_new <= 0)
        if collect_headway:
            ok = active & (v > 2.0) & (g_new > 0)
            headway.append((g_new / np.maximum(v, 1e-3))[ok])
    out = {"collision": col, "min_gap": np.maximum(min_gap, 0.0), "min_ttc": min_ttc, "peak_brake": peak}
    if collect_headway:
        out["headway"] = np.concatenate(headway)
    return out


def human_baseline(logs, idx):
    """What the logged human achieved over the same window (from the handover on): min gap and time headways."""
    H = C.H
    n = logs.n[idx]
    gap = _ffill(logs.gap[idx], n)[:, H:]
    v = _ffill(logs.v_ego[idx], n)[:, H:]
    mask = np.arange(gap.shape[1])[None, :] + H < n[:, None]
    moving = mask & (v > 2.0) & (gap > 0)
    return {"min_gap": np.where(mask, gap, np.inf).min(1), "headway": (gap / np.maximum(v, 1e-3))[moving]}


# ---------------------------------------------------------------- cut-in scenario (+ optional rear agent)
@dataclass
class RearAgent:
    """A vehicle behind the ego. mode='replay': keeps its logged cruise speed whatever the ego does (no reaction).
    mode='reactive': an IDM driver following the ego, acting on what it saw `delay_s` seconds ago."""
    mode: str
    gap: float = 15.0
    idm: IDM = None
    delay_s: float = 0.6


def rollout_cutin(planner, v_ego, gaps, dvs, t_react=0.0, rear=None, t_end=12.0):
    """Ego cruises at v_ego with a 2 s steady history. At t=0 a vehicle completes a cut-in `gap` m ahead,
    `dv` m/s slower, and holds that speed. The ego's command is delayed by t_react (perception + actuation).
    Returns arrays shaped (len(dvs), len(gaps)): front collision, rear collision, min TTC, peak braking."""
    H, L = C.H, C.VEH_LEN
    G, DV = np.meshgrid(np.asarray(gaps, float), np.asarray(dvs, float))
    shape = G.shape
    g0, dv = G.ravel(), DV.ravel()
    M = len(g0)
    v, x = np.full(M, float(v_ego)), np.zeros(M)
    lead_x, v_lead = g0 + L, v_ego - dv
    hist = np.full((M, H + 1), float(v_ego))
    front, back = np.zeros(M, bool), np.zeros(M, bool)
    min_ttc, peak = np.full(M, np.inf), np.zeros(M)
    q = [np.zeros(M)] * int(round(t_react / C.DT))
    if rear is not None:
        r_x, r_v = np.full(M, -L - rear.gap), np.full(M, float(v_ego))
        rq = [np.zeros(M)] * int(round(rear.delay_s / C.DT))
        rear_idm = rear.idm
    for _ in range(int(t_end / C.DT)):
        active = ~(front | back)
        g = lead_x - x - L
        min_ttc = np.where(active, np.minimum(min_ttc, _ttc(g, v - v_lead)), min_ttc)
        front |= active & (g <= 0)
        a = clip_cmd(planner.act(hist - hist[:, -1:], v, g, v_lead))
        q.append(a)
        a = q.pop(0)
        peak = np.where(active, np.maximum(peak, -a), peak)
        v_prev = v.copy()
        v, x = _advance(v, x, a, active)
        hist = np.where(active[:, None], np.concatenate([hist[:, 1:], v[:, None]], 1), hist)
        lead_x = np.where(active, lead_x + v_lead * C.DT, lead_x)
        if rear is not None:
            if rear.mode == "reactive":
                gr = (x - L) - r_x                       # gap the rear driver perceives (from the current state)
                ar = clip_cmd(rear_idm.act(None, r_v, gr, v))
                rq.append(ar)
                ar = rq.pop(0)
                r_v, r_x = _advance(r_v, r_x, ar, active)
            else:                                        # replay: constant logged speed
                r_x = np.where(active, r_x + r_v * C.DT, r_x)
            back |= active & (((x - L) - r_x) <= 0)
    reshape = lambda a: a.reshape(shape)
    return {"front": reshape(front), "rear": reshape(back), "min_ttc": reshape(np.where(front, 0.0, min_ttc)),
            "peak_brake": reshape(peak)}
