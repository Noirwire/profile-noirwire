<h1 align="center">profile-noirwire</h1>
<p align="center">The on-chain program that keeps a NoirWire wallet's own labels, as ciphertext, on a private rollup.</p>

<p align="center">
  <a href="https://github.com/Noirwire/profile-noirwire/actions/workflows/ci.yml"><img src="https://github.com/Noirwire/profile-noirwire/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/license-proprietary-black" alt="License">
</p>

NoirWire is a non-custodial Solana wallet. One recovery phrase derives a funding wallet and separate portfolios, and the keys never leave the device. This program stores one small record per wallet (portfolio names, icons, colours, watchlist) so the labels come back when the recovery phrase is restored on another device.

- The record is encrypted on the device before it is written. This program only ever stores ciphertext and never interprets it.
- Each record belongs to a key derived from the recovery phrase for this purpose only. It is not the funding wallet and not a portfolio.
- The program runs on MagicBlock's Private Ephemeral Rollup, where each record carries a read permission naming its owner and nobody else.
- One account, the sponsor, pays the rent of every record, so an owner needs no SOL. A second key, the gate, must sign every instruction that spends that rent.
- It holds no user money and is not part of any payment or trade.

We publish this source so that anyone can read what runs. See [LICENSE](LICENSE) for what you may do with it.

## What it guarantees, and what it does not

Checked by the program, and proven by the tests on a local network:

- Only the owner's key can write or close a profile. Another key is refused even with the gate's signature.
- A profile and its read permission are created in one instruction, so the record is never readable by anyone else in between.
- A write lands only on top of the revision the writer last read. An older copy cannot overwrite a newer one.
- Nothing that costs the sponsor rent happens without the gate's signature. Closing needs only the owner, and returns the rent.
- While paused, nothing is created or written. An owner can still close their own profile.
- The permission account is the one address the permission program derives for that profile. Any other is refused.
- Only the program's upgrade authority can set up the sponsor. Only the sponsor's admin can change its settings, move it or pay it out, and never below its own rent.

Not this program's to guarantee:

- **Confidentiality of reads** is the rollup's. The program attaches an owner-only permission; the rollup's query filter enforces it. The record is ciphertext either way.
- **Durability** is the rollup's. A profile exists only inside the rollup and is never committed to Solana. The device's own wallet record stays the truth; this is a mirror.
- **Rate limiting** is the gate holder's. The program checks that the gate signed, not how often.

Not proven by the local tests:

- That a record survives a restart of the rollup validator.
- Behaviour on the public devnet and mainnet private validators. Every test here runs against a local stack.

This program has not had a third-party audit.

## How it is laid out

```
programs/noirwire-profile/src/
  lib.rs                   the instruction list and the embedded security contact
  state.rs                 the two accounts, their seeds and their pure rules
  errors.rs                what a caller did wrong, by name
  instructions/sponsor.rs  set up, change, move and pay out the sponsor
  instructions/profile.rs  create, write and close a profile
tests/
  profile.test.ts          the behaviour, as sentences
  support.ts               connections, addresses and one helper per repeated action
Makefile                   the only entry point
```

### Accounts

| Account    | Address                                                       | Lives on                         | Holds                                                                                   |
| ---------- | ------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Sponsor    | seeds `["sponsor"]`                                           | Solana, then delegated to rollup | bump, admin, gate, `max_data_len` (u16), paused. 76 bytes with its discriminator        |
| Profile    | seeds `["profile", owner]`                                    | the rollup only                  | layout (1), bump, owner, revision (u64), data (u32 length, then bytes). 54 bytes + data |
| Permission | seeds `["permission:", profile]` under the permission program | the rollup only                  | the one member allowed to read the profile: its owner                                   |

Profile bytes: 0-7 discriminator, 8 layout, 9 bump, 10-41 owner, 42-49 revision (little endian), 50-53 data length (little endian), 54 onwards data.

### Instructions

| Instruction          | Sent to                    | Signed by                 | What it does                                                                       |
| -------------------- | -------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `initialize_sponsor` | Solana                     | program upgrade authority | Creates the sponsor with its settings. The signer becomes its admin                |
| `update_sponsor`     | wherever the sponsor lives | admin                     | Sets the gate, the size limit (1 to 4096 bytes) and the pause                      |
| `delegate_sponsor`   | Solana                     | admin                     | Moves the sponsor and its balance to the rollup run by the given validator         |
| `undelegate_sponsor` | the rollup                 | admin                     | Brings the sponsor back to Solana with what it has left                            |
| `withdraw_sponsor`   | Solana                     | admin                     | Pays the admin from the undelegated sponsor, never below the sponsor's own rent    |
| `create_profile`     | the rollup                 | gate and owner            | Creates the owner's profile at revision 1, with its owner-only read permission     |
| `write_profile`      | the rollup                 | gate and owner            | Replaces the record if `expected_revision` matches, and raises the revision by one |
| `close_profile`      | the rollup                 | owner                     | Removes the profile and its permission. The rent goes back to the sponsor          |

The sponsor is funded with a plain system transfer to its address while it is on Solana. There is no instruction for it, because none is needed.

The account order and the discriminators of the three profile instructions, the seeds and the profile layout are relied on by the wallet apps and do not change. The interface file is `target/idl/noirwire_profile.json` after a build.

### What a profile costs

The rollup charges `(size + 60) * 32` lamports of rent per account, and returns it when the account is closed. A 300-byte record is a 354-byte profile and a 101-byte permission: 13,248 + 5,152 = **18,400 lamports**, measured by the tests, paid by the sponsor and returned to it on close. Growing or shrinking a record moves 32 lamports per byte. Neither the owner nor the gate needs any SOL on the rollup.

## Build and test

You need Rust (the version in `rust-toolchain.toml` is picked up by itself), the Solana CLI 2.3.11, Anchor 1.0.2 and Node 26. With `avm`, `make` uses `anchor-1.0.2` directly whatever version is active.

```sh
git clone https://github.com/Noirwire/profile-noirwire.git
cd profile-noirwire
make install
make test
```

```sh
make build          # compile the program and its interface file
make test           # build, start a fresh local network, run the tests, stop it
make stack          # start the local network and leave it running
make check          # cargo fmt, clippy with warnings as errors, prettier, tsc
make format         # fix formatting
make audit          # cargo audit over Cargo.lock
make verify-build   # reproducible build in a container, and its hash
```

`make test` starts a Solana validator, a private rollup and its query filter on ports 8899, 8900, 7799, 7800, 6699, 6700 and 9900, runs every test against them and stops them. Nothing in this repository sends a transaction to a public network. The program is loaded at its declared address with a throwaway key under `.localnet` as its upgrade authority, so no real key is needed to build or test.

CI runs the same targets on every push and pull request: `make check`, `make audit`, `make build`, `make test`.

## Deploying

Nothing here deploys by itself. These are the steps, in order, for devnet first and then mainnet. The program keypair and every other key stay outside this repository.

1. **Build reproducibly.** `make verify-build` builds in a container and prints the hash of the program. Deploy that file, not a local build.

   ```sh
   make verify-build
   solana program deploy -u devnet target/deploy/noirwire_profile.so --program-id <program keypair>
   solana-verify verify-from-repo -u devnet --program-id AiS6fT2x5XELHvZPrLfdzydC9xUazjS6r4z4bNDTqtHQ \
     --library-name noirwire_profile https://github.com/Noirwire/profile-noirwire
   ```

2. **Set up the sponsor**, with the deploy key, while it is still the upgrade authority. `initialize_sponsor` makes the signer the sponsor's admin for good; there is no instruction to change the admin. The admin signs on the rollup to pause and to undelegate, so it must be an ordinary key that can sign there.
   - `initialize_sponsor({ gate, max_data_len, paused: false })` on Solana.
   - Fund it: a plain transfer to the sponsor's address, `solana transfer <sponsor> <amount>`. Budget 18,400 lamports per 300-byte profile.
   - `delegate_sponsor(validator)` on Solana. `validator` is the identity of the private rollup validator for that network, from MagicBlock's documentation. Check it against `getIdentity` on the rollup's own endpoint before sending. The program does not store it and cannot check it for you.

3. **Hand the upgrade authority to a multisig.** Squads is the common choice.

   ```sh
   solana program set-upgrade-authority AiS6fT2x5XELHvZPrLfdzydC9xUazjS6r4z4bNDTqtHQ \
     --new-upgrade-authority <multisig vault> --skip-new-upgrade-authority-signer-check
   ```

4. **Repeat on mainnet** once devnet behaves, with a mainnet gate key and the mainnet validator.

This repository ships no admin command line. The sponsor instructions are sent with any Anchor client built from the interface file, exactly as `tests/profile.test.ts` does:

```ts
await program.methods
  .initializeSponsor({ gate, maxDataLen: 2048, paused: false })
  .accountsPartial({ admin, sponsor, program: programId, programData })
  .rpc();
await program.methods
  .delegateSponsor(validator)
  .accountsPartial({ admin, sponsor })
  .rpc();
```

### The gate key

The gate is an ordinary keypair made for this purpose and held only by the service that stands in front of this program and rate limits profile creation. Its public key is the `gate` in the sponsor's settings. It pays the rollup's transaction fee for create and write, and it needs no SOL. Use a different gate key per network. To replace it, send `update_sponsor` with the new public key.

### Topping up the sponsor

Fund the sponsor only while it is on Solana. What happens to lamports sent to its address while it is delegated is not covered by the tests. The procedure, which the tests run end to end with a profile left open:

1. `undelegate_sponsor`, sent to the rollup. Wait until the sponsor's owner on Solana is this program again (about nine seconds on the local stack).
2. Transfer SOL to the sponsor's address on Solana.
3. `delegate_sponsor(validator)` on Solana.

While the sponsor is away, existing profiles stay readable by their owners, and every create, write and close is refused by the rollup, because the sponsor is not writable there. Profiles that were open before are readable and writable again afterwards, and new ones can be created. On the local stack the whole procedure takes about ten seconds. Expect longer on a public network, and do it at a quiet hour.

To take SOL out, undelegate and call `withdraw_sponsor(lamports)` on Solana. It is refused on the rollup.

### Pausing

Send `update_sponsor` with `paused: true`, signed by the admin, to wherever the sponsor lives: the rollup while it is delegated. Nothing is created or written until it is sent again with `paused: false`. Owners can still close their own profiles. The settings are sent whole, so repeat the current gate and size limit.

## Security

Every instruction checks who signed, which program owns each account it reads, and that each address is the one its seeds derive. Arithmetic is checked, and the release build keeps overflow checks on. The contact for reports is embedded in the program with `solana-security-txt`. Report a vulnerability privately: see [SECURITY.md](SECURITY.md).

## Later

Richer accounts and social features will be separate account types and separate instructions, never inside this private record. The profile's layout byte is the hook.

## Licence

Copyright (c) 2026 NoirWire. All rights reserved. Published for transparency; no licence is granted. See [LICENSE](LICENSE).
