/**
 * Column-major transpose of bind rows: one pg array parameter per column, for a multi-row write
 * that `unnest`s them back into rows. A missing value binds as NULL.
 */
export function columnsOf(rows: readonly unknown[][], width: number): unknown[][] {
  const cols: unknown[][] = Array.from({ length: width }, () => []);
  for (const row of rows) for (let i = 0; i < width; i++) cols[i]!.push(row[i] ?? null);
  return cols;
}
