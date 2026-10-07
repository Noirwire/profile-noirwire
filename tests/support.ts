import { readFileSync } from "fs";
import { join } from "path";
import * as anchor from "@coral-xyz/anchor";
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
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

const idl = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/noirwire_profile.json"), "utf8"),
);

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8899";
const ROLLUP_URL = process.env.ROLLUP_URL ?? "http://127.0.0.1:7799";
export const PRIVATE_URL = process.env.PRIVATE_URL ?? "http://127.0.0.1:6699";

export const VALIDATOR = new PublicKey(
  process.env.VALIDATOR ?? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
);

export const base = new Connection(BASE_URL, "confirmed");
export const rollup = new Connection(ROLLUP_URL, "confirmed");

export const admin = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(join(process.cwd(), ".localnet/admin.json"), "utf8"),
    ),
  ),
);

const readOnlyWallet = new anchor.Wallet(Keypair.generate());
export const program = new anchor.Program(
  idl,
  new anchor.AnchorProvider(base, readOnlyWallet, { commitment: "confirmed" }),
);

export const PROGRAM_ID: PublicKey = program.programId;
export const SPONSOR = PublicKey.findProgramAddressSync(
  [Buffer.from("sponsor")],
  PROGRAM_ID,
)[0];
export const PROGRAM_DATA = PublicKey.findProgramAddressSync(
  [PROGRAM_ID.toBuffer()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
)[0];

export function profileOf(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** The accounts every profile instruction names, for one owner. */
export function profileAccounts(owner: PublicKey) {
  const profile = profileOf(owner);
  return {
    owner,
    sponsor: SPONSOR,
    profile,
    permission: permissionPdaFromAccount(profile),
    permissionProgram: PERMISSION_PROGRAM_ID,
    vault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
  };
}

/** Sends one instruction and resolves to its signature, or throws with the program's logs. */
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

export async function send(
  connection: Connection,
  instruction: TransactionInstruction,
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...latest,
  }).add(instruction);
  const signature = await connection.sendRawTransaction(
    wire(transaction, [feePayer, ...signers]),
    {
      skipPreflight: true,
    },
  );
  // Asked for, not subscribed to: the rollup lands a transaction within a few
  // milliseconds, often before a subscription for it could be in place.
  const status = await until(async () => {
    const { value } = await connection.getSignatureStatus(signature);
    return value && value.confirmationStatus !== "processed" && value;
  }, `transaction ${signature} to be confirmed`);
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

/** Moves lamports from `from` to any address on Solana, as any wallet would. */
export function transferred(from: Keypair, to: PublicKey, lamports: number) {
  return send(
    base,
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports,
    }),
    from,
  );
}

export async function airdropped(to: PublicKey, sol: number) {
  const signature = await base.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await base.confirmTransaction(
    { signature, ...(await base.getLatestBlockhash()) },
    "confirmed",
  );
}

/** A connection to the private endpoint that reads as `reader`. */
export async function readingAs(reader: Keypair): Promise<Connection> {
  const { token } = await getAuthToken(
    PRIVATE_URL,
    reader.publicKey,
    async (message) => nacl.sign.detached(message, reader.secretKey),
  );
  return new Connection(`${PRIVATE_URL}?token=${token}`, "confirmed");
}

/** A profile as the program stores it, read without the program's own client. */
export async function decodedProfile(connection: Connection, owner: PublicKey) {
  const account = await connection.getAccountInfo(profileOf(owner));
  if (!account) return null;
  const { data } = account;
  const length = data.readUInt32LE(50);
  return {
    layout: data[8],
    owner: new PublicKey(data.subarray(10, 42)),
    revision: data.readBigUInt64LE(42),
    data: Buffer.from(data.subarray(54, 54 + length)),
    space: data.length,
  };
}

export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
