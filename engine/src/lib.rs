//! LoveWorld simulation engine: a headless Bevy ECS world of married agent couples with
//! episodic memory, an explicit decision policy, a randomised retention intervention, and
//! Parquet event logs. Python drives experiments and does the statistics.

pub mod assignment;
pub mod components;
pub mod config;
pub mod dynamics;
pub mod intervention;
pub mod log;
pub mod market;
pub mod memory;
pub mod output;
pub mod policy;
pub mod population;
pub mod publish;
pub mod rng;
pub mod sim;
pub mod systems;

pub fn engine_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
