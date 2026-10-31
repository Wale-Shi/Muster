import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Encrypts connection credentials with a key kept in the data directory. */
export class Vault {
  constructor(readonly directory: string) {}
  private key(): Buffer {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); const path = join(this.directory, "secret.key");
    try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const key = readFileSync(path); if (key.length !== 32) throw new Error("Invalid secret key"); return key;
  }
  encrypt(value: string, binding: string): { ciphertext: string; iv: string; tag: string } {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(binding));
    return { ciphertext: Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }
  decrypt(value: { ciphertext: string; iv: string; tag: string }, binding: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}
