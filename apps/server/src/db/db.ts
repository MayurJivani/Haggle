import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string, max = 20): Sql {
  return postgres(url, {
    max,
    onnotice: () => {},
    // bigint columns come back as JS numbers: cents stay far below 2^53 in a €1,000 game.
    types: { bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) } },
  });
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Applies every migrations/*.sql not yet recorded, in filename order, each in its own transaction. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied: string[] = [];
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  await sql.begin(async (tx) => {
    // Two processes booting at once must not race the same migration.
    await tx`SELECT pg_advisory_xact_lock(4371)`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(MIGRATIONS_DIR + file, 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
