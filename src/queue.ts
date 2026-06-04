// Uses Node.js 22.5+ built-in SQLite — no native compilation needed.
// We load via createRequire so bundlers (esbuild/tsup) don't strip the
// node: prefix from this newer built-in that they don't recognise yet.
import { createRequire } from 'node:module'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as
  typeof import('node:sqlite')
import { mkdirSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { config } from './config.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaymentStatus = 'pending' | 'processing' | 'confirmed' | 'failed'

export interface Payment {
  id:           string
  ref:          string | null
  to_address:   string
  amount:       string        // human-readable EXFER, e.g. "1.5"
  webhook_url:  string | null
  wallet_id:    string        // which wallet sends this payment
  status:       PaymentStatus
  tx_id:        string | null
  fee:          string | null // human-readable EXFER
  error:        string | null
  retries:      number
  batch_id:     string | null
  created_at:   number        // unix ms
  updated_at:   number
  confirmed_at: number | null
}

// ── Database init ─────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null

function db(): DatabaseSync {
  if (_db) return _db

  mkdirSync(path.dirname(config.dbPath), { recursive: true })
  _db = new DatabaseSync(config.dbPath)

  _db.exec("PRAGMA journal_mode = WAL")   // safe concurrent reads
  _db.exec("PRAGMA busy_timeout = 5000")
  _db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id           TEXT PRIMARY KEY,
      ref          TEXT,
      to_address   TEXT NOT NULL,
      amount       TEXT NOT NULL,
      webhook_url  TEXT,
      wallet_id    TEXT NOT NULL DEFAULT 'default',
      status       TEXT NOT NULL DEFAULT 'pending',
      tx_id        TEXT,
      fee          TEXT,
      error        TEXT,
      retries      INTEGER NOT NULL DEFAULT 0,
      batch_id     TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_status    ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_ref       ON payments(ref);
    CREATE INDEX IF NOT EXISTS idx_batch     ON payments(batch_id);
    CREATE INDEX IF NOT EXISTS idx_created   ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet    ON payments(wallet_id);
  `)

  // ── Migration: add wallet_id to existing databases ────────────────────────
  const cols = (_db.prepare("PRAGMA table_info(payments)").all() as unknown as {name: string}[]).map(c => c.name)
  if (!cols.includes('wallet_id')) {
    _db.exec("ALTER TABLE payments ADD COLUMN wallet_id TEXT NOT NULL DEFAULT 'default'")
    _db.exec("CREATE INDEX IF NOT EXISTS idx_wallet ON payments(wallet_id)")
    console.log('[db] Migrated: added wallet_id column')
  }

  return _db
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function now() { return Date.now() }
function newId() { return `pay_${crypto.randomBytes(8).toString('hex')}` }

function transaction(fn: () => void): void {
  db().exec('BEGIN')
  try { fn(); db().exec('COMMIT') }
  catch (e) { db().exec('ROLLBACK'); throw e }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Add a payment to the queue. Returns the created record. */
export function enqueue(params: {
  to_address:   string
  amount:       string
  wallet_id:    string
  webhook_url?: string
  ref?:         string
}): Payment {
  const id = newId()
  const t  = now()

  db().prepare(`
    INSERT INTO payments
      (id, ref, to_address, amount, wallet_id, webhook_url, status, retries, created_at, updated_at)
    VALUES
      (@id, @ref, @to_address, @amount, @wallet_id, @webhook_url, 'pending', 0, @t, @t)
  `).run({
    id,
    ref:         params.ref         ?? null,
    to_address:  params.to_address,
    amount:      params.amount,
    wallet_id:   params.wallet_id,
    webhook_url: params.webhook_url ?? null,
    t,
  })

  return getById(id)!
}

/** Fetch a single payment by ID. */
export function getById(id: string): Payment | null {
  return db().prepare('SELECT * FROM payments WHERE id = ?').get(id) as unknown as Payment | null
}

/** Fetch all payments sharing a caller-supplied ref. */
export function getByRef(ref: string): Payment[] {
  return db()
    .prepare('SELECT * FROM payments WHERE ref = ? ORDER BY created_at ASC')
    .all(ref) as unknown as Payment[]
}

/** Pull the next batch of pending payments for a specific wallet (FIFO). */
export function getPending(walletId: string, limit: number): Payment[] {
  return db()
    .prepare("SELECT * FROM payments WHERE status = 'pending' AND wallet_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(walletId, limit) as unknown as Payment[]
}

/** Count pending payments by status for a specific wallet. */
export function countByStatusForWallet(walletId: string): Record<PaymentStatus, number> {
  const rows = db()
    .prepare("SELECT status, COUNT(*) as cnt FROM payments WHERE wallet_id = ? GROUP BY status")
    .all(walletId) as unknown as { status: PaymentStatus; cnt: number }[]

  const result: Record<PaymentStatus, number> = {
    pending: 0, processing: 0, confirmed: 0, failed: 0,
  }
  for (const r of rows) result[r.status] = r.cnt
  return result
}

/** Get all payments in a batch. */
export function getByBatch(batchId: string): Payment[] {
  return db()
    .prepare('SELECT * FROM payments WHERE batch_id = ?')
    .all(batchId) as unknown as Payment[]
}

/** Mark a set of payments as in-flight under a shared batch_id. */
export function markProcessing(ids: string[], batchId: string): void {
  const t    = now()
  const stmt = db().prepare(`
    UPDATE payments SET status = 'processing', batch_id = @batchId, updated_at = @t
    WHERE id = @id
  `)
  transaction(() => {
    for (const id of ids) stmt.run({ id, batchId, t })
  })
}

/** Mark all payments in a batch as confirmed. */
export function markConfirmed(batchId: string, txId: string, fee: string): void {
  const t = now()
  db().prepare(`
    UPDATE payments
    SET status = 'confirmed', tx_id = @txId, fee = @fee,
        confirmed_at = @t, updated_at = @t
    WHERE batch_id = @batchId
  `).run({ batchId, txId, fee, t })
}

/**
 * After a batch failure:
 *   - payments still under maxRetries  → back to 'pending' for retry
 *   - payments that hit maxRetries     → permanently 'failed'
 */
export function markBatchFailed(batchId: string, error: string): void {
  const t   = now()
  const max = config.maxRetries

  transaction(() => {
    db().prepare(`
      UPDATE payments
      SET status = 'pending', retries = retries + 1, error = @error,
          batch_id = NULL, updated_at = @t
      WHERE batch_id = @batchId AND retries + 1 < @max
    `).run({ batchId, error, t, max })

    db().prepare(`
      UPDATE payments
      SET status = 'failed', retries = retries + 1, error = @error, updated_at = @t
      WHERE batch_id = @batchId AND retries + 1 >= @max
    `).run({ batchId, error, t, max })
  })
}

/** Get all payments currently in processing state (used for startup recovery). */
export function getProcessing(): Payment[] {
  return db()
    .prepare("SELECT * FROM payments WHERE status = 'processing' ORDER BY created_at ASC")
    .all() as unknown as Payment[]
}

/**
 * Reset payments back to pending WITHOUT incrementing retries.
 * Used on startup when a service crash left payments stuck in processing.
 */
export function resetToPending(batchId: string): void {
  const t = now()
  db().prepare(`
    UPDATE payments
    SET status = 'pending', batch_id = NULL, tx_id = NULL,
        error = 'Reset after service restart', updated_at = @t
    WHERE batch_id = @batchId AND status = 'processing'
  `).run({ batchId, t })
}

/** Count payments by status (used by /health). */
export function countByStatus(): Record<PaymentStatus, number> {
  const rows = db()
    .prepare('SELECT status, COUNT(*) as cnt FROM payments GROUP BY status')
    .all() as unknown as { status: PaymentStatus; cnt: number }[]

  const result: Record<PaymentStatus, number> = {
    pending: 0, processing: 0, confirmed: 0, failed: 0,
  }
  for (const r of rows) result[r.status] = r.cnt
  return result
}
