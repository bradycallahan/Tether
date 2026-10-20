//! Session logging. Writes either the raw byte stream or a cleaned-up plain
//! text version (ANSI escapes stripped), optionally with a timestamp at the
//! start of every line.

use anyhow::Result;
use chrono::Local;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub struct Logger {
    path: PathBuf,
    out: Sink,
    timestamps: bool,
    at_line_start: bool,
}

#[allow(clippy::large_enum_variant)]
enum Sink {
    Raw(BufWriter<File>),
    Plain(strip_ansi_escapes::Writer<BufWriter<File>>),
}

impl Sink {
    fn write_all(&mut self, b: &[u8]) -> std::io::Result<()> {
        match self {
            Sink::Raw(w) => w.write_all(b),
            Sink::Plain(w) => w.write_all(b),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Sink::Raw(w) => w.flush(),
            Sink::Plain(w) => w.flush(),
        }
    }
}

pub struct LogTarget<'a> {
    pub dir: &'a Path,
    pub template: &'a str,
    pub session: &'a str,
    pub host: &'a str,
    pub timestamps: bool,
    pub strip_ansi: bool,
}

impl Logger {
    pub fn open(t: LogTarget) -> Result<Self> {
        fs::create_dir_all(t.dir)?;
        let path = t.dir.join(render_template(t.template, t.session, t.host));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let buf = BufWriter::new(file);
        let out = if t.strip_ansi { Sink::Plain(strip_ansi_escapes::Writer::new(buf)) } else { Sink::Raw(buf) };
        let mut logger = Self { path, out, timestamps: t.timestamps, at_line_start: true };
        let banner = format!(
            "\n===== Tether log opened {} — {} ({}) =====\n",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            t.session,
            t.host
        );
        logger.out.write_all(banner.as_bytes())?;
        Ok(logger)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(&mut self, data: &[u8]) {
        let result = if self.timestamps { self.write_stamped(data) } else { self.out.write_all(data) };
        if let Err(e) = result.and_then(|_| self.out.flush()) {
            log::warn!("log write failed for {}: {e}", self.path.display());
        }
    }

    fn write_stamped(&mut self, data: &[u8]) -> std::io::Result<()> {
        let mut start = 0;
        for (i, &b) in data.iter().enumerate() {
            if self.at_line_start && b != b'\r' && b != b'\n' {
                self.out.write_all(&data[start..i])?;
                start = i;
                let stamp = Local::now().format("[%H:%M:%S%.3f] ").to_string();
                self.out.write_all(stamp.as_bytes())?;
                self.at_line_start = false;
            }
            if b == b'\n' {
                self.at_line_start = true;
            }
        }
        self.out.write_all(&data[start..])
    }
}

pub fn render_template(template: &str, session: &str, host: &str) -> String {
    let now = Local::now();
    let clean = |s: &str| -> String {
        s.chars().map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect()
    };
    let t = if template.trim().is_empty() { "{session}_{date}_{time}.log" } else { template };
    t.replace("{session}", &clean(session))
        .replace("{host}", &clean(host))
        .replace("{date}", &now.format("%Y-%m-%d").to_string())
        .replace("{time}", &now.format("%H%M%S").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_each_line_and_strips_ansi() {
        let dir = std::env::temp_dir().join(format!("tether-log-{}", uuid::Uuid::new_v4()));
        let mut l = Logger::open(LogTarget {
            dir: &dir,
            template: "t.log",
            session: "sw1",
            host: "10.0.0.1",
            timestamps: true,
            strip_ansi: true,
        })
        .unwrap();
        l.write(b"\x1b[32mup\x1b[0m line one\r\nline ");
        l.write(b"two\r\n");
        drop(l);
        let text = fs::read_to_string(dir.join("t.log")).unwrap();
        let body: Vec<&str> = text.lines().filter(|l| l.starts_with('[')).collect();
        assert_eq!(body.len(), 2);
        assert!(body[0].trim_end_matches('\r').ends_with("up line one"), "{text:?}");
        assert!(body[1].trim_end_matches('\r').ends_with("line two"), "{text:?}");
        assert!(!text.contains('\x1b'));
    }

    #[test]
    fn template_is_filesystem_safe() {
        let name = render_template("{session}@{host}.log", "core/sw 1", "10.0.0.1");
        assert!(name.starts_with("core_sw_1@10.0.0.1"));
    }
}
