use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::ProfileError;
use crate::program::NoirwireProfile;
use crate::state::{Sponsor, HARD_MAX_DATA_LEN, SPONSOR_SEED};

/// What the admin may change after the sponsor exists.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SponsorSettings {
    pub gate: Pubkey,
    pub max_data_len: u16,
    pub paused: bool,
}

impl SponsorSettings {
    fn apply_to(self, sponsor: &mut Sponsor) -> Result<()> {
        require!(
            self.max_data_len > 0 && self.max_data_len <= HARD_MAX_DATA_LEN,
            ProfileError::InvalidSizeLimit
        );
        sponsor.gate = self.gate;
        sponsor.max_data_len = self.max_data_len;
        sponsor.paused = self.paused;
        Ok(())
    }
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

/// Creates the sponsor on Solana. Only the program's upgrade authority may,
/// so nobody can claim the one sponsor address before the deployer does.
pub fn initialize_sponsor(
    ctx: Context<InitializeSponsor>,
    settings: SponsorSettings,
) -> Result<()> {
    let sponsor = &mut ctx.accounts.sponsor;
    sponsor.bump = ctx.bumps.sponsor;
    sponsor.admin = ctx.accounts.admin.key();
    sponsor.pending_admin = None;
    settings.apply_to(sponsor)
}

/// The admin and the sponsor, for the instructions that only change what the
/// sponsor stores. They are sent to wherever the sponsor lives at the time:
/// the rollup while delegated, Solana otherwise.
#[derive(Accounts)]
pub struct AdministerSponsor<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        has_one = admin @ ProfileError::NotAdmin
    )]
    pub sponsor: Account<'info, Sponsor>,
}

/// Changes the gate, the size limit or the pause.
pub fn update_sponsor(ctx: Context<AdministerSponsor>, settings: SponsorSettings) -> Result<()> {
    settings.apply_to(&mut ctx.accounts.sponsor)
}

/// Offers the admin role to `nominee`, replacing any earlier offer. `None`
/// withdraws it. Nothing changes hands until the nominee accepts.
pub fn nominate_admin(ctx: Context<AdministerSponsor>, nominee: Option<Pubkey>) -> Result<()> {
    ctx.accounts.sponsor.pending_admin = nominee;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub nominee: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        constraint = sponsor.pending_admin == Some(nominee.key()) @ ProfileError::NotNominee
    )]
    pub sponsor: Account<'info, Sponsor>,
}

/// Makes the nominee the admin. The admin before it keeps nothing.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let sponsor = &mut ctx.accounts.sponsor;
    sponsor.admin = ctx.accounts.nominee.key();
    sponsor.pending_admin = None;
    Ok(())
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

/// Moves the sponsor, with its balance, to the rollup run by `validator`.
pub fn delegate_sponsor(ctx: Context<DelegateSponsor>, validator: Pubkey) -> Result<()> {
    let accounts = &ctx.accounts;
    require_keys_eq!(
        stored_admin(&accounts.sponsor)?,
        accounts.admin.key(),
        ProfileError::NotAdmin
    );
    accounts.delegate_sponsor(
        &accounts.admin,
        &[SPONSOR_SEED],
        DelegateConfig {
            validator: Some(validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

fn stored_admin(sponsor: &AccountInfo) -> Result<Pubkey> {
    require_keys_eq!(
        *sponsor.owner,
        crate::ID,
        ErrorCode::AccountOwnedByWrongProgram
    );
    let data = sponsor.try_borrow_data()?;
    Ok(Sponsor::try_deserialize(&mut &data[..])?.admin)
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

/// Sent to the rollup. Brings the sponsor back to Solana with the balance it
/// has there. Profiles stay where they are and keep the rent already paid.
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

/// Pays the admin out of the sponsor's balance, down to its own rent and no
/// further. Meant for the undelegated sponsor on Solana: undelegate first.
///
/// The program owns the sponsor, so it moves the lamports itself. The system
/// program would refuse to debit an account that carries data.
pub fn withdraw_sponsor(ctx: Context<WithdrawSponsor>, lamports: u64) -> Result<()> {
    let sponsor = ctx.accounts.sponsor.to_account_info();
    let admin = ctx.accounts.admin.to_account_info();

    let rent = Rent::get()?.minimum_balance(sponsor.data_len());
    let remaining = sponsor
        .lamports()
        .checked_sub(lamports)
        .ok_or(ProfileError::BelowRent)?;
    require!(remaining >= rent, ProfileError::BelowRent);
    let paid = admin
        .lamports()
        .checked_add(lamports)
        .ok_or(ProfileError::Overflow)?;

    **sponsor.try_borrow_mut_lamports()? = remaining;
    **admin.try_borrow_mut_lamports()? = paid;
    Ok(())
}
