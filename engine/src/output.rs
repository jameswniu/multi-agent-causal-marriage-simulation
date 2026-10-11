//! Parquet outputs and the run manifest.

use crate::config::SimConfig;
use crate::log::Logs;
use crate::sim::{AgentSummary, CoupleSummary};
use anyhow::{Context as _, Result};
use arrow::array::{
    ArrayRef, BooleanArray, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray,
};
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

type Col = (&'static str, ArrayRef, bool);

fn f64s(name: &'static str, v: Vec<f64>) -> Col {
    (name, Arc::new(Float64Array::from(v)) as ArrayRef, false)
}
fn opt_f64s(name: &'static str, v: Vec<Option<f64>>) -> Col {
    (name, Arc::new(Float64Array::from(v)) as ArrayRef, true)
}
fn i32s(name: &'static str, v: Vec<i32>) -> Col {
    (name, Arc::new(Int32Array::from(v)) as ArrayRef, false)
}
fn opt_i32s(name: &'static str, v: Vec<Option<i32>>) -> Col {
    (name, Arc::new(Int32Array::from(v)) as ArrayRef, true)
}
fn i64s(name: &'static str, v: Vec<i64>) -> Col {
    (name, Arc::new(Int64Array::from(v)) as ArrayRef, false)
}
fn opt_i64s(name: &'static str, v: Vec<Option<i64>>) -> Col {
    (name, Arc::new(Int64Array::from(v)) as ArrayRef, true)
}
fn bools(name: &'static str, v: Vec<bool>) -> Col {
    (name, Arc::new(BooleanArray::from(v)) as ArrayRef, false)
}
fn strs(name: &'static str, v: Vec<&str>) -> Col {
    (name, Arc::new(StringArray::from(v)) as ArrayRef, false)
}
fn opt_strs(name: &'static str, v: Vec<Option<&str>>) -> Col {
    (name, Arc::new(StringArray::from(v)) as ArrayRef, true)
}

fn batch(cols: Vec<Col>) -> Result<RecordBatch> {
    Ok(RecordBatch::try_from_iter_with_nullable(cols)?)
}

pub fn write_parquet(path: &Path, b: &RecordBatch) -> Result<()> {
    let file = File::create(path).with_context(|| format!("create {}", path.display()))?;
    let props = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_created_by("loveworld-engine".to_string())
        .build();
    let mut w = ArrowWriter::try_new(file, b.schema(), Some(props))?;
    w.write(b)?;
    w.close()?;
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let out = Sha256::digest(&bytes);
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn agents_batch(rows: &[AgentSummary]) -> Result<RecordBatch> {
    batch(vec![
        i64s("agent_id", rows.iter().map(|r| r.agent_id).collect()),
        i64s("couple_id", rows.iter().map(|r| r.couple_id).collect()),
        strs("arm", rows.iter().map(|r| r.arm).collect()),
        f64s("neuroticism", rows.iter().map(|r| r.neuroticism).collect()),
        f64s(
            "agreeableness",
            rows.iter().map(|r| r.agreeableness).collect(),
        ),
        f64s(
            "conscientiousness",
            rows.iter().map(|r| r.conscientiousness).collect(),
        ),
        f64s("openness", rows.iter().map(|r| r.openness).collect()),
        f64s(
            "extraversion",
            rows.iter().map(|r| r.extraversion).collect(),
        ),
        f64s("forgiveness", rows.iter().map(|r| r.forgiveness).collect()),
        f64s("commitment", rows.iter().map(|r| r.commitment).collect()),
        f64s(
            "closeness_pref",
            rows.iter().map(|r| r.closeness_pref).collect(),
        ),
        f64s(
            "conflict_engagement",
            rows.iter().map(|r| r.conflict_engagement).collect(),
        ),
        i32s(
            "prior_relationships",
            rows.iter().map(|r| r.prior_relationships).collect(),
        ),
        i32s(
            "prior_divorces",
            rows.iter().map(|r| r.prior_divorces).collect(),
        ),
        f64s(
            "years_married",
            rows.iter().map(|r| r.years_married).collect(),
        ),
        f64s("base_trust", rows.iter().map(|r| r.base_trust).collect()),
        f64s("relax_rate", rows.iter().map(|r| r.relax_rate).collect()),
        i32s(
            "initial_episodes",
            rows.iter().map(|r| r.initial_episodes).collect(),
        ),
        f64s(
            "conflict_half_life_days",
            rows.iter().map(|r| r.conflict_half_life_days).collect(),
        ),
        f64s(
            "repair_half_life_days",
            rows.iter().map(|r| r.repair_half_life_days).collect(),
        ),
        f64s(
            "positive_half_life_days",
            rows.iter().map(|r| r.positive_half_life_days).collect(),
        ),
        i32s(
            "divorces_in_sim",
            rows.iter().map(|r| r.divorces_in_sim).collect(),
        ),
        i32s(
            "marriages_in_sim",
            rows.iter().map(|r| r.marriages_in_sim).collect(),
        ),
        f64s("final_trust", rows.iter().map(|r| r.final_trust).collect()),
        i32s(
            "final_memory_size",
            rows.iter().map(|r| r.final_memory_size).collect(),
        ),
    ])
}

pub fn couples_batch(rows: &[CoupleSummary]) -> Result<RecordBatch> {
    batch(vec![
        i64s("couple_id", rows.iter().map(|r| r.couple_id).collect()),
        i64s("agent_a", rows.iter().map(|r| r.agent_a).collect()),
        i64s("agent_b", rows.iter().map(|r| r.agent_b).collect()),
        opt_strs("arm", rows.iter().map(|r| r.arm).collect()),
        strs("origin", rows.iter().map(|r| r.origin).collect()),
        i32s("formed_day", rows.iter().map(|r| r.formed_day).collect()),
        opt_i32s("married_day", rows.iter().map(|r| r.married_day).collect()),
        f64s(
            "compatibility",
            rows.iter().map(|r| r.compatibility).collect(),
        ),
        strs("final_state", rows.iter().map(|r| r.final_state).collect()),
        opt_i32s("ended_day", rows.iter().map(|r| r.ended_day).collect()),
        f64s(
            "years_married_at_start",
            rows.iter().map(|r| r.years_married_at_start).collect(),
        ),
    ])
}

pub fn events_batch(logs: &Logs) -> Result<RecordBatch> {
    let r = &logs.events;
    batch(vec![
        i32s("day", r.iter().map(|x| x.day).collect()),
        i32s("seq", r.iter().map(|x| x.seq as i32).collect()),
        i64s("couple_id", r.iter().map(|x| x.couple_id).collect()),
        opt_i64s("agent_id", r.iter().map(|x| x.agent_id).collect()),
        strs("kind", r.iter().map(|x| x.kind).collect()),
        opt_strs("from_state", r.iter().map(|x| x.from_state).collect()),
        opt_strs("to_state", r.iter().map(|x| x.to_state).collect()),
        opt_f64s("value", r.iter().map(|x| x.value).collect()),
    ])
}

pub fn daily_batch(logs: &Logs) -> Result<RecordBatch> {
    let r = &logs.daily;
    batch(vec![
        i32s("day", r.iter().map(|x| x.day).collect()),
        i64s("couple_id", r.iter().map(|x| x.couple_id).collect()),
        strs("state", r.iter().map(|x| x.state).collect()),
        bools("in_conflict", r.iter().map(|x| x.in_conflict).collect()),
        i32s("conflict_days", r.iter().map(|x| x.conflict_days).collect()),
        f64s("intensity", r.iter().map(|x| x.intensity).collect()),
        bools(
            "positive_episode",
            r.iter().map(|x| x.positive_episode).collect(),
        ),
        f64s("trust_a", r.iter().map(|x| x.trust_a).collect()),
        f64s("trust_b", r.iter().map(|x| x.trust_b).collect()),
        f64s("affect_a", r.iter().map(|x| x.affect_a).collect()),
        f64s("affect_b", r.iter().map(|x| x.affect_b).collect()),
        f64s(
            "satisfaction_a",
            r.iter().map(|x| x.satisfaction_a).collect(),
        ),
        f64s(
            "satisfaction_b",
            r.iter().map(|x| x.satisfaction_b).collect(),
        ),
        f64s("neg_a", r.iter().map(|x| x.neg_a).collect()),
        f64s("neg_b", r.iter().map(|x| x.neg_b).collect()),
        f64s("pos_a", r.iter().map(|x| x.pos_a).collect()),
        f64s("pos_b", r.iter().map(|x| x.pos_b).collect()),
        f64s("stress_a", r.iter().map(|x| x.stress_a).collect()),
        f64s("stress_b", r.iter().map(|x| x.stress_b).collect()),
    ])
}

pub fn decisions_batch(logs: &Logs) -> Result<RecordBatch> {
    let r = &logs.decisions;
    batch(vec![
        i32s("day", r.iter().map(|x| x.day).collect()),
        i64s("couple_id", r.iter().map(|x| x.couple_id).collect()),
        i64s("agent_id", r.iter().map(|x| x.agent_id).collect()),
        strs("context", r.iter().map(|x| x.context).collect()),
        strs("action", r.iter().map(|x| x.action).collect()),
        f64s("p_chosen", r.iter().map(|x| x.p_chosen).collect()),
        opt_f64s("u_repair", r.iter().map(|x| x.u_repair).collect()),
        opt_f64s("u_hold", r.iter().map(|x| x.u_hold).collect()),
        opt_f64s("u_escalate", r.iter().map(|x| x.u_escalate).collect()),
        opt_f64s("u_withdraw", r.iter().map(|x| x.u_withdraw).collect()),
        opt_f64s("u_leave", r.iter().map(|x| x.u_leave).collect()),
        f64s("trust", r.iter().map(|x| x.trust).collect()),
        f64s("affect", r.iter().map(|x| x.affect).collect()),
        f64s("neg_load", r.iter().map(|x| x.neg_load).collect()),
        f64s("pos_load", r.iter().map(|x| x.pos_load).collect()),
        f64s("intensity", r.iter().map(|x| x.intensity).collect()),
        i32s("conflict_days", r.iter().map(|x| x.conflict_days).collect()),
        opt_strs("partner_last", r.iter().map(|x| x.partner_last).collect()),
    ])
}

pub fn interventions_batch(logs: &Logs) -> Result<RecordBatch> {
    let r = &logs.interventions;
    batch(vec![
        i32s("day", r.iter().map(|x| x.day).collect()),
        i64s("couple_id", r.iter().map(|x| x.couple_id).collect()),
        i64s("agent_id", r.iter().map(|x| x.agent_id).collect()),
        strs("arm", r.iter().map(|x| x.arm.as_str()).collect()),
        strs("parameter", r.iter().map(|x| x.parameter).collect()),
        f64s("control_value", r.iter().map(|x| x.control_value).collect()),
        f64s("applied_value", r.iter().map(|x| x.applied_value).collect()),
    ])
}

pub fn conflicts_batch(logs: &Logs) -> Result<RecordBatch> {
    let r = &logs.conflicts;
    batch(vec![
        i64s("couple_id", r.iter().map(|x| x.couple_id).collect()),
        i32s("started_day", r.iter().map(|x| x.started_day).collect()),
        opt_i32s("ended_day", r.iter().map(|x| x.ended_day).collect()),
        strs("outcome", r.iter().map(|x| x.outcome).collect()),
        f64s(
            "peak_intensity",
            r.iter().map(|x| x.peak_intensity).collect(),
        ),
        i32s("escalations", r.iter().map(|x| x.escalations).collect()),
        i32s(
            "repair_attempts",
            r.iter().map(|x| x.repair_attempts).collect(),
        ),
        opt_i32s("duration_days", r.iter().map(|x| x.duration_days).collect()),
    ])
}

pub fn episodes_batch(logs: &Logs) -> Result<RecordBatch> {
    let r = &logs.episodes;
    batch(vec![
        i32s("day", r.iter().map(|x| x.day).collect()),
        i64s("couple_id", r.iter().map(|x| x.couple_id).collect()),
        i64s("agent_id", r.iter().map(|x| x.agent_id).collect()),
        i64s("partner_id", r.iter().map(|x| x.partner_id).collect()),
        strs("kind", r.iter().map(|x| x.kind).collect()),
        f64s("intensity", r.iter().map(|x| x.intensity).collect()),
        strs("source", r.iter().map(|x| x.source).collect()),
        bools("amplified", r.iter().map(|x| x.amplified).collect()),
    ])
}

pub struct Written {
    pub name: &'static str,
    pub path: PathBuf,
    pub rows: usize,
    pub sha256: String,
}

/// Write every table into `dir` and return the file records.
pub fn write_all(
    dir: &Path,
    logs: &Logs,
    agents: &[AgentSummary],
    couples: &[CoupleSummary],
) -> Result<Vec<Written>> {
    std::fs::create_dir_all(dir)?;
    let tables: Vec<(&'static str, RecordBatch)> = vec![
        ("agents.parquet", agents_batch(agents)?),
        ("couples.parquet", couples_batch(couples)?),
        ("events.parquet", events_batch(logs)?),
        ("daily.parquet", daily_batch(logs)?),
        ("decisions.parquet", decisions_batch(logs)?),
        ("interventions.parquet", interventions_batch(logs)?),
        ("conflicts.parquet", conflicts_batch(logs)?),
        ("episodes.parquet", episodes_batch(logs)?),
    ];
    let mut out = Vec::new();
    for (name, b) in tables {
        let path = dir.join(name);
        write_parquet(&path, &b)?;
        let sha256 = sha256_file(&path)?;
        out.push(Written {
            name,
            path,
            rows: b.num_rows(),
            sha256,
        });
    }
    Ok(out)
}

/// Hash of all table hashes in file-name order: equal across runs iff every table is equal.
pub fn determinism_hash(files: &[Written]) -> String {
    let mut h = Sha256::new();
    let mut sorted: Vec<&Written> = files.iter().collect();
    sorted.sort_by_key(|w| w.name);
    for w in sorted {
        h.update(w.name.as_bytes());
        h.update(b"=");
        h.update(w.sha256.as_bytes());
        h.update(b"\n");
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn manifest_json(
    cfg: &SimConfig,
    files: &[Written],
    summary: serde_json::Value,
    policy_spec: serde_json::Value,
) -> serde_json::Value {
    let generated_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    serde_json::json!({
        "engine": "loveworld-engine",
        "engine_version": crate::engine_version(),
        "evidence_class": "simulation",
        "name": cfg.name,
        "n_couples": cfg.n_couples,
        "days": cfg.days,
        "seeds": cfg.seeds,
        "arm_override": cfg.arm_override,
        "config": cfg,
        "policy_spec": policy_spec,
        "files": files.iter().map(|w| (w.name.to_string(), serde_json::json!({"rows": w.rows, "sha256": w.sha256}))).collect::<serde_json::Map<String, serde_json::Value>>(),
        "determinism_hash": determinism_hash(files),
        "summary": summary,
        "generated_at_unix": generated_at_unix,
    })
}
