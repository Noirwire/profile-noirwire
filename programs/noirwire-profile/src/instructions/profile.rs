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
use crate::state::{Profile, Sponsor, PROFILE_LAYOUT, PROFILE_SEED, SPONSOR_SEED};

const OWNER_READS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

fn checked_len(sponsor: &Sponsor, data: &[u8]) -> Result<()> {
    require!(!sponsor.paused, ProfileError::Paused);
    require!(!data.is_empty(), ProfileError::EmptyRecord);
    require!(
        data.len() <= sponsor.max_data_len as usize,
        ProfileError::RecordTooLarge
    );
    Ok(())
}

fn stored(profile: &AccountInfo) -> Result<Profile> {
    require!(!profile.data_is_empty(), ProfileError::ProfileMissing);
    let data = profile.try_borrow_data()?;
    let read = Profile::try_deserialize(&mut &data[..])?;
    require!(read.layout == PROFILE_LAYOUT, ProfileError::UnknownLayout);
    Ok(read)
}

fn store(profile: &AccountInfo, record: &Profile) -> Result<()> {
    let mut data = profile.try_borrow_mut_data()?;
    data.fill(0);
    record.try_serialize(&mut &mut data[..])
}

/// Creates the profile and its read permission in one step, so the record is
/// never readable by anyone but its owner, not even between two transactions.
pub fn create_profile(ctx: Context<CreateProfile>, data: Vec<u8>) -> Result<()> {
    checked_len(&ctx.accounts.sponsor, &data)?;
    require!(
        ctx.accounts.profile.data_is_empty(),
        ProfileError::ProfileExists
    );

    ctx.accounts
        .create_ephemeral_profile(Profile::space_for(data.len()) as u32)?;

    let owner = ctx.accounts.owner.key();
    let bump = ctx.bumps.profile;
    store(
        &ctx.accounts.profile.to_account_info(),
        &Profile {
            layout: PROFILE_LAYOUT,
            bump,
            owner,
            revision: 1,
            data,
        },
    )?;

    let sponsor_signer: &[&[u8]] = &[SPONSOR_SEED, &[ctx.accounts.sponsor.bump]];
    let profile_signer: &[&[u8]] = &[PROFILE_SEED, owner.as_ref(), &[bump]];
    CreateEphemeralPermissionCpi {
        payer: ctx.accounts.sponsor.to_account_info(),
        permissioned_account: ctx.accounts.profile.to_account_info(),
        permission: ctx.accounts.permission.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private: true,
            members: vec![Member {
                flags: OWNER_READS,
                pubkey: owner,
            }],
        },
    }
    .invoke_signed(&[sponsor_signer, profile_signer])?;
    Ok(())
}

/// Replaces the record, but only on top of the revision the writer last read.
pub fn write_profile(
    ctx: Context<WriteProfile>,
    expected_revision: u64,
    data: Vec<u8>,
) -> Result<()> {
    checked_len(&ctx.accounts.sponsor, &data)?;

    let profile = ctx.accounts.profile.to_account_info();
    let current = stored(&profile)?;
    require_keys_eq!(current.owner, ctx.accounts.owner.key(), ProfileError::NotOwner);
    require!(
        current.revision == expected_revision,
        ProfileError::StaleRevision
    );

    let space = Profile::space_for(data.len());
    if space != profile.data_len() {
        ctx.accounts.resize_ephemeral_profile(space as u32)?;
    }

    store(
        &profile,
        &Profile {
            revision: current
                .revision
                .checked_add(1)
                .ok_or(ProfileError::Overflow)?,
            data,
            ..current
        },
    )
}

/// Removes the record and its permission. The rent goes back to the sponsor.
/// The owner needs nobody's leave to delete their own record.
pub fn close_profile(ctx: Context<CloseProfile>) -> Result<()> {
    let profile = ctx.accounts.profile.to_account_info();
    let current = stored(&profile)?;
    let owner = ctx.accounts.owner.key();
    require_keys_eq!(current.owner, owner, ProfileError::NotOwner);

    let sponsor_signer: &[&[u8]] = &[SPONSOR_SEED, &[ctx.accounts.sponsor.bump]];
    let profile_signer: &[&[u8]] = &[PROFILE_SEED, owner.as_ref(), &[current.bump]];
    CloseEphemeralPermissionCpi {
        payer: ctx.accounts.sponsor.to_account_info(),
        authority: profile.clone(),
        permissioned_account: profile.clone(),
        permission: ctx.accounts.permission.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        authority_is_signer: false,
    }
    .invoke_signed(&[sponsor_signer, profile_signer])?;

    ctx.accounts.close_ephemeral_profile()?;
    Ok(())
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
    /// CHECK: The profile's permission account. The permission program derives and checks it.
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct WriteProfile<'info> {
    #[account(address = sponsor.gate @ ProfileError::GateMissing)]
    pub gate: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, sponsor, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: The owner's profile PDA. Its stored owner and layout are checked in the handler.
    #[account(mut, eph, seeds = [PROFILE_SEED, owner.key().as_ref()], bump)]
    pub profile: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CloseProfile<'info> {
    pub owner: Signer<'info>,
    #[account(mut, sponsor, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: The owner's profile PDA. Its stored owner and layout are checked in the handler.
    #[account(mut, eph, seeds = [PROFILE_SEED, owner.key().as_ref()], bump)]
    pub profile: UncheckedAccount<'info>,
    /// CHECK: The profile's permission account. The permission program derives and checks it.
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
}
