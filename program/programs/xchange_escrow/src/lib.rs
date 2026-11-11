//! xchange escrow.
//!
//! Funds for an offer sit in a vault the program owns. They leave by exactly
//! two doors: release to a counterparty, less the configured fee into the fee
//! vault, or `refund` to the depositor. Release comes in two shapes: `release`
//! pays the whole escrow to the counterparty recorded on it, and
//! `release_partial` pays part of it to a registered address the coordinator
//! names, leaving the rest in escrow for the next taker. Either way the
//! coordinator can only ever pay an address that registered itself; it can
//! never name a destination of its own. Nobody, not even the authority, can
//! take funds anywhere else.
//!
//! An escrow lives only as long as it holds funds. When the last of them
//! leaves, by release or refund, the vault and the escrow account are closed
//! and their rent goes to the address the authority set with `set_rent_to`:
//! the wallet that paid the rent in the first place. Before that address is
//! set, nothing closes and nothing changes.

use anchor_lang::prelude::*;

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "xchange escrow",
    project_url: "https://xchangehq.com",
    contacts: "link:https://github.com/xchange-hq/xchange/security/advisories/new,email:contact@xchangehq.com",
    policy: "https://xchangehq.com/security.html",
    preferred_languages: "en",
    source_code: "https://github.com/xchange-hq/xchange/tree/main/contracts/solana",
    auditors: "None yet"
}
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("9TwvUTeAP5q2CjkgrkUBDjqUR1PWJCvnXysSWxhnVvBZ");

pub const MAX_FEE_BPS: u16 = 1_000; // 10 percent, an upper bound on configuration mistakes

#[program]
pub mod xchange_escrow {
    use super::*;

    /// Once. The payer becomes the authority; it may change the coordinator
    /// and the fee, within bounds, and nothing else.
    pub fn initialize(ctx: Context<Initialize>, coordinator: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.coordinator = coordinator;
        c.fee_bps = fee_bps;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_coordinator(ctx: Context<Authority>, coordinator: Pubkey) -> Result<()> {
        ctx.accounts.config.coordinator = coordinator;
        Ok(())
    }

    /// Move collected fees out of a mint's fee vault to the authority's own
    /// token account for that mint. Authority only; the vault holds nothing
    /// but fees, so nobody's escrow can be touched through it.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= ctx.accounts.fee_vault.amount, EscrowError::BadAmount);
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", &[bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.fee_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.authority_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Where closed escrows send their rent: the wallet that pays it. The
    /// authority only. Until this is set, escrows are left open after they
    /// empty, as they always were.
    pub fn set_rent_to(ctx: Context<SetRentTo>, to: Pubkey) -> Result<()> {
        ctx.accounts.rent.to = to;
        Ok(())
    }

    pub fn set_fee(ctx: Context<Authority>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        Ok(())
    }

    /// A person registers their own address by signing. Only registered
    /// addresses can ever be set as a counterparty by the coordinator.
    pub fn register(ctx: Context<Register>) -> Result<()> {
        ctx.accounts.registry.owner = ctx.accounts.owner.key();
        Ok(())
    }

    /// Lock `amount` of the mint for `order_id`. `counterparty` is known for
    /// a taker and null for a maker. `expiry` is a unix time after which
    /// anyone may refund.
    pub fn deposit(
        ctx: Context<Deposit>,
        order_id: [u8; 16],
        amount: u64,
        counterparty: Option<Pubkey>,
        expiry: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(expiry > now, EscrowError::ExpiryInPast);
        let e = &mut ctx.accounts.escrow;
        e.order_id = order_id;
        e.depositor = ctx.accounts.depositor.key();
        e.mint = ctx.accounts.mint.key();
        e.amount = amount;
        e.counterparty = counterparty;
        e.expiry = expiry;
        e.matched = counterparty.is_some();
        e.state = State::Funded;
        e.bump = ctx.bumps.escrow;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.depositor_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// The coordinator names a maker's counterparty, once, when a fill is
    /// journaled. Only a registered address; only while unmatched and funded.
    pub fn set_counterparty(ctx: Context<SetCounterparty>, _order_id: [u8; 16]) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(e.state == State::Funded, EscrowError::NotFunded);
        require!(!e.matched, EscrowError::AlreadyMatched);
        require!(Clock::get()?.unix_timestamp < e.expiry, EscrowError::Expired);
        e.counterparty = Some(ctx.accounts.registry.owner);
        e.matched = true;
        Ok(())
    }

    /// Pay the counterparty, less the fee into the fee vault. Coordinator only.
    pub fn release(ctx: Context<Release>, _order_id: [u8; 16]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &ctx.accounts.escrow;
        require!(e.state == State::Funded, EscrowError::NotFunded);
        require!(now < e.expiry, EscrowError::Expired);
        let counterparty = e.counterparty.ok_or(EscrowError::NoCounterparty)?;
        require_keys_eq!(ctx.accounts.counterparty_token.owner, counterparty, EscrowError::WrongCounterparty);
        let fee = fee_of(e.amount, ctx.accounts.config.fee_bps);
        pay(&ctx, e.amount - fee, fee)?;
        ctx.accounts.escrow.state = State::Released;
        close_empty(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.rent,
            &ctx.accounts.rent_to,
            &ctx.accounts.token_program,
        )
    }

    /// Pay `amount` of the escrow to a registered address, less the fee, and
    /// keep the rest in escrow. This is how one offer fills several takers.
    /// The last part empties the escrow and marks it released. Coordinator
    /// only; only while funded and not expired; never to an unregistered
    /// address, which is the registry account's job to prove.
    pub fn release_partial(
        ctx: Context<ReleasePartial>,
        _order_id: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &ctx.accounts.escrow;
        require!(e.state == State::Funded, EscrowError::NotFunded);
        require!(now < e.expiry, EscrowError::Expired);
        require!(amount > 0 && amount <= e.amount, EscrowError::BadAmount);
        require_keys_eq!(
            ctx.accounts.counterparty_token.owner,
            ctx.accounts.registry.owner,
            EscrowError::WrongCounterparty
        );
        let fee = fee_of(amount, ctx.accounts.config.fee_bps);
        let seeds: &[&[u8]] = &[b"escrow", &e.order_id, &[e.bump]];
        let decimals = ctx.accounts.mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.counterparty_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            amount - fee,
            decimals,
        )?;
        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.fee_vault.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
                decimals,
            )?;
        }
        let e = &mut ctx.accounts.escrow;
        e.amount -= amount;
        if e.amount == 0 {
            e.state = State::Released;
            return close_empty(
                &ctx.accounts.escrow,
                &ctx.accounts.vault,
                &ctx.accounts.rent,
                &ctx.accounts.rent_to,
                &ctx.accounts.token_program,
            );
        }
        Ok(())
    }

    /// Everything back to the depositor. The depositor at any time while
    /// unmatched; anyone once expired.
    pub fn refund(ctx: Context<Refund>, _order_id: [u8; 16]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &ctx.accounts.escrow;
        require!(e.state == State::Funded, EscrowError::NotFunded);
        let by_depositor = ctx.accounts.caller.key() == e.depositor && !e.matched;
        require!(by_depositor || now >= e.expiry, EscrowError::NotRefundable);
        let seeds: &[&[u8]] = &[b"escrow", &e.order_id, &[e.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.depositor_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            e.amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.escrow.state = State::Refunded;
        close_empty(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.rent,
            &ctx.accounts.rent_to,
            &ctx.accounts.token_program,
        )
    }
}

/// Close an emptied escrow's vault and then the escrow itself, sending both
/// rents to the configured address. Only when the authority has set one, and
/// only to that address, which the accounts constraint already checked. The
/// vault must hold nothing, which the token program enforces.
fn close_empty<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    rent: &Option<Account<'info, RentTo>>,
    rent_to: &Option<UncheckedAccount<'info>>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let (Some(rent), Some(rent_to)) = (rent, rent_to) else {
        return Ok(());
    };
    require_keys_eq!(rent_to.key(), rent.to, EscrowError::WrongRentDestination);
    let seeds: &[&[u8]] = &[b"escrow", &escrow.order_id, &[escrow.bump]];
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to.to_account_info(),
            authority: escrow.to_account_info(),
        },
        &[seeds],
    ))?;
    escrow.close(rent_to.to_account_info())
}

fn fee_of(amount: u64, bps: u16) -> u64 {
    ((amount as u128) * (bps as u128) / 10_000) as u64
}

fn pay(ctx: &Context<Release>, to_counterparty: u64, fee: u64) -> Result<()> {
    let e = &ctx.accounts.escrow;
    let seeds: &[&[u8]] = &[b"escrow", &e.order_id, &[e.bump]];
    let decimals = ctx.accounts.mint.decimals;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.counterparty_token.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ),
        to_counterparty,
        decimals,
    )?;
    if fee > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            fee,
            decimals,
        )?;
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub coordinator: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub owner: Pubkey,
}

/// Where a closed escrow's rent goes. One per program, set by the authority.
#[account]
#[derive(InitSpace)]
pub struct RentTo {
    pub to: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum State {
    Funded,
    Released,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub order_id: [u8; 16],
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub counterparty: Option<Pubkey>,
    pub expiry: i64,
    pub matched: bool,
    pub state: State,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Authority<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// The fee vault: the config PDA's own token account for this mint.
    #[account(mut, associated_token::mint = mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    /// The authority's own token account for this mint, opened beforehand by whoever runs this.
    #[account(mut, token::mint = mint, token::authority = authority, token::token_program = token_program)]
    pub authority_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(init, payer = payer, space = 8 + Registry::INIT_SPACE, seeds = [b"registry", owner.key().as_ref()], bump)]
    pub registry: Account<'info, Registry>,
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct Deposit<'info> {
    #[account(init, payer = payer, space = 8 + Escrow::INIT_SPACE, seeds = [b"escrow", order_id.as_ref()], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = escrow, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = depositor, token::token_program = token_program)]
    pub depositor_token: InterfaceAccount<'info, TokenAccount>,
    pub depositor: Signer<'info>,
    /// Whoever pays rent: the depositor, or the sponsor on their behalf.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct SetCounterparty<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = coordinator)]
    pub config: Account<'info, Config>,
    pub coordinator: Signer<'info>,
    #[account(mut, seeds = [b"escrow", order_id.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// The counterparty's registration: it must exist, which is the whole point.
    #[account(seeds = [b"registry", registry.owner.as_ref()], bump)]
    pub registry: Account<'info, Registry>,
}

#[derive(Accounts)]
pub struct SetRentTo<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init_if_needed, payer = authority, space = 8 + RentTo::INIT_SPACE, seeds = [b"rent"], bump)]
    pub rent: Account<'info, RentTo>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct Release<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = coordinator)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub coordinator: Signer<'info>,
    #[account(mut, seeds = [b"escrow", order_id.as_ref()], bump = escrow.bump, has_one = mint)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub counterparty_token: InterfaceAccount<'info, TokenAccount>,
    /// The fee vault: the config PDA's own token account for this mint.
    #[account(init_if_needed, payer = coordinator, associated_token::mint = mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    /// Where the closed escrow's rent goes, if the authority has set one.
    #[account(seeds = [b"rent"], bump)]
    pub rent: Option<Account<'info, RentTo>>,
    /// CHECK: must be the address the `rent` account names; checked in close_empty.
    #[account(mut)]
    pub rent_to: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct ReleasePartial<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = coordinator)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub coordinator: Signer<'info>,
    #[account(mut, seeds = [b"escrow", order_id.as_ref()], bump = escrow.bump, has_one = mint)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// The recipient's registration: it must exist, which is the whole point.
    #[account(seeds = [b"registry", registry.owner.as_ref()], bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub counterparty_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = coordinator, associated_token::mint = mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    /// Where the closed escrow's rent goes, if the authority has set one.
    #[account(seeds = [b"rent"], bump)]
    pub rent: Option<Account<'info, RentTo>>,
    /// CHECK: must be the address the `rent` account names; checked in close_empty.
    #[account(mut)]
    pub rent_to: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct Refund<'info> {
    #[account(mut, seeds = [b"escrow", order_id.as_ref()], bump = escrow.bump, has_one = mint, has_one = depositor)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: only compared with the escrow's depositor through has_one.
    pub depositor: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = depositor, token::token_program = token_program)]
    pub depositor_token: InterfaceAccount<'info, TokenAccount>,
    /// Where the closed escrow's rent goes, if the authority has set one.
    #[account(seeds = [b"rent"], bump)]
    pub rent: Option<Account<'info, RentTo>>,
    /// CHECK: must be the address the `rent` account names; checked in close_empty.
    #[account(mut)]
    pub rent_to: Option<UncheckedAccount<'info>>,
    pub caller: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum EscrowError {
    #[msg("The fee is above the allowed maximum")]
    FeeTooHigh,
    #[msg("Nothing to deposit")]
    ZeroAmount,
    #[msg("The expiry is in the past")]
    ExpiryInPast,
    #[msg("This escrow is not holding funds")]
    NotFunded,
    #[msg("This escrow already has a counterparty")]
    AlreadyMatched,
    #[msg("This escrow has expired")]
    Expired,
    #[msg("No counterparty has been set")]
    NoCounterparty,
    #[msg("That token account does not belong to the counterparty")]
    WrongCounterparty,
    #[msg("Only the depositor may refund an unmatched escrow before it expires")]
    NotRefundable,
    #[msg("The amount must be more than zero and no more than the escrow holds")]
    BadAmount,
    #[msg("Rent may only go to the address the authority set")]
    WrongRentDestination,
}
