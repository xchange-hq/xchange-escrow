/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- BN's types do not resolve under the workspace's module settings; the values are Anchor's own. */
import { AnchorProvider, BN, Program, utils } from '@coral-xyz/anchor';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Commitment,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import idl from './escrow.idl.json' with { type: 'json' };
import type { XchangeEscrow } from './escrow.types.js';

/** A coordinator payout signed but not yet known to have landed; see payoutStatus. */
export interface SignedPayout {
  readonly id: string;
  readonly raw: string;
  /** The blockhash's last valid block height: after it, it can never land. */
  readonly expires: number;
}

/** What became of a signed payout. */
export type PayoutStatus = 'landed' | 'failed' | 'pending' | 'unseen' | 'dropped';

/**
 * The xchange escrow program on Solana, from the server's side.
 *
 * A user's transaction is built here with xchange's fee payer, signed by it
 * for the fee only, and sent to the phone for the user's own
 * signature; nothing moves without it. The coordinator's calls are signed
 * here. The registry, escrow and vault accounts are program-derived, so the
 * client and the program can never disagree about where funds sit.
 */
export interface SolanaEscrowConfig {
  readonly rpcUrl: string;
  readonly commitment: Commitment;
  readonly programId: string;
  readonly coordinatorEncryptedKey: string;
  readonly feePayerEncryptedKey: string;
  readonly decrypt: (ciphertext: string) => string;
}

export interface SolanaEscrowState {
  readonly depositor: string;
  readonly mint: string;
  readonly amount: bigint;
  readonly counterparty: string | null;
  readonly expiry: bigint;
  readonly matched: boolean;
  readonly status: 'funded' | 'released' | 'refunded';
}

/** Accounts per getMultipleAccounts call: PublicNode answers no more than ten. */
const ACCOUNTS_PER_CALL = 10;

type EscrowAccount = Awaited<ReturnType<Program<XchangeEscrow>['account']['escrow']['fetch']>>;

function escrowState(e: EscrowAccount): SolanaEscrowState {
  const state = Object.keys(e.state)[0] ?? 'funded';
  return {
    depositor: e.depositor.toBase58(),
    mint: e.mint.toBase58(),
    amount: BigInt(e.amount.toString()),
    counterparty: e.counterparty?.toBase58() ?? null,
    expiry: BigInt(e.expiry.toString()),
    matched: e.matched,
    status: state === 'released' ? 'released' : state === 'refunded' ? 'refunded' : 'funded',
  };
}

export interface UnsignedSolanaTx {
  /** base64 of the serialized transaction, fee payer's signature included. */
  readonly tx: string;
  readonly summary: string;
}

/** 16 bytes of order id, from a uuid. */
export function orderIdBytes(id: string): number[] {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32) throw new Error('order ids are uuids');
  return Array.from(Buffer.from(hex, 'hex'));
}

/** Anchor's node wallet, which its module build does not export. */
function keypairWallet(payer: Keypair): {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
} {
  const signOne = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof Transaction) tx.partialSign(payer);
    else tx.sign([payer]);
    return tx;
  };
  return {
    publicKey: payer.publicKey,
    signTransaction: (tx) => Promise.resolve(signOne(tx)),
    signAllTransactions: (txs) => Promise.resolve(txs.map(signOne)),
  };
}

export class SolanaEscrow {
  readonly #c: SolanaEscrowConfig;
  readonly #connection: Connection;
  readonly #programId: PublicKey;
  #program: Program<XchangeEscrow> | null = null;
  #coordinator: Keypair | null = null;
  #feePayer: Keypair | null = null;

  constructor(config: SolanaEscrowConfig) {
    this.#c = config;
    this.#connection = new Connection(config.rpcUrl, config.commitment);
    this.#programId = new PublicKey(config.programId);
  }

  #keys(): { coordinator: Keypair; feePayer: Keypair } {
    this.#coordinator ??= Keypair.fromSecretKey(
      utils.bytes.bs58.decode(this.#c.decrypt(this.#c.coordinatorEncryptedKey)),
    );
    this.#feePayer ??= Keypair.fromSecretKey(
      utils.bytes.bs58.decode(this.#c.decrypt(this.#c.feePayerEncryptedKey)),
    );
    return { coordinator: this.#coordinator, feePayer: this.#feePayer };
  }

  /** The wallet that pays rent and fees for every transaction built here. */
  /** One small read (getSlot, about 250 bytes out), to learn whether the RPC answers at all. */
  async ping(): Promise<void> {
    await this.#connection.getSlot();
  }

  get feePayerAddress(): string {
    return this.#keys().feePayer.publicKey.toBase58();
  }

  get coordinatorAddress(): string {
    return this.#keys().coordinator.publicKey.toBase58();
  }

  #prog(): Program<XchangeEscrow> {
    if (this.#program === null) {
      const provider = new AnchorProvider(this.#connection, keypairWallet(this.#keys().feePayer), {
        commitment: this.#c.commitment,
      });
      this.#program = new Program(idl, provider);
    }
    return this.#program;
  }

  #pda(...seeds: (Buffer | Uint8Array)[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.#programId)[0];
  }
  registryOf(owner: string): PublicKey {
    return this.#pda(Buffer.from('registry'), new PublicKey(owner).toBuffer());
  }
  escrowOf(orderId: string): PublicKey {
    return this.#pda(Buffer.from('escrow'), Buffer.from(orderIdBytes(orderId)));
  }

  static tokenProgram(token2022: boolean): PublicKey {
    return token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  }

  /** A transaction for the phone: fee paid by xchange's fee payer, awaiting the user's signature. */
  async #forUser(
    user: string,
    build: () => Promise<TransactionInstruction | TransactionInstruction[]>,
    summary: string,
  ): Promise<UnsignedSolanaTx> {
    const { feePayer } = this.#keys();
    const built = await build();
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash(
      this.#c.commitment,
    );
    const tx = new Transaction({
      feePayer: feePayer.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(...(Array.isArray(built) ? built : [built]));
    tx.partialSign(feePayer);
    // `user` is whose signature is still missing; the phone supplies it.
    if (user === '') throw new Error('no user');
    return {
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      summary,
    };
  }

  async isRegistered(owner: string): Promise<boolean> {
    return (
      (await this.#connection.getAccountInfo(this.registryOf(owner), this.#c.commitment)) !== null
    );
  }

  async unsignedRegister(owner: string): Promise<UnsignedSolanaTx> {
    const { feePayer } = this.#keys();
    return this.#forUser(
      owner,
      () =>
        this.#prog()
          .methods.register()
          .accountsPartial({ owner: new PublicKey(owner), payer: feePayer.publicKey })
          .instruction(),
      'Activate your wallet with the escrow',
    );
  }

  /**
   * A deposit for the phone to sign. With `registerOwner`, the same
   * transaction first registers the owner with the escrow, so a person whose
   * payout comes on this chain needs no separate step and no second PIN.
   */
  async unsignedDeposit(
    owner: string,
    orderId: string,
    mint: string,
    token2022: boolean,
    amount: bigint,
    counterparty: string | null,
    expirySeconds: bigint,
    registerOwner = false,
    /** xchange's charge for the order, in the same token, to its fee wallet, in the same transaction. */
    fee?: { readonly to: string; readonly amount: bigint; readonly decimals: number },
  ): Promise<UnsignedSolanaTx> {
    const { feePayer } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    return this.#forUser(
      owner,
      async () => {
        const ownerKey = new PublicKey(owner);
        const ownerAccount = getAssociatedTokenAddressSync(mintKey, ownerKey, false, program);
        // The charge first: the person signs the deposit and the charge as
        // one, or neither; xchange signed first as fee payer, so nothing in
        // it can be changed or left out.
        const charge: TransactionInstruction[] = [];
        if (fee !== undefined && fee.amount > 0n) {
          const feeOwner = new PublicKey(fee.to);
          const feeAccount = getAssociatedTokenAddressSync(mintKey, feeOwner, true, program);
          charge.push(
            createAssociatedTokenAccountIdempotentInstruction(
              feePayer.publicKey,
              feeAccount,
              feeOwner,
              mintKey,
              program,
            ),
            createTransferCheckedInstruction(
              ownerAccount,
              mintKey,
              feeAccount,
              ownerKey,
              fee.amount,
              fee.decimals,
              [],
              program,
            ),
          );
        }
        const deposit = await this.#prog()
          .methods.deposit(
            orderIdBytes(orderId),
            new BN(amount.toString()),
            counterparty === null ? null : new PublicKey(counterparty),
            new BN(expirySeconds.toString()),
          )
          .accountsPartial({
            mint: mintKey,
            depositorToken: getAssociatedTokenAddressSync(
              mintKey,
              new PublicKey(owner),
              false,
              program,
            ),
            depositor: new PublicKey(owner),
            payer: feePayer.publicKey,
            tokenProgram: program,
          })
          .instruction();
        if (!registerOwner) return [...charge, deposit];
        const register = await this.#prog()
          .methods.register()
          .accountsPartial({ owner: new PublicKey(owner), payer: feePayer.publicKey })
          .instruction();
        return [register, ...charge, deposit];
      },
      'Move funds into escrow',
    );
  }

  async unsignedRefund(
    owner: string,
    orderId: string,
    mint: string,
    token2022: boolean,
  ): Promise<UnsignedSolanaTx> {
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    return this.#forUser(
      owner,
      () =>
        this.#prog()
          .methods.refund(orderIdBytes(orderId))
          .accountsPartial({
            mint: mintKey,
            depositor: new PublicKey(owner),
            depositorToken: getAssociatedTokenAddressSync(
              mintKey,
              new PublicKey(owner),
              false,
              program,
            ),
            caller: new PublicKey(owner),
            tokenProgram: program,
            rentTo: this.#keys().feePayer.publicKey,
          })
          .instruction(),
      'Take your funds back from escrow',
    );
  }

  /** A token transfer from the person's wallet, fee paid by xchange's fee payer, for the phone to sign. */
  /** Whether `owner` already has a token account for `mint`: a send to them opens none. */
  async tokenAccountExists(owner: string, mint: string, token2022: boolean): Promise<boolean> {
    const program = SolanaEscrow.tokenProgram(token2022);
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(owner),
      true,
      program,
    );
    return (await this.#connection.getAccountInfo(ata, this.#c.commitment)) !== null;
  }

  /** What `owner` holds of `mint`, in its smallest unit; nothing when it has no account. */
  async tokenBalance(owner: string, mint: string, token2022: boolean): Promise<bigint> {
    const program = SolanaEscrow.tokenProgram(token2022);
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(owner),
      true,
      program,
    );
    const info = await this.#connection.getAccountInfo(ata, this.#c.commitment);
    // A token account's amount is the u64 at byte 64, after the mint and owner.
    if (info === null || info.data.length < 72) return 0n;
    return Buffer.from(info.data).readBigUInt64LE(64);
  }

  /**
   * A send from the person's wallet, for the phone to sign. xchange pays the
   * network fee and any account the recipient needs. When `fee` is given, the
   * same transaction pays it to xchange's fee wallet: the person signs one
   * transaction that does both or neither, and since xchange signs first as
   * the fee payer, nothing in it can be changed or left out afterwards.
   */
  async unsignedTransfer(
    owner: string,
    to: string,
    mint: string,
    token2022: boolean,
    amount: bigint,
    decimals: number,
    fee?: { readonly to: string; readonly amount: bigint },
  ): Promise<UnsignedSolanaTx> {
    const { feePayer } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    const from = getAssociatedTokenAddressSync(mintKey, new PublicKey(owner), false, program);
    const toAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(to), true, program);
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash(
      this.#c.commitment,
    );
    const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight })
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          toAta,
          new PublicKey(to),
          mintKey,
          program,
        ),
      )
      .add(
        createTransferCheckedInstruction(
          from,
          mintKey,
          toAta,
          new PublicKey(owner),
          amount,
          decimals,
          [],
          program,
        ),
      );
    if (fee !== undefined && fee.amount > 0n) {
      const feeAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(fee.to), true, program);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          feeAta,
          new PublicKey(fee.to),
          mintKey,
          program,
        ),
      ).add(
        createTransferCheckedInstruction(
          from,
          mintKey,
          feeAta,
          new PublicKey(owner),
          fee.amount,
          decimals,
          [],
          program,
        ),
      );
    }
    tx.partialSign(feePayer);
    return {
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      summary: 'Send',
    };
  }

  /** Broadcast a transaction the phone completed. Returns the signature. */
  async submit(txBase64: string): Promise<string> {
    const raw = Buffer.from(txBase64, 'base64');
    const sig = await this.#connection.sendRawTransaction(raw, {
      preflightCommitment: this.#c.commitment,
    });
    return sig;
  }

  // ---- the coordinator ----------------------------------------------------

  async setCounterparty(orderId: string, counterparty: string): Promise<string> {
    const { coordinator } = this.#keys();
    return this.#prog()
      .methods.setCounterparty(orderIdBytes(orderId))
      .accountsPartial({
        coordinator: coordinator.publicKey,
        registry: this.registryOf(counterparty),
      })
      .signers([coordinator])
      .rpc({ commitment: this.#c.commitment });
  }

  async release(
    orderId: string,
    mint: string,
    token2022: boolean,
    counterparty: string,
  ): Promise<string> {
    const { coordinator } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    return this.#prog()
      .methods.release(orderIdBytes(orderId))
      .accountsPartial({
        coordinator: coordinator.publicKey,
        mint: mintKey,
        counterpartyToken: getAssociatedTokenAddressSync(
          mintKey,
          new PublicKey(counterparty),
          false,
          program,
        ),
        tokenProgram: program,
        rentTo: this.#keys().feePayer.publicKey,
      })
      .preInstructions([this.#openAccount(mintKey, new PublicKey(counterparty), program)])
      .signers([coordinator])
      .rpc({ commitment: this.#c.commitment });
  }

  /** Part of an escrow to a registered address; the rest stays for the next taker. */
  /**
   * The recipient's token account, opened if it is not there yet, paid for by
   * the fee payer. Someone who has never held XGE or USDC has no account to
   * be paid into, and the release would fail until they had one.
   */
  #openAccount(mint: PublicKey, owner: PublicKey, program: PublicKey): TransactionInstruction {
    return createAssociatedTokenAccountIdempotentInstruction(
      this.#keys().feePayer.publicKey,
      getAssociatedTokenAddressSync(mint, owner, false, program),
      owner,
      mint,
      program,
    );
  }

  async releasePartial(
    orderId: string,
    mint: string,
    token2022: boolean,
    to: string,
    amount: bigint,
  ): Promise<string> {
    const { coordinator } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    return this.#prog()
      .methods.releasePartial(orderIdBytes(orderId), new BN(amount.toString()))
      .accountsPartial({
        coordinator: coordinator.publicKey,
        mint: mintKey,
        registry: this.registryOf(to),
        counterpartyToken: getAssociatedTokenAddressSync(
          mintKey,
          new PublicKey(to),
          false,
          program,
        ),
        tokenProgram: program,
        rentTo: this.#keys().feePayer.publicKey,
      })
      .preInstructions([this.#openAccount(mintKey, new PublicKey(to), program)])
      .signers([coordinator])
      .rpc({ commitment: this.#c.commitment });
  }

  async refundExpired(
    orderId: string,
    mint: string,
    token2022: boolean,
    depositor: string,
  ): Promise<string> {
    const { coordinator } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    return this.#prog()
      .methods.refund(orderIdBytes(orderId))
      .accountsPartial({
        mint: mintKey,
        depositor: new PublicKey(depositor),
        depositorToken: getAssociatedTokenAddressSync(
          mintKey,
          new PublicKey(depositor),
          false,
          program,
        ),
        caller: coordinator.publicKey,
        tokenProgram: program,
        rentTo: this.#keys().feePayer.publicKey,
      })
      .signers([coordinator])
      .rpc({ commitment: this.#c.commitment });
  }

  /** The config PDA, which owns each mint's fee vault. */
  get configAddress(): PublicKey {
    return this.#pda(Buffer.from('config'));
  }

  /** A mint's fee vault and what it holds, in the token's smallest units. */
  async feesHeld(mint: string, token2022: boolean): Promise<{ vault: string; amount: bigint }> {
    const program = SolanaEscrow.tokenProgram(token2022);
    const vault = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      this.configAddress,
      true,
      program,
    );
    const info = await this.#connection.getAccountInfo(vault);
    return {
      vault: vault.toBase58(),
      amount: info === null || info.data.length < 72 ? 0n : info.data.readBigUInt64LE(64),
    };
  }

  /**
   * Collected fees of one mint, out of the fee vault to the authority's own
   * token account. Signed by the program's authority, which is not a server
   * key: the laptop holding it runs this (tools/solana-fees.ts).
   */
  async withdrawFees(
    authority: Keypair,
    mint: string,
    token2022: boolean,
    amount: bigint,
  ): Promise<string> {
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    const authorityAccount = getAssociatedTokenAddressSync(
      mintKey,
      authority.publicKey,
      false,
      program,
    );
    return (
      this.#prog()
        .methods.withdrawFees(new BN(amount.toString()))
        .accountsPartial({
          config: this.configAddress,
          authority: authority.publicKey,
          mint: mintKey,
          feeVault: getAssociatedTokenAddressSync(mintKey, this.configAddress, true, program),
          authorityToken: authorityAccount,
          tokenProgram: program,
        })
        // The authority's own token account, opened here if it is not there yet.
        .preInstructions([
          createAssociatedTokenAccountIdempotentInstruction(
            authority.publicKey,
            authorityAccount,
            authority.publicKey,
            mintKey,
            program,
          ),
        ])
        .signers([authority])
        .rpc({ commitment: this.#c.commitment })
    );
  }

  /** Where the program sends the rent of closed escrows; null until the authority set it. */
  async rentTo(): Promise<string | null> {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('rent')], this.#programId);
    const r = await this.#prog().account.rentTo.fetchNullable(pda);
    return r === null ? null : r.to.toBase58();
  }

  /** Set where closed escrows send their rent. Signed by the program's authority, from the laptop. */
  async setRentTo(authority: Keypair, to: string): Promise<string> {
    return this.#prog()
      .methods.setRentTo(new PublicKey(to))
      .accountsPartial({ config: this.configAddress, authority: authority.publicKey })
      .signers([authority])
      .rpc({ commitment: this.#c.commitment });
  }

  // ---- reads ----------------------------------------------------------------

  async escrow(orderId: string): Promise<SolanaEscrowState | null> {
    const e = await this.#prog().account.escrow.fetchNullable(this.escrowOf(orderId));
    return e === null ? null : escrowState(e);
  }

  /**
   * Many escrows, ten to a getMultipleAccounts call (PublicNode's ceiling),
   * instead of one request each: the watchdog reads every open escrow every
   * few minutes. A chunk the RPC did not answer is left out of the map, so
   * the caller can tell it from an escrow that does not exist (null).
   */
  async readEscrows(orderIds: readonly string[]): Promise<Map<string, SolanaEscrowState | null>> {
    const out = new Map<string, SolanaEscrowState | null>();
    for (let i = 0; i < orderIds.length; i += ACCOUNTS_PER_CALL) {
      const chunk = orderIds.slice(i, i + ACCOUNTS_PER_CALL);
      try {
        const got = await this.#prog().account.escrow.fetchMultiple(
          chunk.map((id) => this.escrowOf(id)),
        );
        chunk.forEach((id, j) => {
          const e = got[j];
          out.set(id, e === null || e === undefined ? null : escrowState(e));
        });
      } catch {
        /* left out: read again next time */
      }
    }
    return out;
  }

  /**
   * Finalized and successful: on Solana that is the only depth that matters.
   * A transaction that failed is final too, but nothing moved, so it is not
   * counted as arrived.
   */
  async finalized(signature: string): Promise<boolean> {
    const s = await this.#connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const v = s.value[0];
    return v?.confirmationStatus === 'finalized' && v.err === null;
  }

  /** Whether the chain knows this signature at all, with its history searched. */
  async signatureKnown(signature: string): Promise<boolean> {
    const s = await this.#connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    return s.value[0] !== null && s.value[0] !== undefined;
  }

  // ---- payouts: signed, saved, then sent -----------------------------------

  async #signPayout(built: Transaction): Promise<SignedPayout> {
    const { coordinator, feePayer } = this.#keys();
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash(
      this.#c.commitment,
    );
    built.feePayer = feePayer.publicKey;
    built.recentBlockhash = blockhash;
    built.sign(feePayer, coordinator);
    const sig = built.signature;
    if (sig === null) throw new Error('payout was not signed');
    return {
      id: utils.bytes.bs58.encode(sig),
      raw: built.serialize().toString('base64'),
      expires: lastValidBlockHeight,
    };
  }

  /** A whole release to the escrow's named counterparty, signed and not yet sent. */
  async signRelease(
    orderId: string,
    mint: string,
    token2022: boolean,
    counterparty: string,
  ): Promise<SignedPayout> {
    const { coordinator } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    const tx = await this.#prog()
      .methods.release(orderIdBytes(orderId))
      .accountsPartial({
        coordinator: coordinator.publicKey,
        mint: mintKey,
        counterpartyToken: getAssociatedTokenAddressSync(
          mintKey,
          new PublicKey(counterparty),
          false,
          program,
        ),
        tokenProgram: program,
        rentTo: this.#keys().feePayer.publicKey,
      })
      .preInstructions([this.#openAccount(mintKey, new PublicKey(counterparty), program)])
      .transaction();
    return this.#signPayout(tx);
  }

  /** Part of an escrow to a registered address, signed and not yet sent. */
  async signReleasePartial(
    orderId: string,
    mint: string,
    token2022: boolean,
    to: string,
    amount: bigint,
  ): Promise<SignedPayout> {
    const { coordinator } = this.#keys();
    const program = SolanaEscrow.tokenProgram(token2022);
    const mintKey = new PublicKey(mint);
    const tx = await this.#prog()
      .methods.releasePartial(orderIdBytes(orderId), new BN(amount.toString()))
      .accountsPartial({
        coordinator: coordinator.publicKey,
        mint: mintKey,
        registry: this.registryOf(to),
        counterpartyToken: getAssociatedTokenAddressSync(
          mintKey,
          new PublicKey(to),
          false,
          program,
        ),
        tokenProgram: program,
        rentTo: this.#keys().feePayer.publicKey,
      })
      .preInstructions([this.#openAccount(mintKey, new PublicKey(to), program)])
      .transaction();
    return this.#signPayout(tx);
  }

  /** Send a signed payout. Sending the same bytes again is harmless: one signature lands once. */
  async broadcast(raw: string): Promise<void> {
    await this.#connection.sendRawTransaction(Buffer.from(raw, 'base64'), {
      preflightCommitment: this.#c.commitment,
    });
  }

  /**
   * What became of a signed payout. Unseen past its blockhash's last valid
   * height (with a margin for a lagging RPC) means it can never land.
   */
  async payoutStatus(id: string, expires: number): Promise<PayoutStatus> {
    const s = await this.#connection.getSignatureStatuses([id], {
      searchTransactionHistory: true,
    });
    const v = s.value[0];
    if (v === null || v === undefined) {
      // The current block height, read the same way `expires` was: a fresh
      // blockhash is valid for 150 blocks. Not getBlockHeight: PublicNode
      // answers that with the slot, some 22 million ahead, which made every
      // payout not yet visible look expired.
      const latest = await this.#connection.getLatestBlockhash('confirmed');
      const height = latest.lastValidBlockHeight - 150;
      return height > expires + 150 ? 'dropped' : 'unseen';
    }
    if (v.err !== null) return 'failed';
    return v.confirmationStatus === 'finalized' ? 'landed' : 'pending';
  }
}
