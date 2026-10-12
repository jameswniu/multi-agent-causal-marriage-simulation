"""Causal analysis over the engine's Parquet tables.

Everything here is a pure function of the tables. Effects are differences between arms on the
initial couples, with bootstrap percentile confidence intervals and randomisation-inference
p-values. Inference respects the randomisation unit: in couple mode every couple is its own
cluster; in block mode whole blocks (couple_id divided by block_size) are resampled within arm
and block labels are permuted. Outcomes defined on post-treatment populations (conflicts that
happened, agents who divorced) are ratio-of-sums per arm with the same cluster resampling, and
are flagged.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from loveworld.experiment import AnalysisSettings, intervention_summary, shocks_summary
from loveworld.schema import (
    BALANCE_COVARIATES,
    DAILY_OPTIONAL_DEFAULTS,
    DISCLAIMER,
    EVIDENCE_CLASS,
    OPTIONAL_COLUMNS,
    OPTIONAL_TABLES,
    OUTCOMES,
    SAFE_NAME,
    TABLES,
)


@dataclass
class Tables:
    """Every table of one results directory."""

    results_dir: Path
    manifest: dict[str, Any]
    config: dict[str, Any]
    agents: pd.DataFrame
    couples: pd.DataFrame
    events: pd.DataFrame
    daily: pd.DataFrame
    decisions: pd.DataFrame
    interventions: pd.DataFrame
    conflicts: pd.DataFrame
    episodes: pd.DataFrame
    legacies: pd.DataFrame

    @property
    def days(self) -> int:
        """Number of simulated days."""
        return int(self.config["days"])

    @property
    def initial(self) -> pd.DataFrame:
        """The randomised couples (origin initial)."""
        return self.couples[self.couples["origin"] == "initial"]

    @property
    def block_size(self) -> int | None:
        """Block size when the experiment was block-randomised, else None."""
        a = self.config.get("assignment", {})
        return int(a.get("block_size", 1)) if a.get("mode") == "block" else None


def load_tables(results_dir: str | Path) -> Tables:
    """Read manifest, config and every Parquet table (optional tables default to empty frames)."""
    d = Path(results_dir)
    manifest = json.loads((d / "manifest.json").read_text())
    config = json.loads((d / "config.json").read_text()) if (d / "config.json").exists() else manifest["config"]
    frames = {name: pq.read_table(d / f"{name}.parquet").to_pandas() for name in TABLES}
    for name in OPTIONAL_TABLES:
        path = d / f"{name}.parquet"
        frames[name] = (
            pq.read_table(path).to_pandas() if path.exists() else pd.DataFrame({c: [] for c in OPTIONAL_COLUMNS[name]})
        )
    for col, default in DAILY_OPTIONAL_DEFAULTS.items():
        if col not in frames["daily"].columns:
            frames["daily"][col] = default
    return Tables(results_dir=d, manifest=manifest, config=config, **frames)


# ---------------------------------------------------------------------------- couple frame


def couple_frame(t: Tables) -> pd.DataFrame:
    """One row per initial couple: arm, cluster, outcome values, and numerator/denominator pairs."""
    init = t.initial.set_index("couple_id").sort_index()
    df = pd.DataFrame(index=init.index)
    df["arm"] = init["arm"].astype(str)
    bs = t.block_size
    df["cluster"] = (df.index // bs) if bs else df.index
    divorced = init["final_state"] == "divorced"
    df["divorce_rate"] = divorced.astype(float)
    sep_ids = set(t.events.loc[t.events["kind"] == "separated", "couple_id"].tolist())
    df["separation_rate"] = df.index.isin(sep_ids).astype(float)
    ended = init["ended_day"].astype(float)
    days = float(t.days)
    # The terminal day counts as a married day: ended_day + 1, never beyond the window.
    df["days_married"] = np.where(divorced, np.minimum(ended.fillna(days - 1.0) + 1.0, days), days)

    daily = t.daily[t.daily["couple_id"].isin(df.index)].copy()
    if len(daily):
        daily["trust"] = (daily["trust_a"] + daily["trust_b"]) / 2.0
        last = daily.sort_values("day").groupby("couple_id").tail(1).set_index("couple_id")
        df["final_trust"] = last["trust"].reindex(df.index)
        df["mean_trust"] = daily.groupby("couple_id")["trust"].mean().reindex(df.index)
        exposure = (last["day"].astype(float) + 1.0).reindex(df.index)
    else:
        ag = t.agents.set_index("agent_id")
        a_trust = ag.loc[init["agent_a"], "final_trust"].to_numpy()
        b_trust = ag.loc[init["agent_b"], "final_trust"].to_numpy()
        df["final_trust"] = (a_trust + b_trust) / 2
        df["mean_trust"] = np.nan
        exposure = pd.Series(df["days_married"].to_numpy(), index=df.index)

    cf = t.conflicts[t.conflicts["couple_id"].isin(df.index)]
    n_conf = cf.groupby("couple_id").size().reindex(df.index).fillna(0).astype(float)
    df["n_conflicts"] = n_conf
    df["conflict_rate"] = n_conf / (exposure / 365.0)

    closed = cf[cf["outcome"] != "open_at_end"]
    rec = cf[cf["outcome"] == "reconciled"]
    esc = cf.groupby("couple_id")["escalations"].sum()
    df["escalations_per_conflict__num"] = esc.reindex(df.index).fillna(0).astype(float)
    df["escalations_per_conflict__den"] = n_conf
    rec_num = (closed["outcome"] == "reconciled").groupby(closed["couple_id"]).sum()
    df["reconciliation_rate__num"] = rec_num.reindex(df.index).fillna(0).astype(float)
    df["reconciliation_rate__den"] = closed.groupby("couple_id").size().reindex(df.index).fillna(0).astype(float)
    df["recovery_days__num"] = rec.groupby("couple_id")["duration_days"].sum().reindex(df.index).fillna(0).astype(float)
    df["recovery_days__den"] = rec.groupby("couple_id").size().reindex(df.index).fillna(0).astype(float)

    ag = t.agents
    div_agents = ag[ag["divorces_in_sim"] > 0]
    rem_num = (div_agents["marriages_in_sim"] > 0).groupby(div_agents["couple_id"]).sum()
    df["remarriage_rate__num"] = rem_num.reindex(df.index).fillna(0).astype(float)
    df["remarriage_rate__den"] = div_agents.groupby("couple_id").size().reindex(df.index).fillna(0).astype(float)
    return df


def outcome_pairs(df: pd.DataFrame, name: str) -> tuple[np.ndarray, np.ndarray]:
    """Numerator and denominator per couple for an outcome (den = 1 for plain means)."""
    if f"{name}__num" in df.columns:
        num = df[f"{name}__num"].to_numpy(dtype=float)
        den = df[f"{name}__den"].to_numpy(dtype=float)
        return num, den
    values = df[name].to_numpy(dtype=float)
    den = np.where(np.isnan(values), 0.0, 1.0)
    return np.nan_to_num(values), den


def cluster_pairs(
    num: np.ndarray, den: np.ndarray, treated: np.ndarray, cluster: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Aggregate unit-level pairs to the randomisation unit (sum within cluster)."""
    frame = pd.DataFrame({"num": num, "den": den, "treated": treated.astype(bool), "cluster": cluster})
    g = frame.groupby("cluster", sort=True)
    mixed = g["treated"].nunique()
    if (mixed > 1).any():
        raise ValueError("a cluster spans both arms; block ids must be nested in arms")
    agg = g.agg(num=("num", "sum"), den=("den", "sum"), treated=("treated", "first"))
    return agg["num"].to_numpy(dtype=float), agg["den"].to_numpy(dtype=float), agg["treated"].to_numpy(dtype=bool)


# ---------------------------------------------------------------------------- estimators


@dataclass
class Effect:
    """A between-arm difference with its uncertainty."""

    control_mean: float
    treatment_mean: float
    ate: float
    ci_low: float
    ci_high: float
    p_permutation: float
    n_control: int
    n_treatment: int


def _ratio(num: np.ndarray, den: np.ndarray) -> float:
    d = float(den.sum())
    return float(num.sum() / d) if d > 0 else math.nan


def _boot_ratio(num: np.ndarray, den: np.ndarray, idx: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return num[idx].sum(axis=1) / den[idx].sum(axis=1)


def estimate_effect(
    num: np.ndarray,
    den: np.ndarray,
    treated: np.ndarray,
    rng: np.random.Generator,
    n_boot: int,
    n_perm: int,
    ci_level: float = 0.95,
    cluster: np.ndarray | None = None,
) -> Effect:
    """Difference of per-arm ratio-of-sums, cluster bootstrap CI and cluster permutation p-value.

    `cluster` names the randomisation unit of each row; rows sharing a cluster are resampled and
    relabelled together. Without it every row is its own cluster.
    """
    if not 0.0 < ci_level < 1.0:
        raise ValueError(f"ci_level must be strictly between 0 and 1, got {ci_level}")
    if n_boot < 0 or n_perm < 0:
        raise ValueError("n_boot and n_perm must not be negative")
    num = np.asarray(num, dtype=float)
    den = np.asarray(den, dtype=float)
    treated = np.asarray(treated, dtype=bool)
    n_units_t, n_units_c = int(treated.sum()), int((~treated).sum())
    if cluster is not None:
        num, den, treated = cluster_pairs(num, den, treated, np.asarray(cluster))
    num_t, den_t = num[treated], den[treated]
    num_c, den_c = num[~treated], den[~treated]
    mean_t, mean_c = _ratio(num_t, den_t), _ratio(num_c, den_c)
    ate = mean_t - mean_c
    n_t, n_c = int(treated.sum()), int((~treated).sum())
    alpha = 1.0 - ci_level
    ci_low = ci_high = math.nan
    if n_boot > 0 and n_t > 0 and n_c > 0:
        it = rng.integers(0, n_t, size=(n_boot, n_t))
        ic = rng.integers(0, n_c, size=(n_boot, n_c))
        boots = _boot_ratio(num_t, den_t, it) - _boot_ratio(num_c, den_c, ic)
        boots = boots[~np.isnan(boots)]
        if len(boots):
            ci_low, ci_high = (float(x) for x in np.percentile(boots, [100 * alpha / 2, 100 * (1 - alpha / 2)]))
    p = math.nan
    if n_perm > 0 and n_t > 0 and n_c > 0 and not math.isnan(ate):
        n = len(num)
        order = np.argsort(rng.random((n_perm, n)), axis=1)
        labels = treated[order]
        with np.errstate(divide="ignore", invalid="ignore"):
            stat_t = (num[None, :] * labels).sum(axis=1) / (den[None, :] * labels).sum(axis=1)
            stat_c = (num[None, :] * ~labels).sum(axis=1) / (den[None, :] * ~labels).sum(axis=1)
        diffs = stat_t - stat_c
        diffs = diffs[~np.isnan(diffs)]
        if len(diffs):
            p = float((1 + np.sum(np.abs(diffs) >= abs(ate) - 1e-12)) / (len(diffs) + 1))
    return Effect(mean_c, mean_t, ate, ci_low, ci_high, p, n_units_c, n_units_t)


def _clean(x: Any) -> float | None:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def sanitize(obj: Any) -> Any:
    """Recursively turn NaN and infinities into null and numpy scalars into plain Python."""
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [sanitize(v) for v in obj]
    if isinstance(obj, bool | np.bool_):
        return bool(obj)
    if isinstance(obj, int | np.integer):
        return int(obj)
    if isinstance(obj, float | np.floating):
        v = float(obj)
        return v if math.isfinite(v) else None
    return obj


def outcomes_table(df: pd.DataFrame, settings: AnalysisSettings) -> list[dict[str, Any]]:
    """Every outcome in report order, as contract rows."""
    rng = np.random.default_rng(settings.seed)
    treated = (df["arm"] == "treatment").to_numpy()
    cluster = df["cluster"].to_numpy()
    rows: list[dict[str, Any]] = []
    for name, label, unit, kind, conditional in OUTCOMES:
        num, den = outcome_pairs(df, name)
        e = estimate_effect(
            num, den, treated, rng, settings.n_boot, settings.n_perm, settings.ci_level, cluster=cluster
        )
        note = ""
        if conditional:
            note = "Estimated on a post-treatment population (ratio of sums per arm, cluster bootstrap over couples)."
        if name == "reconciliation_rate":
            note += " Conflicts still open at the end of the window are excluded."
        rows.append(
            {
                "name": name,
                "label": label,
                "unit": unit,
                "type": kind,
                "level": "agent" if name == "remarriage_rate" else ("conflict" if conditional else "couple"),
                "n_control": e.n_control,
                "n_treatment": e.n_treatment,
                "control_mean": _clean(e.control_mean),
                "treatment_mean": _clean(e.treatment_mean),
                "ate": _clean(e.ate),
                "ci_low": _clean(e.ci_low),
                "ci_high": _clean(e.ci_high),
                "ci_level": settings.ci_level,
                "ci_method": "bootstrap_percentile",
                "n_boot": settings.n_boot,
                "p_permutation": _clean(e.p_permutation),
                "n_perm": settings.n_perm,
                "conditional_on_post_treatment": bool(conditional),
                "note": note.strip(),
            }
        )
    return rows


# ---------------------------------------------------------------------------- balance, curves, distributions


def balance_table(agents: pd.DataFrame) -> list[dict[str, Any]]:
    """Covariate means by arm and standardized mean differences at the couple level.

    Agents are averaged within their couple first (the couple is the randomisation unit and
    partners are assortatively matched, so agent rows are not independent).
    """
    cols = [c for c in BALANCE_COVARIATES if c in agents.columns]
    if not cols or len(agents) == 0:
        return []
    couples = agents.groupby("couple_id").agg({**{c: "mean" for c in cols}, "arm": "first"})
    c = couples[couples["arm"] == "control"]
    t = couples[couples["arm"] == "treatment"]
    rows = []
    for cov in cols:
        xc = c[cov].to_numpy(dtype=float)
        xt = t[cov].to_numpy(dtype=float)
        smd: float | None
        if len(xc) == 0 or len(xt) == 0:
            smd = None
        else:
            pooled = math.sqrt((xc.var(ddof=1) + xt.var(ddof=1)) / 2.0) if len(xc) > 1 and len(xt) > 1 else 0.0
            smd = float((xt.mean() - xc.mean()) / pooled) if pooled > 0 else 0.0
        rows.append(
            {
                "covariate": cov,
                "unit": "couple",
                "n_control": int(len(xc)),
                "n_treatment": int(len(xt)),
                "control_mean": _clean(xc.mean()) if len(xc) else None,
                "treatment_mean": _clean(xt.mean()) if len(xt) else None,
                "smd": _clean(smd),
            }
        )
    return rows


def _series(values: pd.Series, index: Any) -> list[float | None]:
    return [_clean(v) for v in values.reindex(index).to_numpy(dtype=float)]


def curves(t: Tables) -> dict[str, Any]:
    """Survival of marriages, trust band, in-conflict share and negative load by day and arm."""
    days = np.arange(t.days)
    init = t.initial
    out: dict[str, Any] = {"survival": {"day": days.tolist()}}
    for arm in ("control", "treatment"):
        sub = init[init["arm"] == arm]
        ended = np.where(
            sub["final_state"] == "divorced", sub["ended_day"].fillna(np.inf).to_numpy(dtype=float), np.inf
        )
        if len(sub):
            out["survival"][arm] = [float(np.mean(ended > d)) for d in days]
        else:
            out["survival"][arm] = [None for _ in days]
    trust: dict[str, Any] = {"day": days.tolist()}
    in_conflict: dict[str, Any] = {"day": days.tolist()}
    neg: dict[str, Any] = {"day": days.tolist()}
    d = t.daily.merge(init[["couple_id", "arm"]], on="couple_id", how="inner")
    if len(d):
        d = d.assign(trust=(d["trust_a"] + d["trust_b"]) / 2.0, neg=(d["neg_a"] + d["neg_b"]) / 2.0)
    for arm in ("control", "treatment"):
        sub = d[d["arm"] == arm] if len(d) else d
        if len(sub):
            g = sub.groupby("day")
            mean = g["trust"].mean()
            se = g["trust"].std(ddof=1).fillna(0.0) / np.sqrt(g["trust"].count().clip(lower=1))
            trust[f"{arm}_mean"] = _series(mean, days)
            trust[f"{arm}_lo"] = _series(mean - 1.96 * se, days)
            trust[f"{arm}_hi"] = _series(mean + 1.96 * se, days)
            in_conflict[arm] = _series(g["in_conflict"].mean().astype(float), days)
            neg[arm] = _series(g["neg"].mean(), days)
        else:
            trust[f"{arm}_mean"] = trust[f"{arm}_lo"] = trust[f"{arm}_hi"] = [None for _ in days]
            in_conflict[arm] = neg[arm] = [None for _ in days]
    out["trust"] = trust
    out["in_conflict"] = in_conflict
    out["neg_load"] = neg
    return out


def _hist_share(values: np.ndarray, bins: list[int]) -> list[float | None]:
    if len(values) == 0:
        return [None for _ in bins]
    capped = np.minimum(values, bins[-1])
    counts = np.array([(capped == b).sum() for b in bins], dtype=float)
    return [float(x) for x in counts / counts.sum()]


def distributions(t: Tables, df: pd.DataFrame) -> dict[str, Any]:
    """Recovery-time and conflicts-per-couple histograms as shares per arm (last bin is open)."""
    rec_bins = list(range(1, 31))
    conf_bins = list(range(0, 21))
    out: dict[str, Any] = {
        "recovery_days": {"bins": rec_bins, "last_bin_open": True},
        "conflicts_per_couple": {"bins": conf_bins, "last_bin_open": True},
    }
    rec = t.conflicts[(t.conflicts["outcome"] == "reconciled") & t.conflicts["couple_id"].isin(df.index)]
    arm_of = df["arm"]
    for arm in ("control", "treatment"):
        ids = df.index[arm_of == arm]
        r = rec[rec["couple_id"].isin(ids)]["duration_days"].to_numpy(dtype=float)
        out["recovery_days"][arm] = _hist_share(r, rec_bins)
        n = df.loc[ids, "n_conflicts"].to_numpy(dtype=float)
        out["conflicts_per_couple"][arm] = _hist_share(n, conf_bins)
    return out


# ---------------------------------------------------------------------------- summary


def arm_counts(t: Tables) -> dict[str, Any]:
    """Couples and agents per arm."""
    out = {}
    for arm in ("control", "treatment"):
        out[arm] = {
            "couples": int((t.initial["arm"] == arm).sum()),
            "agents": int((t.agents["arm"] == arm).sum()),
        }
    return out


def experiment_block(t: Tables) -> dict[str, Any]:
    """Build the `experiment` section of a summary."""
    cfg = t.config
    return {
        "name": cfg.get("name"),
        "n_couples": int(cfg["n_couples"]),
        "days": int(cfg["days"]),
        "seeds": cfg.get("seeds", {}),
        "assignment": cfg.get("assignment", {}),
        "arm_override": cfg.get("arm_override"),
        "treatment": intervention_summary(cfg),
        "shocks": shocks_summary(cfg),
        "determinism_hash": t.manifest.get("determinism_hash"),
        "engine_version": t.manifest.get("engine_version"),
    }


def build_summary(t: Tables, settings: AnalysisSettings | None = None) -> dict[str, Any]:
    """Assemble the contract's summary.json content for one results directory."""
    settings = settings or AnalysisSettings()
    df = couple_frame(t)
    bs = t.block_size
    return {
        "evidence_class": EVIDENCE_CLASS,
        "disclaimer": DISCLAIMER,
        "experiment": experiment_block(t),
        "analysis": {
            "n_boot": settings.n_boot,
            "n_perm": settings.n_perm,
            "seed": settings.seed,
            "ci_level": settings.ci_level,
            "unit": "initial couples",
            "inference_unit": f"block of {bs} couples" if bs else "couple",
            "n_clusters": int(df["cluster"].nunique()),
        },
        "arms": arm_counts(t),
        "outcomes": outcomes_table(df, settings),
        "balance": balance_table(t.agents),
        "curves": curves(t),
        "distributions": distributions(t, df),
        "governance": {"placebo": None, "twins": None},
    }


def _same_design(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return (
        a.get("seeds") == b.get("seeds") and a.get("days") == b.get("days") and a.get("n_couples") == b.get("n_couples")
    )


def sibling_dir(root: Path, name: str, kind: str) -> Path | None:
    """`<root>/<name>-<kind>` when the name is safe and the directory resolves to a direct child of root.

    Nothing read from a summary or manifest is ever used as a path: only a name, and only once it
    matches `SAFE_NAME` and lands inside the root.
    """
    if not name or not SAFE_NAME.fullmatch(name):
        return None
    root = Path(root).resolve()
    candidate = root / f"{name}-{kind}"
    if candidate.is_symlink() or not candidate.is_dir():
        return None
    if candidate.resolve().parent != root:
        return None
    return candidate


def link_governance(results_dir: Path, summary: dict[str, Any], anchor: Path | None = None) -> dict[str, Any]:
    """Attach placebo and twins summaries that sit next to `anchor` (default: the results dir).

    Candidates are derived from names only (the experiment name first, then the directory name),
    must resolve to direct children of the parent directory, and are linked only when their name,
    seeds, days and couple count match this experiment. Paths stored inside summaries are never
    followed.
    """
    base = Path(anchor) if anchor is not None else Path(results_dir)
    exp = summary.get("experiment", {})
    name = str(exp.get("name") or "")
    candidates: list[str] = []
    for n in (name, base.name):
        if n and n not in candidates:
            candidates.append(n)
    for kind in ("placebo", "twins"):
        for cand in candidates:
            sib = sibling_dir(base.parent, cand, kind)
            if sib is None:
                continue
            path = sib / "summary.json"
            if not path.is_file():
                continue
            try:
                other = json.loads(path.read_text())
            except ValueError:
                continue
            o_exp = other.get("experiment", {})
            expected = f"{name}-placebo" if kind == "placebo" else name
            if str(o_exp.get("name")) != expected or not _same_design(exp, o_exp):
                continue
            if kind == "placebo":
                summary["governance"]["placebo"] = {
                    "path": path.parent.name,
                    "treatment": o_exp.get("treatment"),
                    "outcomes": other.get("outcomes", []),
                    "determinism_hash": o_exp.get("determinism_hash"),
                }
            else:
                summary["governance"]["twins"] = {
                    "path": path.parent.name,
                    "paired": other.get("paired", []),
                    "runs": other.get("runs", {}),
                    "identical_parameters": other.get("identical_parameters"),
                    "dynamics_hashes_equal": other.get("dynamics_hashes_equal"),
                }
            break
    return summary


def write_json(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Sanitize and write JSON with NaN forbidden; return the sanitized payload."""
    clean = sanitize(payload)
    path.write_text(json.dumps(clean, indent=2, allow_nan=False))
    return dict(clean)


def write_summary(
    results_dir: str | Path, settings: AnalysisSettings | None = None, link_from: Path | None = None
) -> dict[str, Any]:
    """Analyse a results directory and write its summary.json.

    `link_from` is where the directory will finally live (the runner analyses in a staging dir),
    so governance siblings are looked up next to the final location.
    """
    d = Path(results_dir)
    t = load_tables(d)
    summary = link_governance(d, build_summary(t, settings), anchor=link_from)
    return write_json(d / "summary.json", summary)


# ---------------------------------------------------------------------------- twins


PAIRED_OUTCOMES = ("divorce_rate", "separation_rate", "days_married", "final_trust", "mean_trust", "conflict_rate")

# Tables that carry no arm label: identical across twin runs with identical parameters.
DYNAMICS_TABLES = ("events", "daily", "decisions", "conflicts")

_TWIN_SUFFIX = re.compile(r"-twins-(control|treatment)$")


def table_hashes(manifest: dict[str, Any]) -> dict[str, str]:
    """Per-table sha256 from a manifest."""
    return {name: str(info.get("sha256")) for name, info in manifest.get("files", {}).items()}


def paired_effects(
    fc: pd.DataFrame, ft: pd.DataFrame, ids: pd.Index, settings: AnalysisSettings, outcomes: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """Per-outcome mean of (ft - fc) over the couples `ids`, with a cluster bootstrap interval.

    `fc` and `ft` are couple frames of two runs of the same couples on the same seeds (twins, or a
    world and its fork). Resamples whole clusters (blocks, or single couples), and draws from one
    generator seeded by the analysis seed in outcome order, so the same inputs give the same output.
    """
    rng = np.random.default_rng(settings.seed)
    cluster = fc.loc[ids, "cluster"].to_numpy()
    out = []
    for name in outcomes or PAIRED_OUTCOMES:
        diff = ft.loc[ids, name].to_numpy(dtype=float) - fc.loc[ids, name].to_numpy(dtype=float)
        ok = ~np.isnan(diff)
        diff, cl = diff[ok], cluster[ok]
        n = len(diff)
        mean = float(diff.mean()) if n else math.nan
        lo = hi = math.nan
        if n and settings.n_boot > 0:
            frame = pd.DataFrame({"d": diff, "c": cl}).groupby("c").agg(s=("d", "sum"), k=("d", "size"))
            s, k = frame["s"].to_numpy(dtype=float), frame["k"].to_numpy(dtype=float)
            idx = rng.integers(0, len(s), size=(settings.n_boot, len(s)))
            boots = s[idx].sum(axis=1) / k[idx].sum(axis=1)
            alpha = 1.0 - settings.ci_level
            lo, hi = (float(x) for x in np.percentile(boots, [100 * alpha / 2, 100 * (1 - alpha / 2)]))
        out.append(
            {
                "name": name,
                "mean_diff": _clean(mean),
                "ci_low": _clean(lo),
                "ci_high": _clean(hi),
                "n_pairs": int(n),
                "share_changed": _clean(float(np.mean(diff != 0))) if n else None,
            }
        )
    return out


def twins_summary(twins_dir: str | Path, settings: AnalysisSettings | None = None) -> dict[str, Any]:
    """Paired per-couple effects from a control run and a treatment run on identical seeds."""
    settings = settings or AnalysisSettings()
    d = Path(twins_dir)
    tc = load_tables(d / "control")
    tt = load_tables(d / "treatment")
    fc = couple_frame(tc)
    ft = couple_frame(tt)
    ids = fc.index.intersection(ft.index)
    paired = paired_effects(fc, ft, ids, settings)
    identical = tc.config["memory"]["treatment"] == tc.config["memory"]["control"] and not any(
        s.get("target") == "treatment" for s in shocks_summary(tt.config)
    )
    hc, ht = table_hashes(tc.manifest), table_hashes(tt.manifest)
    dyn_equal = all(hc.get(f"{n}.parquet") == ht.get(f"{n}.parquet") for n in DYNAMICS_TABLES)
    hashes = {
        "control": {"determinism_hash": tc.manifest.get("determinism_hash"), "tables": hc},
        "treatment": {"determinism_hash": tt.manifest.get("determinism_hash"), "tables": ht},
    }
    base_name = _TWIN_SUFFIX.sub("", str(tc.config.get("name") or ""))
    exp = experiment_block(tt)
    exp["name"] = base_name
    exp["arm_override"] = None
    summary = {
        "evidence_class": EVIDENCE_CLASS,
        "disclaimer": DISCLAIMER,
        "design": "twins: every couple simulated under both arms on identical seeds (common random numbers)",
        "experiment": exp,
        "analysis": {
            "n_boot": settings.n_boot,
            "seed": settings.seed,
            "ci_level": settings.ci_level,
            "unit": "couple pairs",
            "inference_unit": f"block of {tc.block_size} couples" if tc.block_size else "couple",
        },
        "paired": paired,
        "runs": hashes,
        "identical_parameters": bool(identical),
        "dynamics_tables": list(DYNAMICS_TABLES),
        "dynamics_hashes_equal": bool(dyn_equal),
    }
    return write_json(d / "summary.json", summary)
