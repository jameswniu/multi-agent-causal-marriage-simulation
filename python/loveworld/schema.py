"""Shared constants: outcome names, event kinds, relationship states, tables, shock catalog."""

from __future__ import annotations

import re
from typing import Any

EVIDENCE_CLASS = "simulation"
DISCLAIMER = (
    "Findings describe simulated agents under an explicit rule-based policy; "
    "they are not evidence about human relationships."
)

TABLES = (
    "agents",
    "couples",
    "events",
    "daily",
    "decisions",
    "interventions",
    "conflicts",
)

# Written by newer engines; tolerated when absent.
OPTIONAL_TABLES = ("episodes",)

EPISODE_COLUMNS = ("day", "couple_id", "agent_id", "partner_id", "kind", "intensity", "source", "amplified")

STATES = ("dating", "married", "separated", "divorced", "broken_up")

EVENT_KINDS = (
    "intervention_applied",
    "outside_encounter",
    "conflict_started",
    "escalated",
    "withdrew",
    "repair_attempted",
    "repair_rejected",
    "reconciled",
    "conflict_faded",
    "separated",
    "reunited",
    "divorced",
    "broke_up",
    "matched",
    "married",
    "disappointed",
)

CONFLICT_OUTCOMES = ("reconciled", "faded", "separated", "breakup", "open_at_end")

ARMS = ("control", "treatment")

# Outcome names in report order. Conditional outcomes are computed on post-treatment
# populations (conflicts that happened, agents who divorced) and are flagged as such.
OUTCOMES: tuple[tuple[str, str, str, str, bool], ...] = (
    # name, label, unit, type, conditional_on_post_treatment
    ("divorce_rate", "Divorced within the window", "share of couples", "binary", False),
    ("separation_rate", "Separated at least once", "share of couples", "binary", False),
    ("days_married", "Days married until divorce or end", "days", "continuous", False),
    ("final_trust", "Trust on the couple's last day", "trust (0 to 1)", "continuous", False),
    ("mean_trust", "Mean trust over couple-days", "trust (0 to 1)", "continuous", False),
    ("conflict_rate", "Conflicts per couple-year", "conflicts per year", "continuous", False),
    ("escalations_per_conflict", "Escalations per conflict", "escalations", "continuous", True),
    ("reconciliation_rate", "Conflicts ending in reconciliation", "share of closed conflicts", "binary", True),
    ("recovery_days", "Days from conflict onset to reconciliation", "days", "continuous", True),
    ("remarriage_rate", "Divorced agents who remarried", "share of divorced agents", "binary", True),
)

OUTCOME_NAMES = tuple(o[0] for o in OUTCOMES)

BALANCE_COVARIATES = (
    "neuroticism",
    "agreeableness",
    "conscientiousness",
    "openness",
    "extraversion",
    "forgiveness",
    "commitment",
    "closeness_pref",
    "conflict_engagement",
    "base_trust",
    "prior_divorces",
    "years_married",
)

MEMORY_PARAMS = ("conflict_half_life_days", "repair_half_life_days", "positive_half_life_days", "load_saturation")

# Experiment YAML vocabulary (every other key raises).
EXPERIMENT_KEYS = ("name", "n_couples", "days", "seeds", "treatment", "control", "world", "engine", "analysis")
SEED_KEYS = ("population", "assignment", "dynamics")
ANALYSIS_KEYS = ("n_boot", "n_perm", "seed", "ci_level")
SHOCK_KEYS = ("kind", "member", "start_day", "end_day", "magnitude", "trait")
SHOCK_MEMBERS = ("a", "b", "random")
SHOCK_TARGETS = ("treatment", "control", "all")

# Results directory names: letters, digits, dash and underscore only.
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

# On-demand run bounds (section 6 of the contract).
MAX_COUPLES = 2000
MAX_DAYS = 730
MAX_RESAMPLES = 500

SHIFTABLE_TRAITS = (
    "neuroticism",
    "agreeableness",
    "conscientiousness",
    "openness",
    "extraversion",
    "forgiveness",
    "commitment",
    "closeness_pref",
    "conflict_engagement",
)


def _kind(
    kind: str,
    label: str,
    blurb: str,
    member_applies: bool,
    lo: float,
    hi: float,
    default: float,
    unit: str,
    default_start_day: int,
    default_length_days: int | None,
    traits: tuple[str, ...] = (),
) -> dict[str, Any]:
    end = default_start_day + default_length_days if default_length_days is not None else None
    return {
        "kind": kind,
        "label": label,
        "blurb": blurb,
        "member_applies": member_applies,
        "magnitude": {"min": lo, "max": hi, "default": default, "unit": unit},
        "default_start_day": default_start_day,
        "default_length_days": default_length_days,
        "default_end_day": end,
        "traits": list(traits),
    }


# Bounds, defaults and default lengths mirror `loveworld-engine shock-catalog`; a test pins them.
SHOCK_CATALOG: tuple[dict[str, Any], ...] = (
    _kind(
        "job_loss",
        "Job loss",
        "One partner loses their job: a stress jump on the start day, then extra daily stress until the end day.",
        True,
        0.0,
        5.0,
        1.5,
        "stress",
        90,
        120,
    ),
    _kind(
        "financial_crisis",
        "Financial crisis",
        "Money trouble for the household: both partners carry extra daily stress between the start and end days.",
        False,
        0.0,
        5.0,
        1.0,
        "stress",
        90,
        120,
    ),
    _kind(
        "temptation",
        "Temptation",
        "One partner keeps meeting attractive alternatives: a higher daily chance of an outside encounter.",
        True,
        0.0,
        1.0,
        0.2,
        "daily probability",
        90,
        120,
    ),
    _kind(
        "intimacy_mismatch",
        "Intimacy mismatch",
        "One partner's wish for closeness shifts; the gap drags on affect and the partner wanting more "
        "may store disappointment.",
        True,
        -1.0,
        1.0,
        0.4,
        "closeness shift",
        90,
        None,
    ),
    _kind(
        "daily_texts",
        "Daily texts",
        "One partner sends affection every day: the other stores a small positive memory and a lift in affect.",
        True,
        0.0,
        5.0,
        1.0,
        "intensity multiplier",
        30,
        None,
    ),
    _kind(
        "anniversary",
        "Anniversary",
        "On the start day and every 365 days after, both partners store a strong positive memory and trust rises.",
        False,
        0.0,
        2.0,
        1.0,
        "intensity multiplier",
        180,
        None,
    ),
    _kind(
        "date_nights",
        "Date nights",
        "Every seventh day between the start and end days, both partners store a positive memory.",
        False,
        0.0,
        2.0,
        1.0,
        "intensity multiplier",
        30,
        None,
    ),
    _kind(
        "trait_shift",
        "Trait shift",
        "One partner's named trait moves by the magnitude on the start day (clamped to 0 to 1).",
        True,
        -1.0,
        1.0,
        0.3,
        "trait shift",
        90,
        None,
        SHIFTABLE_TRAITS,
    ),
)

SHOCK_KINDS = {s["kind"]: s for s in SHOCK_CATALOG}
