"""Constants and per-student parameters for Lab 12."""
import hashlib
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
WORK_DIR = ROOT / "work"
EVID_DIR = ROOT / "evidence"

HF_URL = ("https://huggingface.co/datasets/OpenPAV/OpenPAV-trajectory/resolve/main/"
          "data/Argoverse/step3.csv")
CSV_PATH = DATA_DIR / "argoverse_step3.csv"
CSV_BYTES = 195_380_179          # size seen on 2026-10-11; used as a download sanity check

DT = 0.1                          # logs are 10 Hz
H = 20                            # history steps given to a planner (2 s)
F = 30                            # future steps a learned planner predicts (3 s)
LOOKAHEAD = 5                     # closed loop: a = predicted dv at LOOKAHEAD steps / (LOOKAHEAD * DT)
HANDOVER = H                      # closed loop on logs: replay the human for 2 s, then the planner drives
VEH_LEN = 4.5                     # Spatial_Gap = Pos_LV - Pos_FAV - 4.5 exactly (checked on the data)

A_MAX = 3.0                       # actuator limits [m/s^2]
B_MAX = 9.0
BRAKE_THRESHOLD = -2.0            # smoothed lead deceleration that counts as "lead is braking" [m/s^2]


def student_params(student_id=None):
    """Everything that makes one student's numbers different from another's, derived from the student id."""
    sid = str(student_id or os.environ.get("LAB_STUDENT_ID") or "demo")
    h = int(hashlib.sha256(sid.encode()).hexdigest(), 16)
    return {
        "student_id": sid,
        "split_seed": h % 10_000,
        "model_seed": (h >> 16) % 10_000,
        "v_ego": [10.0, 12.0, 14.0][(h >> 32) % 3],     # cruise speed of the scenario grid [m/s]
    }
