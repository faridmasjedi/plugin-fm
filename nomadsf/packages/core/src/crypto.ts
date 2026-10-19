import type { BackupSink } from './backup.js';
import { fromBase64, toBase64 } from './zip.js';

/**
 * Encrypted backups: AES-256-GCM with a key derived from a passphrase (PBKDF2, SHA-256), all
 * in the browser's Web Crypto. Every file gets its own random IV; a file starts with "NSE1".
 * Only the passphrase (or a key kept on this computer) can read the backup's data; the list
 * of runs (backups.json) stays readable and holds the salt and a check value, never the key.
 */

export type EncryptionInfo = {
  algorithm: 'AES-GCM-256';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** Base64. */
  salt: string;
  /** "nomadsf" encrypted with the key (base64), to tell a wrong passphrase. */
  check: string;
};

const MAGIC = new TextEncoder().encode('NSE1');
const CHECK_TEXT = 'nomadsf';
const ITERATIONS = 310_000;
const subtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw new Error('Encryption needs Web Crypto (a secure context).');
  return globalThis.crypto.subtle;
};

export async function deriveKey(
  passphrase: string,
  info: Pick<EncryptionInfo, 'salt' | 'iterations'>
): Promise<CryptoKey> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const material = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(info.salt), iterations: info.iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    // Not extractable: a key kept on this computer cannot be read back as bytes
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(MAGIC.length + iv.length + cipher.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(cipher, MAGIC.length + iv.length);
  return out;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 16 || MAGIC.some((b, i) => data[i] !== b)) throw new Error('Not a NomadSF encrypted file.');
  const iv = data.slice(4, 16);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, key, data.slice(16)));
  } catch {
    throw new Error('Wrong passphrase, or the file was changed.');
  }
}

/** A new passphrase: the info to store with the job, and the key. */
export async function newEncryption(passphrase: string): Promise<{ info: EncryptionInfo; key: CryptoKey }> {
  const salt = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, { salt, iterations: ITERATIONS });
  const check = toBase64(await encryptBytes(key, new TextEncoder().encode(CHECK_TEXT)));
  return { info: { algorithm: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt, check }, key };
}

/** The key for a passphrase, after checking it is the right one. */
export async function unlockEncryption(info: EncryptionInfo, passphrase: string): Promise<CryptoKey> {
  const key = await deriveKey(passphrase, info);
  const text = new TextDecoder().decode(await decryptBytes(key, fromBase64(info.check)).catch(() => new Uint8Array()));
  if (text !== CHECK_TEXT) throw new Error('Wrong passphrase.');
  return key;
}

/** Files that stay readable in an encrypted backup (the list of runs: no data in it). */
const PLAIN = new Set(['backups.json']);
const isPlain = (path: string): boolean => PLAIN.has(path.split('/').pop() ?? '');

/**
 * Encrypts everything written through it (as "<name>.enc") and decrypts on read, so backups,
 * restores and copies work the same on encrypted and plain backups.
 */
export function encryptedSink(sink: BackupSink, key: CryptoKey): BackupSink {
  const writeBytes = async (path: string, content: Uint8Array): Promise<void> =>
    isPlain(path) ? sink.writeBytes(path, content) : sink.writeBytes(`${path}.enc`, await encryptBytes(key, content));
  const readBytes = async (path: string): Promise<Uint8Array | undefined> => {
    if (isPlain(path)) return sink.readBytes(path);
    const data = await sink.readBytes(`${path}.enc`);
    if (data) return decryptBytes(key, data);
    // Runs written before the backup was encrypted stay readable
    return sink.readBytes(path);
  };
  return {
    writeBytes,
    readBytes,
    async write(path, content) {
      if (isPlain(path)) return sink.write(path, content);
      return writeBytes(path, new TextEncoder().encode(content));
    },
    async read(path) {
      if (isPlain(path)) return sink.read(path);
      const data = await readBytes(path);
      return data ? new TextDecoder().decode(data) : undefined;
    },
    async list(dir) {
      return (await sink.list(dir)).map((n) => n.replace(/\.enc$/, ''));
    },
  };
}
