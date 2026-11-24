import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import type { Sql } from './db/db.js';

// Nickname-only accounts: the cookie token IS the credential, so it is random (32 bytes) and only its
// SHA-256 digest is stored. A leaked users table cannot be replayed as live sessions.

export const COOKIE = 'hg_token';
export const COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export const nicknameSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters')
  .max(20, 'Use at most 20 characters')
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Letters, numbers, spaces, dots, dashes and underscores only');

export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters');

export interface User {
  id: string;
  nickname: string;
  /** Has a password, so the nickname is claimed and can log in elsewhere. */
  registered: boolean;
}

const digest = (token: string) => createHash('sha256').update(token).digest();
const newToken = () => randomBytes(32).toString('base64url');

export async function userForToken(sql: Sql, token: string | undefined): Promise<User | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const d = digest(token);
  const [row] = await sql<User[]>`
    SELECT id, nickname, password_hash IS NOT NULL AS registered FROM users WHERE token_hash = ${d}
    UNION ALL
    SELECT u.id, u.nickname, u.password_hash IS NOT NULL FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${d}
    LIMIT 1`;
  return row ?? null;
}

/** Returns the new user and its raw token, or null when the nickname is taken. */
export async function createUser(sql: Sql, nickname: string): Promise<{ user: User; token: string } | null> {
  const token = newToken();
  const [row] = await sql<User[]>`
    INSERT INTO users (nickname, token_hash) VALUES (${nickname}, ${digest(token)})
    ON CONFLICT ((lower(nickname))) DO NOTHING RETURNING id, nickname, false AS registered`;
  return row ? { user: row, token } : null;
}

// scrypt from node:crypto: N=2^15, r=8, p=1, a 16-byte salt, stored as scrypt$salt$hash.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((ok, fail) => scrypt(password, salt, 32, SCRYPT, (e, k) => (e ? fail(e) : ok(k))));
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const key = await new Promise<Buffer>((ok, fail) => scrypt(password, Buffer.from(salt, 'base64url'), want.length, SCRYPT, (e, k) => (e ? fail(e) : ok(k))));
  return timingSafeEqual(key, want);
}

/** A hash to compare against when the nickname has no password, so a miss takes as long as a wrong password. */
const DUMMY = hashPassword('not-a-real-password');

/** Logs in on a new device: a fresh session token, or null on a wrong name or password. */
export async function login(sql: Sql, nickname: string, password: string): Promise<{ user: User; token: string } | null> {
  const [row] = await sql<{ id: string; nickname: string; password_hash: string | null }[]>`
    SELECT id, nickname, password_hash FROM users WHERE lower(nickname) = lower(${nickname})`;
  const ok = await verifyPassword(password, row?.password_hash ?? (await DUMMY));
  if (!row?.password_hash || !ok) return null;
  const token = newToken();
  await sql`INSERT INTO user_sessions (token_hash, user_id) VALUES (${digest(token)}, ${row.id})`;
  return { user: { id: row.id, nickname: row.nickname, registered: true }, token };
}

/** Sets or changes a password. Changing needs the current one; every other device is signed out. */
export async function setPassword(sql: Sql, userId: string, password: string, current: string | undefined): Promise<'ok' | 'wrong_current'> {
  const [row] = await sql<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${userId}`;
  if (row?.password_hash && !(current && (await verifyPassword(current, row.password_hash)))) return 'wrong_current';
  await sql`UPDATE users SET password_hash = ${await hashPassword(password)} WHERE id = ${userId}`;
  return 'ok';
}

/** Ends this device's session: an extra device's token is deleted, the join token is replaced. */
export async function logout(sql: Sql, token: string | undefined): Promise<void> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  const d = digest(token);
  await sql`DELETE FROM user_sessions WHERE token_hash = ${d}`;
  // Only a registered player can get back in, so only theirs is worth revoking; a nickname-only token stays.
  await sql`UPDATE users SET token_hash = ${digest(newToken())} WHERE token_hash = ${d} AND password_hash IS NOT NULL`;
}

/** Parses one cookie out of a raw Cookie header (the WebSocket upgrade has no cookie-parser). */
export function cookieFrom(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Same-origin check for state-changing requests and the WebSocket upgrade. Cookies are SameSite=Lax,
 * which blocks cross-site POSTs from carrying them, but a cross-site WebSocket would still send them,
 * so the Origin header is checked explicitly against the Host (or the configured allow list).
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Who is asking, for rate limits. Behind cloudflared and Caddy every request arrives from loopback and
 * X-Forwarded-For ends in loopback too, so req.ip would put every visitor in one bucket and a full room
 * would lock itself out. Cloudflare's CF-Connecting-IP names the visitor; it is read only behind the
 * proxy (TRUST_PROXY), where a client cannot set it. IPv6 addresses are grouped by /56 so one host
 * cannot rotate through its block.
 */
export function clientKey(req: { ip?: string; get(name: string): string | undefined }, trustProxy: boolean): string {
  return ipKeyGenerator((trustProxy && req.get('cf-connecting-ip')?.trim()) || req.ip || '');
}
