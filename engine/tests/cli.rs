//! Integration tests through the public library API and the compiled binary.

use loveworld_engine::config::{Arm, SimConfig};
use loveworld_engine::sim;
use std::path::Path;
use std::process::Command;

fn small(name: &str) -> SimConfig {
    SimConfig {
        name: name.to_string(),
        n_couples: 30,
        days: 45,
        ..SimConfig::default()
    }
}

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_loveworld-engine")
}

#[test]
fn run_to_dir_writes_every_table_and_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("r");
    let m = sim::run_to_dir(&small("t"), &out, false).unwrap();
    for f in [
        "agents.parquet",
        "couples.parquet",
        "events.parquet",
        "daily.parquet",
        "decisions.parquet",
        "interventions.parquet",
        "conflicts.parquet",
        "episodes.parquet",
        "legacies.parquet",
        "manifest.json",
        "config.json",
    ] {
        assert!(out.join(f).exists(), "{f} missing");
    }
    assert_eq!(m["evidence_class"], "simulation");
    assert_eq!(m["files"]["agents.parquet"]["rows"], 60);
    assert_eq!(m["files"]["interventions.parquet"]["rows"], 60 * 4);
    assert!(m["determinism_hash"].as_str().unwrap().len() == 64);
    assert!(
        sim::run_to_dir(&small("t"), &out, false).is_err(),
        "refuses to overwrite without the flag"
    );
}

#[test]
fn overwrite_refuses_a_directory_that_is_not_a_results_dir() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("precious");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("notes.txt"), "keep me").unwrap();
    let err = sim::run_to_dir(&small("guard"), &out, true).unwrap_err();
    assert!(err
        .to_string()
        .contains("not a LoveWorld results directory"));
    assert!(out.join("notes.txt").exists(), "nothing was deleted");
    // An empty directory and a real results directory may be replaced.
    let empty = dir.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    sim::run_to_dir(&small("guard"), &empty, true).unwrap();
    sim::run_to_dir(&small("guard"), &empty, true).unwrap();
    let hidden: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect();
    assert!(hidden.is_empty(), "staging left behind: {hidden:?}");
}

#[cfg(unix)]
#[test]
fn a_failed_overwrite_keeps_the_previous_results() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("keep");
    sim::run_to_dir(&small("keep"), &out, false).unwrap();
    let before = std::fs::read_to_string(out.join("manifest.json")).unwrap();
    // A read-only parent makes the staging directory impossible to create, so the run fails
    // after validation; the previous results must survive it untouched.
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let attempt = sim::run_to_dir(&small("replacement"), &out, true);
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    if attempt.is_ok() {
        return; // root ignores directory permissions; nothing to check
    }
    assert_eq!(
        std::fs::read_to_string(out.join("manifest.json")).unwrap(),
        before
    );
    let others: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != "keep")
        .collect();
    assert!(others.is_empty(), "nothing else remains: {others:?}");
}

#[test]
fn same_config_same_hash_different_seed_different_hash() {
    let dir = tempfile::tempdir().unwrap();
    let a = sim::run_to_dir(&small("a"), &dir.path().join("a"), false).unwrap();
    let b = sim::run_to_dir(&small("a"), &dir.path().join("b"), false).unwrap();
    assert_eq!(a["determinism_hash"], b["determinism_hash"]);
    let mut c = small("a");
    c.seeds.dynamics += 1;
    let c = sim::run_to_dir(&c, &dir.path().join("c"), false).unwrap();
    assert_ne!(a["determinism_hash"], c["determinism_hash"]);
}

#[test]
fn placebo_twins_are_byte_identical() {
    // With identical memory params in both arms, forcing every couple into either arm must
    // produce the same tables: the arm label itself does nothing.
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = small("placebo");
    cfg.memory.treatment = cfg.memory.control.clone();
    let mut ctrl = cfg.clone();
    ctrl.arm_override = Some(Arm::Control);
    let mut treat = cfg.clone();
    treat.arm_override = Some(Arm::Treatment);
    let a = sim::run_to_dir(&ctrl, &dir.path().join("c"), false).unwrap();
    let b = sim::run_to_dir(&treat, &dir.path().join("t"), false).unwrap();
    // couples.parquet, agents.parquet and interventions.parquet carry the arm label itself and
    // are expected to differ; every behavioural table must not.
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
}

#[test]
fn real_twins_share_initial_conditions_and_diverge_later() {
    let mut ctrl = small("twins");
    ctrl.arm_override = Some(Arm::Control);
    let mut treat = small("twins");
    treat.arm_override = Some(Arm::Treatment);
    let a = sim::run(&ctrl);
    let b = sim::run(&treat);
    assert_eq!(a.population, b.population);
    // Same first-day stress for every couple (common random numbers), then dynamics may differ.
    let first = |r: &sim::SimResult| {
        r.logs
            .daily
            .iter()
            .filter(|d| d.day == 0)
            .map(|d| (d.couple_id, d.stress_a.to_bits()))
            .collect::<Vec<_>>()
    };
    assert_eq!(first(&a), first(&b));
    assert_ne!(a.logs.daily, b.logs.daily);
}

#[test]
fn binary_run_replay_and_policy_spec() {
    let dir = tempfile::tempdir().unwrap();
    let cfg_path = dir.path().join("cfg.json");
    std::fs::write(&cfg_path, r#"{"name":"bin","n_couples":20,"days":30}"#).unwrap();
    let out = dir.path().join("out");
    let st = Command::new(bin())
        .args([
            "run",
            "--config",
            cfg_path.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        st.status.success(),
        "{}",
        String::from_utf8_lossy(&st.stderr)
    );
    let summary: serde_json::Value = serde_json::from_slice(&st.stdout).unwrap();
    assert_eq!(summary["control"]["couples"], 10);

    let replay = Command::new(bin())
        .args([
            "replay",
            "--manifest",
            out.join("manifest.json").to_str().unwrap(),
            "--out",
            dir.path().join("replay").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&replay.stdout);
    assert!(replay.status.success(), "replay failed: {text}");
    assert!(text.contains("PASS determinism_hash"));

    let spec = Command::new(bin()).args(["policy-spec"]).output().unwrap();
    let v: serde_json::Value = serde_json::from_slice(&spec.stdout).unwrap();
    assert_eq!(v["kind"], "rule_based_softmax");
    assert!(v["weights"]["leave_base"].is_number());

    let assign = Command::new(bin())
        .args(["assign", "--config", cfg_path.to_str().unwrap()])
        .output()
        .unwrap();
    let arms: Vec<String> = serde_json::from_slice(&assign.stdout).unwrap();
    assert_eq!(arms.len(), 20);
    assert_eq!(arms.iter().filter(|a| *a == "treatment").count(), 10);
}

#[test]
fn replay_detects_tampering() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    sim::run_to_dir(&small("tamper"), &out, false).unwrap();
    let mpath = out.join("manifest.json");
    let text = std::fs::read_to_string(&mpath).unwrap();
    let mut m: serde_json::Value = serde_json::from_str(&text).unwrap();
    m["files"]["events.parquet"]["sha256"] = serde_json::Value::String("0".repeat(64));
    std::fs::write(&mpath, serde_json::to_string(&m).unwrap()).unwrap();
    let replay = Command::new(bin())
        .args([
            "replay",
            "--manifest",
            mpath.to_str().unwrap(),
            "--out",
            dir.path().join("r").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!replay.status.success());
    assert!(String::from_utf8_lossy(&replay.stdout).contains("FAIL events.parquet"));
}

#[test]
fn policy_sources_never_mention_the_arm() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for f in ["policy.rs", "dynamics.rs", "market.rs", "memory.rs"] {
        let text = std::fs::read_to_string(root.join(f)).unwrap();
        assert!(
            !text.contains("Arm"),
            "{f} must not reference the treatment arm"
        );
    }
}

#[test]
fn an_interrupted_publication_is_repaired_by_the_next_run() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("r");
    sim::run_to_dir(&small("r"), &out, false).unwrap();
    let before = std::fs::read_to_string(out.join("manifest.json")).unwrap();
    // A crash between the two publication renames leaves the results aside with their marker.
    let marker = serde_json::json!({"state": "replacing", "target": "r", "pid": 999}).to_string();
    std::fs::write(out.join(loveworld_engine::publish::SWAP_MARKER), marker).unwrap();
    std::fs::rename(&out, dir.path().join(".r.old-999-0")).unwrap();
    let err = sim::run_to_dir(&small("r"), &out, false).unwrap_err();
    assert!(
        err.to_string().contains("pass --overwrite"),
        "the restored results count as existing: {err}"
    );
    assert_eq!(
        std::fs::read_to_string(out.join("manifest.json")).unwrap(),
        before
    );
    assert!(!dir.path().join(".r.old-999-0").exists());
    sim::run_to_dir(&small("r"), &out, true).unwrap();
    let hidden: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect();
    assert!(hidden.is_empty(), "{hidden:?}");
}

#[test]
fn a_held_lock_refuses_a_second_run_on_the_same_target() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("r");
    std::fs::write(dir.path().join(".r.lock"), "4242").unwrap();
    let err = sim::run_to_dir(&small("r"), &out, false).unwrap_err();
    assert!(
        err.to_string().contains("another run is publishing"),
        "{err}"
    );
    assert!(!out.exists());
    std::fs::remove_file(dir.path().join(".r.lock")).unwrap();
    sim::run_to_dir(&small("r"), &out, false).unwrap();
    assert!(!dir.path().join(".r.lock").exists(), "the lock is released");
}

#[test]
fn a_zero_magnitude_shock_changes_nothing_but_its_own_rows() {
    // A job loss of size zero on everyone, with the partner drawn at random, must leave every
    // behavioural row identical: only the shock's own intervention and event rows may appear.
    let base = SimConfig {
        name: "zero".to_string(),
        n_couples: 60,
        days: 90,
        ..SimConfig::default()
    };
    let mut v = serde_json::to_value(&base).unwrap();
    v["shocks"] = serde_json::json!([{
        "kind": "job_loss",
        "target": "all",
        "member": "random",
        "start_day": 5,
        "end_day": 60,
        "magnitude": 0.0
    }]);
    let shocked: SimConfig = serde_json::from_value(v).unwrap();
    shocked.validate().unwrap();
    let a = sim::run(&base);
    let b = sim::run(&shocked);
    assert!(
        b.logs.events.iter().any(|e| e.kind == "shock_job_loss"),
        "the shock was applied"
    );
    assert_eq!(a.logs.daily, b.logs.daily, "daily rows moved");
    assert_eq!(a.logs.decisions, b.logs.decisions, "decisions moved");
    assert_eq!(a.logs.conflicts, b.logs.conflicts, "conflicts moved");
    assert_eq!(a.logs.episodes, b.logs.episodes, "episodes moved");
    assert_eq!(a.logs.legacies, b.logs.legacies, "legacies moved");
    let others = |r: &sim::SimResult| {
        r.logs
            .events
            .iter()
            .filter(|e| !e.kind.starts_with("shock_"))
            .map(|e| {
                (
                    e.day,
                    e.couple_id,
                    e.agent_id,
                    e.kind,
                    e.from_state,
                    e.to_state,
                    e.value.map(f64::to_bits),
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        others(&a),
        others(&b),
        "events other than the shock's own moved"
    );
}

#[test]
fn unknown_config_keys_are_rejected_by_name() {
    let err = SimConfig::from_json(r#"{"n_couples": 10, "bogus_knob": 1}"#)
        .unwrap_err()
        .to_string();
    assert!(err.contains("bogus_knob"), "{err}");
    let shock =
        r#"{"shocks": [{"kind": "job_loss", "target": "all", "start_day": 1, "magnitud": 2.0}]}"#;
    let err = SimConfig::from_json(shock).unwrap_err().to_string();
    assert!(err.contains("magnitud"), "{err}");
    let err = SimConfig::from_json(r#"{"dynamics": {"onset_intercep": 0.1}}"#)
        .unwrap_err()
        .to_string();
    assert!(err.contains("onset_intercep"), "{err}");
    // The full default config, exactly as the engine prints it, still parses.
    let text = serde_json::to_string(&SimConfig::default()).unwrap();
    SimConfig::from_json(&text).unwrap();
}

#[test]
fn the_cli_refuses_a_misspelt_key_and_names_it() {
    let out = Command::new(bin())
        .args(["assign", "--config", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(br#"{"n_couples": 4, "provenance": {"model": "x"}}"#)?;
            child.wait_with_output()
        })
        .unwrap();
    assert!(!out.status.success(), "an unknown key must fail the run");
    assert!(String::from_utf8_lossy(&out.stderr).contains("provenance"));
}
