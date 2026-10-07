import { expect } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  PRIVATE_URL,
  PROGRAM_DATA,
  PROGRAM_ID,
  SPONSOR,
  VALIDATOR,
  admin,
  base,
  decodedProfile,
  profileAccounts,
  profileOf,
  program,
  readingAs,
  refusal,
  rollup,
  send,
  until,
} from "./support";

const MAX_DATA_LEN = 512;
const SPONSOR_FUNDING = 0.01 * LAMPORTS_PER_SOL;

/** What the rollup charges to hold an account of `space` bytes. */
const rollupRent = (space: number) => (space + 60) * 32;
const profileSpace = (dataLen: number) => 54 + dataLen;
const PERMISSION_SPACE = 35 + 2 * 33;

const gate = Keypair.generate();
const stranger = Keypair.generate();

const settings = (over: { maxDataLen?: number; paused?: boolean } = {}) => ({
  gate: gate.publicKey,
  validator: VALIDATOR,
  maxDataLen: MAX_DATA_LEN,
  paused: false,
  ...over,
});

const record = (length: number, fill: number) => Buffer.alloc(length, fill);

async function funded(key: Keypair, sol: number) {
  const signature = await base.requestAirdrop(
    key.publicKey,
    sol * LAMPORTS_PER_SOL,
  );
  await base.confirmTransaction(
    { signature, ...(await base.getLatestBlockhash()) },
    "confirmed",
  );
}

const initialize = (
  by: Keypair,
  with_: ReturnType<typeof settings>,
  lamports = SPONSOR_FUNDING,
) =>
  program.methods
    .initializeSponsor(with_, new BN(lamports))
    .accountsPartial({
      admin: by.publicKey,
      sponsor: SPONSOR,
      program: PROGRAM_ID,
      programData: PROGRAM_DATA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

const create = (owner: PublicKey, data: Buffer, signedGate = gate.publicKey) =>
  program.methods
    .createProfile(data)
    .accountsPartial({ gate: signedGate, ...profileAccounts(owner) })
    .instruction();

const write = (owner: PublicKey, expectedRevision: number, data: Buffer) =>
  program.methods
    .writeProfile(new BN(expectedRevision), data)
    .accountsPartial({ gate: gate.publicKey, ...profileAccounts(owner) })
    .instruction();

const close = (owner: PublicKey) =>
  program.methods
    .closeProfile()
    .accountsPartial(profileAccounts(owner))
    .instruction();

const update = (by: PublicKey, with_: ReturnType<typeof settings>) =>
  program.methods
    .updateSponsor(with_)
    .accountsPartial({ admin: by, sponsor: SPONSOR })
    .instruction();

const sponsorBalance = () => rollup.getBalance(SPONSOR);

describe("the sponsor, on Solana", () => {
  before(async () => {
    await Promise.all([funded(admin, 5), funded(stranger, 5)]);
  });

  it("can only be set up by the program's upgrade authority", async () => {
    const error = await refusal(
      send(base, await initialize(stranger, settings()), stranger),
    );
    expect(error).to.include("NotUpgradeAuthority");
    expect(await base.getAccountInfo(SPONSOR)).to.equal(null);
  });

  it("refuses a size limit of zero or above the hard maximum", async () => {
    for (const maxDataLen of [0, 4097]) {
      const error = await refusal(
        send(base, await initialize(admin, settings({ maxDataLen })), admin),
      );
      expect(error).to.include("InvalidSizeLimit");
    }
  });

  it("is delegated to the rollup only by its admin", async () => {
    await send(base, await initialize(admin, settings()), admin);

    const delegate = (by: PublicKey) =>
      program.methods
        .delegateSponsor()
        .accountsPartial({ admin: by, sponsor: SPONSOR })
        .instruction();

    const error = await refusal(
      send(base, await delegate(stranger.publicKey), stranger),
    );
    expect(error).to.include("NotAdmin");

    await send(base, await delegate(admin.publicKey), admin);
    await until(sponsorBalance, "the sponsor to reach the rollup");
  });
});

describe("a profile, on the rollup", () => {
  const owner = Keypair.generate();
  const first = record(300, 7);

  it("is created for an owner and a gate that hold no SOL, and costs the sponsor only its rent", async () => {
    expect(await base.getBalance(owner.publicKey)).to.equal(0);
    expect(await base.getBalance(gate.publicKey)).to.equal(0);
    const before = await sponsorBalance();

    await send(rollup, await create(owner.publicKey, first), gate, [owner]);

    expect(before - (await sponsorBalance())).to.equal(
      rollupRent(profileSpace(first.length)) + rollupRent(PERMISSION_SPACE),
    );
    const stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.owner.equals(owner.publicKey)).to.equal(true);
    expect(stored?.revision).to.equal(1n);
    expect(stored?.data.equals(first)).to.equal(true);
  });

  it("is readable through the private endpoint by its owner and by nobody else", async () => {
    const address = profileOf(owner.publicKey);

    const asOwner = await readingAs(owner);
    const mine = await decodedProfile(asOwner, owner.publicKey);
    expect(mine?.data.equals(first)).to.equal(true);

    const asStranger = await readingAs(stranger);
    expect(await asStranger.getAccountInfo(address)).to.equal(null);

    const unsigned = new Connection(PRIVATE_URL, "confirmed");
    const withoutToken = await unsigned.getAccountInfo(address).then(
      (account) => account,
      () => null,
    );
    expect(withoutToken).to.equal(null);
  });

  it("is not created without the gate's signature", async () => {
    const other = Keypair.generate();
    const error = await refusal(
      send(
        rollup,
        await create(other.publicKey, first, stranger.publicKey),
        stranger,
        [other],
      ),
    );
    expect(error).to.include("GateMissing");
    expect(await decodedProfile(rollup, other.publicKey)).to.equal(null);
  });

  it("is not created twice", async () => {
    const error = await refusal(
      send(rollup, await create(owner.publicKey, record(10, 1)), gate, [owner]),
    );
    expect(error).to.include("ProfileExists");
    const stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.data.equals(first)).to.equal(true);
  });

  it("refuses an empty record and one over the limit", async () => {
    const other = Keypair.generate();
    for (const [data, reason] of [
      [record(0, 0), "EmptyRecord"],
      [record(MAX_DATA_LEN + 1, 1), "RecordTooLarge"],
    ] as const) {
      const error = await refusal(
        send(rollup, await create(other.publicKey, data), gate, [other]),
      );
      expect(error).to.include(reason);
    }
  });

  it("grows and shrinks with what is written, and the sponsor pays or is repaid the difference", async () => {
    const larger = record(450, 9);
    const before = await sponsorBalance();
    await send(rollup, await write(owner.publicKey, 1, larger), gate, [owner]);

    expect(before - (await sponsorBalance())).to.equal(
      (larger.length - first.length) * 32,
    );
    let stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.revision).to.equal(2n);
    expect(stored?.data.equals(larger)).to.equal(true);

    const smaller = record(120, 3);
    await send(rollup, await write(owner.publicKey, 2, smaller), gate, [owner]);

    expect(before - (await sponsorBalance())).to.equal(
      (smaller.length - first.length) * 32,
    );
    stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.revision).to.equal(3n);
    expect(stored?.data.equals(smaller)).to.equal(true);
    expect(stored?.space).to.equal(profileSpace(smaller.length));
  });

  it("refuses a write made on top of an older revision, and keeps what it had", async () => {
    const error = await refusal(
      send(rollup, await write(owner.publicKey, 2, record(50, 5)), gate, [
        owner,
      ]),
    );
    expect(error).to.include("StaleRevision");
    const stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.revision).to.equal(3n);
    expect(stored?.data.equals(record(120, 3))).to.equal(true);
  });

  it("cannot be written or closed by another key, even with the gate's signature", async () => {
    const attacker = Keypair.generate();
    const victim = profileAccounts(owner.publicKey);
    const aimedAtVictim = {
      ...victim,
      owner: attacker.publicKey,
    };

    const writing = await program.methods
      .writeProfile(new BN(3), record(20, 6))
      .accountsPartial({ gate: gate.publicKey, ...aimedAtVictim })
      .instruction();
    expect(
      await refusal(send(rollup, writing, gate, [attacker])),
    ).to.include("ConstraintSeeds");

    const closing = await program.methods
      .closeProfile()
      .accountsPartial(aimedAtVictim)
      .instruction();
    expect(
      await refusal(send(rollup, closing, gate, [attacker])),
    ).to.include("ConstraintSeeds");

    const stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.revision).to.equal(3n);
  });

  it("is neither created nor written while the sponsor is paused, and only the admin can pause", async () => {
    const error = await refusal(
      send(
        rollup,
        await update(stranger.publicKey, settings({ paused: true })),
        stranger,
      ),
    );
    expect(error).to.include("NotAdmin");

    await send(
      rollup,
      await update(admin.publicKey, settings({ paused: true })),
      admin,
    );

    const other = Keypair.generate();
    expect(
      await refusal(
        send(rollup, await create(other.publicKey, first), gate, [other]),
      ),
    ).to.include("Paused");
    expect(
      await refusal(
        send(rollup, await write(owner.publicKey, 3, first), gate, [owner]),
      ),
    ).to.include("Paused");
  });

  it("is closed by its owner alone, even while paused, and the sponsor gets all its rent back", async () => {
    const address = profileOf(owner.publicKey);
    const before = await sponsorBalance();

    await send(rollup, await close(owner.publicKey), owner);

    expect((await sponsorBalance()) - before).to.equal(
      rollupRent(profileSpace(120)) + rollupRent(PERMISSION_SPACE),
    );
    expect(await rollup.getAccountInfo(address)).to.equal(null);
    expect(
      await rollup.getAccountInfo(profileAccounts(owner.publicKey).permission),
    ).to.equal(null);
  });

  it("can be created again after it was closed, starting from revision one", async () => {
    await send(
      rollup,
      await update(admin.publicKey, settings({ paused: false })),
      admin,
    );
    const again = record(64, 2);
    await send(rollup, await create(owner.publicKey, again), gate, [owner]);

    const mine = await decodedProfile(await readingAs(owner), owner.publicKey);
    expect(mine?.revision).to.equal(1n);
    expect(mine?.data.equals(again)).to.equal(true);

    // Paid by the gate this time: the same close, paid by the same key in
    // the same moment, would be the very transaction the rollup already ran.
    await send(rollup, await close(owner.publicKey), gate, [owner]);
  });
});

describe("the sponsor, back on Solana", () => {
  const withdraw = (by: PublicKey, lamports: number) =>
    program.methods
      .withdrawSponsor(new BN(lamports))
      .accountsPartial({ admin: by, sponsor: SPONSOR })
      .instruction();

  it("is undelegated only by its admin, with every lamport it was funded with", async () => {
    const undelegate = (by: PublicKey) =>
      program.methods
        .undelegateSponsor()
        .accountsPartial({ admin: by, sponsor: SPONSOR })
        .instruction();

    expect(
      await refusal(
        send(rollup, await undelegate(stranger.publicKey), stranger),
      ),
    ).to.include("NotAdmin");

    await send(rollup, await undelegate(admin.publicKey), admin);
    await until(
      async () =>
        (await base.getAccountInfo(SPONSOR))?.owner.equals(PROGRAM_ID),
      "the sponsor to return to Solana",
      60_000,
    );

    const rent = await base.getMinimumBalanceForRentExemption(
      (await base.getAccountInfo(SPONSOR))!.data.length,
    );
    expect(await base.getBalance(SPONSOR)).to.equal(rent + SPONSOR_FUNDING);
  });

  it("pays out to its admin only, and never below its own rent", async () => {
    expect(
      await refusal(
        send(base, await withdraw(stranger.publicKey, 1), stranger),
      ),
    ).to.include("NotAdmin");
    expect(
      await refusal(
        send(base, await withdraw(admin.publicKey, SPONSOR_FUNDING + 1), admin),
      ),
    ).to.include("BelowRent");

    const before = await base.getBalance(SPONSOR);
    await send(base, await withdraw(admin.publicKey, SPONSOR_FUNDING), admin);
    expect(before - (await base.getBalance(SPONSOR))).to.equal(SPONSOR_FUNDING);
  });
});
