import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from './db/db.js';

// Nickname-only accounts: the cookie token IS the credential, so it is random (32 bytes) and only its
// SHA-256 digest is stored. A leaked users table cannot be replayed as live sessions.

export const COOKIE = 'lb_token';
export const COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export const nicknameSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters')
  .max(20, 'Use at most 20 characters')
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Letters, numbers, spaces, dots, dashes and underscores only');

export interface User {
  id: string;
  nickname: string;
}

const digest = (token: string) => createHash('sha256').update(token).digest();

export async function userForToken(sql: Sql, token: string | undefined): Promise<User | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await sql<User[]>`SELECT id, nickname FROM users WHERE token_hash = ${digest(token)}`;
  return row ?? null;
}

/** Returns the new user and its raw token, or null when the nickname is taken. */
export async function createUser(sql: Sql, nickname: string): Promise<{ user: User; token: string } | null> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await sql<User[]>`
    INSERT INTO users (nickname, token_hash) VALUES (${nickname}, ${digest(token)})
    ON CONFLICT ((lower(nickname))) DO NOTHING RETURNING id, nickname`;
  return row ? { user: row, token } : null;
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
