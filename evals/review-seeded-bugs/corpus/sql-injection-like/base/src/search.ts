export type Db = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
};

export async function searchArticles(db: Db, term: string) {
  return db.query<{ id: string; title: string }>(
    "select id, title from articles where title like ?",
    [`%${term}%`],
  );
}
