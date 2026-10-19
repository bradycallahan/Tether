//! Serial consoles (Cisco rollover cables, USB-serial adapters, etc.).

use crate::conn::{CmdError, CmdResult, Ctl, Output};
use crate::model::{FlowControl, Parity};
use serde::Serialize;
use serialport::{DataBits, SerialPortType, StopBits};
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

pub fn list_ports() -> Vec<PortInfo> {
    let mut ports: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                SerialPortType::UsbPort(u) => {
                    let mut parts = Vec::new();
                    if let Some(m) = u.manufacturer { parts.push(m) }
                    if let Some(pr) = u.product { parts.push(pr) }
                    if parts.is_empty() { format!("USB {:04x}:{:04x}", u.vid, u.pid) } else { parts.join(" ") }
                }
                SerialPortType::BluetoothPort => "Bluetooth".into(),
                SerialPortType::PciPort => "Built-in".into(),
                SerialPortType::Unknown => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect();
    ports.sort_by_key(|p| natural_key(&p.name));
    ports
}

/// "COM10" sorts after "COM9".
fn natural_key(s: &str) -> (String, u32) {
    let digits: String = s.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    let prefix = s[..s.len() - digits.len()].to_lowercase();
    (prefix, digits.parse().unwrap_or(0))
}

pub struct Params {
    pub port: String,
    pub baud: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub flow: FlowControl,
}

pub async fn start(p: Params, out: Output, mut rx: mpsc::UnboundedReceiver<Ctl>) -> CmdResult<()> {
    out.status("connecting", format!("Opening {} at {} baud…", p.port, p.baud));
    let builder = serialport::new(&p.port, p.baud)
        .data_bits(match p.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .parity(match p.parity {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        })
        .stop_bits(if p.stop_bits == 2 { StopBits::Two } else { StopBits::One })
        .flow_control(match p.flow {
            FlowControl::None => serialport::FlowControl::None,
            FlowControl::Software => serialport::FlowControl::Software,
            FlowControl::Hardware => serialport::FlowControl::Hardware,
        })
        .timeout(Duration::from_millis(50));
    let mut port = builder.open().map_err(|e| {
        let hint = match e.kind {
            serialport::ErrorKind::NoDevice => " Is the cable plugged in?",
            serialport::ErrorKind::Io(ErrorKind::PermissionDenied) => {
                if cfg!(target_os = "linux") { " On Linux, add yourself to the dialout group." } else { " Another program may have the port open." }
            }
            _ => "",
        };
        CmdError::new("SERIAL", format!("Could not open {}: {e}.{hint}", p.port))
    })?;
    let mut reader = port.try_clone().map_err(|e| CmdError::new("SERIAL", e.to_string()))?;
    let stop = Arc::new(AtomicBool::new(false));

    let reader_out = out.clone();
    let reader_stop = stop.clone();
    let port_name = p.port.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut reason = format!("{port_name} closed.");
        while !reader_stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => continue,
                Ok(n) => reader_out.data(&buf[..n]),
                Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => {
                    reason = format!("{port_name} disconnected: {e}");
                    break;
                }
            }
        }
        reader_out.status("closed", reason);
    });

    tokio::spawn(async move {
        while let Some(ctl) = rx.recv().await {
            match ctl {
                Ctl::Write(bytes) => {
                    if port.write_all(&bytes).is_err() {
                        break;
                    }
                }
                Ctl::Resize(..) => {}
                Ctl::Break => {
                    // ~300 ms break: what ROMMON / password recovery wants.
                    let _ = port.set_break();
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    let _ = port.clear_break();
                }
                Ctl::Close => break,
            }
        }
        stop.store(true, Ordering::Relaxed);
    });

    out.status("connected", format!("{} open at {} baud", p.port, p.baud));
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn natural_sort() {
        let mut v = vec!["COM10", "COM2", "COM1", "/dev/ttyUSB0"];
        v.sort_by_key(|s| super::natural_key(s));
        assert_eq!(v, vec!["/dev/ttyUSB0", "COM1", "COM2", "COM10"]);
    }
}
