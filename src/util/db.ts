/** Piso usado quando um nível é -Infinity ou abaixo do que o VU da mesa mostra. */
export const FLOOR_DB = -80;

export function dbToPow(db: number): number {
  return Math.pow(10, db / 10);
}

export function powToDb(pow: number): number {
  if (pow <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 10 * Math.log10(pow));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Soma de potências (ex.: vários canais somando num auxiliar). */
export function sumDb(levels: number[]): number {
  return powToDb(levels.reduce((acc, db) => acc + dbToPow(db), 0));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
