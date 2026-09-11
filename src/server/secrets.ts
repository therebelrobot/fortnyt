// The SimpleFIN Access URL embeds Basic-Auth credentials that can read every connected
// bank account. If FORTNYT_SECRET is set, it's stored AES-256-GCM encrypted, so a copied
// database file alone doesn't leak it. Without the env var it's stored as plain text next to
// the financial data (which the SimpleFIN checklist accepts as the minimum bar).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Repo } from './repo';

const PREFIX = 'enc:v1:';

function key(repo: Repo, secret: string): Buffer {
  let salt = repo.getMeta('secret_salt');
  if (!salt) {
    salt = randomBytes(16).toString('base64');
    repo.setMeta('secret_salt', salt);
  }
  return scryptSync(secret, Buffer.from(salt, 'base64'), 32);
}

export function sealSecret(repo: Repo, plain: string, secret: string | undefined): string {
  if (!secret) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(repo, secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

export function openSecret(repo: Repo, stored: string, secret: string | undefined): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!secret) throw new Error('The saved SimpleFIN connection is encrypted. Set FORTNYT_SECRET to the value used when it was saved.');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(repo, secret), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt the saved SimpleFIN connection. FORTNYT_SECRET does not match the value used when it was saved.');
  }
}

export function isSealed(stored: string | null): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
