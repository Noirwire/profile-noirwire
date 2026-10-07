#![forbid(unsafe_code)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("AiS6fT2x5XELHvZPrLfdzydC9xUazjS6r4z4bNDTqtHQ");

/// The security contact, embedded in the program. `$stamp` is where a build
/// that knows which release and commit it came from says so.
macro_rules! security_contact {
    ($($stamp:ident: $value:expr),*) => {
        #[cfg(not(feature = "no-entrypoint"))]
        solana_security_txt::security_txt! {
            name: "NoirWire Profile",
            project_url: "https://noirwire.com",
            contacts: "email:ph1l1ph@proton.me",
            policy: "https://github.com/Noirwire/profile-noirwire/blob/main/SECURITY.md",
            preferred_languages: "en",
            source_code: "https://github.com/Noirwire/profile-noirwire"
            $(, $stamp: $value)*
        }
    };
}

#[cfg(not(source_stamped))]
security_contact! {}

#[cfg(source_stamped)]
security_contact! {
    source_release: env!("SOURCE_RELEASE"),
    source_revision: env!("SOURCE_REVISION")
}

#[ephemeral]
#[program]
pub mod noirwire_profile {
    use super::*;

    pub fn initialize_sponsor(
        ctx: Context<InitializeSponsor>,
        settings: SponsorSettings,
    ) -> Result<()> {
        instructions::initialize_sponsor(ctx, settings)
    }

    pub fn update_sponsor(
        ctx: Context<AdministerSponsor>,
        settings: SponsorSettings,
    ) -> Result<()> {
        instructions::update_sponsor(ctx, settings)
    }

    pub fn nominate_admin(ctx: Context<AdministerSponsor>, nominee: Option<Pubkey>) -> Result<()> {
        instructions::nominate_admin(ctx, nominee)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin(ctx)
    }

    pub fn delegate_sponsor(ctx: Context<DelegateSponsor>, validator: Pubkey) -> Result<()> {
        instructions::delegate_sponsor(ctx, validator)
    }

    pub fn undelegate_sponsor(ctx: Context<UndelegateSponsor>) -> Result<()> {
        instructions::undelegate_sponsor(ctx)
    }

    pub fn withdraw_sponsor(ctx: Context<WithdrawSponsor>, lamports: u64) -> Result<()> {
        instructions::withdraw_sponsor(ctx, lamports)
    }

    pub fn create_profile(ctx: Context<CreateProfile>, data: Vec<u8>) -> Result<()> {
        instructions::create_profile(ctx, data)
    }

    pub fn write_profile(
        ctx: Context<WriteProfile>,
        expected_revision: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::write_profile(ctx, expected_revision, data)
    }

    pub fn close_profile(ctx: Context<CloseProfile>) -> Result<()> {
        instructions::close_profile(ctx)
    }
}
