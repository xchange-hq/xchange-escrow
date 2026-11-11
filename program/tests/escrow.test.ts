import { AnchorProvider, BN, Program, Wallet, web3 } from '@coral-xyz/anchor';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from '@solana/spl-token';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';

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
});
