use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;
use skeptic_contract::{ResponseEnvelope, SideEffects};
use skeptic_report::{build, latest_manifest, view};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
    Sarif,
}

fn output(path: Option<&Path>, bytes: &[u8]) -> Result<(), String> {
    if let Some(path) = path {
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(path, bytes).map_err(|error| error.to_string())
    } else {
        std::io::stdout()
            .lock()
            .write_all(bytes)
            .map_err(|error| error.to_string())
    }
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let command = args.first().map(String::as_str).unwrap_or("report");
    let flag_value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let format = match flag_value("--format").as_deref().unwrap_or("human") {
        "human" => Format::Human,
        "json" => Format::Json,
        "sarif" => Format::Sarif,
        other => {
            eprintln!("unsupported report format `{other}`");
            std::process::exit(2);
        }
    };
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manifest = flag_value("--manifest")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            latest_manifest(&cwd).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(2)
            })
        });
    let diagnostics = flag_value("--diagnostics").map(PathBuf::from);
    let report = build(&manifest, diagnostics.as_deref()).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(10)
    });
    if command == "score" {
        if format == Format::Human {
            let mut text = format!(
                "Score: {}  Coverage: {:.0}%  Formula: {}\n",
                report
                    .score
                    .total
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "—".into()),
                report.score.coverage * 100.0,
                report.score.formula
            );
            if args.iter().any(|arg| arg == "--explain") {
                for item in &report.score_explanation {
                    text.push_str(&format!(
                        "{:?}: weight {:.0}, sevPts {:.2}, k {:.2}, deduction {:.2}, points {}\n",
                        item.category,
                        item.weight,
                        item.severity_points,
                        item.normalization,
                        item.deduction,
                        item.points
                            .map(|value| format!("{value:.2}"))
                            .unwrap_or_else(|| "—".into())
                    ));
                }
            }
            let path = flag_value("--output").map(PathBuf::from);
            output(path.as_deref(), text.as_bytes()).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(10)
            });
            return;
        }
        if format == Format::Json {
            let payload = json!({"score":report.score,"explanation":report.score_explanation});
            let envelope = ResponseEnvelope::success(payload, "skeptic.score/1", 0);
            let mut bytes = serde_json::to_vec(&envelope).unwrap();
            bytes.push(b'\n');
            let path = flag_value("--output").map(PathBuf::from);
            output(path.as_deref(), &bytes).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(10)
            });
            return;
        }
    }
    if format == Format::Human {
        if let Some(path) = flag_value("--output").map(PathBuf::from) {
            let text = skeptic_tui::render_plain(&view(&report));
            output(Some(&path), text.as_bytes()).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(10)
            });
        } else {
            skeptic_tui::render(&view(&report)).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(10)
            });
        }
        return;
    }
    let payload = match format {
        Format::Json => serde_json::to_value(&report).unwrap(),
        Format::Sarif => json!({
            "$schema":"https://json.schemastore.org/sarif-2.1.0.json",
            "version":"2.1.0",
            "runs":[{
                "tool":{"driver":{"name":"skeptic","version":env!("CARGO_PKG_VERSION")}},
                "results":report.diagnostics.iter().map(|item| json!({
                    "ruleId":item.producer.rule_id,
                    "level":match item.severity {
                        skeptic_contract::Severity::P0|skeptic_contract::Severity::P1=>"error",
                        skeptic_contract::Severity::P2=>"warning",
                        skeptic_contract::Severity::P3=>"note"
                    },
                    "message":{"text":item.message},
                    "locations":item.file.as_ref().map(|file| vec![json!({
                        "physicalLocation": {
                            "artifactLocation": {"uri": file},
                            "region": item.span.as_ref().map(|span| json!({
                                "startLine": span.start.line,
                                "startColumn": span.start.column,
                                "endLine": span.end.line,
                                "endColumn": span.end.column
                            }))
                        }
                    })]).unwrap_or_default()
                })).collect::<Vec<_>>()
            }]
        }),
        Format::Human => unreachable!(),
    };
    let mut bytes = if format == Format::Sarif {
        serde_json::to_vec_pretty(&payload).unwrap()
    } else {
        let mut envelope = ResponseEnvelope::success(payload, "skeptic.report/1", 0);
        envelope.meta.side_effects = SideEffects::None;
        serde_json::to_vec(&envelope).unwrap()
    };
    bytes.push(b'\n');
    let path = flag_value("--output").map(PathBuf::from);
    output(path.as_deref(), &bytes).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(10)
    });
}
