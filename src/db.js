import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'plates.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id            TEXT PRIMARY KEY,
      plate_display TEXT NOT NULL,
      plate_norm    TEXT NOT NULL,
      province      TEXT NOT NULL,
      vehicle_type  TEXT NOT NULL,
      lat           REAL NOT NULL,
      lng           REAL NOT NULL,
      accuracy_m    REAL,
      place_note    TEXT,
      note          TEXT,
      photo         TEXT,
      status        TEXT NOT NULL DEFAULT 'found',
      token_hash    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_plate ON reports(plate_norm);
    CREATE INDEX IF NOT EXISTS idx_reports_province ON reports(province);
    CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_geo ON reports(lat, lng);
  `);

  // Lightweight migrations for databases created before these columns existed.
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  for (const [name, type] of [['claim_note', 'TEXT'], ['claim_photo', 'TEXT'], ['claimed_at', 'INTEGER'], ['photo_hash', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_photo_hash ON reports(photo_hash)');

  const stmts = {
    insert: db.prepare(`
      INSERT INTO reports (id, plate_display, plate_norm, province, vehicle_type, lat, lng,
        accuracy_m, place_note, note, photo, photo_hash, status, token_hash, created_at, updated_at)
      VALUES (@id, @plate_display, @plate_norm, @province, @vehicle_type, @lat, @lng,
        @accuracy_m, @place_note, @note, @photo, @photo_hash, 'found', @token_hash, @created_at, @updated_at)
    `),
    byId: db.prepare(`SELECT * FROM reports WHERE id = ?`),
    setStatus: db.prepare(`UPDATE reports SET status = ?, updated_at = ? WHERE id = ?`),
    claim: db.prepare(`UPDATE reports SET status = 'returned', claim_note = @claim_note, claim_photo = @claim_photo,
      claimed_at = @now, updated_at = @now WHERE id = @id`),
    expired: db.prepare(`SELECT id, photo, claim_photo FROM reports WHERE status = 'returned' AND updated_at < ?`),
    recentHashes: db.prepare(`SELECT id, photo_hash, plate_display, province FROM reports WHERE photo_hash IS NOT NULL AND created_at > ?`),
    photoRefs: db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE photo = ? OR claim_photo = ?`),
    allFiles: db.prepare(`SELECT photo, claim_photo FROM reports`),
    deleteAll: db.prepare(`DELETE FROM reports`),
    delete: db.prepare(`DELETE FROM reports WHERE id = ?`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'found'`),
  };

  const PUBLIC_COLS = `id, plate_display, province, vehicle_type, lat, lng, accuracy_m,
    place_note, note, photo, status, claim_note, claim_photo, claimed_at, created_at, updated_at`;

  function search({ plate, province, vehicleType, status, bbox, limit = 200 }) {
    const where = [];
    const params = {};
    if (plate) {
      // Substring match on the normalised plate lets "1234" find "กข1234".
      where.push(`plate_norm LIKE @plate ESCAPE '\\'`);
      params.plate = `%${plate.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    }
    if (province) {
      where.push(`province = @province`);
      params.province = province;
    }
    if (vehicleType) {
      where.push(`vehicle_type = @vehicleType`);
      params.vehicleType = vehicleType;
    }
    if (status) {
      where.push(`status = @status`);
      params.status = status;
    }
    if (bbox) {
      where.push(`lat BETWEEN @south AND @north AND lng BETWEEN @west AND @east`);
      Object.assign(params, bbox);
    }
    const sql = `SELECT ${PUBLIC_COLS} FROM reports
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT @limit`;
    params.limit = limit;
    return db.prepare(sql).all(params);
  }

  return {
    db,
    insert: (row) => stmts.insert.run(row),
    insertMany: db.transaction((rows) => rows.forEach((r) => stmts.insert.run(r))),
    recentHashes: (sinceMs) => stmts.recentHashes.all(Date.now() - sinceMs),
    /** True when another report still references this photo file. */
    photoInUse: (name) => !!name && stmts.photoRefs.get(name, name).n > 0,
    byId: (id) => stmts.byId.get(id),
    setStatus: (id, status) => stmts.setStatus.run(status, Date.now(), id),
    claim: (id, { note, photo }) => stmts.claim.run({ id, claim_note: note, claim_photo: photo, now: Date.now() }),
    /** Returned reports older than `olderThanMs` are deleted; returns rows so the caller can unlink photos. */
    purgeReturned: (olderThanMs) => {
      const rows = stmts.expired.all(Date.now() - olderThanMs);
      const del = db.transaction((ids) => ids.forEach((id) => stmts.delete.run(id)));
      del(rows.map((r) => r.id));
      return rows;
    },
    delete: (id) => stmts.delete.run(id),
    countFound: () => stmts.count.get().n,
    /** Delete every report; returns the photo file names that were referenced. */
    wipe: () => {
      const files = stmts.allFiles.all().flatMap((r) => [r.photo, r.claim_photo]).filter(Boolean);
      stmts.deleteAll.run();
      return files;
    },
    search,
    close: () => db.close(),
  };
}

export function toPublic(row) {
  if (!row) return null;
  const { token_hash, ...rest } = row;
  return rest;
}
