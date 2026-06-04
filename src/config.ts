import 'dotenv/config'
import path from 'path'

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function num(key: string, def: number): number {
  const v = process.env[key]
  return v ? parseInt(v, 10) : def
}

// Wallet config is validated at runtime in wallet.ts
const mnemonic    = process.env.MNEMONIC
const keyFilePath = process.env.KEY_FILE_PATH
const keyFilePass = process.env.KEY_FILE_PASS

export const config = {
  // Wallet
  mnemonic,
  keyFilePath,
  keyFilePass,

  // Security
  apiKey:     required('API_KEY'),
  allowedIps: process.env.ALLOWED_IPS
    ?.split(',').map(s => s.trim()).filter(Boolean) ?? [],

  // Network
  rpcUrl: process.env.RPC_URL ?? 'https://rpc.exfer.dev',
  apiUrl: process.env.API_URL ?? 'https://api.exfer.dev',
  port:   num('PORT', 3000),

  // Behaviour
  maxBatchSize:      num('MAX_BATCH_SIZE',      200),
  confirmTimeoutSec: num('CONFIRM_TIMEOUT_SEC', 300),
  maxRetries:        num('MAX_RETRIES',           3),
  pollIntervalMs:    num('POLL_INTERVAL_MS',    3000),

  // Paths
  dbPath: process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'queue.db'),
}
