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
OPTIONAL_TABLES = ("episodes", "legacies")

EPISODE_COLUMNS = ("day", "couple_id", "agent_id", "partner_id", "kind", "intensity", "source", "amplified")

# One row per agent per divorce: the sealed record of the marriage that just ended.
LEGACY_COLUMNS = (
    "day",
    "couple_id",
    "agent_id",
    "partner_id",
    "ended_by",
    "conflicts",
    "reconciled",
    "final_trust",
    "final_neg_load",
    "final_pos_load",
    "match_quality",
    "commitment_shift",
    "trust_prior",
)

OPTIONAL_COLUMNS: dict[str, tuple[str, ...]] = {"episodes": EPISODE_COLUMNS, "legacies": LEGACY_COLUMNS}

# Daily columns added by newer engines, with the value an older run implies.
DAILY_OPTIONAL_DEFAULTS: dict[str, Any] = {"orphan_days": 0}

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
    "sealed",
    "memory_consolidated",
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
SHOCK_KEYS = ("kind", "member", "start_day", "end_day", "magnitude", "trait", "label", "description", "effects")
SHOCK_MEMBERS = ("a", "b", "random")
SHOCK_TARGETS = ("treatment", "control", "all")

# Results directory names: letters, digits, dash and underscore only.
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

# On-demand run bounds, as set out in section 6 of docs/contracts.md (the interface contract between
# the engine, this package and the dashboard).
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


# Bounds, defaults and default lengths match the shock catalog that the simulation engine prints
# (the Rust binary, `loveworld-engine shock-catalog`), and a test pins them.
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


# Custom shocks: effect channels, matching the engine's effect catalog
# (`loveworld-engine effect-catalog`), and a test holds the two to byte equality.
MAX_EFFECTS = 8
LABEL_MAX_CHARS = 40
DESCRIPTION_MAX_CHARS = 240
EFFECT_CADENCES = ("once", "daily", "weekly", "yearly")
EFFECT_WHO = ("member", "partner", "both")
EFFECT_EPISODE_CLASSES = ("positive", "conflict", "repair", "disappointment")
EFFECT_KEYS = ("channel", "op", "amount", "cadence", "who", "class", "trait", "start_day", "end_day")
CUSTOM_SHOCK_KEYS = ("label", "description", "effects")

# channel -> (op, identity, {cadence: (min, max, sustained)}, who, classes, traits, description)
EFFECT_CHANNELS: dict[str, dict[str, Any]] = {
    "stress": {
        "op": "add",
        "identity": 0.0,
        "cadences": {
            "daily": (-1.5, 1.5, True),
            "once": (-3.0, 5.0, False),
            "weekly": (-3.0, 5.0, False),
            "yearly": (-3.0, 5.0, False),
        },
        "who": ("member", "partner", "both"),
        "classes": (),
        "traits": (),
        "description": (
            "Stress level, 0 to 3. Once, weekly or yearly: added to the level on each day it acts. "
            "Daily: a standing daily stress input for the window, so stress settles higher rather "
            "than climbing without limit."
        ),
    },
    "affect": {
        "op": "add",
        "identity": 0.0,
        "cadences": {
            "daily": (-0.1, 0.1, False),
            "once": (-1.0, 1.0, False),
            "weekly": (-0.5, 0.5, False),
            "yearly": (-1.0, 1.0, False),
        },
        "who": ("member", "partner", "both"),
        "classes": (),
        "traits": (),
        "description": ("Mood toward the partner, -1 to 1, added on each day the effect acts."),
    },
    "trust": {
        "op": "add",
        "identity": 0.0,
        "cadences": {
            "daily": (-0.02, 0.02, False),
            "once": (-0.5, 0.5, False),
            "weekly": (-0.1, 0.1, False),
            "yearly": (-0.5, 0.5, False),
        },
        "who": ("member", "partner", "both"),
        "classes": (),
        "traits": (),
        "description": ("Trust in the partner, 0 to 1, added on each day the effect acts."),
    },
    "episode": {
        "op": "add",
        "identity": 0.0,
        "cadences": {
            "daily": (0.0, 0.25, False),
            "once": (0.0, 2.0, False),
            "weekly": (0.0, 1.0, False),
            "yearly": (0.0, 2.0, False),
        },
        "who": ("member", "partner", "both"),
        "classes": EFFECT_EPISODE_CLASSES,
        "traits": (),
        "description": (
            "Stores a memory about the partner of the given class and intensity on each day the "
            "effect acts. Memories fade on the agent's own half-lives."
        ),
    },
    "outside": {
        "op": "add",
        "identity": 0.0,
        "cadences": {"daily": (0.0, 1.0, True)},
        "who": ("member", "partner", "both"),
        "classes": (),
        "traits": (),
        "description": (
            "Daily chance of meeting an attractive alternative while the window lasts (the strongest "
            "active value wins)."
        ),
    },
    "onset_hazard": {
        "op": "multiply",
        "identity": 1.0,
        "cadences": {"daily": (0.0, 5.0, True)},
        "who": ("both",),
        "classes": (),
        "traits": (),
        "description": (
            "Multiplies the couple's daily chance that a fight starts while the window lasts. Acts on "
            "the couple, so it always hits both."
        ),
    },
    "repair_propensity": {
        "op": "multiply",
        "identity": 1.0,
        "cadences": {"daily": (0.1, 10.0, True)},
        "who": ("member", "partner", "both"),
        "classes": (),
        "traits": (),
        "description": (
            "Multiplies the odds that the agent chooses to repair, or to reunite when separated, "
            "while the window lasts."
        ),
    },
    "trait": {
        "op": "add",
        "identity": 0.0,
        "cadences": {"once": (-1.0, 1.0, False), "yearly": (-0.25, 0.25, False)},
        "who": ("member", "partner", "both"),
        "classes": (),
        "traits": SHIFTABLE_TRAITS,
        "description": ("Shifts a personality trait or preference (0 to 1) on each day the effect acts."),
    },
}


def builtin_effects(kind: str, m: float, trait: str | None = None) -> list[dict[str, Any]]:
    """Return the effect list a named kind stands for at magnitude `m` (the engine's `builtin_effects`)."""

    def eff(channel: str, amount: float, cadence: str, who: str, **extra: str) -> dict[str, Any]:
        out: dict[str, Any] = {
            "channel": channel,
            "op": EFFECT_CHANNELS[channel]["op"],
            "amount": amount,
            "cadence": cadence,
            "who": who,
        }
        out.update(extra)
        return out

    if kind == "job_loss":
        return [eff("stress", m, "once", "member"), eff("stress", 0.1 * m, "daily", "member")]
    if kind == "financial_crisis":
        return [eff("stress", 0.3 * m, "daily", "both")]
    if kind == "temptation":
        return [eff("outside", m, "daily", "member")]
    if kind == "intimacy_mismatch":
        return [eff("trait", m, "once", "member", trait="closeness_pref")]
    if kind == "trait_shift":
        return [eff("trait", m, "once", "member", trait=trait or "conflict_engagement")]
    if kind == "daily_texts":
        return [
            eff("episode", 0.05 * m, "daily", "partner", **{"class": "positive"}),
            eff("affect", 0.02 * m, "daily", "partner"),
        ]
    if kind == "anniversary":
        return [
            eff("episode", 0.5 * m, "yearly", "both", **{"class": "positive"}),
            eff("trust", 0.02 * m, "yearly", "both"),
        ]
    if kind == "date_nights":
        return [eff("episode", 0.15 * m, "weekly", "both", **{"class": "positive"})]
    return []


def effect_catalog() -> dict[str, Any]:
    """Return the engine's effect catalog, built from this module's copy (a test compares the two)."""
    channels = []
    for name, c in EFFECT_CHANNELS.items():
        channels.append(
            {
                "channel": name,
                "op": c["op"],
                "identity": c["identity"],
                "cadences": {k: {"min": lo, "max": hi, "sustained": sus} for k, (lo, hi, sus) in c["cadences"].items()},
                "who": list(c["who"]),
                "classes": list(c["classes"]),
                "traits": list(c["traits"]),
                "description": c["description"],
            }
        )
    builtin = {
        s["kind"]: builtin_effects(
            s["kind"], s["magnitude"]["default"], "neuroticism" if s["kind"] == "trait_shift" else None
        )
        for s in SHOCK_CATALOG
    }
    return {
        "channels": channels,
        "max_effects": MAX_EFFECTS,
        "label_max_chars": LABEL_MAX_CHARS,
        "description_max_chars": DESCRIPTION_MAX_CHARS,
        "builtin_at_default_magnitude": builtin,
    }
