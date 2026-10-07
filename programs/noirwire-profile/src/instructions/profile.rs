use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::ephemeral_accounts;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID};

use crate::errors::ProfileError;
use crate::state::{Profile, Sponsor, PERMISSION_SEED, PROFILE_LAYOUT, PROFILE_SEED, SPONSOR_SEED};

const OWNER_READS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

/// Reads the owner's record and refuses anything this program did not write
/// at this address, before the caller changes a byte.
fn stored(profile: &AccountInfo, owner: &Pubkey, bump: u8) -> Result<Profile> {
    require!(!profile.data_is_empty(), ProfileError::ProfileMissing);
    require_keys_eq!(
        *profile.owner,
        crate::ID,
        ErrorCode::AccountOwnedByWrongProgram
    );
    let record = {
        let data = profile.try_borrow_data()?;
        Profile::try_deserialize(&mut &data[..])?
    };
    require!(record.layout == PROFILE_LAYOUT, ProfileError::UnknownLayout);
    require!(record.bump == bump, ErrorCode::ConstraintSeeds);
    require_keys_eq!(record.owner, *owner, ProfileError::NotOwner);
    Ok(record)
}

fn store(profile: &AccountInfo, record: &Profile) -> Result<()> {
    let mut data = profile.try_borrow_mut_data()?;
    data.fill(0);
    record.try_serialize(&mut &mut data[..])
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CreateProfile<'info> {
    #[account(address = sponsor.gate @ ProfileError::GateMissing)]
    pub gate: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, sponsor, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: The owner's profile PDA, created here inside the rollup.
    #[account(mut, eph, seeds = [PROFILE_SEED, owner.key().as_ref()], bump)]
    pub profile: UncheckedAccount<'info>,
    /// CHECK: The profile's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, profile.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
}

/// Creates the profile and its read permission in one step, so the record is
/// never readable by anyone but its owner, not even between two transactions.
pub fn create_profile(ctx: Context<CreateProfile>, data: Vec<u8>) -> Result<()> {
    let accounts = &ctx.accounts;
    accounts.sponsor.accepts(&data)?;
    require!(
        accounts.profile.data_is_empty(),
        ProfileError::ProfileExists
    );

    let record = Profile::first(accounts.owner.key(), ctx.bumps.profile, data);
    accounts.create_ephemeral_profile(record.space() as u32)?;
    store(&accounts.profile, &record)?;
    accounts.let_only_the_owner_read(&record)
}

impl CreateProfile<'_> {
    /// The sponsor pays for the permission and the profile owns it, so both sign.
    fn let_only_the_owner_read(&self, record: &Profile) -> Result<()> {
        CreateEphemeralPermissionCpi {
            payer: self.sponsor.to_account_info(),
            permissioned_account: self.profile.to_account_info(),
            permission: self.permission.to_account_info(),
            vault: self.vault.to_account_info(),
            magic_program: self.magic_program.to_account_info(),
            permission_program: self.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: OWNER_READS,
                    pubkey: record.owner,
                }],
            },
        }
        .invoke_signed(&[&self.sponsor.signer_seeds(), &record.signer_seeds()])?;
        Ok(())
    }
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct WriteProfile<'info> {
    #[account(address = sponsor.gate @ ProfileError::GateMissing)]
    pub gate: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, sponsor, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: The owner's profile PDA. What it holds is checked in the handler.
    #[account(mut, eph, seeds = [PROFILE_SEED, owner.key().as_ref()], bump)]
    pub profile: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
}

/// Replaces the record, but only on top of the revision the writer last read.
/// The sponsor pays for any growth and is repaid for any shrinkage.
pub fn write_profile(
    ctx: Context<WriteProfile>,
    expected_revision: u64,
    data: Vec<u8>,
) -> Result<()> {
    let accounts = &ctx.accounts;
    accounts.sponsor.accepts(&data)?;

    let current = stored(&accounts.profile, accounts.owner.key, ctx.bumps.profile)?;
    let next = current.next(expected_revision, data)?;
    if next.space() != accounts.profile.data_len() {
        accounts.resize_ephemeral_profile(next.space() as u32)?;
    }
    store(&accounts.profile, &next)
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CloseProfile<'info> {
    pub owner: Signer<'info>,
    #[account(mut, sponsor, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: The owner's profile PDA. What it holds is checked in the handler.
    #[account(mut, eph, seeds = [PROFILE_SEED, owner.key().as_ref()], bump)]
    pub profile: UncheckedAccount<'info>,
    /// CHECK: The profile's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, profile.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
}

/// Removes the record and its permission. The rent goes back to the sponsor.
/// The owner needs nobody's leave to delete their own record.
pub fn close_profile(ctx: Context<CloseProfile>) -> Result<()> {
    let accounts = &ctx.accounts;
    let record = stored(&accounts.profile, accounts.owner.key, ctx.bumps.profile)?;
    accounts.close_permission(&record)?;
    accounts.close_ephemeral_profile()
}

impl CloseProfile<'_> {
    /// The sponsor is repaid and the profile owns the permission, so both sign.
    fn close_permission(&self, record: &Profile) -> Result<()> {
        CloseEphemeralPermissionCpi {
            payer: self.sponsor.to_account_info(),
            authority: self.profile.to_account_info(),
            permissioned_account: self.profile.to_account_info(),
            permission: self.permission.to_account_info(),
            vault: self.vault.to_account_info(),
            magic_program: self.magic_program.to_account_info(),
            permission_program: self.permission_program.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&self.sponsor.signer_seeds(), &record.signer_seeds()])?;
        Ok(())
    }
}
