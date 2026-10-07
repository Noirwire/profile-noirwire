import { expect } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PRIVATE_URL,
  PROGRAM_DATA,
  PROGRAM_ID,
  SPONSOR,
  VALIDATOR,
  admin,
  airdropped,
  base,
  decodedProfile,
  decodedSponsor,
  profileAccounts,
  profileOf,
  program,
  readingAs,
  refusal,
  rollup,
  send,
  transferred,
  until,
} from "./support";

const MAX_DATA_LEN = 2048;
const SPONSOR_FUNDING = 0.01 * LAMPORTS_PER_SOL;
const SPONSOR_TOP_UP = 0.02 * LAMPORTS_PER_SOL;

/** What the rollup charges to hold an account of `space` bytes. */
const rollupRent = (space: number) => (space + 60) * 32;
const profileSpace = (dataLen: number) => 54 + dataLen;
const PERMISSION_SPACE = 35 + 2 * 33;
const profileCost = (dataLen: number) =>
  rollupRent(profileSpace(dataLen)) + rollupRent(PERMISSION_SPACE);

const gate = Keypair.generate();
const stranger = Keypair.generate();

const settings = (over: { maxDataLen?: number; paused?: boolean } = {}) => ({
  gate: gate.publicKey,
  maxDataLen: MAX_DATA_LEN,
  paused: false,
  ...over,
});

const record = (length: number, fill: number) => Buffer.alloc(length, fill);

const asAdmin = (by: PublicKey) => ({ admin: by, sponsor: SPONSOR });

const initialize = (by: PublicKey, with_: ReturnType<typeof settings>) =>
  program.methods
    .initializeSponsor(with_)
    .accountsPartial({
      ...asAdmin(by),
      program: PROGRAM_ID,
      programData: PROGRAM_DATA,
    })
    .instruction();

const update = (by: PublicKey, with_: ReturnType<typeof settings>) =>
  program.methods
    .updateSponsor(with_)
    .accountsPartial(asAdmin(by))
    .instruction();

const delegate = (by: PublicKey) =>
  program.methods
    .delegateSponsor(VALIDATOR)
    .accountsPartial(asAdmin(by))
    .instruction();

const undelegate = (by: PublicKey) =>
  program.methods
    .undelegateSponsor()
    .accountsPartial(asAdmin(by))
    .instruction();

const withdraw = (by: PublicKey, lamports: number) =>
  program.methods
    .withdrawSponsor(new BN(lamports))
    .accountsPartial(asAdmin(by))
    .instruction();

const nominate = (by: PublicKey, nominee: PublicKey | null) =>
  program.methods
    .nominateAdmin(nominee)
    .accountsPartial(asAdmin(by))
    .instruction();

const accept = (nominee: PublicKey) =>
  program.methods
    .acceptAdmin()
    .accountsPartial({ nominee, sponsor: SPONSOR })
    .instruction();

/** The same instruction, no longer asking for `key`'s signature. */
function unsignedBy(
  instruction: TransactionInstruction,
  key: PublicKey,
): TransactionInstruction {
  instruction.keys = instruction.keys.map((meta) =>
    meta.pubkey.equals(key) ? { ...meta, isSigner: false } : meta,
  );
  return instruction;
}

/**
 * The hand-over of the admin role, wherever the sponsor lives. `powers` are
 * the instructions only an admin may send there.
 */
function handsOverItsAdminRole(
  connection: Connection,
  powers: (by: PublicKey) => Promise<TransactionInstruction>[],
) {
  const heir = Keypair.generate();
  const adminIs = async (key: Keypair) =>
    expect((await decodedSponsor(connection)).admin.equals(key.publicKey)).to.be
      .true;

  before(() => airdropped(heir.publicKey, 1));

  it("offers its admin role only through its admin, and gives it only to a nominee who signs", async () => {
    expect(
      await refusal(
        send(
          connection,
          await nominate(stranger.publicKey, stranger.publicKey),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");

    await send(
      connection,
      await nominate(admin.publicKey, heir.publicKey),
      admin,
    );
    expect(
      await refusal(
        send(connection, await accept(stranger.publicKey), stranger),
      ),
    ).to.include("NotNominee");
    expect(
      await refusal(
        send(
          connection,
          unsignedBy(await accept(heir.publicKey), heir.publicKey),
          stranger,
        ),
      ),
    ).to.include("AccountNotSigner");
    await adminIs(admin);
  });

  it("keeps its admin when the offer is withdrawn or made to another key", async () => {
    // Each attempt is paid for by a different key. The rollup takes two
    // byte-identical transactions sent in the same moment for one.
    for (const [nominee, feePayer] of [
      [null, stranger],
      [stranger.publicKey, admin],
    ] as const) {
      await send(connection, await nominate(admin.publicKey, nominee), admin);
      expect(
        await refusal(
          send(connection, await accept(heir.publicKey), feePayer, [heir]),
        ),
      ).to.include("NotNominee");
    }
    await adminIs(admin);
  });

  it("leaves the old admin no power once the nominee accepts, and the new admin can pause", async () => {
    await send(
      connection,
      await nominate(admin.publicKey, heir.publicKey),
      stranger,
      [admin],
    );
    await send(connection, await accept(heir.publicKey), heir);
    await adminIs(heir);
    expect((await decodedSponsor(connection)).pendingAdmin).to.equal(null);

    for (const power of powers(admin.publicKey)) {
      expect(await refusal(send(connection, await power, admin))).to.include(
        "NotAdmin",
      );
    }

    for (const paused of [true, false]) {
      await send(
        connection,
        await update(heir.publicKey, settings({ paused })),
        heir,
      );
      expect((await decodedSponsor(connection)).paused).to.equal(paused);
    }
  });

  it("is handed back the same way", async () => {
    await send(
      connection,
      await nominate(heir.publicKey, admin.publicKey),
      heir,
    );
    await send(connection, await accept(admin.publicKey), admin);
    await adminIs(admin);
  });
}

type ProfileAccounts = ReturnType<typeof profileAccounts>;

/**
 * Puts `data` where an instruction built around an empty record left room
 * for it. The program's own client cannot encode more than a thousand bytes.
 */
function carrying(
  instruction: TransactionInstruction,
  data: Buffer,
): TransactionInstruction {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  instruction.data = Buffer.concat([
    instruction.data.subarray(0, -4),
    length,
    data,
  ]);
  return instruction;
}

const create = async (
  owner: PublicKey,
  data: Buffer,
  over: Partial<ProfileAccounts> & { gate?: PublicKey } = {},
) =>
  carrying(
    await program.methods
      .createProfile(Buffer.alloc(0))
      .accountsPartial({
        gate: gate.publicKey,
        ...profileAccounts(owner),
        ...over,
      })
      .instruction(),
    data,
  );

const write = async (
  owner: PublicKey,
  expectedRevision: number,
  data: Buffer,
  over: Partial<ProfileAccounts> = {},
) =>
  carrying(
    await program.methods
      .writeProfile(new BN(expectedRevision), Buffer.alloc(0))
      .accountsPartial({
        gate: gate.publicKey,
        ...profileAccounts(owner),
        ...over,
      })
      .instruction(),
    data,
  );

const close = (owner: PublicKey, over: Partial<ProfileAccounts> = {}) =>
  program.methods
    .closeProfile()
    .accountsPartial({ ...profileAccounts(owner), ...over })
    .instruction();

const sponsorOnRollup = () => rollup.getBalance(SPONSOR);
const sponsorOnSolana = () => base.getBalance(SPONSOR);
const sponsorRent = async () =>
  base.getMinimumBalanceForRentExemption(
    (await base.getAccountInfo(SPONSOR))!.data.length,
  );

const sponsorIsBackOnSolana = () =>
  until(
    async () => (await base.getAccountInfo(SPONSOR))?.owner.equals(PROGRAM_ID),
    "the sponsor to return to Solana",
  );

const sponsorIsOnRollupWith = (lamports: number) =>
  until(
    async () => (await sponsorOnRollup()) === lamports,
    `the sponsor to reach the rollup with ${lamports} lamports`,
  );

describe("the sponsor, on Solana", () => {
  before(async () => {
    await Promise.all([
      airdropped(admin.publicKey, 5),
      airdropped(stranger.publicKey, 5),
    ]);
  });

  it("can only be set up by the program's upgrade authority", async () => {
    const error = await refusal(
      send(base, await initialize(stranger.publicKey, settings()), stranger),
    );
    expect(error).to.include("NotUpgradeAuthority");
    expect(await base.getAccountInfo(SPONSOR)).to.equal(null);
  });

  it("refuses a size limit of zero or above the hard maximum", async () => {
    for (const maxDataLen of [0, 4097]) {
      const error = await refusal(
        send(
          base,
          await initialize(admin.publicKey, settings({ maxDataLen })),
          admin,
        ),
      );
      expect(error).to.include("InvalidSizeLimit");
    }
  });

  it("is funded by a plain transfer, from anyone", async () => {
    await send(base, await initialize(admin.publicKey, settings()), admin);
    await transferred(stranger, SPONSOR, SPONSOR_FUNDING);

    expect(await sponsorOnSolana()).to.equal(
      (await sponsorRent()) + SPONSOR_FUNDING,
    );
  });

  handsOverItsAdminRole(base, (by) => [
    update(by, settings({ paused: true })),
    nominate(by, by),
    withdraw(by, 1),
    delegate(by),
  ]);

  it("is delegated to the rollup only by its admin, with its whole balance", async () => {
    const error = await refusal(
      send(base, await delegate(stranger.publicKey), stranger),
    );
    expect(error).to.include("NotAdmin");

    const balance = await sponsorOnSolana();
    await send(base, await delegate(admin.publicKey), admin);
    await sponsorIsOnRollupWith(balance);
  });
});

describe("a profile, on the rollup", () => {
  const owner = Keypair.generate();
  const first = record(300, 7);

  it("is created for an owner and a gate that hold no SOL, and costs the sponsor only its rent", async () => {
    expect(await base.getBalance(owner.publicKey)).to.equal(0);
    expect(await base.getBalance(gate.publicKey)).to.equal(0);
    const before = await sponsorOnRollup();

    await send(rollup, await create(owner.publicKey, first), gate, [owner]);

    expect(before - (await sponsorOnRollup())).to.equal(18_400);
    expect(profileCost(first.length)).to.equal(18_400);
    const stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.layout).to.equal(1);
    expect(stored?.owner.equals(owner.publicKey)).to.equal(true);
    expect(stored?.revision).to.equal(1n);
    expect(stored?.data.equals(first)).to.equal(true);
  });

  it("is readable through the private endpoint by its owner and by nobody else", async () => {
    const address = profileOf(owner.publicKey);

    const mine = await decodedProfile(await readingAs(owner), owner.publicKey);
    expect(mine?.data.equals(first)).to.equal(true);

    // The query filter answers a reader it will not serve as if the account
    // did not exist. Each such reader is first shown to reach the endpoint,
    // through an account anyone may read, so an outage cannot pass for privacy.
    const withoutToken = new Connection(PRIVATE_URL, "confirmed");
    for (const reader of [await readingAs(stranger), withoutToken]) {
      expect(await reader.getAccountInfo(SPONSOR)).to.not.equal(null);
      expect(await reader.getAccountInfo(address)).to.equal(null);
    }
  });

  it("is not created without the gate's signature", async () => {
    const other = Keypair.generate();
    const error = await refusal(
      send(
        rollup,
        await create(other.publicKey, first, { gate: stranger.publicKey }),
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

  it("is neither written nor closed before it exists", async () => {
    const other = Keypair.generate();
    expect(
      await refusal(
        send(rollup, await write(other.publicKey, 1, first), gate, [other]),
      ),
    ).to.include("ProfileMissing");
    expect(
      await refusal(send(rollup, await close(other.publicKey), gate, [other])),
    ).to.include("ProfileMissing");
  });

  it("is neither created nor closed with a permission account that is not its own", async () => {
    const other = Keypair.generate();
    const spoofed = {
      permission: permissionPdaFromAccount(profileOf(other.publicKey)),
    };
    const before = await sponsorOnRollup();

    expect(
      await refusal(
        send(
          rollup,
          await create(other.publicKey, first, {
            permission: profileAccounts(owner.publicKey).permission,
          }),
          gate,
          [other],
        ),
      ),
    ).to.include("ConstraintSeeds");
    expect(await decodedProfile(rollup, other.publicKey)).to.equal(null);

    expect(
      await refusal(
        send(rollup, await close(owner.publicKey, spoofed), gate, [owner]),
      ),
    ).to.include("ConstraintSeeds");
    const stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.data.equals(first)).to.equal(true);
    expect(await sponsorOnRollup()).to.equal(before);
  });

  it("grows past what one Solana transaction could carry, shrinks again, and the sponsor pays or is repaid the difference", async () => {
    const larger = record(2000, 9);
    const before = await sponsorOnRollup();
    await send(rollup, await write(owner.publicKey, 1, larger), gate, [owner]);

    expect(before - (await sponsorOnRollup())).to.equal(72_800 - 18_400);
    expect(profileCost(larger.length)).to.equal(72_800);
    let stored = await decodedProfile(rollup, owner.publicKey);
    expect(stored?.revision).to.equal(2n);
    expect(stored?.data.equals(larger)).to.equal(true);

    const smaller = record(120, 3);
    await send(rollup, await write(owner.publicKey, 2, smaller), gate, [owner]);

    expect(before - (await sponsorOnRollup())).to.equal(
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
    const aimedAtVictim = {
      ...profileAccounts(owner.publicKey),
      owner: attacker.publicKey,
    };

    expect(
      await refusal(
        send(
          rollup,
          await write(attacker.publicKey, 3, record(20, 6), aimedAtVictim),
          gate,
          [attacker],
        ),
      ),
    ).to.include("ConstraintSeeds");
    expect(
      await refusal(
        send(rollup, await close(attacker.publicKey, aimedAtVictim), gate, [
          attacker,
        ]),
      ),
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
    const before = await sponsorOnRollup();

    await send(rollup, await close(owner.publicKey), owner);

    expect((await sponsorOnRollup()) - before).to.equal(profileCost(120));
    const { profile, permission } = profileAccounts(owner.publicKey);
    expect(await rollup.getAccountInfo(profile)).to.equal(null);
    expect(await rollup.getAccountInfo(permission)).to.equal(null);
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

describe("the sponsor, while it is on the rollup", () => {
  handsOverItsAdminRole(rollup, (by) => [
    update(by, settings({ paused: true })),
    nominate(by, by),
    undelegate(by),
  ]);
});

describe("the sponsor, topped up on Solana while a profile stays open", () => {
  const owner = Keypair.generate();
  const newcomer = Keypair.generate();
  const kept = record(300, 4);
  let funded: number;

  before(async () => {
    funded = await sponsorOnRollup();
    await send(rollup, await create(owner.publicKey, kept), gate, [owner]);
  });

  it("cannot be paid out while it is on the rollup, whoever pays the fee", async () => {
    for (const [feePayer, reason] of [
      [admin, "InvalidAccountForFee"],
      [gate, "InvalidWritableAccount"],
    ] as const) {
      const error = await refusal(
        send(rollup, await withdraw(admin.publicKey, 1000), feePayer, [admin]),
      );
      expect(error).to.include(reason);
    }
    expect(await sponsorOnRollup()).to.equal(funded - profileCost(kept.length));
  });

  it("returns to Solana with everything but the rent of the open profile, and with what its admin decided on the rollup", async () => {
    await send(
      rollup,
      await nominate(admin.publicKey, newcomer.publicKey),
      admin,
    );
    await send(rollup, await undelegate(admin.publicKey), admin);
    await sponsorIsBackOnSolana();

    expect(await sponsorOnSolana()).to.equal(funded - profileCost(kept.length));
    const { pendingAdmin } = await decodedSponsor(base);
    expect(pendingAdmin?.equals(newcomer.publicKey)).to.equal(true);
  });

  it("leaves the open profile readable while it is away, and nothing can be created, written or closed", async () => {
    for (const [instruction, signer] of [
      [await create(newcomer.publicKey, kept), newcomer],
      [await write(owner.publicKey, 1, record(10, 1)), owner],
      [await close(owner.publicKey), owner],
    ] as const) {
      const error = await refusal(send(rollup, instruction, gate, [signer]));
      expect(error).to.include("InvalidWritableAccount");
    }
    expect(await decodedProfile(rollup, newcomer.publicKey)).to.equal(null);

    const mine = await decodedProfile(await readingAs(owner), owner.publicKey);
    expect(mine?.revision).to.equal(1n);
    expect(mine?.data.equals(kept)).to.equal(true);
  });

  it("takes a plain transfer on Solana and carries it back to the rollup", async () => {
    await transferred(admin, SPONSOR, SPONSOR_TOP_UP);
    const balance = await sponsorOnSolana();
    expect(balance).to.equal(
      funded - profileCost(kept.length) + SPONSOR_TOP_UP,
    );

    await send(base, await delegate(admin.publicKey), admin);
    await sponsorIsOnRollupWith(balance);
  });

  it("still lets the owner read and write the profile that was open", async () => {
    const mine = await decodedProfile(await readingAs(owner), owner.publicKey);
    expect(mine?.revision).to.equal(1n);
    expect(mine?.data.equals(kept)).to.equal(true);

    const rewritten = record(310, 5);
    const before = await sponsorOnRollup();
    await send(rollup, await write(owner.publicKey, 1, rewritten), gate, [
      owner,
    ]);

    expect(before - (await sponsorOnRollup())).to.equal(
      (rewritten.length - kept.length) * 32,
    );
    const stored = await decodedProfile(
      await readingAs(owner),
      owner.publicKey,
    );
    expect(stored?.revision).to.equal(2n);
    expect(stored?.data.equals(rewritten)).to.equal(true);
  });

  it("pays for a new profile, and is repaid when both are closed", async () => {
    const data = record(200, 8);
    const before = await sponsorOnRollup();
    await send(rollup, await create(newcomer.publicKey, data), gate, [
      newcomer,
    ]);

    expect(before - (await sponsorOnRollup())).to.equal(
      profileCost(data.length),
    );
    const theirs = await decodedProfile(
      await readingAs(newcomer),
      newcomer.publicKey,
    );
    expect(theirs?.data.equals(data)).to.equal(true);

    await send(rollup, await close(newcomer.publicKey), newcomer);
    await send(rollup, await close(owner.publicKey), owner);
    expect(await sponsorOnRollup()).to.equal(funded + SPONSOR_TOP_UP);
  });
});

describe("the sponsor, back on Solana for good", () => {
  it("is undelegated only by its admin, with every lamport it was given", async () => {
    expect(
      await refusal(
        send(rollup, await undelegate(stranger.publicKey), stranger),
      ),
    ).to.include("NotAdmin");

    await send(rollup, await undelegate(admin.publicKey), admin);
    await sponsorIsBackOnSolana();

    expect(await sponsorOnSolana()).to.equal(
      (await sponsorRent()) + SPONSOR_FUNDING + SPONSOR_TOP_UP,
    );
  });

  it("pays out to its admin only, and never below its own rent", async () => {
    const held = SPONSOR_FUNDING + SPONSOR_TOP_UP;
    expect(
      await refusal(
        send(base, await withdraw(stranger.publicKey, 1), stranger),
      ),
    ).to.include("NotAdmin");
    expect(
      await refusal(
        send(base, await withdraw(admin.publicKey, held + 1), admin),
      ),
    ).to.include("BelowRent");

    const adminBefore = await base.getBalance(admin.publicKey);
    await send(base, await withdraw(admin.publicKey, held), admin);

    expect(await sponsorOnSolana()).to.equal(await sponsorRent());
    expect((await base.getBalance(admin.publicKey)) - adminBefore).to.equal(
      held - 5000,
    );
  });
});
