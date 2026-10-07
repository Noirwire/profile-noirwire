use anchor_lang::prelude::*;

/// Clients match these by name or by number, so a new one goes at the end.
#[error_code]
pub enum ProfileError {
    #[msg("Only the program's upgrade authority may set up the sponsor")]
    NotUpgradeAuthority,
    #[msg("Only the sponsor's admin may do this")]
    NotAdmin,
    #[msg("The gate key did not sign")]
    GateMissing,
    #[msg("Profiles are paused")]
    Paused,
    #[msg("The record is empty")]
    EmptyRecord,
    #[msg("The record is larger than this deployment allows")]
    RecordTooLarge,
    #[msg("The size limit is zero or above the hard maximum")]
    InvalidSizeLimit,
    #[msg("This profile already exists")]
    ProfileExists,
    #[msg("This profile does not exist")]
    ProfileMissing,
    #[msg("The profile belongs to another key")]
    NotOwner,
    #[msg("The profile changed since it was read")]
    StaleRevision,
    #[msg("The profile was written by a newer program layout")]
    UnknownLayout,
    #[msg("The sponsor must keep its own rent")]
    BelowRent,
    #[msg("Arithmetic overflow")]
    Overflow,
}
