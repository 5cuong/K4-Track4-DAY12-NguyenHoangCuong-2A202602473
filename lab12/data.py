"""Step 0: get the logs, audit them, clean them, split them.

Source: OpenPAV-Trajectory (Hugging Face), Argoverse 2 part: ~10k car-following pairs, 10 Hz, 7-11 s each.
Each trajectory = a lead vehicle (logged) and a human-driven follower (logged).
"""
import hashlib
import json
import sys
import urllib.request
from dataclasses import dataclass

import numpy as np

from . import config as C

RAW_COLS = ["Trajectory_ID", "Time_Index", "Pos_LV", "Speed_LV", "Acc_LV", "Pos_FAV", "Speed_FAV", "Acc_FAV", "Spatial_Gap"]


# ---------------------------------------------------------------- download
def download(force=False):
    """Download the Argoverse CSV once (~195 MB). Safe to re-run."""
    C.DATA_DIR.mkdir(exist_ok=True)
    if C.CSV_PATH.exists() and C.CSV_PATH.stat().st_size == C.CSV_BYTES and not force:
        return C.CSV_PATH
    tmp = C.CSV_PATH.with_suffix(".part")
    print(f"downloading {C.HF_URL}")

    last = [-1]

    def hook(blocks, bsize, total):
        pct = int(min(100, blocks * bsize * 100 / total)) // 10 * 10 if total > 0 else -1
        if pct != last[0]:                      # print every 10 % so logs and notebooks stay readable
            last[0] = pct
            print(f"  {pct:3d} %  ({blocks * bsize / 1e6:.0f} / {total / 1e6:.0f} MB)", flush=True)

    urllib.request.urlretrieve(C.HF_URL, tmp, hook)
    print()
    if tmp.stat().st_size != C.CSV_BYTES:
        print(f"  note: size {tmp.stat().st_size} differs from the {C.CSV_BYTES} bytes seen when this lab was written "
              f"(the dataset may have been updated); continuing")
    tmp.replace(C.CSV_PATH)
    return C.CSV_PATH


# ---------------------------------------------------------------- arrays
@dataclass
class Logs:
    """Padded (N, T) arrays, NaN after the end of each trajectory. Positions are relative to the follower's start."""
    n: np.ndarray        # (N,) number of valid steps
    v_lead: np.ndarray   # logged lead speed (noisy, as recorded)
    pos_lead: np.ndarray
    v_ego: np.ndarray    # logged follower speed (the human)
    pos_ego: np.ndarray
    gap: np.ndarray      # bumper-to-bumper, logged
    acc_lead_raw: np.ndarray   # the Acc_LV column as recorded: NOT trustworthy, see audit()
    ids: np.ndarray
    v_lead_s: np.ndarray       # lead speed, smoothed (derived)
    a_lead: np.ndarray         # lead acceleration from the smoothed speed (derived): use this, not Acc_LV

    def __len__(self):
        return len(self.n)

    @property
    def T(self):
        return self.v_lead.shape[1]

    def take(self, idx):
        return Logs(*(getattr(self, f)[idx] for f in self.__dataclass_fields__))


def from_frame(df):
    """Build padded arrays from a DataFrame with the OpenPAV columns."""
    df = df.sort_values(["Trajectory_ID", "Time_Index"], kind="stable")
    tid = df["Trajectory_ID"].to_numpy()
    starts = np.r_[0, np.flatnonzero(np.diff(tid)) + 1]
    ends = np.r_[starts[1:], len(df)]
    N, T = len(starts), int((ends - starts).max())

    def pad(col):
        a = np.full((N, T), np.nan)
        x = df[col].to_numpy(dtype=float)
        for i, (s, e) in enumerate(zip(starts, ends)):
            a[i, :e - s] = x[s:e]
        return a

    pos_f0 = df["Pos_FAV"].to_numpy(dtype=float)[starts]
    pos_lead = pad("Pos_LV")
    pos_lead -= pos_f0[:, None]
    n = ends - starts
    v_lead = pad("Speed_LV")
    v_lead_s, a_lead = derive_lead(v_lead, n)
    return Logs(n=n, v_lead=v_lead, pos_lead=pos_lead, v_ego=pad("Speed_FAV"),
                pos_ego=pad("Pos_FAV") - pos_f0[:, None], gap=pad("Spatial_Gap"), acc_lead_raw=pad("Acc_LV"),
                ids=tid[starts], v_lead_s=v_lead_s, a_lead=a_lead)


def _signature(logs, i):
    k = logs.n[i]
    blob = np.round(np.stack([logs.v_lead[i, :k], logs.v_ego[i, :k], logs.gap[i, :k]]), 4).tobytes()
    return hashlib.md5(blob).hexdigest()


def dedupe(logs):
    """Drop exact duplicate trajectories (same lead, follower and gap profile). Returns (clean, n_removed)."""
    seen, keep = set(), []
    for i in range(len(logs)):
        s = _signature(logs, i)
        if s not in seen:
            seen.add(s)
            keep.append(i)
    return logs.take(np.array(keep)), len(logs) - len(keep)


def _ffill(x, n):
    """Replace padding NaN by the last valid value (edge padding) so filters do not leak NaN."""
    out = x.copy()
    for i in range(len(x)):
        out[i, n[i]:] = x[i, n[i] - 1]
    return out


def smooth(x, n, width=5):
    """Moving average along time, edge-padded, per trajectory. NaN stays NaN after the end."""
    out = np.full_like(x, np.nan)
    k = np.ones(width) / width
    for i in range(len(x)):
        s = x[i, :n[i]]
        p = np.pad(s, (width // 2, width // 2), mode="edge")
        out[i, :n[i]] = np.convolve(p, k, mode="valid")
    return out


def derive_lead(v_lead, n, width=5):
    """(smoothed lead speed, lead acceleration from it by central difference). Use this, not Acc_LV."""
    vs = smooth(v_lead, n, width)
    a = np.full_like(vs, np.nan)
    for i in range(len(vs)):
        k = n[i]
        a[i, :k] = np.gradient(vs[i, :k], C.DT) if k > 1 else 0.0
    return vs, a


def split_indices(n_total, seed, test_frac=0.3):
    """Split BY TRAJECTORY (never by frame: neighbouring frames of one trajectory are almost the same)."""
    perm = np.random.default_rng(seed).permutation(n_total)
    n_test = int(round(test_frac * n_total))
    return np.sort(perm[n_test:]), np.sort(perm[:n_test])


# ---------------------------------------------------------------- audit
def audit(raw_df, logs_raw, logs_clean, n_dup):
    """Facts a student must know about this data before trusting a single number (written to evidence/data_audit.json)."""
    g = raw_df.groupby("Trajectory_ID")
    dv = g["Speed_LV"].diff() / C.DT
    m = raw_df.assign(dv=dv)[["Acc_LV", "dv"]].dropna()
    corr_raw = float(np.corrcoef(m["Acc_LV"], m["dv"])[0, 1])
    dvf = g["Speed_FAV"].diff() / C.DT
    mf = raw_df.assign(dv=dvf)[["Acc_FAV", "dv"]].dropna()
    corr_f = float(np.corrcoef(mf["Acc_FAV"], mf["dv"])[0, 1])
    gap_off = raw_df["Pos_LV"] - raw_df["Pos_FAV"] - raw_df["Spatial_Gap"]
    flat = logs_clean.a_lead[~np.isnan(logs_clean.a_lead)]
    n_i = logs_clean.n
    return {
        "rows": int(len(raw_df)),
        "trajectories_raw": int(len(logs_raw)),
        "exact_duplicates_removed": int(n_dup),
        "trajectories_clean": int(len(logs_clean)),
        "steps_min_median_max": [int(n_i.min()), float(np.median(n_i)), int(n_i.max())],
        "dt_s": C.DT,
        "gap_equals_pos_diff_minus_length": {"mean_offset_m": float(gap_off.mean()), "max_abs_dev_m": float((gap_off - gap_off.mean()).abs().max())},
        "acc_lead_column_corr_with_dv_dt": corr_raw,
        "acc_follower_column_corr_with_dv_dt": corr_f,
        "lead_speed_quantiles_m_s_p1_p50_p99": [float(x) for x in np.nanpercentile(logs_clean.v_lead, [1, 50, 99])],
        "follower_speed_quantiles_m_s_p1_p50_p99": [float(x) for x in np.nanpercentile(logs_clean.v_ego, [1, 50, 99])],
        "gap_quantiles_m_p1_p50_p99": [float(x) for x in np.nanpercentile(logs_clean.gap, [1, 50, 99])],
        "lead_decel_smoothed_quantiles_p0.1_p1_p50": [float(x) for x in np.percentile(flat, [0.1, 1, 50])],
        "verdict": ("Acc_LV is not usable (corr with d(speed)/dt ~ 0): derive lead acceleration from smoothed Speed_LV. "
                    "Duplicates exist at far-apart ids, so a naive split can leak."),
    }


def prepare(max_traj=None, verbose=True):
    """Download -> read -> dedupe -> cache to work/logs.npz. Returns (logs, audit_dict)."""
    import pandas as pd
    path = download()
    raw = pd.read_csv(path, usecols=RAW_COLS)
    if max_traj:
        raw = raw[raw["Trajectory_ID"] < raw["Trajectory_ID"].unique()[max_traj]]
    logs_raw = from_frame(raw)
    logs, n_dup = dedupe(logs_raw)
    info = audit(raw, logs_raw, logs, n_dup)
    C.WORK_DIR.mkdir(exist_ok=True)
    np.savez_compressed(C.WORK_DIR / "logs.npz", **{f: getattr(logs, f) for f in logs.__dataclass_fields__})
    C.EVID_DIR.mkdir(exist_ok=True)
    (C.EVID_DIR / "data_audit.json").write_text(json.dumps(info, indent=2))
    if verbose:
        print(json.dumps(info, indent=2))
    return logs, info


def load_logs():
    """Load the cached clean logs (run `python run_all.py data` first)."""
    p = C.WORK_DIR / "logs.npz"
    if not p.exists():
        prepare()
    z = np.load(p)
    return Logs(**{f: z[f] for f in Logs.__dataclass_fields__})
