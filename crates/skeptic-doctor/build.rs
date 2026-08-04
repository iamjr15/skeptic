use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=rules/registry.json");
    let source = fs::read_to_string("rules/registry.json").expect("read rule registry");
    let rules: Vec<String> = serde_json::from_str(&source).expect("valid rule registry JSON");
    let unique: BTreeSet<_> = rules.iter().collect();
    assert_eq!(unique.len(), rules.len(), "rule ids must be unique");
    let generated = format!(
        "pub const GENERATED_RULE_IDS: &[&str] = &[{}];\n",
        rules
            .iter()
            .map(|rule| format!("{:?}", rule))
            .collect::<Vec<_>>()
            .join(",")
    );
    let output = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    fs::write(output.join("rule_registry.rs"), generated).expect("write generated registry");
}
