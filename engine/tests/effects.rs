//! Shocks as effect lists: the eight named kinds against their effect lists, identity amounts,
//! what each channel moves, cadences and windows, logging, the placebo and replay.

use loveworld_engine::config::{
    builtin_effects, Arm, Cadence, EffectChannel, EffectConfig, EffectOp, EffectWho, ShockConfig,
    ShockKind, ShockMember, ShockTarget, SimConfig,
};
use loveworld_engine::log::{ConflictRow, DailyRow, DecisionRow, LegacyRow, Logs};
use loveworld_engine::sim;

const DAYS: u32 = 400;

fn base() -> SimConfig {
    SimConfig {
        name: "effects".to_string(),
        n_couples: 120,
        days: DAYS,
        ..SimConfig::default()
    }
}

fn with(shocks: Vec<ShockConfig>) -> SimConfig {
    let cfg = SimConfig { shocks, ..base() };
    cfg.validate().expect("test config validates");
    cfg
}

fn eff(channel: EffectChannel, amount: f64, cadence: Cadence, who: EffectWho) -> EffectConfig {
    EffectConfig {
        channel,
        op: channel.op(),
        amount,
        cadence,
        who,
        class: None,
        trait_name: None,
        start_day: None,
        end_day: None,
    }
}

fn episode(class: &str, amount: f64, cadence: Cadence, who: EffectWho) -> EffectConfig {
    EffectConfig {
        class: Some(class.to_string()),
        ..eff(EffectChannel::Episode, amount, cadence, who)
    }
}

fn shift(name: &str, amount: f64, cadence: Cadence, who: EffectWho) -> EffectConfig {
    EffectConfig {
        trait_name: Some(name.to_string()),
        ..eff(EffectChannel::Trait, amount, cadence, who)
    }
}

fn custom(label: &str, start: u32, end: Option<u32>, effects: Vec<EffectConfig>) -> ShockConfig {
    ShockConfig {
        kind: ShockKind::Custom,
        target: ShockTarget::All,
        member: ShockMember::Random,
        start_day: start,
        end_day: end,
        magnitude: None,
        trait_name: None,
        label: Some(label.to_string()),
        description: Some(format!("{label}, a test shock")),
        effects: Some(effects),
    }
}

type EpisodeKey = (i32, i64, i64, i64, &'static str, u64, bool);

/// Behavioural rows of one run.
type Behaviour = (
    Vec<DailyRow>,
    Vec<DecisionRow>,
    Vec<ConflictRow>,
    Vec<LegacyRow>,
    Vec<EpisodeKey>,
);

/// Every behavioural row, with episodes keyed without their source (the one column a custom twin
/// of a named kind renames).
fn behaviour(l: &Logs) -> Behaviour {
    (
        l.daily.clone(),
        l.decisions.clone(),
        l.conflicts.clone(),
        l.legacies.clone(),
        l.episodes
            .iter()
            .map(|e| {
                (
                    e.day,
                    e.couple_id,
                    e.agent_id,
                    e.partner_id,
                    e.kind,
                    e.intensity.to_bits(),
                    e.amplified,
                )
            })
            .collect(),
    )
}

#[test]
fn every_named_kind_behaves_exactly_like_its_effect_list() {
    for kind in ShockKind::all() {
        let (lo, hi, default, _) = kind.bounds();
        for m in [default, hi, lo] {
            let trait_name = (kind == ShockKind::TraitShift).then(|| "commitment".to_string());
            let named = ShockConfig {
                kind,
                target: ShockTarget::All,
                member: ShockMember::Random,
                start_day: 15,
                end_day: None,
                magnitude: Some(m),
                trait_name: trait_name.clone(),
                label: None,
                description: None,
                effects: None,
            };
            let last = named.last_day(DAYS) as u32;
            let twin = custom(
                kind.as_str(),
                15,
                Some(last),
                builtin_effects(kind, m, trait_name.as_deref()),
            );
            let a = sim::run(&with(vec![named]));
            let b = sim::run(&with(vec![twin]));
            assert!(
                behaviour(&a.logs) == behaviour(&b.logs),
                "{kind:?} at magnitude {m} differs from its effect list"
            );
            assert_eq!(a.couples, b.couples, "{kind:?} at {m}: couples differ");
            assert_eq!(a.agents, b.agents, "{kind:?} at {m}: agents differ");
        }
    }
}

#[test]
fn identity_amounts_leave_every_behavioural_row_unchanged() {
    let nothing = custom(
        "nothing at all",
        10,
        Some(300),
        vec![
            eff(EffectChannel::Stress, 0.0, Cadence::Once, EffectWho::Member),
            eff(EffectChannel::Stress, 0.0, Cadence::Daily, EffectWho::Both),
            eff(
                EffectChannel::Affect,
                0.0,
                Cadence::Daily,
                EffectWho::Partner,
            ),
            eff(EffectChannel::Trust, 0.0, Cadence::Yearly, EffectWho::Both),
            episode("conflict", 0.0, Cadence::Weekly, EffectWho::Both),
            eff(
                EffectChannel::Outside,
                0.0,
                Cadence::Daily,
                EffectWho::Member,
            ),
            eff(
                EffectChannel::OnsetHazard,
                1.0,
                Cadence::Daily,
                EffectWho::Both,
            ),
            eff(
                EffectChannel::RepairPropensity,
                1.0,
                Cadence::Daily,
                EffectWho::Both,
            ),
        ],
    );
    let still_nothing = ShockConfig {
        target: ShockTarget::Treatment,
        member: ShockMember::A,
        ..custom(
            "still nothing",
            30,
            None,
            vec![
                shift("neuroticism", 0.0, Cadence::Once, EffectWho::Member),
                shift("commitment", 0.0, Cadence::Yearly, EffectWho::Both),
                episode("positive", 0.0, Cadence::Daily, EffectWho::Partner),
            ],
        )
    };
    let none = sim::run(&base());
    let zero = sim::run(&with(vec![nothing, still_nothing]));
    assert!(behaviour(&none.logs) == behaviour(&zero.logs));
    assert_eq!(none.logs.episodes, zero.logs.episodes);
    assert_eq!(none.couples, zero.couples);
    // The shocks still log that they started.
    assert!(zero.logs.interventions.len() > none.logs.interventions.len());
    // A named kind at magnitude 0 does nothing either.
    for kind in ShockKind::all() {
        let s = ShockConfig {
            kind,
            target: ShockTarget::All,
            member: ShockMember::Random,
            start_day: 5,
            end_day: None,
            magnitude: Some(0.0),
            trait_name: (kind == ShockKind::TraitShift).then(|| "openness".to_string()),
            label: None,
            description: None,
            effects: None,
        };
        let r = sim::run(&with(vec![s]));
        assert!(
            behaviour(&none.logs) == behaviour(&r.logs),
            "{kind:?} at magnitude 0 changed behaviour"
        );
    }
}

fn mean<T>(rows: &[T], f: impl Fn(&T) -> Option<f64>) -> f64 {
    let v: Vec<f64> = rows.iter().filter_map(f).collect();
    v.iter().sum::<f64>() / v.len().max(1) as f64
}

fn daily_mean(r: &sim::SimResult, from: i32, to: i32, f: impl Fn(&DailyRow) -> f64) -> f64 {
    mean(&r.logs.daily, |d| {
        (d.day >= from && d.day <= to && (d.state == "married" || d.state == "dating"))
            .then(|| f(d))
    })
}

#[test]
fn each_channel_moves_what_it_names() {
    let none = sim::run(&base());
    let run =
        |effects: Vec<EffectConfig>| sim::run(&with(vec![custom("probe", 50, Some(200), effects)]));

    let s = run(vec![eff(
        EffectChannel::Stress,
        2.0,
        Cadence::Once,
        EffectWho::Both,
    )]);
    assert!(
        daily_mean(&s, 50, 50, |d| d.stress_a + d.stress_b)
            > daily_mean(&none, 50, 50, |d| d.stress_a + d.stress_b) + 1.0
    );

    let s = run(vec![eff(
        EffectChannel::Stress,
        0.5,
        Cadence::Daily,
        EffectWho::Both,
    )]);
    assert!(
        daily_mean(&s, 60, 200, |d| d.stress_a) > daily_mean(&none, 60, 200, |d| d.stress_a) + 0.2
    );

    let s = run(vec![eff(
        EffectChannel::Affect,
        -0.08,
        Cadence::Daily,
        EffectWho::Both,
    )]);
    assert!(daily_mean(&s, 60, 200, |d| d.affect_a) < daily_mean(&none, 60, 200, |d| d.affect_a));

    let s = run(vec![eff(
        EffectChannel::Trust,
        -0.3,
        Cadence::Once,
        EffectWho::Both,
    )]);
    assert!(daily_mean(&s, 50, 50, |d| d.trust_a) < daily_mean(&none, 50, 50, |d| d.trust_a) - 0.1);

    let s = run(vec![episode(
        "conflict",
        0.6,
        Cadence::Weekly,
        EffectWho::Both,
    )]);
    assert!(daily_mean(&s, 60, 200, |d| d.neg_a) > daily_mean(&none, 60, 200, |d| d.neg_a));

    let s = run(vec![episode(
        "positive",
        0.6,
        Cadence::Weekly,
        EffectWho::Both,
    )]);
    assert!(daily_mean(&s, 60, 200, |d| d.pos_a) > daily_mean(&none, 60, 200, |d| d.pos_a));

    let encounters = |r: &sim::SimResult| {
        r.logs
            .events
            .iter()
            .filter(|e| e.kind == "outside_encounter")
            .count()
    };
    let s = run(vec![eff(
        EffectChannel::Outside,
        0.5,
        Cadence::Daily,
        EffectWho::Both,
    )]);
    assert!(encounters(&s) > 2 * encounters(&none) + 10);

    let starts = |r: &sim::SimResult| {
        r.logs
            .conflicts
            .iter()
            .filter(|c| c.started_day >= 50 && c.started_day <= 200)
            .count()
    };
    let s = run(vec![eff(
        EffectChannel::OnsetHazard,
        3.0,
        Cadence::Daily,
        EffectWho::Both,
    )]);
    assert!(
        starts(&s) as f64 > 1.5 * starts(&none) as f64,
        "{} vs {}",
        starts(&s),
        starts(&none)
    );
    let s = run(vec![eff(
        EffectChannel::OnsetHazard,
        0.0,
        Cadence::Daily,
        EffectWho::Both,
    )]);
    assert_eq!(
        starts(&s),
        0,
        "a zero multiplier stops every new fight in the window"
    );

    let repair_share = |r: &sim::SimResult| {
        let c: Vec<&DecisionRow> = r
            .logs
            .decisions
            .iter()
            .filter(|d| d.context == "conflict" && d.day >= 50 && d.day <= 200)
            .collect();
        c.iter().filter(|d| d.action == "repair").count() as f64 / c.len().max(1) as f64
    };
    let s = run(vec![eff(
        EffectChannel::RepairPropensity,
        6.0,
        Cadence::Daily,
        EffectWho::Both,
    )]);
    assert!(
        repair_share(&s) > repair_share(&none) + 0.1,
        "{} vs {}",
        repair_share(&s),
        repair_share(&none)
    );

    let s = run(vec![shift(
        "neuroticism",
        0.6,
        Cadence::Once,
        EffectWho::Both,
    )]);
    assert!(daily_mean(&s, 80, 200, |d| d.stress_a) > daily_mean(&none, 80, 200, |d| d.stress_a));
}

#[test]
fn cadences_and_windows_pick_the_right_days() {
    let src = "shock:custom:calendar";
    let r = sim::run(&with(vec![custom(
        "calendar",
        20,
        Some(399),
        vec![
            EffectConfig {
                end_day: Some(80),
                ..episode("positive", 0.2, Cadence::Weekly, EffectWho::Both)
            },
            episode("repair", 0.3, Cadence::Yearly, EffectWho::Member),
            episode("disappointment", 0.1, Cadence::Once, EffectWho::Partner),
            EffectConfig {
                start_day: Some(30),
                end_day: Some(40),
                ..episode("conflict", 0.05, Cadence::Daily, EffectWho::Member)
            },
        ],
    )]));
    let rows: Vec<_> = r.logs.episodes.iter().filter(|e| e.source == src).collect();
    let days = |kind: &str| {
        rows.iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.day)
            .collect::<Vec<_>>()
    };
    let weekly = days("positive");
    assert!(
        !weekly.is_empty()
            && weekly
                .iter()
                .all(|d| (20..=80).contains(d) && (d - 20) % 7 == 0)
    );
    assert!(weekly.contains(&20) && weekly.contains(&76));
    let yearly = days("reconciliation");
    assert!(yearly.iter().all(|d| *d == 20 || *d == 385));
    assert!(yearly.contains(&20) && yearly.contains(&385));
    let daily = days("conflict");
    assert!(!daily.is_empty() && daily.iter().all(|d| (30..=40).contains(d)));
    // Once: at most one row per agent in each couple (a remarried agent meets the shock afresh).
    let mut once: Vec<(i64, i64)> = rows
        .iter()
        .filter(|e| e.kind == "disappointment")
        .map(|e| (e.couple_id, e.agent_id))
        .collect();
    let n = once.len();
    once.sort();
    once.dedup();
    assert!(n > 0, "the once effect never fired");
    assert_eq!(
        once.len(),
        n,
        "a once effect fired twice for one agent in one couple"
    );
}

#[test]
fn custom_shocks_log_their_start_their_later_firings_and_their_memories() {
    let r = sim::run(&with(vec![custom(
        "Visiting in-laws",
        30,
        Some(120),
        vec![
            eff(EffectChannel::Stress, 0.3, Cadence::Daily, EffectWho::Both),
            episode("conflict", 0.4, Cadence::Weekly, EffectWho::Member),
        ],
    )]));
    let params: Vec<&str> = r
        .logs
        .interventions
        .iter()
        .map(|i| i.parameter)
        .filter(|p| p.starts_with("custom:"))
        .collect();
    assert!(params.contains(&"custom:visiting_in_laws:stress"));
    assert!(params.contains(&"custom:visiting_in_laws:episode:conflict"));
    let starts: Vec<_> = r
        .logs
        .events
        .iter()
        .filter(|e| e.kind == "shock_custom:visiting_in_laws" && e.agent_id.is_some())
        .collect();
    assert!(!starts.is_empty() && starts.iter().all(|e| e.day >= 30));
    let later: Vec<_> = r
        .logs
        .events
        .iter()
        .filter(|e| e.kind == "shock_custom:visiting_in_laws" && e.agent_id.is_none())
        .collect();
    assert!(
        !later.is_empty()
            && later
                .iter()
                .all(|e| (e.day - 30) % 7 == 0 && e.value == Some(0.4))
    );
    assert!(r
        .logs
        .episodes
        .iter()
        .any(|e| e.source == "shock:custom:visiting_in_laws" && e.kind == "conflict"));
    // The stress input is a standing modifier, so it logs no daily event of its own.
    assert!(later.iter().all(|e| e.value != Some(0.3)));
}

#[test]
fn an_effect_with_a_later_window_logs_its_start_on_its_own_first_day() {
    let late = EffectConfig {
        start_day: Some(50),
        end_day: Some(90),
        ..eff(
            EffectChannel::Affect,
            -0.05,
            Cadence::Daily,
            EffectWho::Both,
        )
    };
    let r = sim::run(&with(vec![custom(
        "Staggered",
        30,
        Some(120),
        vec![
            eff(EffectChannel::Stress, 0.3, Cadence::Daily, EffectWho::Both),
            late,
        ],
    )]));
    let days_of = |param: &str| -> Vec<i32> {
        r.logs
            .interventions
            .iter()
            .filter(|i| i.parameter == param)
            .map(|i| i.day)
            .collect()
    };
    let stress = days_of("custom:staggered:stress");
    let affect = days_of("custom:staggered:affect");
    assert!(stress.contains(&30) && stress.iter().all(|d| (30..=120).contains(d)));
    assert!(
        affect.contains(&50),
        "the late effect logged no start on day 50"
    );
    assert!(
        affect.iter().all(|d| (50..=90).contains(d)),
        "the late effect logged a start outside its own window: {affect:?}"
    );
    // One start row per agent per couple for each effect.
    let mut rows: Vec<(i64, i64, &str)> = r
        .logs
        .interventions
        .iter()
        .filter(|i| i.parameter.starts_with("custom:staggered:"))
        .map(|i| (i.couple_id, i.agent_id, i.parameter))
        .collect();
    let n = rows.len();
    rows.sort();
    rows.dedup();
    assert_eq!(rows.len(), n, "an effect logged its start twice");
    // Each start is also an agent event, on the day of the effects it counts.
    let events: Vec<i32> = r
        .logs
        .events
        .iter()
        .filter(|e| e.kind == "shock_custom:staggered" && e.agent_id.is_some())
        .map(|e| e.day)
        .collect();
    assert!(events.contains(&30) && events.contains(&50));
}

#[test]
fn custom_placebo_twins_are_identical_and_custom_runs_replay() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = with(vec![custom(
        "everyone's bad year",
        10,
        Some(300),
        vec![
            eff(EffectChannel::Stress, 0.4, Cadence::Daily, EffectWho::Both),
            eff(
                EffectChannel::OnsetHazard,
                1.5,
                Cadence::Daily,
                EffectWho::Both,
            ),
            eff(
                EffectChannel::RepairPropensity,
                0.5,
                Cadence::Daily,
                EffectWho::Member,
            ),
        ],
    )]);
    cfg.n_couples = 40;
    cfg.days = 320;
    cfg.memory.treatment = cfg.memory.control.clone();
    let mut ctrl = cfg.clone();
    ctrl.arm_override = Some(Arm::Control);
    let mut treat = cfg.clone();
    treat.arm_override = Some(Arm::Treatment);
    let a = sim::run_to_dir(&ctrl, &dir.path().join("c"), false).unwrap();
    let b = sim::run_to_dir(&treat, &dir.path().join("t"), false).unwrap();
    for f in [
        "events.parquet",
        "daily.parquet",
        "decisions.parquet",
        "conflicts.parquet",
        "episodes.parquet",
        "legacies.parquet",
    ] {
        assert_eq!(
            a["files"][f]["sha256"], b["files"][f]["sha256"],
            "{f} differs between placebo twins"
        );
    }
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_loveworld-engine"))
        .args(["replay", "--manifest"])
        .arg(dir.path().join("c").join("manifest.json"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "replay of a custom-shock run failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn effects_never_reach_what_they_must_not() {
    // The channel set is closed: none of them names memory, rules, the gate, policy, assignment,
    // seeds or the arm, and the op of each is fixed.
    for c in EffectChannel::all() {
        let name = c.as_str();
        for banned in [
            "half_life",
            "memory_rules",
            "leave",
            "policy",
            "weight",
            "temperature",
            "assign",
            "seed",
            "arm",
        ] {
            assert!(!name.contains(banned), "{name} must not reach {banned}");
        }
        let ok = match c {
            EffectChannel::OnsetHazard | EffectChannel::RepairPropensity => EffectOp::Multiply,
            _ => EffectOp::Add,
        };
        assert_eq!(c.op(), ok);
    }
    let src = include_str!("../src/systems.rs");
    let start = src.find("fn apply_effect(").unwrap();
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    for banned in [
        "MemoryParams",
        "memory.params",
        "PolicyConfig",
        "Arm::",
        "association",
        "temperature",
    ] {
        assert!(
            !body.contains(banned),
            "apply_effect must not touch {banned}"
        );
    }
}
