"""Planners under test. Common interface (vectorised over M simultaneous situations):

    planner.act(hist_rel, v, gap, lead_v) -> acceleration command [m/s^2], shape (M,)

hist_rel : (M, H+1) own speed over the last 2 s minus the current speed
v        : (M,) own speed          gap : (M,) bumper-to-bumper gap          lead_v : (M,) lead speed
"""
import numpy as np

from . import config as C
from .models import features


class ConstVel:
    name = "const-vel"

    def act(self, hist_rel, v, gap, lead_v):
        return np.zeros_like(v)


class FullBrake:
    """Brakes at the physical limit from the first step. Used to VALIDATE the simulator: it collides exactly where
    contact is physically unavoidable (see scenarios.unavoidable)."""
    name = "full-brake"

    def act(self, hist_rel, v, gap, lead_v):
        return np.full_like(v, -C.B_MAX)


class IDM:
    """Intelligent Driver Model (Treiber et al. 2000): the 'simple rule' every learned model must beat."""

    def __init__(self, v0=15.0, T=1.2, s0=2.0, a=1.5, b=2.0, name="IDM"):
        self.v0, self.T, self.s0, self.a, self.b, self.name = v0, T, s0, a, b, name

    def act(self, hist_rel, v, gap, lead_v):
        s_star = self.s0 + np.maximum(0.0, v * self.T + v * (v - lead_v) / (2 * np.sqrt(self.a * self.b)))
        return self.a * (1 - (v / self.v0) ** 4 - (s_star / np.maximum(gap, 0.1)) ** 2)


class LearnedPlanner:
    """Wraps a trained MLP: the command is the predicted speed change LOOKAHEAD steps ahead divided by that time."""

    def __init__(self, model, name):
        self.model, self.name = model, name

    def act(self, hist_rel, v, gap, lead_v):
        pred = self.model.predict(features(self.model.kind, hist_rel, v, gap, lead_v))
        return pred[:, C.LOOKAHEAD - 1] / (C.LOOKAHEAD * C.DT)


def clip_cmd(a):
    return np.clip(a, -C.B_MAX, C.A_MAX)


def idm_forecast(idm, v, gap, lead_v, steps=C.F):
    """Open-loop 'prediction' of a rule: roll the IDM forward assuming the lead keeps its current speed.
    Returns (M, steps) speed deltas relative to now, comparable with a learned model's output."""
    v, g, v0 = v.astype(float).copy(), gap.astype(float).copy(), v.astype(float)
    out = np.zeros((len(v), steps), np.float32)
    for k in range(steps):
        a = clip_cmd(idm.act(None, v, g, lead_v))
        v_new = np.maximum(0.0, v + a * C.DT)
        g = g + (lead_v - 0.5 * (v + v_new)) * C.DT
        v = v_new
        out[:, k] = v - v0
    return out
