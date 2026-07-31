//! Twice-daily local schedule configuration and idempotent run identifiers.

use std::{
	error::Error,
	fmt::{Display, Formatter},
	str::FromStr,
};

use jiff::{civil::DateTime, tz::TimeZone};
use jiff_tzdb::VERSION;
use serde::{Deserialize, Serialize};

use crate::{
	model::ModelConfig,
	protocol::{self, ProtocolError},
};

/// Schedule configuration schema version.
pub const SCHEDULE_SCHEMA_VERSION: &str = "aiq.schedule.v1";
/// Reviewed IANA Time Zone Database release embedded in every runner build.
pub const EMBEDDED_TZDB_VERSION: &str = "2026c";

/// A twice-daily local schedule.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleConfig {
	/// Schedule schema version.
	pub schema_version: String,
	/// IANA-style local time-zone name retained in slot identity.
	pub timezone: String,
	/// Local daytime start in `HH:MM` format.
	pub day_local_time: String,
	/// Local overnight start in `HH:MM` format.
	pub night_local_time: String,
}
impl ScheduleConfig {
	/// Validates the schedule without creating an external timer.
	pub fn validate(&self) -> Result<(), ScheduleError> {
		if self.schema_version != SCHEDULE_SCHEMA_VERSION {
			return Err(ScheduleError::new("unsupported schedule schema"));
		}

		validate_timezone(&self.timezone)?;
		validate_time(&self.day_local_time)?;
		validate_time(&self.night_local_time)?;

		if self.day_local_time == self.night_local_time {
			return Err(ScheduleError::new("day and night schedule times must differ"));
		}

		Ok(())
	}

	/// Creates one stable local schedule slot.
	pub fn slot(
		&self,
		local_date: &str,
		occurrence: ScheduleOccurrence,
	) -> Result<ScheduleSlot, ScheduleError> {
		self.validate()?;

		let local_time = match occurrence {
			ScheduleOccurrence::Day => self.day_local_time.clone(),
			ScheduleOccurrence::Night => self.night_local_time.clone(),
		};
		let slot = ScheduleSlot {
			local_date: local_date.to_owned(),
			occurrence,
			local_time,
			timezone: self.timezone.clone(),
		};

		slot.validate()?;

		Ok(slot)
	}

	/// Returns the exact seconds from one configured slot to the next configured slot.
	pub fn seconds_until_next_slot(&self, slot: &ScheduleSlot) -> Result<u64, ScheduleError> {
		self.validate()?;

		let expected = self.slot(&slot.local_date, slot.occurrence)?;

		if &expected != slot {
			return Err(ScheduleError::new(
				"schedule slot does not match the supplied schedule configuration",
			));
		}

		let current_ms = slot.scheduled_unix_ms()?;
		let other_occurrence = match slot.occurrence {
			ScheduleOccurrence::Day => ScheduleOccurrence::Night,
			ScheduleOccurrence::Night => ScheduleOccurrence::Day,
		};
		let same_date_other = self.slot(&slot.local_date, other_occurrence)?;
		let same_date_other_ms = same_date_other.scheduled_unix_ms()?;
		let next_ms = if same_date_other_ms > current_ms {
			same_date_other_ms
		} else {
			self.slot(&next_date(&slot.local_date)?, other_occurrence)?.scheduled_unix_ms()?
		};
		let interval_ms = next_ms.checked_sub(current_ms).ok_or_else(|| {
			ScheduleError::new("next schedule slot is not after the current slot")
		})?;

		if interval_ms == 0 || !interval_ms.is_multiple_of(1_000) {
			return Err(ScheduleError::new(
				"next schedule interval is not a positive whole second",
			));
		}

		Ok(interval_ms / 1_000)
	}
}

impl Default for ScheduleConfig {
	fn default() -> Self {
		Self {
			schema_version: SCHEDULE_SCHEMA_VERSION.to_owned(),
			timezone: "UTC".to_owned(),
			day_local_time: "15:00".to_owned(),
			night_local_time: "03:00".to_owned(),
		}
	}
}

/// One of the two daily schedule occurrences.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleOccurrence {
	/// Daytime run.
	Day,
	/// Overnight run.
	Night,
}
impl FromStr for ScheduleOccurrence {
	type Err = ScheduleError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		match value {
			"day" => Ok(Self::Day),
			"night" => Ok(Self::Night),
			_ => Err(ScheduleError::new("occurrence must be day or night")),
		}
	}
}

/// A concrete twice-daily schedule slot.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleSlot {
	/// Local calendar date.
	pub local_date: String,
	/// Day or night occurrence.
	pub occurrence: ScheduleOccurrence,
	/// Configured local time.
	pub local_time: String,
	/// Configured local time zone.
	pub timezone: String,
}
impl ScheduleSlot {
	/// Validates every identity component of a saved schedule slot.
	pub fn validate(&self) -> Result<(), ScheduleError> {
		self.scheduled_unix_ms().map(|_| ())
	}

	/// Resolves the unambiguous local slot to Unix milliseconds.
	pub fn scheduled_unix_ms(&self) -> Result<u64, ScheduleError> {
		validate_date(&self.local_date)?;
		validate_time(&self.local_time)?;
		validate_timezone(&self.timezone)?;

		resolve_scheduled_unix_ms(self)
	}
}

/// A schedule validation error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleError {
	message: String,
}
impl ScheduleError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Error for ScheduleError {}

impl Display for ScheduleError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// Returns an idempotent run identifier from stable run inputs.
pub fn idempotent_run_id(
	slot: &ScheduleSlot,
	task_set_hash: &str,
	models: &[ModelConfig],
	scoring_version: &str,
) -> Result<String, ProtocolError> {
	#[derive(Serialize)]
	struct RunIdentity<'a> {
		schema_version: &'static str,
		slot: &'a ScheduleSlot,
		task_set_hash: &'a str,
		models: &'a [ModelConfig],
		scoring_version: &'a str,
	}

	let digest = protocol::canonical_hash(&RunIdentity {
		schema_version: "aiq.run-identity.v1",
		slot,
		task_set_hash,
		models,
		scoring_version,
	})?;

	Ok(format!("run_{}", digest.trim_start_matches("sha256:")))
}

fn validate_time(value: &str) -> Result<(), ScheduleError> {
	let mut parts = value.split(':');
	let hour = parts.next().and_then(|part| part.parse::<u8>().ok());
	let minute = parts.next().and_then(|part| part.parse::<u8>().ok());

	if parts.next().is_some() || hour.is_none_or(|hour| hour > 23) || minute.is_none_or(|m| m > 59)
	{
		return Err(ScheduleError::new("schedule time must use valid HH:MM format"));
	}
	if value.len() != 5 {
		return Err(ScheduleError::new("schedule time must use zero-padded HH:MM format"));
	}

	Ok(())
}

fn validate_date(value: &str) -> Result<(), ScheduleError> {
	let bytes = value.as_bytes();

	if bytes.len() != 10
		|| bytes[4] != b'-'
		|| bytes[7] != b'-'
		|| bytes
			.iter()
			.enumerate()
			.any(|(index, byte)| !matches!(index, 4 | 7) && !byte.is_ascii_digit())
	{
		return Err(ScheduleError::new("local date must use YYYY-MM-DD format"));
	}

	let year = value[0..4].parse::<u16>().ok();
	let month = value[5..7].parse::<u8>().ok();
	let day = value[8..10].parse::<u8>().ok();
	let (Some(year), Some(month), Some(day)) = (year, month, day) else {
		return Err(ScheduleError::new("local date contains an invalid component"));
	};

	if year == 0 || !(1..=12).contains(&month) {
		return Err(ScheduleError::new("local date contains an invalid component"));
	}

	let maximum = days_in_month(year, month);

	if day == 0 || day > maximum {
		return Err(ScheduleError::new("local date is not a real Gregorian calendar date"));
	}

	Ok(())
}

fn next_date(value: &str) -> Result<String, ScheduleError> {
	validate_date(value)?;

	let mut year = value[0..4]
		.parse::<u16>()
		.map_err(|_| ScheduleError::new("local date contains an invalid component"))?;
	let mut month = value[5..7]
		.parse::<u8>()
		.map_err(|_| ScheduleError::new("local date contains an invalid component"))?;
	let mut day = value[8..10]
		.parse::<u8>()
		.map_err(|_| ScheduleError::new("local date contains an invalid component"))?;

	if day < days_in_month(year, month) {
		day += 1;
	} else if month < 12 {
		month += 1;
		day = 1;
	} else {
		year = year
			.checked_add(1)
			.filter(|year| *year <= 9_999)
			.ok_or_else(|| ScheduleError::new("next local date is outside the supported range"))?;
		month = 1;
		day = 1;
	}

	Ok(format!("{year:04}-{month:02}-{day:02}"))
}

fn days_in_month(year: u16, month: u8) -> u8 {
	let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));

	match month {
		2 if leap => 29,
		2 => 28,
		4 | 6 | 9 | 11 => 30,
		_ => 31,
	}
}

fn validate_timezone(value: &str) -> Result<(), ScheduleError> {
	validate_embedded_tzdb()?;

	TimeZone::get(value)
		.map(|_| ())
		.map_err(|_| ScheduleError::new("timezone is not present in the embedded IANA database"))
}

fn validate_embedded_tzdb() -> Result<(), ScheduleError> {
	if VERSION != Some(EMBEDDED_TZDB_VERSION) {
		return Err(ScheduleError::new(
			"embedded IANA database version does not match the reviewed runner version",
		));
	}

	Ok(())
}

fn resolve_scheduled_unix_ms(slot: &ScheduleSlot) -> Result<u64, ScheduleError> {
	let year = slot.local_date[0..4]
		.parse::<i16>()
		.map_err(|_| ScheduleError::new("local date contains an invalid component"))?;
	let month = slot.local_date[5..7]
		.parse::<i8>()
		.map_err(|_| ScheduleError::new("local date contains an invalid component"))?;
	let day = slot.local_date[8..10]
		.parse::<i8>()
		.map_err(|_| ScheduleError::new("local date contains an invalid component"))?;
	let hour = slot.local_time[0..2]
		.parse::<i8>()
		.map_err(|_| ScheduleError::new("schedule time contains an invalid component"))?;
	let minute = slot.local_time[3..5]
		.parse::<i8>()
		.map_err(|_| ScheduleError::new("schedule time contains an invalid component"))?;
	let local = DateTime::new(year, month, day, hour, minute, 0, 0)
		.map_err(|_| ScheduleError::new("local date or schedule time is invalid"))?;
	let timezone = TimeZone::get(&slot.timezone)
		.map_err(|_| ScheduleError::new("timezone is not present in the embedded IANA database"))?;
	let instant = timezone.to_ambiguous_zoned(local).unambiguous().map_err(|_| {
		ScheduleError::new(
			"schedule local time is ambiguous or does not exist in the selected timezone",
		)
	})?;

	u64::try_from(instant.timestamp().as_millisecond())
		.map_err(|_| ScheduleError::new("schedule local time precedes the Unix epoch"))
}

#[cfg(test)]
mod tests {
	use crate::{
		model::MODEL_MATRIX,
		schedule::{self, ScheduleConfig, ScheduleOccurrence},
	};

	#[test]
	fn run_identifier_is_idempotent_and_changes_with_slot() {
		let schedule = ScheduleConfig::default();

		assert_eq!(schedule.day_local_time, "15:00");
		assert_eq!(schedule.night_local_time, "03:00");

		let day = schedule
			.slot("2026-07-24", ScheduleOccurrence::Day)
			.expect("fixture slot must be valid");
		let night = schedule
			.slot("2026-07-24", ScheduleOccurrence::Night)
			.expect("fixture slot must be valid");
		let first = schedule::idempotent_run_id(&day, "sha256:tasks", &MODEL_MATRIX, "1.0.0")
			.expect("fixture must hash");
		let repeated = schedule::idempotent_run_id(&day, "sha256:tasks", &MODEL_MATRIX, "1.0.0")
			.expect("fixture must hash");
		let changed = schedule::idempotent_run_id(&night, "sha256:tasks", &MODEL_MATRIX, "1.0.0")
			.expect("fixture must hash");

		assert_eq!(first, repeated);
		assert_ne!(first, changed);
	}

	#[test]
	fn schedule_requires_two_distinct_daily_times() {
		let invalid = ScheduleConfig {
			day_local_time: "09:00".to_owned(),
			night_local_time: "09:00".to_owned(),
			..ScheduleConfig::default()
		};

		assert!(invalid.validate().is_err());
	}

	#[test]
	fn schedule_rejects_unknown_top_level_fields() {
		let schedule = serde_json::json!({
			"schema_version": schedule::SCHEDULE_SCHEMA_VERSION,
			"timezone": "Etc/UTC",
			"day_local_time": "15:00",
			"night_local_time": "03:00",
			"unexpected": true,
		});

		assert!(serde_json::from_value::<ScheduleConfig>(schedule).is_err());
	}

	#[test]
	fn next_slot_intervals_follow_both_daily_slots() {
		let schedule = ScheduleConfig {
			schema_version: schedule::SCHEDULE_SCHEMA_VERSION.to_owned(),
			timezone: "Etc/UTC".to_owned(),
			day_local_time: "09:00".to_owned(),
			night_local_time: "02:00".to_owned(),
		};
		let night = schedule.slot("2026-07-24", ScheduleOccurrence::Night).expect("night slot");
		let day = schedule.slot("2026-07-24", ScheduleOccurrence::Day).expect("day slot");

		assert_eq!(schedule.seconds_until_next_slot(&night).expect("night interval"), 7 * 3_600);
		assert_eq!(schedule.seconds_until_next_slot(&day).expect("day interval"), 17 * 3_600);
	}

	#[test]
	fn default_schedule_has_two_twelve_hour_intervals() {
		let schedule = ScheduleConfig {
			schema_version: schedule::SCHEDULE_SCHEMA_VERSION.to_owned(),
			timezone: "Etc/UTC".to_owned(),
			..ScheduleConfig::default()
		};
		let day = schedule.slot("2026-07-24", ScheduleOccurrence::Day).expect("day slot");
		let night = schedule.slot("2026-07-24", ScheduleOccurrence::Night).expect("night slot");

		assert_eq!(schedule.seconds_until_next_slot(&day).expect("day interval"), 12 * 3_600);
		assert_eq!(schedule.seconds_until_next_slot(&night).expect("night interval"), 12 * 3_600);
	}

	#[test]
	fn next_slot_interval_uses_timezone_rules_across_dst_transitions() {
		let schedule = ScheduleConfig {
			schema_version: schedule::SCHEDULE_SCHEMA_VERSION.to_owned(),
			timezone: "America/New_York".to_owned(),
			..ScheduleConfig::default()
		};
		let before_spring =
			schedule.slot("2026-03-07", ScheduleOccurrence::Day).expect("pre-spring slot");
		let before_fall =
			schedule.slot("2026-10-31", ScheduleOccurrence::Day).expect("pre-fall slot");

		assert_eq!(
			schedule.seconds_until_next_slot(&before_spring).expect("spring interval"),
			11 * 3_600
		);
		assert_eq!(
			schedule.seconds_until_next_slot(&before_fall).expect("fall interval"),
			13 * 3_600
		);
	}

	#[test]
	fn next_slot_interval_crosses_year_rollover() {
		let schedule = ScheduleConfig {
			schema_version: schedule::SCHEDULE_SCHEMA_VERSION.to_owned(),
			timezone: "Etc/UTC".to_owned(),
			..ScheduleConfig::default()
		};
		let day = schedule.slot("2026-12-31", ScheduleOccurrence::Day).expect("year-end slot");

		assert_eq!(schedule.seconds_until_next_slot(&day).expect("year interval"), 12 * 3_600);
	}

	#[test]
	fn packaged_schedule_is_cross_platform_and_valid() {
		let schedule: ScheduleConfig =
			serde_json::from_str(include_str!("../../../config/schedule.example.json"))
				.expect("packaged schedule must parse");

		assert_eq!(schedule.timezone, "Etc/UTC");
		assert_eq!(schedule.day_local_time, "15:00");
		assert_eq!(schedule.night_local_time, "03:00");
		assert!(schedule.validate().is_ok());
		assert_eq!(jiff_tzdb::VERSION, Some(schedule::EMBEDDED_TZDB_VERSION));
	}

	#[test]
	fn scheduled_unix_time_uses_the_selected_iana_timezone() {
		let new_york =
			ScheduleConfig { timezone: "America/New_York".to_owned(), ..ScheduleConfig::default() };
		let slot = new_york
			.slot("2026-07-24", ScheduleOccurrence::Day)
			.expect("summer New York slot must resolve");

		assert_eq!(slot.scheduled_unix_ms().expect("resolved slot"), 1_784_919_600_000);

		for timezone in ["UTC", "Etc/UTC"] {
			let slot =
				ScheduleConfig { timezone: timezone.to_owned(), ..ScheduleConfig::default() }
					.slot("2026-07-24", ScheduleOccurrence::Day)
					.expect("UTC slot must resolve");

			assert_eq!(slot.scheduled_unix_ms().expect("resolved UTC slot"), 1_784_905_200_000);
		}
	}

	#[test]
	fn schedule_uses_reviewed_2026c_future_rules() {
		let edmonton =
			ScheduleConfig { timezone: "America/Edmonton".to_owned(), ..ScheduleConfig::default() }
				.slot("2027-01-15", ScheduleOccurrence::Day)
				.expect("Alberta permanent UTC-06 rule");
		let casablanca = ScheduleConfig {
			timezone: "Africa/Casablanca".to_owned(),
			..ScheduleConfig::default()
		}
		.slot("2026-10-15", ScheduleOccurrence::Day)
		.expect("Morocco permanent UTC rule");

		assert_eq!(edmonton.scheduled_unix_ms().expect("Edmonton slot"), 1_800_046_800_000);
		assert_eq!(casablanca.scheduled_unix_ms().expect("Casablanca slot"), 1_792_076_400_000);
	}

	#[test]
	fn ambiguous_and_nonexistent_local_slots_fail_closed() {
		let nonexistent = ScheduleConfig {
			timezone: "America/New_York".to_owned(),
			day_local_time: "02:30".to_owned(),
			night_local_time: "03:30".to_owned(),
			..ScheduleConfig::default()
		};
		let ambiguous = ScheduleConfig {
			timezone: "America/New_York".to_owned(),
			day_local_time: "01:30".to_owned(),
			night_local_time: "03:30".to_owned(),
			..ScheduleConfig::default()
		};

		assert!(nonexistent.slot("2026-03-08", ScheduleOccurrence::Day).is_err());
		assert!(ambiguous.slot("2026-11-01", ScheduleOccurrence::Day).is_err());
	}

	#[test]
	fn schedule_rejects_impossible_dates_and_unknown_timezones() {
		assert!(ScheduleConfig::default().slot("2026-02-29", ScheduleOccurrence::Day).is_err());
		assert!(
			ScheduleConfig { timezone: "Not/A_Real_Zone".to_owned(), ..ScheduleConfig::default() }
				.validate()
				.is_err()
		);
		assert!(ScheduleConfig::default().slot("2024-02-29", ScheduleOccurrence::Day).is_ok());
		assert!(
			ScheduleConfig { timezone: "America/New_York".to_owned(), ..ScheduleConfig::default() }
				.validate()
				.is_ok()
		);
		assert!(
			ScheduleConfig { timezone: "Etc/UTC".to_owned(), ..ScheduleConfig::default() }
				.validate()
				.is_ok()
		);
	}
}
