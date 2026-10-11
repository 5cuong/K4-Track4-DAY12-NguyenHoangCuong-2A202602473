"""Run the Day 12 lab.   python3 run_all.py [step ...] [--student-id ID] [--quick] [--seeds N]

steps: data replay scenarios openloop closedloop agents gate fix   (default: all, in that order)
Student id (or env LAB_STUDENT_ID) fixes your train/test split, model seeds and cruise speed, so your numbers are yours.
"""
import argparse
import sys
import time

from lab12 import steps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("steps", nargs="*", default=["all"])
    ap.add_argument("--student-id", default=None)
    ap.add_argument("--seeds", type=int, default=5, help="training seeds per learned planner (default 5)")
    ap.add_argument("--quick", action="store_true", help="smaller, faster run for debugging (numbers will differ)")
    a = ap.parse_args()
    todo = list(steps.STEPS) if a.steps == ["all"] else a.steps
    for s in todo:
        if s not in steps.STEPS:
            sys.exit(f"unknown step '{s}'. choose from: {' '.join(steps.STEPS)}")
    t0 = time.time()
    if "data" in todo:
        steps.step_data(None)
        todo.remove("data")
    if todo:
        ctx = steps.Ctx(a.student_id, a.seeds, a.quick)
        print(f"student {ctx.sp['student_id']}: split seed {ctx.sp['split_seed']}, model seeds {ctx.seeds}, cruise speed {ctx.sp['v_ego']} m/s")
        for s in todo:
            steps.STEPS[s](ctx)
    print(f"\ndone in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
