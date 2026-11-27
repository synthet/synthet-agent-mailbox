//! The agent-mail tray (ADR 0005): a loopback dashboard over `mail.db`, the mailer's status, the
//! dispatch kill switch, and the consumer that answers received mail or runs a headless agent for
//! it. The tray icon and menu live in `main.rs`; this library is what the tests drive.

pub mod consumer;
pub mod dashboard;
pub mod live;
pub mod runner;
