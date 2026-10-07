use anchor_lang::prelude::*;

pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const PROFILE_SEED: &[u8] = b"profile";

pub const SPONSOR_LAYOUT: u8 = 1;
pub const PROFILE_LAYOUT: u8 = 1;

/// The largest record any deployment may allow. A sponsor sets its own limit at or under this.
pub const HARD_MAX_DATA_LEN: u16 = 4096;

/// The one account that pays for every profile and holds the deployment's settings.
///
/// It is created on Solana, funded there, then delegated to the private
/// rollup, where it pays the rent of each profile and of each profile's read
/// permission. Rent comes back to it when a profile is closed.
#[account]
#[derive(InitSpace)]
pub struct Sponsor {
    pub layout: u8,
    pub bump: u8,
    /// May change the settings, delegate, undelegate and withdraw.
    pub admin: Pubkey,
    /// Must sign every instruction that can spend rent. Held by the service
    /// that rate limits profile creation, so a stranger cannot drain the sponsor.
    pub gate: Pubkey,
    /// The rollup validator this sponsor is delegated to.
    pub validator: Pubkey,
    /// The largest record a profile may hold, in bytes.
    pub max_data_len: u16,
    /// While set, no profile is created or written. Closing stays open.
    pub paused: bool,
}

/// One wallet's record. It exists only inside the private rollup.
///
/// `data` is ciphertext the wallet encrypted on its own device. The program
/// never interprets it. `revision` rises by one with every write, so a device
/// holding an older copy cannot overwrite a newer one without reading it first.
#[account]
pub struct Profile {
    pub layout: u8,
    pub bump: u8,
    pub owner: Pubkey,
    pub revision: u64,
    pub data: Vec<u8>,
}

impl Profile {
    const FIXED_LEN: usize = 8 + 1 + 1 + 32 + 8 + 4;

    pub const fn space_for(data_len: usize) -> usize {
        Self::FIXED_LEN + data_len
    }
}
