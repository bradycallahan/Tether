//! What Tether was asked to open on its command line: `--session <name or id>`
//! (taskbar jump list, shortcuts, scripts) and `ssh://` / `telnet://` links
//! (when Tether is the link handler). A second launch hands its targets to the
//! running window instead of opening another one (single-instance plugin).

use serde::Serialize;

/// Something to open, as the UI receives it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Target {
    /// A saved session, by id, name or "Folder/Name".
    Session(String),
    /// An `ssh://` or `telnet://` URL.
    Url(String),
    /// A command id from the UI's registry (jump list tasks).
    Command(String),
}

/// Jump list tasks: flag, command id in the UI's registry.
pub const TASKS: [(&str, &str); 2] = [("--quick-connect", "connect.quick"), ("--local-shell", "connect.local")];

/// Pick the targets out of a command line (without the program name). Anything
/// else is ignored, so stray flags from shortcuts or the OS can't do harm.
pub fn targets<I: IntoIterator<Item = String>>(args: I) -> Vec<Target> {
    let mut out = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if let Some(v) = arg.strip_prefix("--session=") {
            if !v.trim().is_empty() {
                out.push(Target::Session(v.trim().to_string()));
            }
        } else if arg == "--session" {
            if let Some(v) = args.next().filter(|v| !v.trim().is_empty()) {
                out.push(Target::Session(v.trim().to_string()));
            }
        } else if let Some((_, id)) = TASKS.iter().find(|(flag, _)| *flag == arg) {
            out.push(Target::Command(id.to_string()));
        } else if is_link(&arg) {
            out.push(Target::Url(arg));
        }
    }
    out
}

fn is_link(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    // Only network protocols: a link must never open a local shell or a serial port.
    (lower.starts_with("ssh://") || lower.starts_with("telnet://"))
        && arg.len() < 2048
        && !arg.chars().any(char::is_control)
}

/// URL schemes Tether can be the handler for.
pub const SCHEMES: [&str; 2] = ["ssh", "telnet"];

#[cfg(test)]
mod tests {
    use super::*;

    fn t(args: &[&str]) -> Vec<Target> {
        targets(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn reads_sessions_and_links() {
        assert_eq!(
            t(&[
                "--session",
                "Core/core-sw1",
                "ssh://admin@10.0.0.1:2222",
                "--session=edge-fw1",
                "TELNET://ts1:2003",
                "--local-shell"
            ]),
            vec![
                Target::Session("Core/core-sw1".into()),
                Target::Url("ssh://admin@10.0.0.1:2222".into()),
                Target::Session("edge-fw1".into()),
                Target::Url("TELNET://ts1:2003".into()),
                Target::Command("connect.local".into()),
            ]
        );
    }

    #[test]
    fn ignores_everything_else() {
        assert!(t(&["--flag", "file:///etc/passwd", "local://bash", "http://x", "--session"]).is_empty());
        assert!(t(&["--session", "  "]).is_empty());
        assert!(t(&["ssh://host\n--evil"]).is_empty());
    }
}
