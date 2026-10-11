"""Unit tests that need no download: python3 -m unittest discover -s tests -v   (run from the Labs folder)"""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lab12 import augment, config as C, data, gate, models, planners as P, replay as R, scenarios as S, sim, stats


def synthetic_frame(n_traj=40, steps=70, seed=0):
    """A fake OpenPAV table: lead cruises at 8 m/s, follower follows an IDM; same column names as the real data."""
    rng = np.random.default_rng(seed)
    rows = []
    for tid in range(n_traj):
        v_l, v_e, gap, pos_l, pos_e = 8.0 + rng.normal(0, 1), 8.0, 12.0, 12.0 + C.VEH_LEN, 0.0
        for k in range(steps):
            rows.append(dict(Trajectory_ID=tid, Time_Index=round(0.1 * (k + 1), 1), Pos_LV=pos_l, Speed_LV=v_l, Acc_LV=rng.normal(),
                             Pos_FAV=pos_e, Speed_FAV=v_e, Acc_FAV=0.0, Spatial_Gap=pos_l - pos_e - C.VEH_LEN))
            a = P.IDM().act(None, np.array([v_e]), np.array([pos_l - pos_e - C.VEH_LEN]), np.array([v_l]))[0]
            v_e = max(0.0, v_e + a * C.DT)
            pos_e += v_e * C.DT
            pos_l += v_l * C.DT
    return pd.DataFrame(rows)


class Metrics(unittest.TestCase):
    def test_slide_examples(self):
        self.assertAlmostEqual(float(S.ttc(12, 5)), 2.4)                   # slide: TTC = 12 / 5 = 2.4 s
        self.assertAlmostEqual(float(S.required_decel(12, 5)), 25 / 24)    # slide: 5^2 / (2 * 12) = 1.04 m/s^2
        self.assertTrue(np.isinf(S.ttc(10, -1)))                           # not closing in: no collision time

    def test_wilson(self):
        lo, hi = stats.wilson(0, 100)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 0.0370, places=3)                       # known value for 0/100
        lo, hi = stats.wilson(50, 100)
        self.assertAlmostEqual(lo, 0.404, places=3)
        self.assertAlmostEqual(hi, 0.596, places=3)

    def test_ttc_and_required_decel_work_on_arrays(self):
        t = S.ttc(np.array([10.0, 10.0, 10.0]), np.array([5.0, 0.0, -2.0]))
        np.testing.assert_allclose(t[:1], [2.0])
        self.assertTrue(np.isinf(t[1:]).all())                              # not closing in -> no collision time
        np.testing.assert_allclose(S.required_decel(np.array([12.0, 12.0]), np.array([5.0, -3.0])), [25 / 24, 0.0])

    def test_unavoidable_frontier(self):
        gaps, dvs = np.array([1.0, 3.0, 5.0, 20.0]), np.array([6.0])
        # dv = 6, b = 9: dv^2/(2b) = 2 m. With a 0.5 s delay another 3 m are lost: frontier at 5 m
        np.testing.assert_array_equal(S.unavoidable(gaps, dvs, 0.0, 9.0)[0], [True, False, False, False])
        np.testing.assert_array_equal(S.unavoidable(gaps, dvs, 0.5, 9.0)[0], [True, True, False, False])
        self.assertFalse(S.unavoidable(gaps, np.array([0.0]), 0.5, 9.0).any())   # not closing in: always avoidable

    def test_wilson_edges(self):
        lo, hi = stats.wilson(100, 100)
        self.assertAlmostEqual(hi, 1.0, places=6)
        self.assertGreater(lo, 0.96)
        self.assertTrue(np.isnan(stats.wilson(0, 0)[0]))

    def test_float_addition_is_not_associative(self):
        self.assertNotEqual((0.1 + 0.2) + 0.3, 0.1 + (0.2 + 0.3))          # the slide's example


class Data(unittest.TestCase):
    def test_arrays_and_dedupe(self):
        df = synthetic_frame()
        dup = df[df.Trajectory_ID == 3].assign(Trajectory_ID=999)           # an exact copy at a far-away id
        logs = data.from_frame(pd.concat([df, dup]))
        self.assertEqual(len(logs), 41)
        clean, removed = data.dedupe(logs)
        self.assertEqual((len(clean), removed), (40, 1))
        np.testing.assert_allclose(logs.gap[0, :logs.n[0]], logs.pos_lead[0, :logs.n[0]] - logs.pos_ego[0, :logs.n[0]] - C.VEH_LEN)

    def test_split_is_by_trajectory_and_disjoint(self):
        tr, te = data.split_indices(100, seed=5)
        self.assertEqual(len(set(tr) & set(te)), 0)
        self.assertEqual(len(tr) + len(te), 100)

    def test_lead_accel_recovers_a_known_ramp(self):
        v = np.tile(np.arange(60) * 0.1 * 1.5, (3, 1))                       # speed ramps at 1.5 m/s^2
        _, a = data.derive_lead(v, np.array([60, 60, 60]))
        np.testing.assert_allclose(a[:, 5:-5], 1.5, atol=1e-6)


class Mining(unittest.TestCase):
    def _logs(self, lead_speed):
        n = len(lead_speed)
        df = pd.DataFrame(dict(Trajectory_ID=0, Time_Index=np.round(0.1 * np.arange(1, n + 1), 1), Pos_LV=np.cumsum(lead_speed) * 0.1 + 20,
                               Speed_LV=lead_speed, Acc_LV=0.0, Pos_FAV=np.arange(n) * 0.8, Speed_FAV=8.0, Acc_FAV=0.0,
                               Spatial_Gap=15.0))
        return data.from_frame(df)

    def test_a_sustained_braking_lead_is_found_and_a_one_step_blip_is_not(self):
        v = np.full(80, 10.0)
        v[30:50] = 10.0 - 3.0 * 0.1 * np.arange(20)                           # brakes at 3 m/s^2 for 2 s
        events = S.mine_braking(self._logs(v))
        self.assertEqual(len(events), 1)
        self.assertEqual(set(events[0]), {"traj", "onset_step", "peak_decel", "gap_m", "closing_m_s", "ego_speed"})
        self.assertTrue(25 <= events[0]["onset_step"] <= 35)
        self.assertLess(events[0]["peak_decel"], -2.0)
        blip = np.full(80, 10.0)
        blip[40] = 7.0                                                          # one noisy sample
        self.assertEqual(len(S.mine_braking(self._logs(blip))), 0)


class OpenLoop(unittest.TestCase):
    def test_l2_is_zero_for_perfect_prediction_and_sliced_correctly(self):
        Y = np.random.default_rng(0).normal(size=(10, C.F)).astype(np.float32)
        brake = np.array([True] * 3 + [False] * 7)
        pred = Y.copy()
        pred[:3] += 1.0                                                          # wrong only on the 3 'braking' windows
        out = models.l2_summary(pred, Y, brake)
        self.assertAlmostEqual(out["slice_share"], 0.3)
        self.assertGreater(out["brake_slice"], 0.5)
        self.assertGreater(out["brake_slice"], 3 * out["all"] * 0.99)             # the slice is hidden in the average
        self.assertEqual(models.l2_summary(Y, Y, brake)["all"], 0.0)


class Gate(unittest.TestCase):
    def _ev(self, cand_rate, cand_grid, replay_ok=True):
        rate = lambda r, n=3000: {"rate": r, "n": n, "ci95": list(stats.wilson(round(r * n), n))}
        mk = lambda r, g: {"collision": rate(r), "collision_brake_slice": rate(r, 170), "per_seed_collision_rate": [r]}
        return {"replay": {"rerun_identical": replay_ok, "refactor_float32": {"differ_beyond_tol": 0}},
                "closed_loop": {"logs": {"IDM": mk(0.001, 0), "X": mk(cand_rate, 0)},
                                "grid": {"t_react_0.6": {"IDM": {"attributable_area": 0.0}, "X": {"attributable_area": cand_grid}}}},
                "agents": {"rear_comparison_t_react_0.6": {"IDM": {"reactive": {"any": 0.10}}, "X": {"reactive": {"any": 0.10 + cand_grid}}}},
                "scenarios": {"coverage": {"mined_events": 600, "grid_cells": 2700}}}

    def test_good_candidate_is_released(self):
        release, rules = gate.evaluate("X", "IDM", self._ev(0.003, 0.005))
        self.assertTrue(release, rules)

    def test_one_failed_rule_blocks(self):
        for rate, grid, bad in ((0.05, 0.005, "R2_closed_loop_logs"), (0.003, 0.20, "R4_scenario_grid")):
            release, rules = gate.evaluate("X", "IDM", self._ev(rate, grid))
            self.assertFalse(release)
            self.assertFalse(rules[bad]["pass"])

    def test_irreproducible_replay_blocks_everything(self):
        release, rules = gate.evaluate("X", "IDM", self._ev(0.003, 0.005, replay_ok=False))
        self.assertFalse(release)
        self.assertFalse(rules["R1_replay_reproducible"]["pass"])


class Simulator(unittest.TestCase):
    def test_full_brake_collides_exactly_where_physics_says(self):
        gaps, dvs = np.linspace(3, 50, 40), np.linspace(0, 12, 30)
        for tr in (0.0, 0.6):
            un = S.unavoidable(gaps, dvs, tr)
            hit = sim.rollout_cutin(P.FullBrake(), 12.0, gaps, dvs, tr)["front"]
            G, DV = np.meshgrid(gaps, dvs)
            far = np.abs(G - (DV * tr + DV ** 2 / (2 * C.B_MAX))) / G > 0.05
            self.assertEqual(int((hit != un)[far].sum()), 0)

    def test_const_vel_hits_a_slower_cutter_and_idm_does_not(self):
        r_cv = sim.rollout_cutin(P.ConstVel(), 12.0, [20.0], [6.0])
        r_idm = sim.rollout_cutin(P.IDM(), 12.0, [20.0], [6.0])
        self.assertTrue(r_cv["front"][0, 0])
        self.assertFalse(r_idm["front"][0, 0])

    def test_reactive_rear_car_removes_fake_rear_collisions(self):
        idm = P.IDM(v0=20.0, T=1.4)
        res = {m: sim.rollout_cutin(P.IDM(), 12.0, [12.0], [8.0], 0.0, rear=sim.RearAgent(m, gap=19.0, idm=idm))
               for m in ("replay", "reactive")}
        self.assertTrue(res["replay"]["rear"][0, 0])        # replayed car cannot know the ego braked
        self.assertFalse(res["reactive"]["rear"][0, 0])

    def test_rollout_on_logs_human_replay_has_no_collision_for_a_follower_that_copies_the_human(self):
        logs = data.from_frame(synthetic_frame())
        r = sim.rollout_logs(P.IDM(), logs, np.arange(len(logs)))
        self.assertEqual(r["collision"].sum(), 0)
        self.assertTrue((r["min_gap"] > 0).all())


class Replay(unittest.TestCase):
    def setUp(self):
        self.logs = data.from_frame(synthetic_frame(n_traj=12))
        self.path = Path(__file__).resolve().parent / "_tmp_log.jsonl"
        R.write_log(self.path, self.logs, np.arange(12))
        self.segs = R.read_log(self.path)

    def tearDown(self):
        self.path.unlink(missing_ok=True)

    def test_messages_are_replayed_in_timestamp_order(self):
        for msgs in self.segs.values():
            t = [m["t_ns"] for m in msgs]
            self.assertEqual(t, sorted(t))

    def test_same_code_twice_is_identical_refactor_needs_tolerance(self):
        a, _ = R.replay(self.segs, lambda: R.IDMStream())
        b, _ = R.replay(self.segs, lambda: R.IDMStream())
        self.assertEqual(R.compare_with_tol(a, b)["not_bit_identical"], 0)
        c, _ = R.replay(self.segs, lambda: R.IDMStream(dtype=np.float32, variant="refactored"))
        cmp = R.compare_with_tol(a, c)
        self.assertGreater(cmp["not_bit_identical"], 0)
        self.assertEqual(cmp["differ_beyond_tol"], 0)

    def test_realtime_replay_exposes_what_fastest_hides(self):
        fast = R.replay(self.segs, lambda: R.IDMStream(), mode="fastest", spike_prob=0.2)[1]
        real = R.replay(self.segs, lambda: R.IDMStream(), mode="realtime", spike_prob=0.2)[1]
        self.assertEqual(fast["late"] + fast["dropped"], 0)
        self.assertGreater(real["late"] + real["dropped"], 0)


class Dagger(unittest.TestCase):
    def test_windows_have_training_layout_and_expert_labels(self):
        logs = data.from_frame(synthetic_frame(n_traj=10, steps=80))
        X, Y = augment.dagger_windows(P.ConstVel(), logs, np.arange(10))
        self.assertEqual((X.shape[1], Y.shape[1]), (C.H + 4, C.F))
        self.assertEqual(len(X), len(Y))
        self.assertGreater(len(X), 50)
        # the label of every window is the expert's forecast FROM THAT STATE (v = X[:, H+1], gap = X[:, H+2], lead rel = X[:, H+3])
        v, gap, lead = X[:, C.H + 1], X[:, C.H + 2], X[:, C.H + 1] + X[:, C.H + 3]
        np.testing.assert_allclose(Y, P.idm_forecast(P.IDM(), v, gap, lead), atol=1e-4)
        Xs, Ys = augment.cutin_windows(200, np.random.default_rng(0))
        self.assertEqual((Xs.shape[1], Ys.shape[1]), (C.H + 4, C.F))


class Learning(unittest.TestCase):
    def test_mlp_learns_a_linear_map(self):
        rng = np.random.default_rng(0)
        X = rng.normal(size=(4000, 6)).astype(np.float32)
        Y = np.repeat((X[:, :1] * 2.0 - X[:, 1:2]), C.F, axis=1).astype(np.float32)
        m = models.fit("ego", X, Y, seed=0, epochs=12)
        self.assertLess(float(((m.predict(X) - Y) ** 2).mean()), 0.2 * float(Y.var()))

    def test_features_have_the_same_layout_for_training_and_driving(self):
        logs = data.from_frame(synthetic_frame(n_traj=6, steps=80))
        Xe, Xp, Y, _, _ = models.build_windows(logs, np.arange(6))
        self.assertEqual((Xe.shape[1], Xp.shape[1], Y.shape[1]), (C.H + 2, C.H + 4, C.F))
        hist = np.zeros((1, C.H + 1))
        self.assertEqual(models.features("perc", hist, np.array([5.0]), np.array([9.0]), np.array([6.0])).shape[1], Xp.shape[1])

    def test_student_params_are_stable_and_differ(self):
        self.assertEqual(C.student_params("A1"), C.student_params("A1"))
        self.assertNotEqual(C.student_params("A1")["split_seed"], C.student_params("B2")["split_seed"])


if __name__ == "__main__":
    unittest.main()
