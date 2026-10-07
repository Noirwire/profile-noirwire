/**
 * Operates one deployment of the profile program on a public network:
 * set it up, show its state, prove it works, and check it is still there.
 *
 * The Makefile is the way in (`make devnet-setup` and friends). It names the
 * network through variables, so nothing here knows a network by heart.
 * No secret key is ever printed: keys are read from, and written to, files.
 *
 * The three helpers at the top are also what the local tests send with.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegationRecordPdaFromDelegatedAccount,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
  everyMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const shortVec = (length: number) => {
  const bytes: number[] = [];
  for (let rest = length; ; rest >>= 7) {
    if (rest < 0x80) {
      bytes.push(rest);
      return Buffer.from(bytes);
    }
    bytes.push((rest & 0x7f) | 0x80);
  }
};

/**
 * A signed transaction as it travels. Written out by hand because the
 * library refuses to build anything over Solana's 1,232 bytes, and the
 * rollup takes far larger transactions than that.
 */
function wire(transaction: Transaction, signers: Keypair[]): Buffer {
  const compiled = transaction.compileMessage();
  const message = Buffer.concat([
    Buffer.from([
      compiled.header.numRequiredSignatures,
      compiled.header.numReadonlySignedAccounts,
      compiled.header.numReadonlyUnsignedAccounts,
    ]),
    shortVec(compiled.accountKeys.length),
    ...compiled.accountKeys.map((key) => key.toBuffer()),
    anchor.utils.bytes.bs58.decode(compiled.recentBlockhash),
    shortVec(compiled.instructions.length),
    ...compiled.instructions.flatMap((instruction) => {
      const data = anchor.utils.bytes.bs58.decode(instruction.data);
      return [
        Buffer.from([instruction.programIdIndex]),
        shortVec(instruction.accounts.length),
        Buffer.from(instruction.accounts),
        shortVec(data.length),
        data,
      ];
    }),
  ]);
  const signatures = compiled.accountKeys
    .slice(0, compiled.header.numRequiredSignatures)
    .map((key) => {
      const signer = signers.find((held) => held.publicKey.equals(key));
      if (!signer) throw new Error(`${key.toBase58()} did not sign`);
      return nacl.sign.detached(message, signer.secretKey);
    });
  return Buffer.concat([shortVec(signatures.length), ...signatures, message]);
}

/** Sends one instruction and resolves to its signature, or throws with the program's logs. */
export async function send(
  connection: Connection,
  instruction: TransactionInstruction,
  feePayer: Keypair,
  signers: Keypair[] = [],
  everyMs = 400,
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...latest,
  }).add(instruction);
  const signature = await connection.sendRawTransaction(
    wire(transaction, [feePayer, ...signers]),
    { skipPreflight: true },
  );
  // Asked for, not subscribed to: the rollup lands a transaction within a few
  // milliseconds, often before a subscription for it could be in place.
  const status = await until(
    async () => {
      const { value } = await connection.getSignatureStatus(signature);
      return value && value.confirmationStatus !== "processed" && value;
    },
    `transaction ${signature} to be confirmed`,
    60_000,
    everyMs,
  );
  if (status.err) {
    const landed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    throw new Error(
      `${JSON.stringify(status.err)}\n${(landed?.meta?.logMessages ?? []).join("\n")}`,
    );
  }
  return signature;
}

/** Resolves to the error text of a call that must fail, and throws if it succeeds. */
export async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    const logs = (error as { logs?: string[] }).logs ?? [];
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    return [message, ...logs].join("\n");
  }
  throw new Error("The call succeeded, and it must not");
}

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const SMALL = 300;
const LARGE = 2000;

/** What the rollup charges to hold a profile of `dataLen` bytes and its permission. */
const profileRent = (dataLen: number) =>
  (54 + dataLen + 60) * 32 + (35 + 2 * 33 + 60) * 32;

const sol = (lamports: number) =>
  `${(lamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`;

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Use the Makefile targets.`);
  return value;
}

function heldKey(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

/** Keeps a new key in a file only its owner can read, and never overwrites one. */
function keptKey(path: string, key = Keypair.generate()): Keypair {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), {
    mode: 0o600,
    flag: "wx",
  });
  return key;
}

/** Everything one run needs to know about the network it was pointed at. */
async function deployment() {
  const network = setting("NETWORK");
  const keys = setting("KEYS_DIR");
  const rollupUrl = setting("ROLLUP_URL");
  const solana = new Connection(setting("SOLANA_URL"), "confirmed");

  const genesis = await solana.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("Mainnet is not wired up. Nothing was sent.");
  }
  if (genesis !== setting("GENESIS")) {
    throw new Error(`${setting("SOLANA_URL")} is not ${network}: ${genesis}`);
  }

  const idl = JSON.parse(
    readFileSync(
      join(process.cwd(), "target/idl/noirwire_profile.json"),
      "utf8",
    ),
  );
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(solana, new anchor.Wallet(Keypair.generate()), {
      commitment: "confirmed",
    }),
  );
  const programId: PublicKey = program.programId;
  const sponsor = PublicKey.findProgramAddressSync(
    [Buffer.from("sponsor")],
    programId,
  )[0];

  /** A connection to the private rollup that reads and sends as `reader`. */
  const rollupAs = async (reader: Keypair) => {
    const { token } = await getAuthToken(
      rollupUrl,
      reader.publicKey,
      async (message) => nacl.sign.detached(message, reader.secretKey),
    );
    return new Connection(`${rollupUrl}?token=${token}`, "confirmed");
  };

  const discriminator = (name: string) =>
    Buffer.from(
      idl.instructions.find(
        (instruction: { name: string }) => instruction.name === name,
      ).discriminator,
    );

  const decodedSponsor = (data: Buffer) =>
    program.coder.accounts.decode<{
      admin: PublicKey;
      pendingAdmin: PublicKey | null;
      gate: PublicKey;
      maxDataLen: number;
      paused: boolean;
    }>("sponsor", data);

  return {
    network,
    solana,
    rollupUrl,
    rollupAs,
    program,
    programId,
    sponsor,
    discriminator,
    decodedSponsor,
    validator: new PublicKey(setting("VALIDATOR")),
    float: Number(setting("SPONSOR_FLOAT_LAMPORTS")),
    maxDataLen: Number(setting("MAX_DATA_LEN")),
    adminPath: join(keys, `${network}-admin.json`),
    gatePath: join(keys, `${network}-gate.json`),
    canaryPath: join(keys, `${network}-canary.json`),
  };
}

type Deployment = Awaited<ReturnType<typeof deployment>>;

/** The three profile instructions, built byte by byte as any client builds them. */
function profileInstructions(on: Deployment, gate: PublicKey) {
  const profileOf = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), owner.toBuffer()],
      on.programId,
    )[0];
  const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  const u32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const u64 = (value: bigint) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value);
    return bytes;
  };
  const instruction = (keys: ReturnType<typeof meta>[], ...data: Buffer[]) =>
    new TransactionInstruction({
      programId: on.programId,
      keys,
      data: Buffer.concat(data),
    });
  const shared = (owner: PublicKey) => [
    meta(owner, true, false),
    meta(on.sponsor, false, true),
    meta(profileOf(owner), false, true),
  ];
  const permission = (owner: PublicKey) => [
    meta(permissionPdaFromAccount(profileOf(owner)), false, true),
    meta(PERMISSION_PROGRAM_ID, false, false),
  ];
  const rollupOwn = [
    meta(EPHEMERAL_VAULT_ID, false, true),
    meta(MAGIC_PROGRAM_ID, false, false),
  ];

  return {
    profileOf,
    create: (owner: PublicKey, data: Buffer) =>
      instruction(
        [
          meta(gate, true, false),
          ...shared(owner),
          ...permission(owner),
          ...rollupOwn,
        ],
        on.discriminator("create_profile"),
        u32(data.length),
        data,
      ),
    write: (owner: PublicKey, expectedRevision: bigint, data: Buffer) =>
      instruction(
        [meta(gate, true, false), ...shared(owner), ...rollupOwn],
        on.discriminator("write_profile"),
        u64(expectedRevision),
        u32(data.length),
        data,
      ),
    close: (owner: PublicKey) =>
      instruction(
        [...shared(owner), ...permission(owner), ...rollupOwn],
        on.discriminator("close_profile"),
      ),
  };
}

async function storedProfile(connection: Connection, address: PublicKey) {
  const account = await connection.getAccountInfo(address);
  if (!account) return null;
  const length = account.data.readUInt32LE(50);
  return {
    revision: account.data.readBigUInt64LE(42),
    data: Buffer.from(account.data.subarray(54, 54 + length)),
  };
}

/** Where the sponsor is, as Solana sees it. */
async function sponsorOnSolana(on: Deployment) {
  const account = await on.solana.getAccountInfo(on.sponsor);
  if (!account) return null;
  const delegated = account.owner.equals(DELEGATION_PROGRAM_ID);
  const record = delegated
    ? await on.solana.getAccountInfo(
        delegationRecordPdaFromDelegatedAccount(on.sponsor),
      )
    : null;
  return {
    lamports: account.lamports,
    rent: await on.solana.getMinimumBalanceForRentExemption(
      account.data.length,
    ),
    delegated,
    validator: record ? new PublicKey(record.data.subarray(8, 40)) : null,
    stored: on.decodedSponsor(account.data),
  };
}

/** Stops unless the rollup behind the endpoint is the validator we were told. */
async function rollupIsRunBy(on: Deployment) {
  const answer = await fetch(on.rollupUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
  });
  const { result } = (await answer.json()) as {
    result?: { identity?: string };
  };
  const identity = result?.identity;
  if (identity !== on.validator.toBase58()) {
    throw new Error(
      `${on.rollupUrl} is run by ${identity}, not ${on.validator.toBase58()}. Nothing was delegated.`,
    );
  }
  console.log(`rollup validator    ${identity} (confirmed with getIdentity)`);
}

async function setup(on: Deployment) {
  const admin = heldKey(on.adminPath);
  const gate = existsSync(on.gatePath)
    ? heldKey(on.gatePath)
    : keptKey(on.gatePath);
  console.log(`program             ${on.programId.toBase58()}`);
  console.log(`sponsor             ${on.sponsor.toBase58()}`);
  console.log(`admin               ${admin.publicKey.toBase58()}`);
  console.log(`gate                ${gate.publicKey.toBase58()}`);

  if (!(await sponsorOnSolana(on))) {
    const programData = PublicKey.findProgramAddressSync(
      [on.programId.toBuffer()],
      UPGRADEABLE_LOADER,
    )[0];
    const signature = await send(
      on.solana,
      await on.program.methods
        .initializeSponsor({
          gate: gate.publicKey,
          maxDataLen: on.maxDataLen,
          paused: false,
        })
        .accountsPartial({
          admin: admin.publicKey,
          sponsor: on.sponsor,
          program: on.programId,
          programData,
        })
        .instruction(),
      admin,
    );
    console.log(`initialized         ${signature}`);
  }

  let sponsor = (await sponsorOnSolana(on))!;
  if (!sponsor.stored.gate.equals(gate.publicKey)) {
    throw new Error(
      `The sponsor's gate is ${sponsor.stored.gate.toBase58()}, not the key in ${on.gatePath}. Nothing was changed.`,
    );
  }
  if (sponsor.delegated) {
    console.log(
      `already delegated   to ${sponsor.validator?.toBase58()}; funding and delegation left as they are`,
    );
    return;
  }

  const missing = sponsor.rent + on.float - sponsor.lamports;
  if (missing > 0) {
    const signature = await send(
      on.solana,
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: on.sponsor,
        lamports: missing,
      }),
      admin,
    );
    console.log(`funded              ${sol(missing)} ${signature}`);
  }

  await rollupIsRunBy(on);
  const signature = await send(
    on.solana,
    await on.program.methods
      .delegateSponsor(on.validator)
      .accountsPartial({ admin: admin.publicKey, sponsor: on.sponsor })
      .instruction(),
    admin,
  );
  console.log(`delegated           ${signature}`);
  sponsor = (await sponsorOnSolana(on))!;
  console.log(`delegated to        ${sponsor.validator?.toBase58()}`);
}

async function status(on: Deployment) {
  console.log(`network             ${on.network}`);
  console.log(`program             ${on.programId.toBase58()}`);
  console.log(`sponsor             ${on.sponsor.toBase58()}`);
  if (existsSync(on.gatePath)) {
    console.log(
      `gate key on file    ${heldKey(on.gatePath).publicKey.toBase58()}`,
    );
  }

  const sponsor = await sponsorOnSolana(on);
  if (!sponsor) return console.log("sponsor             not set up");
  console.log(
    `on Solana           ${sol(sponsor.lamports)}, of which ${sol(sponsor.rent)} is its own rent`,
  );
  console.log(
    sponsor.delegated
      ? `delegated           yes, to ${sponsor.validator?.toBase58()}`
      : "delegated           no",
  );

  const reader = await on.rollupAs(Keypair.generate());
  const there = await reader.getAccountInfo(on.sponsor);
  if (!there) return console.log("on the rollup       not there");
  const { admin, pendingAdmin, gate, maxDataLen, paused } = on.decodedSponsor(
    there.data,
  );
  console.log(`on the rollup       ${sol(there.lamports)}`);
  console.log(`admin               ${admin.toBase58()}`);
  console.log(`pending admin       ${pendingAdmin?.toBase58() ?? "none"}`);
  console.log(`gate                ${gate.toBase58()}`);
  console.log(`max_data_len        ${maxDataLen}`);
  console.log(`paused              ${paused}`);
}

/**
 * The live test. Every owner is a throwaway key made here, and every profile
 * it opens is closed again, but one: the canary.
 */
async function smoke(on: Deployment) {
  const gate = heldKey(on.gatePath);
  const { profileOf, create, write, close } = profileInstructions(
    on,
    gate.publicKey,
  );
  const owner = Keypair.generate();
  const stranger = Keypair.generate();
  const asOwner = await on.rollupAs(owner);
  const sponsorBalance = () => asOwner.getBalance(on.sponsor);
  const record = (length: number, fill: number) => Buffer.alloc(length, fill);

  const timings: Record<string, number[]> = { create: [], write: [], read: [] };
  const timed = async <T>(what: string, work: () => Promise<T>) => {
    const started = performance.now();
    const result = await work();
    timings[what].push(Math.round(performance.now() - started));
    return result;
  };
  const sent = (
    what: "create" | "write",
    instruction: TransactionInstruction,
    by: Keypair,
    connection = asOwner,
  ) =>
    timed(what, () => send(connection, instruction, gate, [by], 25)).then(
      () => undefined,
    );

  let failed = 0;
  const proven = async (label: string, proof: () => Promise<string>) => {
    try {
      console.log(`PASS ${label}: ${await proof()}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${label}: ${(error as Error).message}`);
    }
  };
  const expectEqual = (actual: unknown, expected: unknown, what: string) => {
    if (actual !== expected) {
      throw new Error(`${what}: expected ${expected}, got ${actual}`);
    }
  };

  console.log(`sponsor             ${on.sponsor.toBase58()}`);
  console.log(`gate                ${gate.publicKey.toBase58()}`);
  const start = await sponsorBalance();
  console.log(`sponsor on rollup   ${sol(start)} before`);

  await proven("(a) create, sponsor-paid", async () => {
    for (const key of [owner, gate]) {
      expectEqual(
        await on.solana.getBalance(key.publicKey),
        0,
        "SOL held on Solana",
      );
      expectEqual(
        await asOwner.getBalance(key.publicKey),
        0,
        "SOL held on rollup",
      );
    }
    await sent("create", create(owner.publicKey, record(SMALL, 7)), owner);
    const charged = start - (await sponsorBalance());
    expectEqual(charged, profileRent(SMALL), "sponsor charged");
    return `owner and gate hold 0 SOL; sponsor charged ${charged} lamports for ${SMALL} bytes`;
  });

  await proven("(b) owner reads, stranger does not", async () => {
    const address = profileOf(owner.publicKey);
    let mine = null;
    for (let sample = 0; sample < 3; sample += 1) {
      mine = await timed("read", () => storedProfile(asOwner, address));
    }
    expectEqual(mine?.data.equals(record(SMALL, 7)), true, "owner's read");
    const asStranger = await on.rollupAs(stranger);
    expectEqual(
      (await asStranger.getAccountInfo(on.sponsor)) !== null,
      true,
      "stranger reaches the endpoint",
    );
    expectEqual(
      await asStranger.getAccountInfo(address),
      null,
      "stranger's read",
    );
    return "owner's token returns the record at revision 1; a stranger's token returns null for it while it can read the sponsor";
  });

  await proven("(c) read with no token", async () => {
    const answer = await fetch(on.rollupUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [profileOf(owner.publicKey).toBase58(), { encoding: "base64" }],
      }),
    });
    const body = await answer.text();
    if (answer.ok && JSON.parse(body).result?.value) {
      throw new Error(`the record was served without a token: ${body}`);
    }
    return `HTTP ${answer.status} ${body.trim().slice(0, 200)}`;
  });

  await proven("(d) revisions", async () => {
    await sent("write", write(owner.publicKey, 1n, record(320, 8)), owner);
    const error = await refusal(
      send(asOwner, write(owner.publicKey, 1n, record(330, 9)), gate, [owner]),
    );
    if (!error.includes("StaleRevision")) throw new Error(error);
    const stored = await storedProfile(asOwner, profileOf(owner.publicKey));
    expectEqual(stored?.revision, 2n, "revision");
    expectEqual(stored?.data.equals(record(320, 8)), true, "kept record");
    return "write on revision 1 landed (now 2); a second write on revision 1 was refused with StaleRevision and changed nothing";
  });

  await proven(`(e) ${LARGE} bytes in one transaction`, async () => {
    await sent("write", write(owner.publicKey, 2n, record(LARGE, 5)), owner);
    const stored = await storedProfile(asOwner, profileOf(owner.publicKey));
    expectEqual(stored?.data.equals(record(LARGE, 5)), true, "stored record");
    const charged = start - (await sponsorBalance());
    expectEqual(charged, profileRent(LARGE), "sponsor charged");
    await sent("write", write(owner.publicKey, 3n, record(SMALL, 6)), owner);
    return `stored and read back; sponsor charged ${charged} lamports in all for ${LARGE} bytes`;
  });

  await proven("(f) close returns the rent", async () => {
    await send(asOwner, close(owner.publicKey), gate, [owner]);
    expectEqual(
      await storedProfile(asOwner, profileOf(owner.publicKey)),
      null,
      "profile after close",
    );
    expectEqual(await sponsorBalance(), start, "sponsor balance");
    return `profile gone; sponsor back at ${sol(start)}`;
  });

  await proven("(g) timings", async () => {
    for (const fill of [1, 2]) {
      const other = Keypair.generate();
      const asOther = await on.rollupAs(other);
      await sent(
        "create",
        create(other.publicKey, record(SMALL, fill)),
        other,
        asOther,
      );
      await send(asOther, close(other.publicKey), gate, [other]);
    }
    expectEqual(await sponsorBalance(), start, "sponsor balance");
    return Object.entries(timings)
      .map(([what, samples]) => `${what} ${samples.join(", ")} ms`)
      .join("; ");
  });

  await proven("(h) canary left open", async () => {
    const canary = existsSync(on.canaryPath)
      ? heldKey(on.canaryPath)
      : keptKey(on.canaryPath);
    const asCanary = await on.rollupAs(canary);
    const address = profileOf(canary.publicKey);
    if (!(await storedProfile(asCanary, address))) {
      await send(
        asCanary,
        create(canary.publicKey, record(SMALL, 3)),
        gate,
        [canary],
        25,
      );
    }
    const stored = await storedProfile(asCanary, address);
    if (!stored) throw new Error("the canary profile is not there");
    return `owner ${canary.publicKey.toBase58()}, profile ${address.toBase58()}, revision ${stored.revision}; key kept in ${on.canaryPath}`;
  });

  console.log(`sponsor on rollup   ${sol(await sponsorBalance())} after`);
  if (failed) throw new Error(`${failed} of the smoke checks failed`);
}

async function canary(on: Deployment) {
  const owner = heldKey(on.canaryPath);
  const gate = heldKey(on.gatePath);
  const asOwner = await on.rollupAs(owner);
  const { profileOf } = profileInstructions(on, gate.publicKey);
  const stored = await storedProfile(asOwner, profileOf(owner.publicKey));
  console.log(`canary owner        ${owner.publicKey.toBase58()}`);
  console.log(
    stored
      ? `canary profile      still there, revision ${stored.revision}, ${stored.data.length} bytes`
      : "canary profile      GONE",
  );
  console.log(
    `sponsor on rollup   ${sol(await asOwner.getBalance(on.sponsor))}`,
  );
  const sponsor = await sponsorOnSolana(on);
  console.log(
    `sponsor on Solana   ${sponsor ? sol(sponsor.lamports) : "GONE"}`,
  );
  if (!stored) throw new Error("The canary profile is gone");
}

if (require.main === module) {
  const commands = { setup, status, smoke, canary };
  const command = commands[process.argv[2] as keyof typeof commands];
  if (!command) {
    throw new Error(`Use one of: ${Object.keys(commands).join(", ")}`);
  }
  deployment()
    .then(command)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
