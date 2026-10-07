import { readFileSync } from "fs";
import { join } from "path";
import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { send } from "../ops/network";

/** Sending, waiting and expecting a refusal are the same on every network. */
export { refusal, send, until } from "../ops/network";

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

/** The sponsor as it is stored wherever `connection` looks. */
export async function decodedSponsor(connection: Connection) {
  const account = await connection.getAccountInfo(SPONSOR);
  return program.coder.accounts.decode<{
    admin: PublicKey;
    pendingAdmin: PublicKey | null;
    paused: boolean;
  }>("sponsor", account!.data);
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
