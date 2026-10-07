#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod errors;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("AiS6fT2x5XELHvZPrLfdzydC9xUazjS6r4z4bNDTqtHQ");

#[ephemeral]
#[program]
pub mod noirwire_profile {
    use super::*;

    pub fn initialize_sponsor(
        ctx: Context<InitializeSponsor>,
        settings: SponsorSettings,
        lamports: u64,
    ) -> Result<()> {
        instructions::initialize_sponsor(ctx, settings, lamports)
    }

    pub fn fund_sponsor(ctx: Context<FundSponsor>, lamports: u64) -> Result<()> {
        instructions::fund_sponsor(ctx, lamports)
    }

    pub fn update_sponsor(ctx: Context<UpdateSponsor>, settings: SponsorSettings) -> Result<()> {
        instructions::update_sponsor(ctx, settings)
    }

    pub fn withdraw_sponsor(ctx: Context<WithdrawSponsor>, lamports: u64) -> Result<()> {
        instructions::withdraw_sponsor(ctx, lamports)
    }

    pub fn delegate_sponsor(ctx: Context<DelegateSponsor>) -> Result<()> {
        instructions::delegate_sponsor(ctx)
    }

    pub fn undelegate_sponsor(ctx: Context<UndelegateSponsor>) -> Result<()> {
        instructions::undelegate_sponsor(ctx)
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
