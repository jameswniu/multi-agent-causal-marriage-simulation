#!/usr/bin/env python3
"""Measure how much the twins design actually cuts the noise, on a real intervention.

Running every couple under both arms on the same random draws (common random numbers) is meant to
remove the luck of the draw from the comparison. On a placebo, where the two arms are the same, it
removes it entirely and the arms agree couple for couple. Under a real intervention it removes less,
because treated couples genuinely diverge from their own twins and the pairing decays as the year
runs. This prints how much is left, so the claim rests on a measured number rather than on the
placebo's perfect case.

For each outcome it reports the correlation between a couple's two lives, the standard error of the
paired estimate, the standard error the same couples would have given as two independent groups, and
the ratio between them. The last column is how many times more couples an unpaired design would need
to match the paired one's precision.

Usage: python3 tools/variance_reduction.py [results/<name>-twins]
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DEFAULT = Path(__file__).resolve().parent.parent / "results" / "retention-90d-twins"


def config(run: Path) -> dict:
    """The settings the arm actually ran under."""
    return json.loads((run / "config.json").read_text())


def study_days(run: Path) -> int:
    """The run's own length. A couple still married on the last day is censored there, and the
    fill has to be this fixed number: filling with the latest divorce actually seen would let one
    couple's failure day decide another couple's recorded outcome, and differently in each arm."""
    return int(config(run)["days"])


def outcomes(run: Path) -> pd.DataFrame:
    """Per-couple outcomes for one arm of a twins run, indexed by couple id."""
    couples = pd.read_parquet(run / "couples.parquet")
    couples = couples[couples.origin == "initial"].copy()
    couples["divorced"] = (couples.final_state == "divorced").astype(float)
    couples["days_married"] = couples.ended_day.fillna(study_days(run))
    out = couples.set_index("couple_id")[["divorced", "days_married"]]

    daily = pd.read_parquet(run / "daily.parquet")
    daily["trust"] = (daily.trust_a + daily.trust_b) / 2
    out["mean_trust"] = daily.groupby("couple_id").trust.mean()
    # A couple's mean trust is only comparable to its twin's if both were averaged over the same
    # days, and a truncated or half-written file still averages to a finite number that looks like
    # an answer. Describe each couple's record by its first day, its last day, how many distinct
    # days it holds and how many rows it holds, which is everything the one check below needs.
    if not pd.api.types.is_integer_dtype(daily.day):
        raise ValueError(
            f"{run}/daily.parquet numbers its days as {daily.day.dtype} rather than whole "
            f"numbers, so a day between two days could sit unnoticed inside a record that "
            f"otherwise looks complete"
        )
    by_couple = daily.groupby("couple_id").day
    out["first_day"] = by_couple.min()
    out["last_day"] = by_couple.max()
    out["distinct_days"] = by_couple.nunique()
    out["rows"] = by_couple.size()
    return out


def main(argv: list[str]) -> int:
    base = Path(argv[1]) if len(argv) > 1 else DEFAULT
    if not (base / "control").is_dir() or not (base / "treatment").is_dir():
        print(f"not a twins run (no control and treatment): {base}", file=sys.stderr)
        return 2

    control, treatment = outcomes(base / "control"), outcomes(base / "treatment")
    if set(control.index) != set(treatment.index):
        only_c = sorted(set(control.index) - set(treatment.index))[:5]
        only_t = sorted(set(treatment.index) - set(control.index))[:5]
        print(
            f"the two arms hold different couples, so they are not twins: "
            f"{len(control)} in control, {len(treatment)} in treatment, "
            f"first only in control {only_c}, first only in treatment {only_t}",
            file=sys.stderr,
        )
        return 2
    # Matching couple ids are not proof of a paired design. Two arms are twins only if they were
    # run from the same seeds for the same length; otherwise the correlation below is between
    # unrelated draws and every saving it reports is imaginary.
    c_cfg, t_cfg = config(base / "control"), config(base / "treatment")
    for field in ("seeds", "days", "n_couples"):
        if c_cfg.get(field) != t_cfg.get(field):
            print(
                f"the two arms differ in {field} ({c_cfg.get(field)} against {t_cfg.get(field)}), "
                f"so they are not twins and nothing here would mean anything",
                file=sys.stderr,
            )
            return 2

    # A couple is written every day until it divorces, so a full record runs to its ending day,
    # or to the last day of the run if it never ends. Anything shorter is a truncated file, and a
    # mean taken over it would still look like a number.
    # One check, not three. A couple's days must be exactly 0 through its own last day, which
    # pins the start, the end, the gaps and the duplicates at once. Counting rows alone let two
    # twins pass while one ran days 0 to 90 and the other days 1 to 91, averaging their trust
    # over different periods, and anchoring only the length would let that back in.
    # The days are whole numbers, checked when they are read, so a record that starts at 0, ends
    # at its last day and holds that many distinct rows can only be every day in between.
    for arm, frame in (("control", control), ("treatment", treatment)):
        # Days are numbered from 0, so a couple ending on day 117 is written on days 0 to 117,
        # which is 118 rows, while a couple that never ends is written on every day of the run.
        want_last = frame.days_married.astype(int) - (~frame.divorced.astype(bool)).astype(int)
        wrong = frame[
            (frame.first_day != 0)
            | (frame.last_day != want_last)
            | (frame.distinct_days != want_last + 1)
            | (frame.rows != frame.distinct_days)
        ]
        if len(wrong):
            first = wrong.index[0]
            row = wrong.loc[first]
            print(
                f"{len(wrong)} couples in {arm} do not have one row for every day they were "
                f"together, the first being couple {int(first)}, which should hold days 0 to "
                f"{int(want_last.loc[first])} and instead holds {int(row.rows)} rows covering "
                f"days {int(row.first_day)} to {int(row.last_day)}",
                file=sys.stderr,
            )
            return 2

    pair = control.join(treatment, lsuffix="_c", rsuffix="_t", how="inner")
    n = len(pair)
    print(f"{base.name}, {n} couples under both arms\n")
    print(f"{'outcome':<14}{'effect':>10}{'corr':>8}{'SE paired':>12}{'SE apart':>11}{'noise cut':>12}{'couples':>10}")
    print("-" * 77)
    for name in ("divorced", "days_married", "mean_trust"):
        control = pair[f"{name}_c"].to_numpy(dtype=float)
        treated = pair[f"{name}_t"].to_numpy(dtype=float)
        gaps = int((~np.isfinite(control)).sum() + (~np.isfinite(treated)).sum())
        if gaps:
            print(f"{name} is missing for {gaps} of {2 * n} couple-arms, so the run is incomplete",
                  file=sys.stderr)
            return 2

        paired = (treated - control).var(ddof=1) / n
        apart = control.var(ddof=1) / n + treated.var(ddof=1) / n
        effect = f"{treated.mean() - control.mean():>10.3f}"
        # A constant arm has no correlation to report, but the effect and both errors still do,
        # and that case is the interesting one: no divorces in control, some under treatment.
        flat = np.std(control) == 0 or np.std(treated) == 0
        corr = "       -" if flat else f"{float(np.corrcoef(control, treated)[0, 1]):>8.3f}"
        if apart == 0:
            print(f"{name:<14}{effect}{corr}     neither arm varies at all")
            continue
        print(
            f"{name:<14}{effect}{corr}"
            f"{np.sqrt(paired):>12.4f}{np.sqrt(apart):>11.4f}"
            f"{(1 - paired / apart) * 100:>11.1f}%{apart / paired:>9.2f}x"
        )
    print("\nThe last column is how many times more couples an unpaired design would need")
    print("to reach the same precision. A placebo, where the arms are identical, cuts all of it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
