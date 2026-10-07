use anchor_lang::prelude::*;

use crate::errors::ProfileError;

pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const PROFILE_SEED: &[u8] = b"profile";

/// The seed the permission program derives a permission's address from,
/// followed by the address of the account it guards.
pub const PERMISSION_SEED: &[u8] = b"permission:";

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
    pub bump: u8,
    /// May change the settings, delegate, undelegate, withdraw and name a successor.
    pub admin: Pubkey,
    /// The key the admin has offered the role to. It becomes the admin only
    /// by signing its acceptance, so the role cannot be sent to a key nobody holds.
    pub pending_admin: Option<Pubkey>,
    /// Must sign every instruction that can spend rent. Held by the service
    /// that rate limits profile creation, so a stranger cannot drain the sponsor.
    pub gate: Pubkey,
    /// The largest record a profile may hold, in bytes.
    pub max_data_len: u16,
    /// While set, no profile is created or written. Closing stays open.
    pub paused: bool,
}

impl Sponsor {
    pub fn signer_seeds(&self) -> [&[u8]; 2] {
        [SPONSOR_SEED, std::slice::from_ref(&self.bump)]
    }

    /// Whether this deployment will pay to store `data` right now.
    pub fn accepts(&self, data: &[u8]) -> Result<()> {
        require!(!self.paused, ProfileError::Paused);
        require!(!data.is_empty(), ProfileError::EmptyRecord);
        require!(
            data.len() <= self.max_data_len as usize,
            ProfileError::RecordTooLarge
        );
        Ok(())
    }
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

    pub fn first(owner: Pubkey, bump: u8, data: Vec<u8>) -> Self {
        Self {
            layout: PROFILE_LAYOUT,
            bump,
            owner,
            revision: 1,
            data,
        }
    }

    /// The record that replaces this one, but only for a writer who read this revision.
    pub fn next(self, expected_revision: u64, data: Vec<u8>) -> Result<Self> {
        require!(
            self.revision == expected_revision,
            ProfileError::StaleRevision
        );
        Ok(Self {
            revision: self.revision.checked_add(1).ok_or(ProfileError::Overflow)?,
            data,
            ..self
        })
    }

    pub fn space(&self) -> usize {
        Self::FIXED_LEN + self.data.len()
    }

    pub fn signer_seeds(&self) -> [&[u8]; 3] {
        [
            PROFILE_SEED,
            self.owner.as_ref(),
            std::slice::from_ref(&self.bump),
        ]
    }
}
