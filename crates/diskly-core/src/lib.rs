//! Diskly's thin layer over the Diskghost core.
//!
//! The core scans one directory tree and compares two snapshots of it. This
//! crate adds what a disk-history tool needs on top, using the core's public
//! API: which volumes exist and whether a scan is really of the same one
//! ([`volumes`]), scanning several at once and finding what could not be read
//! ([`scan`]), keeping history safely ([`store`]), making snapshots comparable
//! without ever presenting the unknown as a change ([`compare`]), finding where
//! the space went ([`insights`]), and turning it all into one offline file
//! ([`report`], [`session`]).
//!
//! Nothing in here writes outside Diskly's own data folder.

pub mod compare;
pub mod insights;
pub mod report;
pub mod scan;
pub mod session;
pub mod store;
pub mod volumes;
