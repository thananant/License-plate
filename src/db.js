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

  db.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      day     TEXT PRIMARY KEY,
      views   INTEGER NOT NULL DEFAULT 0,
      uniques INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
  `);

  // Lightweight migrations for databases created before these columns existed.
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  for (const [name, type] of [['claim_note', 'TEXT'], ['claim_photo', 'TEXT'], ['claimed_at', 'INTEGER'], ['photo_hash', 'TEXT'], ['update_kind', 'TEXT']]) {
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
    // Latest public update on a report: kind = 'returned' (owner collected it)
    // or 'moved' (plate is now somewhere else / still there). 'moved' keeps the
    // report active so a false "returned" can be corrected by anyone.
    claim: db.prepare(`UPDATE reports SET status = @status, update_kind = @kind, claim_note = @claim_note, claim_photo = @claim_photo,
      claimed_at = @now, updated_at = @now WHERE id = @id`),
    expired: db.prepare(`SELECT id, photo, claim_photo FROM reports WHERE status = 'returned' AND updated_at < ?`),
    stale: db.prepare(`SELECT id, photo, claim_photo FROM reports WHERE status = 'found' AND created_at < ?`),
    activeByPlate: db.prepare(`SELECT id, plate_display, province, lat, lng, created_at FROM reports WHERE plate_norm = ? AND province = ? AND status = 'found'`),
    recentHashes: db.prepare(`SELECT id, photo_hash, plate_display, province FROM reports WHERE photo_hash IS NOT NULL AND created_at > ?`),
    photoRefs: db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE photo = ? OR claim_photo = ?`),
    allFiles: db.prepare(`SELECT photo, claim_photo FROM reports`),
    feedbackInsert: db.prepare(`INSERT INTO feedback (id, kind, message, created_at) VALUES (?, ?, ?, ?)`),
    feedbackList: db.prepare(`SELECT id, kind, message, created_at FROM feedback ORDER BY created_at DESC LIMIT ?`),
    feedbackDelete: db.prepare(`DELETE FROM feedback WHERE id = ?`),
    feedbackCount: db.prepare(`SELECT COUNT(*) AS n FROM feedback`),
    visitsUpsert: db.prepare(`INSERT INTO visits (day, views, uniques) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET views = excluded.views, uniques = excluded.uniques`),
    visitsRange: db.prepare(`SELECT day, views, uniques FROM visits WHERE day >= ? ORDER BY day`),
    visitsTotal: db.prepare(`SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(uniques), 0) AS uniques, COUNT(*) AS days FROM visits`),
    visitsDay: db.prepare(`SELECT views, uniques FROM visits WHERE day = ?`),
    deleteAll: db.prepare(`DELETE FROM reports`),
    delete: db.prepare(`DELETE FROM reports WHERE id = ?`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'found'`),
  };

  const PUBLIC_COLS = `id, plate_display, province, vehicle_type, lat, lng, accuracy_m,
    place_note, note, photo, status, update_kind, claim_note, claim_photo, claimed_at, created_at, updated_at`;

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
      ORDER BY (status = 'returned') ASC, created_at DESC LIMIT @limit`;
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
    claim: (id, { kind, note, photo }) => stmts.claim.run({ id, kind, status: kind === 'returned' ? 'returned' : 'found', claim_note: note, claim_photo: photo, now: Date.now() }),
    /** Returned reports older than `olderThanMs` are deleted; returns rows so the caller can unlink photos. */
    purgeReturned: (olderThanMs) => {
      const rows = stmts.expired.all(Date.now() - olderThanMs);
      const del = db.transaction((ids) => ids.forEach((id) => stmts.delete.run(id)));
      del(rows.map((r) => r.id));
      return rows;
    },
    /** Unclaimed reports older than `olderThanMs` are deleted (nobody came for months). */
    purgeStale: (olderThanMs) => {
      const rows = stmts.stale.all(Date.now() - olderThanMs);
      const del = db.transaction((ids) => ids.forEach((id) => stmts.delete.run(id)));
      del(rows.map((r) => r.id));
      return rows;
    },
    activeByPlate: (plateNorm, province) => stmts.activeByPlate.all(plateNorm, province),
    feedbackAdd: (row) => stmts.feedbackInsert.run(row.id, row.kind, row.message, row.created_at),
    feedbackList: (limit = 200) => stmts.feedbackList.all(limit),
    feedbackDelete: (id) => stmts.feedbackDelete.run(id),
    feedbackCount: () => stmts.feedbackCount.get().n,
    visitsSave: (day, views, uniques) => stmts.visitsUpsert.run(day, views, uniques),
    visitsDay: (day) => stmts.visitsDay.get(day) || { views: 0, uniques: 0 },
    visitsRange: (sinceDay) => stmts.visitsRange.all(sinceDay),
    visitsTotal: () => stmts.visitsTotal.get(),
    delete: (id) => stmts.delete.run(id),
    countFound: () => stmts.count.get().n,
    stats: () => {
      const now = Date.now();
      const totals = db.prepare(`SELECT
          COUNT(*) AS total,
          SUM(status = 'found') AS found,
          SUM(status = 'returned') AS returned,
          SUM(created_at > ?) AS last24h,
          SUM(created_at > ?) AS last7d,
          SUM(vehicle_type = 'car') AS car,
          SUM(vehicle_type = 'motorcycle') AS motorcycle,
          SUM(vehicle_type = 'other') AS other
        FROM reports`).get(now - 86_400_000, now - 7 * 86_400_000);
      const byProvince = db.prepare(`SELECT province, COUNT(*) AS total, SUM(status = 'found') AS found, SUM(status = 'returned') AS returned
        FROM reports GROUP BY province ORDER BY total DESC, province LIMIT 12`).all();
      const daily = db.prepare(`SELECT date(created_at / 1000, 'unixepoch', '+7 hours') AS day, COUNT(*) AS count
        FROM reports WHERE created_at > ? GROUP BY day ORDER BY day`).all(now - 14 * 86_400_000);
      const returnedDaily = db.prepare(`SELECT date(claimed_at / 1000, 'unixepoch', '+7 hours') AS day, COUNT(*) AS count
        FROM reports WHERE status = 'returned' AND claimed_at > ? GROUP BY day ORDER BY day`).all(now - 14 * 86_400_000);
      return { ...totals, byProvince, daily, returnedDaily };
    },
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
