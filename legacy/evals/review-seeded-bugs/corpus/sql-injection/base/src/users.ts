export type Db = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
};

export async function findUserByEmail(db: Db, email: string) {
  const rows = await db.query<{ id: string; email: string }>(
    "select id, email from users where email = ?",
    [email],
  );
  return rows[0] ?? null;
}
