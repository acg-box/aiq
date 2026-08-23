//! Canonical UTC observation slots.

use std::time::{SystemTime, UNIX_EPOCH};

use jiff::{
	Timestamp,
	civil::{Date, DateTime},
	tz::Offset,
};
use serde::Serialize;

use crate::{Error, Result, ResultContext};

/// Observation slot identifier used by contract tests.
pub const SLOT_EXAMPLE: &str = "2026-08-10T03-00Z";

const HALF_DAY_MILLISECONDS: i64 = 12 * 60 * 60 * 1_000;

/// One canonical scheduled observation slot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ScheduledSlot {
	/// Filesystem-safe UTC slot identity.
	pub id: String,
	/// UTC date supplied to the Official runner.
	pub slot_date: String,
	/// Named occurrence supplied to the Official runner.
	pub occurrence: &'static str,
	/// Exact provenance observation timestamp.
	pub observed_at: String,
	/// Unix timestamp in milliseconds.
	pub timestamp_ms: i64,
}

/// The latest due slot and the next scheduled slot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SurroundingSlots {
	/// Latest slot whose scheduled instant is not after `now`.
	pub latest: ScheduledSlot,
	/// First slot whose scheduled instant is after `now`.
	pub next: ScheduledSlot,
}

/// Returns the canonical slots surrounding the current system time.
///
/// # Errors
///
/// Returns an error when the system time cannot be represented by the supported UTC range.
pub fn current_surrounding_slots() -> Result<SurroundingSlots> {
	let milliseconds = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.context("current system time is before the Unix epoch")?
		.as_millis();
	let milliseconds = i64::try_from(milliseconds)
		.context("current system time is outside the supported range")?;
	let now = Timestamp::from_millisecond(milliseconds)
		.context("current system time is outside the supported range")?;

	surrounding_slots(now)
}

/// Returns the canonical UTC slots surrounding `now`.
///
/// # Errors
///
/// Returns an error when a surrounding slot cannot be represented as a UTC timestamp.
pub fn surrounding_slots(now: Timestamp) -> Result<SurroundingSlots> {
	let civil = Offset::UTC.to_datetime(now);
	let night = slot_timestamp(civil, 3)?;
	let day = slot_timestamp(civil, 15)?;
	let now_ms = now.as_millisecond();

	if now_ms < night {
		return Ok(SurroundingSlots {
			latest: slot_from_milliseconds(night - HALF_DAY_MILLISECONDS)?,
			next: slot_from_milliseconds(night)?,
		});
	}
	if now_ms < day {
		return Ok(SurroundingSlots {
			latest: slot_from_milliseconds(night)?,
			next: slot_from_milliseconds(day)?,
		});
	}

	Ok(SurroundingSlots {
		latest: slot_from_milliseconds(day)?,
		next: slot_from_milliseconds(day + HALF_DAY_MILLISECONDS)?,
	})
}

/// Parses one exact `YYYY-MM-DDT03-00Z` or `YYYY-MM-DDT15-00Z` slot identity.
///
/// # Errors
///
/// Returns an error when `id` is not a canonical supported UTC slot.
pub fn scheduled_slot(id: &str) -> Result<ScheduledSlot> {
	if !id.is_ascii() || id.len() != SLOT_EXAMPLE.len() || !id.ends_with("-00Z") {
		return Err(Error::new("slot must use YYYY-MM-DDT03-00Z or YYYY-MM-DDT15-00Z"));
	}

	let date: Date = id[..10].parse().context("slot date is invalid")?;
	let hour = match &id[11..13] {
		"03" => 3,
		"15" => 15,
		_ => return Err(Error::new("slot hour must be 03 or 15 UTC")),
	};

	if id.as_bytes().get(10) != Some(&b'T') {
		return Err(Error::new("slot must separate its UTC date and hour with T"));
	}

	let datetime = DateTime::new(date.year(), date.month(), date.day(), hour, 0, 0, 0)
		.context("slot datetime is invalid")?;
	let timestamp = Offset::UTC.to_timestamp(datetime).context("slot timestamp is invalid")?;
	let slot = slot_from_milliseconds(timestamp.as_millisecond())?;

	if slot.id != id {
		return Err(Error::new("slot identity is not canonical"));
	}

	Ok(slot)
}

fn slot_timestamp(civil: DateTime, hour: i8) -> Result<i64> {
	let datetime = DateTime::new(civil.year(), civil.month(), civil.day(), hour, 0, 0, 0)
		.context("scheduled UTC datetime is invalid")?;

	Offset::UTC
		.to_timestamp(datetime)
		.context("scheduled UTC timestamp is invalid")
		.map(Timestamp::as_millisecond)
}

fn slot_from_milliseconds(timestamp_ms: i64) -> Result<ScheduledSlot> {
	let timestamp = Timestamp::from_millisecond(timestamp_ms)
		.context("scheduled timestamp is outside the supported range")?;
	let civil = Offset::UTC.to_datetime(timestamp);
	let hour = civil.hour();
	let occurrence = match hour {
		3 => "night",
		15 => "day",
		_ => return Err(Error::new("scheduled timestamp is not a 03:00 or 15:00 UTC slot")),
	};
	let slot_date = format!("{:04}-{:02}-{:02}", civil.year(), civil.month(), civil.day());

	Ok(ScheduledSlot {
		id: format!("{slot_date}T{hour:02}-00Z"),
		slot_date,
		occurrence,
		observed_at: format!("unix-ms:{timestamp_ms}"),
		timestamp_ms,
	})
}

#[cfg(test)]
mod tests {
	use jiff::Timestamp;

	use crate::schedule::{self, SLOT_EXAMPLE};

	fn timestamp(value: &str) -> Timestamp {
		value.parse().expect("valid test timestamp")
	}

	#[test]
	fn selects_exact_utc_slots() {
		let before =
			schedule::surrounding_slots(timestamp("2026-08-10T02:59:59.999Z")).expect("slots");

		assert_eq!(before.latest.id, "2026-08-09T15-00Z");
		assert_eq!(before.next.id, "2026-08-10T03-00Z");

		let at_night =
			schedule::surrounding_slots(timestamp("2026-08-10T03:00:00Z")).expect("slots");

		assert_eq!(at_night.latest.id, SLOT_EXAMPLE);
		assert_eq!(at_night.latest.observed_at, "unix-ms:1786330800000");
		assert_eq!(at_night.next.id, "2026-08-10T15-00Z");

		let after_day =
			schedule::surrounding_slots(timestamp("2026-08-10T20:00:00Z")).expect("slots");

		assert_eq!(after_day.latest.id, "2026-08-10T15-00Z");
		assert_eq!(after_day.next.id, "2026-08-11T03-00Z");
	}

	#[test]
	fn parses_only_canonical_slot_identities() {
		assert_eq!(schedule::scheduled_slot(SLOT_EXAMPLE).expect("slot").occurrence, "night");
		assert!(schedule::scheduled_slot("2026-08-10T04-00Z").is_err());
		assert!(schedule::scheduled_slot("2026-8-10T03-00Z").is_err());
	}
}
