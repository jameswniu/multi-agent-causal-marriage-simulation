//! Command line entry point for the LoveWorld engine.

use anyhow::{Context as _, Result};
use clap::{Parser, Subcommand, ValueEnum};
use loveworld_engine::config::{Arm, SimConfig};
use loveworld_engine::{assignment, policy, sim};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "loveworld-engine",
    version,
    about = "Headless Bevy ECS simulation of married agent couples"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Clone, Copy, ValueEnum)]
enum ArmArg {
    Control,
    Treatment,
}

impl From<ArmArg> for Arm {
    fn from(a: ArmArg) -> Self {
        match a {
            ArmArg::Control => Arm::Control,
            ArmArg::Treatment => Arm::Treatment,
        }
    }
}

#[derive(Subcommand)]
enum Cmd {
    /// Run a simulation from a JSON config and write Parquet tables plus manifest.json.
    Run {
        /// Config JSON path, or "-" for stdin. Missing fields take defaults.
        #[arg(long)]
        config: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        overwrite: bool,
        /// Force every couple into one arm (twin runs on common random numbers).
        #[arg(long)]
        arm_override: Option<ArmArg>,
        /// Override the experiment name recorded in the manifest.
        #[arg(long)]
        name: Option<String>,
    },
    /// Re-run the config in a manifest and verify every table hash matches.
    Replay {
        #[arg(long)]
        manifest: PathBuf,
        /// Where to write the replayed tables (default: a temp dir).
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Print the decision policy's weights and formulas.
    PolicySpec {
        #[arg(long)]
        config: Option<String>,
    },
    /// Print the arm assigned to each couple id.
    Assign {
        #[arg(long)]
        config: String,
    },
    /// Print the default config with every parameter.
    DefaultConfig,
    /// Print the shock kinds with their magnitude bounds and defaults.
    ShockCatalog,
}

fn load_config(path: &str) -> Result<SimConfig> {
    let text = if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
        s
    } else {
        std::fs::read_to_string(path).with_context(|| format!("read {path}"))?
    };
    SimConfig::from_json(&text)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Run {
            config,
            out,
            overwrite,
            arm_override,
            name,
        } => {
            let mut cfg = load_config(&config)?;
            if let Some(a) = arm_override {
                cfg.arm_override = Some(a.into());
            }
            if let Some(n) = name {
                cfg.name = n;
            }
            let started = std::time::Instant::now();
            let manifest = sim::run_to_dir(&cfg, &out, overwrite)?;
            eprintln!(
                "wrote {} ({} couples x {} days) in {:.2}s; determinism_hash {}",
                out.display(),
                cfg.n_couples,
                cfg.days,
                started.elapsed().as_secs_f64(),
                manifest["determinism_hash"].as_str().unwrap_or("")
            );
            println!("{}", serde_json::to_string(&manifest["summary"])?);
        }
        Cmd::Replay { manifest, out } => {
            let text = std::fs::read_to_string(&manifest)?;
            let m: serde_json::Value = serde_json::from_str(&text)?;
            let cfg: SimConfig =
                serde_json::from_value(m["config"].clone()).context("manifest has no config")?;
            let tmp = tempdir_fallback(out)?;
            let replay = sim::run_to_dir(&cfg, &tmp, true)?;
            let mut ok = true;
            for (name, info) in m["files"].as_object().into_iter().flatten() {
                let want = info["sha256"].as_str().unwrap_or("");
                let got = replay["files"][name]["sha256"].as_str().unwrap_or("");
                let pass = want == got;
                ok &= pass;
                println!("{} {} {}", if pass { "PASS" } else { "FAIL" }, name, got);
            }
            let want = m["determinism_hash"].as_str().unwrap_or("");
            let got = replay["determinism_hash"].as_str().unwrap_or("");
            println!(
                "{} determinism_hash {}",
                if want == got { "PASS" } else { "FAIL" },
                got
            );
            if !ok || want != got {
                anyhow::bail!("replay mismatch");
            }
        }
        Cmd::PolicySpec { config } => {
            let cfg = match config {
                Some(p) => load_config(&p)?,
                None => SimConfig::default(),
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&policy::spec(&cfg.policy))?
            );
        }
        Cmd::Assign { config } => {
            let cfg = load_config(&config)?;
            let arms: Vec<&str> = assignment::assign(&cfg)
                .iter()
                .map(|a| a.as_str())
                .collect();
            println!("{}", serde_json::to_string(&arms)?);
        }
        Cmd::DefaultConfig => {
            println!("{}", serde_json::to_string_pretty(&SimConfig::default())?);
        }
        Cmd::ShockCatalog => {
            println!(
                "{}",
                serde_json::to_string_pretty(&loveworld_engine::config::shock_catalog())?
            );
        }
    }
    Ok(())
}

fn tempdir_fallback(out: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = out {
        return Ok(p);
    }
    let base = std::env::temp_dir().join(format!("loveworld-replay-{}", std::process::id()));
    Ok(base)
}
