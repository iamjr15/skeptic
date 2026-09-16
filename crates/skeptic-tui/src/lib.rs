#![forbid(unsafe_code)]

//! Minimal report renderer: a large score numeral colored on a red→yellow→green
//! scale, a prominent grade, and square-segment category gauges. Quiet palette,
//! no chrome. Falls back to a matching plain-text render when not a TTY.

use std::collections::BTreeMap;
use std::io::{self, IsTerminal};

use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::{Terminal, TerminalOptions, Viewport};
use skeptic_contract::Category;
use tui_big_text::{BigText, PixelSize};

/// How many findings the styled summary shows before "… and N more"
/// (the full list lives in `skeptic doctor`).
const MAX_FINDINGS_SHOWN: usize = 6;

#[derive(Debug, Clone)]
pub struct ReportView {
    pub title: String,
    /// The word after "skeptic · " in the header (e.g. "report", "doctor").
    pub label: String,
    pub subtitle: String,
    pub score: Option<u8>,
    pub coverage: f64,
    pub ghost_gain: f64,
    pub diagnostics: usize,
    pub tests_passed: usize,
    pub tests_failed: usize,
    pub by_category: BTreeMap<Category, Option<f64>>,
    pub top_findings: Vec<String>,
}

const FG: Color = Color::Rgb(0xd3, 0xd9, 0xe2);
const DIM: Color = Color::Rgb(0x8a, 0x93, 0xa3); // readable secondary text (labels, context)
const TRACK: Color = Color::Rgb(0x4d, 0x56, 0x66); // empty gauge squares only — recessed but visible
const SEGMENTS: usize = 10;

/// Traffic-light color for a score: red (bad) → yellow (mid) → green (good).
fn ryg(score: u8) -> Color {
    const STOPS: [(f64, [f64; 3]); 5] = [
        (0.0, [240.0, 86.0, 96.0]),
        (45.0, [236.0, 120.0, 90.0]),
        (70.0, [232.0, 192.0, 80.0]),
        (88.0, [150.0, 200.0, 96.0]),
        (100.0, [74.0, 202.0, 120.0]),
    ];
    let s = f64::from(score);
    let (mut lo, mut hi) = (STOPS[0], STOPS[STOPS.len() - 1]);
    for pair in STOPS.windows(2) {
        if s >= pair[0].0 && s <= pair[1].0 {
            lo = pair[0];
            hi = pair[1];
            break;
        }
    }
    let span = hi.0 - lo.0;
    let t = if span.abs() < f64::EPSILON {
        0.0
    } else {
        (s - lo.0) / span
    };
    let channel = |i: usize| (lo.1[i] + (hi.1[i] - lo.1[i]) * t).round() as u8;
    Color::Rgb(channel(0), channel(1), channel(2))
}

/// Letter grade for a score (ASCII hyphen so the big-text font can render it).
fn grade(score: u8) -> &'static str {
    match score {
        97..=u8::MAX => "A+",
        93..=96 => "A",
        90..=92 => "A-",
        87..=89 => "B+",
        83..=86 => "B",
        80..=82 => "B-",
        77..=79 => "C+",
        73..=76 => "C",
        70..=72 => "C-",
        60..=69 => "D",
        _ => "F",
    }
}

fn filled_segments(score: u8) -> usize {
    (usize::from(score) * SEGMENTS + 50) / 100
}

/// A category row: name, square-segment gauge colored by score, and the number.
fn category_line(category: &Category, score: Option<f64>) -> Line<'static> {
    let name = format!("{:<16}", category.to_string());
    match score {
        None => Line::from(vec![
            Span::styled(name, Style::new().fg(DIM)),
            Span::styled("▫ ".repeat(SEGMENTS), Style::new().fg(TRACK)),
            Span::styled(" —", Style::new().fg(DIM)),
        ]),
        Some(value) => {
            let rounded = value.round().clamp(0.0, 100.0) as u8;
            let filled = filled_segments(rounded);
            let color = ryg(rounded);
            Line::from(vec![
                Span::styled(name, Style::new().fg(DIM)),
                Span::styled("▪ ".repeat(filled), Style::new().fg(color)),
                Span::styled("▫ ".repeat(SEGMENTS - filled), Style::new().fg(TRACK)),
                Span::styled(
                    format!(" {rounded:>3}"),
                    Style::new().fg(color).add_modifier(Modifier::BOLD),
                ),
            ])
        }
    }
}

fn segments_plain(filled: usize) -> String {
    format!("{}{}", "▪".repeat(filled), "▫".repeat(SEGMENTS - filled))
}

pub fn render_plain(view: &ReportView) -> String {
    let score = view
        .score
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".into());
    let grade_label = view.score.map(grade).unwrap_or("—");
    let mut output = format!("skeptic · {}\n", view.label);
    if !view.subtitle.is_empty() {
        output.push_str(&view.subtitle);
        output.push('\n');
    }
    output.push_str(&format!(
        "\n  {score}/100   {grade_label}\n  coverage {:.0}% · {} findings · {} passed, {} failed\n",
        view.coverage * 100.0,
        view.diagnostics,
        view.tests_passed,
        view.tests_failed
    ));
    if !view.by_category.is_empty() {
        output.push_str("\ncategories\n");
        for (category, score) in &view.by_category {
            match score {
                None => output.push_str(&format!(
                    "  {:<16} {}  —\n",
                    category.to_string(),
                    segments_plain(0)
                )),
                Some(value) => {
                    let rounded = value.round().clamp(0.0, 100.0) as u8;
                    output.push_str(&format!(
                        "  {:<16} {}  {rounded:>3}\n",
                        category.to_string(),
                        segments_plain(filled_segments(rounded))
                    ));
                }
            }
        }
    }
    if !view.top_findings.is_empty() {
        output.push_str(&format!("\n{} findings\n", view.diagnostics));
        for finding in &view.top_findings {
            output.push_str(&format!("  • {finding}\n"));
        }
    }
    output
}

pub fn should_use_tui() -> bool {
    io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none()
        && std::env::var_os("CI").is_none()
        && std::env::var("TERM").ok().as_deref() != Some("dumb")
}

fn big_number(text: String, color: Color, alignment: Alignment) -> BigText<'static> {
    BigText::builder()
        .pixel_size(PixelSize::HalfHeight)
        .alignment(alignment)
        .style(Style::new().fg(color))
        .lines(vec![Line::from(text)])
        .build()
}

/// The body rows: the category gauges and a capped list of findings.
fn body_lines(view: &ReportView) -> Vec<Line<'static>> {
    let shown = view.top_findings.len().min(MAX_FINDINGS_SHOWN);
    let mut lines = vec![
        Line::from(Span::styled("CATEGORIES", Style::new().fg(DIM))),
        Line::from(""),
    ];
    for (category, score) in &view.by_category {
        lines.push(category_line(category, *score));
    }
    if !view.top_findings.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("{} FINDINGS", view.diagnostics),
            Style::new().fg(DIM),
        )));
        for finding in view.top_findings.iter().take(shown) {
            lines.push(Line::from(vec![
                Span::styled("• ", Style::new().fg(DIM)),
                Span::styled(finding.clone(), Style::new().fg(FG)),
            ]));
        }
        if view.top_findings.len() > shown {
            lines.push(Line::from(Span::styled(
                format!("  … and {} more", view.top_findings.len() - shown),
                Style::new().fg(DIM),
            )));
        }
    }
    lines
}

/// Render the styled report **inline** in the normal terminal buffer so it
/// persists in scrollback (no alternate screen, no plain-text fallback on top).
pub fn render(view: &ReportView) -> Result<(), String> {
    if !should_use_tui() {
        print!("{}", render_plain(view));
        return Ok(());
    }

    let body = body_lines(view);
    // top + spacer + score(4) + context + spacer + body, plus 1 top/bottom margin.
    let content = 1 + 1 + 4 + 1 + 1 + body.len();
    let needed = u16::try_from(content + 2).unwrap_or(u16::MAX);
    let term_rows = ratatui::crossterm::terminal::size()
        .map(|(_, rows)| rows)
        .unwrap_or(40);
    let height = needed.min(term_rows.saturating_sub(1)).max(6);

    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(height),
        },
    )
    .map_err(|error| error.to_string())?;

    // Big-text at HalfHeight is 8 cells wide per character; size each block to
    // its digits so the score and grade sit close with a separator between them.
    let score_text = view
        .score
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".into());
    let score_cols = u16::try_from(score_text.chars().count() * 8).unwrap_or(24);
    let score_color = view.score.map(ryg).unwrap_or(DIM);
    let score_big = big_number(score_text, score_color, Alignment::Left);
    let grade_cols = view
        .score
        .map(|score| u16::try_from(grade(score).chars().count() * 8).unwrap_or(16))
        .unwrap_or(0);
    let grade_big = view
        .score
        .map(|score| big_number(grade(score).to_string(), ryg(score), Alignment::Left));

    terminal
        .draw(|frame| {
            let root = Layout::vertical([
                Constraint::Length(1),
                Constraint::Length(1),
                Constraint::Length(4),
                Constraint::Length(1),
                Constraint::Length(1),
                Constraint::Min(1),
            ])
            .horizontal_margin(2)
            .vertical_margin(1)
            .split(frame.area());

            let mut top = vec![
                Span::styled("skeptic", Style::new().fg(FG).add_modifier(Modifier::BOLD)),
                Span::styled(format!(" · {}", view.label), Style::new().fg(DIM)),
            ];
            if !view.subtitle.is_empty() {
                top.push(Span::styled(
                    format!("   {}", view.subtitle),
                    Style::new().fg(DIM),
                ));
            }
            frame.render_widget(Paragraph::new(Line::from(top)), root[0]);

            let columns = Layout::horizontal([
                Constraint::Length(score_cols),
                Constraint::Length(3),
                Constraint::Length(grade_cols),
                Constraint::Min(0),
            ])
            .split(root[2]);
            frame.render_widget(score_big, columns[0]);
            if let Some(grade_big) = grade_big {
                // a subtle vertical divider between the score and the grade
                let separator = Paragraph::new(vec![
                    Line::from(""),
                    Line::from(Span::styled("│", Style::new().fg(TRACK))),
                    Line::from(Span::styled("│", Style::new().fg(TRACK))),
                    Line::from(""),
                ])
                .alignment(Alignment::Center);
                frame.render_widget(separator, columns[1]);
                frame.render_widget(grade_big, columns[2]);
            }

            let context = format!(
                "out of 100  ·  coverage {:.0}%  ·  {} findings",
                view.coverage * 100.0,
                view.diagnostics
            );
            frame.render_widget(
                Paragraph::new(Span::styled(context, Style::new().fg(DIM))),
                root[3],
            );

            frame.render_widget(Paragraph::new(body), root[5]);
        })
        .map_err(|error| error.to_string())?;

    // Move the cursor below the inline report so the next shell prompt is clean.
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_report_exposes_score_grade_and_coverage() {
        let output = render_plain(&ReportView {
            title: "Run".into(),
            label: "report".into(),
            subtitle: "2026-07-20 15:47 · 69ms · c85a1fce".into(),
            score: Some(87),
            coverage: 0.75,
            ghost_gain: 4.0,
            diagnostics: 2,
            tests_passed: 3,
            tests_failed: 1,
            by_category: BTreeMap::new(),
            top_findings: vec!["problem".into()],
        });
        assert!(output.contains("87/100"));
        assert!(output.contains("B+"));
        assert!(output.contains("75%"));
    }

    #[test]
    fn ryg_ramps_red_to_green() {
        assert_eq!(ryg(0), Color::Rgb(240, 86, 96));
        assert_eq!(ryg(100), Color::Rgb(74, 202, 120));
        // a low score is redder than a high one
        let low = ryg(30);
        let high = ryg(95);
        if let (Color::Rgb(lr, _, _), Color::Rgb(hr, _, _)) = (low, high) {
            assert!(lr > hr);
        } else {
            panic!("expected rgb");
        }
    }

    #[test]
    fn grades_track_score() {
        assert_eq!(grade(100), "A+");
        assert_eq!(grade(84), "B");
        assert_eq!(grade(50), "F");
    }

    #[test]
    fn segments_scale_with_score() {
        assert_eq!(filled_segments(0), 0);
        assert_eq!(filled_segments(100), 10);
        assert_eq!(filled_segments(84), 8);
    }
}
