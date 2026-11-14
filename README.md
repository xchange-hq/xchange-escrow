# xchange escrow

The on-chain escrow behind [xchange](https://xchangehq.com), a non-custodial
peer-to-peer exchange, and the TypeScript client that talks to it.

Program on Solana mainnet: `9TwvUTeAP5q2CjkgrkUBDjqUR1PWJCvnXysSWxhnVvBZ`

## What it does

Two people who want to swap tokens each deposit their side into an escrow the
program owns. Funds leave an escrow by exactly two doors:

- **release** to the counterparty, less the configured fee, or
- **refund** to the person who deposited.

There is no third door. Nobody, the program's authority included, can send
escrowed funds anywhere else.

- An order can fill in parts: `release_partial` pays part of an escrow and
  leaves the rest for the next taker.
- An unmatched escrow can be refunded by its depositor at any time, and by
  anyone once it has expired, always to the depositor.
- When the last of an escrow's funds leave, its accounts are closed and the
  rent returns to the wallet that paid it.
- An escrow that finished without being closed can be closed by anyone with
  `close_finished`. It moves no tokens: it refuses an escrow that is still
  funded or a vault that is not empty, and the rent goes only to the address
  the authority set.
- It works with the Token program and with Token-2022.

## Instructions

| Instruction        | Who signs        | What it does                                                              |
| ------------------ | ---------------- | ------------------------------------------------------------------------- |
| `register`         | a wallet         | Records the wallet as an address that may be paid. Once per wallet.       |
| `deposit`          | the depositor    | Opens an escrow for an order id and moves the tokens into its vault.      |
| `set_counterparty` | the coordinator  | Names the registered wallet a whole escrow will be released to.           |
| `release`          | the coordinator  | Pays the whole escrow to its counterparty, less the fee.                  |
| `release_partial`  | the coordinator  | Pays part of an escrow to a registered wallet, less the fee.              |
| `refund`           | depositor or any | Returns what is left to the depositor (anyone may call it after expiry).  |
| `close_finished`   | anyone           | Closes a released or refunded escrow whose vault is empty; rent as set.   |
| `initialize`       | the authority    | Once: sets the coordinator and the fee.                                   |
| `set_coordinator`  | the authority    | Changes the coordinator.                                                  |
| `set_fee`          | the authority    | Changes the fee, never above 10%.                                         |
| `set_rent_to`      | the authority    | Sets where the rent of closed escrows returns.                            |
| `withdraw_fees`    | the authority    | Withdraws collected fees from the fee vault.                              |

## What you are trusting

Read this before you rely on it.

- **The coordinator.** One key matches orders and signs releases. It can pay
  an escrow only to a wallet that has registered itself, and it cannot refund
  to anyone but the depositor. A coordinator key that was stolen could
  release an open escrow to a registered wallet of the thief's choosing. A
  second, independent signer on every release is designed and is the next
  change to this program.
- **The authority.** One key can change the coordinator and the fee (capped
  at 10%), withdraw collected fees, and upgrade the program. It cannot move
  escrowed funds, but a program upgrade could change that, as with any
  upgradeable program.
- **No audit yet.** The program has tests, and has run on mainnet since
  September 2026, but no outside party has reviewed it.
- **Tokens with extensions.** Use plain mints. A Token-2022 mint with a
  transfer fee, a transfer hook or a permanent delegate is not handled: the
  vault would receive less than the escrow records.

## Layout

```
program/   the Anchor program (Rust) and its tests
client/    the TypeScript client: builds, signs and reads the program's transactions
```

## Build and test the program

Needs Rust, the Solana CLI and Anchor.

```
cd program
npm install
anchor build
anchor test
```

The source of the build on mainnet is `program/programs/xchange_escrow/src/lib.rs`
as it stands here. The program was last upgraded on 14 November 2026, adding
`close_finished`; that build is 285,128 bytes, sha256
`4c7a590e7b811407bfec14f6e184386d1e95635684d15acd86669f0343074f40`. Its
embedded security.txt names the repository it was first built from; a later
upgrade will name this one.

## Use the client

```
cd client
npm install
npm run build
```

```ts
import { SolanaEscrow } from './dist/index.js';

const escrow = new SolanaEscrow({
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  commitment: 'confirmed',
  programId: '9TwvUTeAP5q2CjkgrkUBDjqUR1PWJCvnXysSWxhnVvBZ',
  coordinatorEncryptedKey: '…',
  feePayerEncryptedKey: '…',
  decrypt: (ciphertext) => myVault.decrypt(ciphertext),
});

const state = await escrow.escrow(orderId); // null, or who deposited what, and its status
```

Reading needs no keys that hold funds. Building a deposit needs a fee payer;
releasing needs the coordinator. Keys are passed encrypted with a `decrypt`
function of your own, so they never sit in configuration in the clear.

## Security

See [SECURITY.md](SECURITY.md). Report anything that could put funds at risk
to contact@xchangehq.com before making it public.

## Licence

MIT. See [LICENSE](LICENSE).
