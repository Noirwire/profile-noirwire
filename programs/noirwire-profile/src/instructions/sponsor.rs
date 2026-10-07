use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::ProfileError;
use crate::program::NoirwireProfile;
use crate::state::{Sponsor, HARD_MAX_DATA_LEN, SPONSOR_LAYOUT, SPONSOR_SEED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SponsorSettings {
    pub gate: Pubkey,
    pub validator: Pubkey,
    pub max_data_len: u16,
    pub paused: bool,
}

impl SponsorSettings {
    fn checked(&self) -> Result<()> {
        require!(
            self.max_data_len > 0 && self.max_data_len <= HARD_MAX_DATA_LEN,
            ProfileError::InvalidSizeLimit
        );
        Ok(())
    }

    fn apply(self, sponsor: &mut Sponsor) {
        sponsor.gate = self.gate;
        sponsor.validator = self.validator;
        sponsor.max_data_len = self.max_data_len;
        sponsor.paused = self.paused;
    }
}

pub fn initialize_sponsor(
    ctx: Context<InitializeSponsor>,
    settings: SponsorSettings,
    lamports: u64,
) -> Result<()> {
    settings.checked()?;

    let sponsor = &mut ctx.accounts.sponsor;
    sponsor.layout = SPONSOR_LAYOUT;
    sponsor.bump = ctx.bumps.sponsor;
    sponsor.admin = ctx.accounts.admin.key();
    settings.apply(sponsor);

    if lamports > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.sponsor.to_account_info(),
                },
            ),
            lamports,
        )?;
    }
    Ok(())
}

pub fn fund_sponsor(ctx: Context<FundSponsor>, lamports: u64) -> Result<()> {
    require!(lamports > 0, ProfileError::ZeroAmount);
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.sponsor.to_account_info(),
            },
        ),
        lamports,
    )
}

pub fn update_sponsor(ctx: Context<UpdateSponsor>, settings: SponsorSettings) -> Result<()> {
    settings.checked()?;
    settings.apply(&mut ctx.accounts.sponsor);
    Ok(())
}

pub fn withdraw_sponsor(ctx: Context<WithdrawSponsor>, lamports: u64) -> Result<()> {
    require!(lamports > 0, ProfileError::ZeroAmount);

    let sponsor = ctx.accounts.sponsor.to_account_info();
    let admin = ctx.accounts.admin.to_account_info();
    let rent = Rent::get()?.minimum_balance(sponsor.data_len());
    let remaining = sponsor
        .lamports()
        .checked_sub(lamports)
        .ok_or(ProfileError::BelowRent)?;
    require!(remaining >= rent, ProfileError::BelowRent);

    **sponsor.try_borrow_mut_lamports()? = remaining;
    **admin.try_borrow_mut_lamports()? = admin
        .lamports()
        .checked_add(lamports)
        .ok_or(ProfileError::Overflow)?;
    Ok(())
}

pub fn delegate_sponsor(ctx: Context<DelegateSponsor>) -> Result<()> {
    let stored = {
        let data = ctx.accounts.sponsor.try_borrow_data()?;
        Sponsor::try_deserialize(&mut &data[..])?
    };
    require_keys_eq!(stored.admin, ctx.accounts.admin.key(), ProfileError::NotAdmin);

    ctx.accounts.delegate_sponsor(
        &ctx.accounts.admin,
        &[SPONSOR_SEED],
        DelegateConfig {
            validator: Some(stored.validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

pub fn undelegate_sponsor(ctx: Context<UndelegateSponsor>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.admin.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.sponsor.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Sponsor::INIT_SPACE,
        seeds = [SPONSOR_SEED],
        bump
    )]
    pub sponsor: Account<'info, Sponsor>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ ProfileError::NotUpgradeAuthority
    )]
    pub program: Program<'info, NoirwireProfile>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ ProfileError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSponsor<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSponsor<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        has_one = admin @ ProfileError::NotAdmin
    )]
    pub sponsor: Account<'info, Sponsor>,
}

#[derive(Accounts)]
pub struct WithdrawSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        has_one = admin @ ProfileError::NotAdmin
    )]
    pub sponsor: Account<'info, Sponsor>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: The sponsor PDA. Its seeds are checked here and again by the
    /// delegation call; its stored admin is compared in the handler. Left
    /// unchecked so Anchor does not write stale data back after ownership moves.
    #[account(mut, del, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        has_one = admin @ ProfileError::NotAdmin
    )]
    pub sponsor: Account<'info, Sponsor>,
}
