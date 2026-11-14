import { AnchorProvider, BN, Program, Wallet, web3 } from '@coral-xyz/anchor';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeMintCloseAuthorityInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
} from '@solana/spl-token';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

/**
 * The escrow's rules, exercised end to end against a validator: local by
 * default (`anchor test`), devnet with ANCHOR_PROVIDER_URL and a funded
 * ANCHOR_WALLET. Every path funds are allowed to take, and every path they
 * are not.
 */
const idl = JSON.parse(
  readFileSync(new URL('../target/idl/xchange_escrow.json', import.meta.url), 'utf8'),
);
const env = AnchorProvider.env();
// Every call waits for confirmation before the next balance is read.
const provider = new AnchorProvider(env.connection, env.wallet, {
  commitment: 'confirmed',
  preflightCommitment: 'confirmed',
});
const program = new Program(idl, provider);
const conn = provider.connection;
const payer = (provider.wallet as Wallet).payer;
const T22 = TOKEN_2022_PROGRAM_ID;

const [config] = web3.PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
const escrowPda = (id: Uint8Array) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), Buffer.from(id)],
    program.programId,
  )[0];
const registryPda = (owner: web3.PublicKey) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from('registry'), owner.toBuffer()],
    program.programId,
  )[0];
const orderId = (): number[] =>
  Array.from(web3.Keypair.generate().publicKey.toBytes().slice(0, 16));
const now = () => Math.floor(Date.now() / 1000);

let mint: web3.PublicKey;
const coordinator = web3.Keypair.generate();
const maker = web3.Keypair.generate();
const taker = web3.Keypair.generate();
const stranger = web3.Keypair.generate();
const ata = (owner: web3.PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, T22);
const balance = async (owner: web3.PublicKey): Promise<bigint> =>
  (await getAccount(conn, ata(owner), 'confirmed', T22)).amount;

async function fund(...keys: web3.Keypair[]): Promise<void> {
  const tx = new web3.Transaction();
  for (const k of keys)
    tx.add(
      web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: k.publicKey,
        lamports: 0.05 * web3.LAMPORTS_PER_SOL,
      }),
    );
  await provider.sendAndConfirm(tx);
}

async function deposit(
  depositor: web3.Keypair,
  id: number[],
  amount: number,
  counterparty: web3.PublicKey | null,
  expiry: number,
) {
  return program.methods
    .deposit(id, new BN(amount), counterparty, new BN(expiry))
    .accounts({
      mint,
      depositorToken: ata(depositor.publicKey),
      depositor: depositor.publicKey,
      payer: payer.publicKey,
      tokenProgram: T22,
    })
    .signers([depositor])
    .rpc();
}
/** Where closed escrows send their rent: the payer, in these tests. `null` leaves escrows open, as old clients do. */
let rentTo: web3.PublicKey | null = null;
const release = (
  id: number[],
  counterparty: web3.PublicKey,
  rent: web3.PublicKey | null = rentTo,
) =>
  program.methods
    .release(id)
    .accounts({
      coordinator: coordinator.publicKey,
      mint,
      counterpartyToken: ata(counterparty),
      tokenProgram: T22,
      rentTo: rent,
    })
    .signers([coordinator])
    .rpc();
const refund = (
  id: number[],
  depositor: web3.PublicKey,
  caller: web3.Keypair,
  rent: web3.PublicKey | null = rentTo,
) =>
  program.methods
    .refund(id)
    .accounts({
      mint,
      depositor,
      depositorToken: ata(depositor),
      caller: caller.publicKey,
      tokenProgram: T22,
      rentTo: rent,
    })
    .signers([caller])
    .rpc();
const releasePartial = (id: number[], who: web3.PublicKey, amount: number, signer = coordinator) =>
  program.methods
    .releasePartial(id, new BN(amount))
    .accounts({
      coordinator: signer.publicKey,
      mint,
      registry: registryPda(who),
      counterpartyToken: ata(who),
      tokenProgram: T22,
      rentTo,
    })
    .signers([signer])
    .rpc();
const escrowGone = async (id: number[]): Promise<boolean> =>
  (await conn.getAccountInfo(escrowPda(new Uint8Array(id)), 'confirmed')) === null &&
  (await conn.getAccountInfo(ata(escrowPda(new Uint8Array(id))), 'confirmed')) === null;
const setCounterparty = (id: number[], who: web3.PublicKey, signer = coordinator) =>
  program.methods
    .setCounterparty(id)
    .accounts({ coordinator: signer.publicKey, registry: registryPda(who) })
    .signers([signer])
    .rpc();
async function fails(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: Error) => e.message.includes(code) || e.toString().includes(code));
}

describe('xchange escrow', () => {
  before(async () => {
    await fund(coordinator, maker, taker, stranger);
    mint = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, T22);
    for (const k of [maker, taker, stranger]) {
      await createAssociatedTokenAccountIdempotent(conn, payer, mint, k.publicKey, undefined, T22);
    }
    await mintTo(
      conn,
      payer,
      mint,
      ata(maker.publicKey),
      payer,
      10_000_000_000n,
      [],
      undefined,
      T22,
    );
    await mintTo(
      conn,
      payer,
      mint,
      ata(taker.publicKey),
      payer,
      1_000_000_000n,
      [],
      undefined,
      T22,
    );
    // A validator that outlives one run keeps the config; point it at this run's coordinator.
    if ((await conn.getAccountInfo(config)) === null) {
      await program.methods
        .initialize(coordinator.publicKey, 25)
        .accounts({ authority: payer.publicKey })
        .rpc();
    } else {
      await program.methods
        .setCoordinator(coordinator.publicKey)
        .accounts({ authority: payer.publicKey })
        .rpc();
    }
    await program.methods
      .register()
      .accounts({ owner: taker.publicKey, payer: payer.publicKey })
      .signers([taker])
      .rpc();
    // Closed escrows send their rent to the payer: the authority says so, once.
    await program.methods.setRentTo(payer.publicKey).accounts({ authority: payer.publicKey }).rpc();
    rentTo = payer.publicKey;
    await fails(
      program.methods
        .setRentTo(stranger.publicKey)
        .accounts({ authority: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      'ConstraintHasOne',
    );
  });

  it('a maker deposits, the coordinator names a registered taker, release pays them less the fee', async () => {
    const id = orderId();
    const before = await balance(taker.publicKey);
    await deposit(maker, id, 1_000_000_000, null, now() + 3600);
    assert.equal(
      (await getAccount(conn, ata(escrowPda(new Uint8Array(id))), 'confirmed', T22)).amount,
      1_000_000_000n,
    );
    // An unregistered address cannot be named.
    await fails(setCounterparty(id, stranger.publicKey), 'AccountNotInitialized');
    // Nor can anyone but the coordinator do the naming, or the releasing.
    await fails(setCounterparty(id, taker.publicKey, stranger), 'ConstraintHasOne');
    await setCounterparty(id, taker.publicKey);
    await fails(setCounterparty(id, taker.publicKey), 'AlreadyMatched');
    await fails(
      program.methods
        .release(id)
        .accounts({
          coordinator: stranger.publicKey,
          mint,
          counterpartyToken: ata(taker.publicKey),
          tokenProgram: T22,
          rentTo,
        })
        .signers([stranger])
        .rpc(),
      'ConstraintHasOne',
    );
    // Release goes to the recorded counterparty only: a stranger's account is refused.
    await fails(release(id, stranger.publicKey), 'WrongCounterparty');
    const lamportsBefore = await conn.getBalance(payer.publicKey, 'confirmed');
    await release(id, taker.publicKey);
    assert.equal((await balance(taker.publicKey)) - before, 997_500_000n);
    assert.equal(await balance(config), 2_500_000n);
    // Emptied, so closed: the escrow and its vault are gone and their rent
    // (two accounts' worth, less this transaction's fee) is back with the payer.
    assert.equal(await escrowGone(id), true);
    const back = (await conn.getBalance(payer.publicKey, 'confirmed')) - lamportsBefore;
    assert.ok(back > 3_000_000, `rent came back: ${back} lamports`);
    // And never twice.
    await fails(release(id, taker.publicKey), 'AccountNotInitialized');
  });

  it('rent goes only where the authority said; a client that names nowhere leaves the escrow as it was', async () => {
    const id = orderId();
    await deposit(maker, id, 1_000_000, null, now() + 3600);
    await setCounterparty(id, taker.publicKey);
    await fails(release(id, taker.publicKey, stranger.publicKey), 'WrongRentDestination');
    // An older client passes no rent accounts: the release still pays, and
    // the escrow stays, marked released, exactly as before this version.
    await release(id, taker.publicKey, null);
    const left = await program.account.escrow.fetch(escrowPda(new Uint8Array(id)));
    assert.deepEqual(left.state, { released: {} });
    assert.equal(await escrowGone(id), false);
  });

  it('one escrow fills several takers a part at a time, and the last part closes it', async () => {
    const id = orderId();
    await deposit(maker, id, 1_000_000_000, null, now() + 3600);
    const before = await balance(taker.publicKey);
    const feesBefore = await balance(config);
    // Only to a registered address, only by the coordinator, never more than is there.
    await fails(releasePartial(id, stranger.publicKey, 1), 'AccountNotInitialized');
    await fails(releasePartial(id, taker.publicKey, 1, stranger), 'ConstraintHasOne');
    await fails(releasePartial(id, taker.publicKey, 1_000_000_001), 'BadAmount');
    await fails(releasePartial(id, taker.publicKey, 0), 'BadAmount');
    // A registry for one address does not let another's token account be paid.
    await fails(
      program.methods
        .releasePartial(id, new BN(1))
        .accounts({
          coordinator: coordinator.publicKey,
          mint,
          registry: registryPda(taker.publicKey),
          counterpartyToken: ata(stranger.publicKey),
          tokenProgram: T22,
          rentTo,
        })
        .signers([coordinator])
        .rpc(),
      'WrongCounterparty',
    );
    // 300 of 1,000, then the remaining 700: two takers of one offer.
    await releasePartial(id, taker.publicKey, 300_000_000);
    assert.equal((await balance(taker.publicKey)) - before, 299_250_000n);
    const mid = await program.account.escrow.fetch(escrowPda(new Uint8Array(id)));
    assert.equal(mid.amount.toString(), '700000000');
    assert.deepEqual(mid.state, { funded: {} });
    // The depositor can still take the rest back while nothing else is in flight.
    // (Not done here, so the rest can be released.)
    await releasePartial(id, taker.publicKey, 700_000_000);
    assert.equal((await balance(taker.publicKey)) - before, 997_500_000n);
    assert.equal((await balance(config)) - feesBefore, 2_500_000n);
    // The last part empties the escrow, so it is closed and its rent is back.
    assert.equal(await escrowGone(id), true);
    await fails(releasePartial(id, taker.publicKey, 1), 'AccountNotInitialized');
    await fails(refund(id, maker.publicKey, maker), 'AccountNotInitialized');
  });

  it('a taker names the maker at deposit and release needs no naming; the depositor cannot refund a matched escrow', async () => {
    const id = orderId();
    await deposit(taker, id, 50_000_000, maker.publicKey, now() + 3600);
    await fails(refund(id, taker.publicKey, taker), 'NotRefundable');
    const before = await balance(maker.publicKey);
    await release(id, maker.publicKey);
    assert.equal((await balance(maker.publicKey)) - before, 49_875_000n);
  });

  it('an unmatched maker refunds themselves at once; nobody else can', async () => {
    const id = orderId();
    const before = await balance(maker.publicKey);
    await deposit(maker, id, 10_000_000, null, now() + 3600);
    await fails(refund(id, maker.publicKey, stranger), 'NotRefundable');
    const lamportsBefore = await conn.getBalance(payer.publicKey, 'confirmed');
    await refund(id, maker.publicKey, maker);
    assert.equal(await balance(maker.publicKey), before);
    // Refunded, so closed: gone, and its rent is back with the payer.
    assert.equal(await escrowGone(id), true);
    assert.ok(
      (await conn.getBalance(payer.publicKey, 'confirmed')) > lamportsBefore,
      'rent came back',
    );
    await fails(release(id, taker.publicKey), 'AccountNotInitialized');
  });

  it('after expiry anyone can refund, and nothing can be released', async () => {
    const id = orderId();
    const before = await balance(maker.publicKey);
    await deposit(maker, id, 10_000_000, null, now() + 2);
    await setCounterparty(id, taker.publicKey);
    await new Promise((r) => setTimeout(r, 4000));
    await fails(release(id, taker.publicKey), 'Expired');
    await refund(id, maker.publicKey, stranger);
    assert.equal(await balance(maker.publicKey), before);
  });

  it('the authority, and nobody else, takes collected fees out of the fee vault', async () => {
    const held = await balance(config);
    assert.ok(held > 0n, 'earlier trades left fees in the vault');
    for (const k of [payer, stranger])
      await createAssociatedTokenAccountIdempotent(conn, payer, mint, k.publicKey, undefined, T22);
    const withdraw = (signer: web3.Keypair, amount: bigint) =>
      program.methods
        .withdrawFees(new BN(amount.toString()))
        .accounts({
          authority: signer.publicKey,
          mint,
          authorityToken: ata(signer.publicKey),
          tokenProgram: T22,
        })
        .signers([signer])
        .rpc();
    // A stranger is refused before anything moves, whichever check trips first.
    await assert.rejects(withdraw(stranger, held));
    assert.equal(await balance(config), held);
    await fails(withdraw(payer, held + 1n), 'BadAmount');
    await fails(withdraw(payer, 0n), 'BadAmount');
    await withdraw(payer, held);
    assert.equal(await balance(config), 0n);
    assert.equal(await balance(payer.publicKey), held);
    await fails(withdraw(payer, 1n), 'BadAmount');
  });

  it('refuses a zero deposit, a past expiry, and a fee above the bound', async () => {
    await fails(deposit(maker, orderId(), 0, null, now() + 60), 'ZeroAmount');
    await fails(deposit(maker, orderId(), 1, null, now() - 60), 'ExpiryInPast');
    await fails(
      program.methods.setFee(1001).accounts({ authority: payer.publicKey }).rpc(),
      'FeeTooHigh',
    );
  });

  /**
   * Escrows that finished before closing existed: released or refunded with
   * no rent accounts, exactly as the program left them before 9 Oct 2026.
   * `close_finished` closes them, to the configured address only, and
   * nothing else. Both token programs: a plain Token mint like USDC, and a
   * Token-2022 mint with the two extensions both XGE mints carry on mainnet
   * (mint close authority and metadata pointer, 270 bytes).
   */
  describe('close_finished', () => {
    type Asset = { mint: web3.PublicKey; program: web3.PublicKey; name: string };
    let usdcLike: Asset;
    let xgeLike: Asset;
    /** Where rent goes in these tests: a fresh address, so every lamport that arrives is counted. */
    const sink = web3.Keypair.generate().publicKey;
    const ataOf = (a: Asset, owner: web3.PublicKey) =>
      getAssociatedTokenAddressSync(a.mint, owner, true, a.program);
    const vaultOf = (a: Asset, id: number[]) => ataOf(a, escrowPda(new Uint8Array(id)));

    async function xgeLikeMint(): Promise<web3.PublicKey> {
      const kp = web3.Keypair.generate();
      const len = getMintLen([ExtensionType.MintCloseAuthority, ExtensionType.MetadataPointer]);
      const tx = new web3.Transaction().add(
        web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: kp.publicKey,
          space: len,
          lamports: await conn.getMinimumBalanceForRentExemption(len),
          programId: T22,
        }),
        createInitializeMintCloseAuthorityInstruction(kp.publicKey, payer.publicKey, T22),
        createInitializeMetadataPointerInstruction(
          kp.publicKey,
          payer.publicKey,
          kp.publicKey,
          T22,
        ),
        createInitializeMint2Instruction(kp.publicKey, 6, payer.publicKey, null, T22),
      );
      await provider.sendAndConfirm(tx, [kp]);
      return kp.publicKey;
    }

    const depositA = (
      a: Asset,
      depositor: web3.Keypair,
      id: number[],
      amount: number,
      cp: web3.PublicKey | null,
    ) =>
      program.methods
        .deposit(id, new BN(amount), cp, new BN(now() + 3600))
        .accounts({
          mint: a.mint,
          depositorToken: ataOf(a, depositor.publicKey),
          depositor: depositor.publicKey,
          payer: payer.publicKey,
          tokenProgram: a.program,
        })
        .signers([depositor])
        .rpc();
    /** A release as the program did it before rent accounts existed: paid, marked released, left open. */
    const releaseOld = (a: Asset, id: number[], to: web3.PublicKey) =>
      program.methods
        .release(id)
        .accounts({
          coordinator: coordinator.publicKey,
          mint: a.mint,
          counterpartyToken: ataOf(a, to),
          tokenProgram: a.program,
          rentTo: null,
        })
        .signers([coordinator])
        .rpc();
    const refundOld = (a: Asset, id: number[], depositor: web3.Keypair) =>
      program.methods
        .refund(id)
        .accounts({
          mint: a.mint,
          depositor: depositor.publicKey,
          depositorToken: ataOf(a, depositor.publicKey),
          caller: depositor.publicKey,
          tokenProgram: a.program,
          rentTo: null,
        })
        .signers([depositor])
        .rpc();
    const close = (
      a: Asset,
      id: number[],
      o: {
        signer?: web3.Keypair;
        to?: web3.PublicKey;
        escrow?: web3.PublicKey;
        vault?: web3.PublicKey;
        tokenProgram?: web3.PublicKey;
        rent?: web3.PublicKey;
      } = {},
    ) => {
      const accounts: Record<string, web3.PublicKey> = {
        mint: a.mint,
        rentTo: o.to ?? sink,
        tokenProgram: o.tokenProgram ?? a.program,
      };
      if (o.escrow !== undefined) accounts.escrow = o.escrow;
      if (o.vault !== undefined) accounts.vault = o.vault;
      if (o.rent !== undefined) accounts.rent = o.rent;
      const m = program.methods.closeFinished(id).accountsPartial(accounts);
      if (o.signer === undefined) return m.rpc();
      // Anyone may ask: the signer is only the transaction's fee payer.
      const signer = o.signer;
      return m.transaction().then((tx) => {
        tx.feePayer = signer.publicKey;
        return web3.sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });
      });
    };
    const lamportsOf = async (k: web3.PublicKey): Promise<number> =>
      (await conn.getAccountInfo(k, 'confirmed'))?.lamports ?? 0;

    before(async () => {
      usdcLike = {
        name: 'Token',
        program: TOKEN_PROGRAM_ID,
        mint: await createMint(
          conn,
          payer,
          payer.publicKey,
          null,
          6,
          undefined,
          undefined,
          TOKEN_PROGRAM_ID,
        ),
      };
      xgeLike = { name: 'Token-2022', program: T22, mint: await xgeLikeMint() };
      assert.equal(
        (await conn.getAccountInfo(xgeLike.mint))?.data.length,
        270,
        'laid out as the live XGE mints',
      );
      for (const a of [usdcLike, xgeLike]) {
        for (const k of [maker, taker, stranger])
          await createAssociatedTokenAccountIdempotent(
            conn,
            payer,
            a.mint,
            k.publicKey,
            undefined,
            a.program,
          );
        await mintTo(
          conn,
          payer,
          a.mint,
          ataOf(a, maker.publicKey),
          payer,
          1_000_000_000n,
          [],
          undefined,
          a.program,
        );
      }
      // The authority points rent at the sink for these tests, and back to the payer after.
      await program.methods.setRentTo(sink).accounts({ authority: payer.publicKey }).rpc();
    });

    for (const which of ['Token', 'Token-2022']) {
      it(`closes a released and a refunded escrow (${which}), every lamport of both rents to the configured address`, async () => {
        const a = which === 'Token' ? usdcLike : xgeLike;
        const released = orderId();
        const refunded = orderId();
        await depositA(a, maker, released, 10_000_000, taker.publicKey);
        await releaseOld(a, released, taker.publicKey);
        await depositA(a, maker, refunded, 10_000_000, null);
        await refundOld(a, refunded, maker);
        for (const [id, state] of [
          [released, { released: {} }],
          [refunded, { refunded: {} }],
        ] as const) {
          assert.deepEqual(
            (await program.account.escrow.fetch(escrowPda(new Uint8Array(id)))).state,
            state,
          );
          assert.equal(await escrowGone(id), false, 'left open, as before v2');
          const rent =
            (await lamportsOf(escrowPda(new Uint8Array(id)))) + (await lamportsOf(vaultOf(a, id)));
          const sinkBefore = await lamportsOf(sink);
          const sig = await close(a, id);
          const landed = await conn.getTransaction(sig, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          const meta = landed?.meta;
          assert.ok(landed !== null && meta !== null && meta !== undefined);
          assert.equal(
            (await lamportsOf(sink)) - sinkBefore,
            rent,
            'both rents, exactly, to the sink',
          );
          // Within the close itself, every account but the signer (who pays
          // the fee; its balance is too large here for exact arithmetic in a
          // JS number), the escrow, its vault and the sink is untouched.
          const moved = new Set([
            escrowPda(new Uint8Array(id)).toBase58(),
            vaultOf(a, id).toBase58(),
            sink.toBase58(),
          ]);
          landed.transaction.message.staticAccountKeys.forEach((k, i) => {
            if (i === 0 || moved.has(k.toBase58())) return;
            assert.equal(meta.postBalances[i], meta.preBalances[i], `${k.toBase58()} unchanged`);
          });
          assert.ok(meta.preBalances[0]! >= meta.postBalances[0]!, 'the signer gains nothing');
          assert.equal(
            (await conn.getAccountInfo(escrowPda(new Uint8Array(id)), 'confirmed')) === null &&
              (await conn.getAccountInfo(vaultOf(a, id), 'confirmed')) === null,
            true,
          );
          // And never twice.
          await fails(close(a, id), 'AccountNotInitialized');
        }
      });
    }

    it('refuses a funded escrow, even once it has expired', async () => {
      for (const a of [usdcLike, xgeLike]) {
        const id = orderId();
        await program.methods
          .deposit(id, new BN(5_000_000), null, new BN(now() + 2))
          .accounts({
            mint: a.mint,
            depositorToken: ataOf(a, maker.publicKey),
            depositor: maker.publicKey,
            payer: payer.publicKey,
            tokenProgram: a.program,
          })
          .signers([maker])
          .rpc();
        await fails(close(a, id), 'StillFunded');
        await new Promise((r) => setTimeout(r, 3000));
        await fails(close(a, id), 'StillFunded');
        assert.equal(
          (await getAccount(conn, vaultOf(a, id), 'confirmed', a.program)).amount,
          5_000_000n,
          'the deposit is untouched',
        );
        // Its owner still has every door they had.
        await refundOld(a, id, maker);
      }
    });

    it('refuses a finished escrow whose vault holds anything, even one unit sent to it afterwards', async () => {
      for (const a of [usdcLike, xgeLike]) {
        const id = orderId();
        await depositA(a, maker, id, 1_000_000, taker.publicKey);
        await releaseOld(a, id, taker.publicKey);
        await provider.sendAndConfirm(
          new web3.Transaction().add(
            createTransferCheckedInstruction(
              ataOf(a, maker.publicKey),
              a.mint,
              vaultOf(a, id),
              maker.publicKey,
              1n,
              6,
              [],
              a.program,
            ),
          ),
          [maker],
        );
        await fails(close(a, id), 'VaultNotEmpty');
        assert.equal((await getAccount(conn, vaultOf(a, id), 'confirmed', a.program)).amount, 1n);
      }
    });

    it('sends rent nowhere but the configured address, whoever asks', async () => {
      const a = xgeLike;
      const id = orderId();
      await depositA(a, maker, id, 1_000_000, taker.publicKey);
      await releaseOld(a, id, taker.publicKey);
      await fails(close(a, id, { to: stranger.publicKey }), 'WrongRentDestination');
      await fails(close(a, id, { to: payer.publicKey }), 'WrongRentDestination');
      // A stranger asking for the rent to come to themselves is refused too.
      await fails(
        close(a, id, { signer: stranger, to: stranger.publicKey }),
        'WrongRentDestination',
      );
      // A rent account that is not the program's own `rent` PDA is refused.
      await fails(close(a, id, { rent: config }), 'AccountDiscriminatorMismatch');
      assert.equal(await escrowGone(id), false);
      await close(a, id);
      assert.equal(await escrowGone(id), true);
    });

    it('anyone may close a finished, empty escrow; the rent still goes only to the configured address', async () => {
      for (const a of [usdcLike, xgeLike]) {
        const id = orderId();
        await depositA(a, maker, id, 1_000_000, taker.publicKey);
        await releaseOld(a, id, taker.publicKey);
        const rent =
          (await lamportsOf(escrowPda(new Uint8Array(id)))) + (await lamportsOf(vaultOf(a, id)));
        const sinkBefore = await lamportsOf(sink);
        const strangerBefore = await lamportsOf(stranger.publicKey);
        const sig = await close(a, id, { signer: stranger });
        const fee =
          (
            await conn.getTransaction(sig, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            })
          )?.meta?.fee ?? -1;
        assert.equal((await lamportsOf(sink)) - sinkBefore, rent, 'both rents to the sink');
        assert.equal(
          strangerBefore - (await lamportsOf(stranger.publicKey)),
          fee,
          'the stranger pays the network fee and receives nothing',
        );
        assert.equal(await escrowGone(id), true);
      }
      // And a stranger is refused everything anyone else is refused.
      const a = usdcLike;
      const funded = orderId();
      await depositA(a, maker, funded, 1_000_000, null);
      await fails(close(a, funded, { signer: stranger }), 'StillFunded');
      const dusted = orderId();
      await depositA(a, maker, dusted, 1_000_000, taker.publicKey);
      await releaseOld(a, dusted, taker.publicKey);
      await provider.sendAndConfirm(
        new web3.Transaction().add(
          createTransferCheckedInstruction(
            ataOf(a, maker.publicKey),
            a.mint,
            vaultOf(a, dusted),
            maker.publicKey,
            1n,
            6,
            [],
            a.program,
          ),
        ),
        [maker],
      );
      await fails(close(a, dusted, { signer: stranger }), 'VaultNotEmpty');
      assert.equal(
        (await getAccount(conn, vaultOf(a, funded), 'confirmed', a.program)).amount,
        1_000_000n,
      );
      await refundOld(a, funded, maker);
    });

    it("refuses another escrow's vault, the wrong token program, and an account that is not this escrow", async () => {
      const a = usdcLike;
      const one = orderId();
      const two = orderId();
      for (const id of [one, two]) {
        await depositA(a, maker, id, 1_000_000, taker.publicKey);
        await releaseOld(a, id, taker.publicKey);
      }
      // Another finished escrow's empty vault, offered as this one's.
      await fails(close(a, one, { vault: vaultOf(a, two) }), 'ConstraintTokenOwner');
      // A vault of the right owner under the other token program does not exist, and is refused.
      await fails(close(a, one, { tokenProgram: T22 }), 'AccountNotInitialized');
      // The escrow must be the PDA of the order id given: another escrow is refused.
      await fails(
        close(a, one, { escrow: escrowPda(new Uint8Array(two)), vault: vaultOf(a, two) }),
        'ConstraintSeeds',
      );
      // An account owned by another program (the mint, owned by Token) is refused.
      await fails(close(a, one, { escrow: a.mint }), 'AccountOwnedByWrongProgram');
      assert.equal(await escrowGone(one), false);
      assert.equal(await escrowGone(two), false);
      await close(a, one);
      await close(a, two);
      assert.equal((await escrowGone(one)) && (await escrowGone(two)), true);
    });

    it('every other door is unchanged: an escrow it cannot close still refunds and releases as before', async () => {
      const a = xgeLike;
      const id = orderId();
      await depositA(a, maker, id, 2_000_000, taker.publicKey);
      await fails(close(a, id), 'StillFunded');
      // Released by a current client, with rent accounts: closed at once, as v2 does.
      await program.methods
        .release(id)
        .accounts({
          coordinator: coordinator.publicKey,
          mint: a.mint,
          counterpartyToken: ataOf(a, taker.publicKey),
          tokenProgram: a.program,
          rentTo: sink,
        })
        .signers([coordinator])
        .rpc();
      assert.equal(await escrowGone(id), true);
      await fails(close(a, id), 'AccountNotInitialized');
    });

    after(async () => {
      await program.methods
        .setRentTo(payer.publicKey)
        .accounts({ authority: payer.publicKey })
        .rpc();
    });
  });
});
