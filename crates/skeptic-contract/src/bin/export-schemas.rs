use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let destination = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("schemas"));
    fs::create_dir_all(&destination)?;

    for (id, schema) in skeptic_contract::published_schemas() {
        let filename = format!("{}.schema.json", id.replace(['/', '.'], "-"));
        let mut bytes = serde_json::to_vec_pretty(&schema)?;
        bytes.push(b'\n');
        fs::write(destination.join(filename), bytes)?;
    }
    Ok(())
}
