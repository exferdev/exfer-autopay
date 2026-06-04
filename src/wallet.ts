import { readFileSync, existsSync } from 'fs'
import { walletFromMnemonic, importKeyFile, type KeyPair } from 'exfer-js'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WalletConfig {
  id:       string
  comment?: string
  mnemonic?: string
  keyFile?:  string
  keyPass?:  string
}

export interface WalletInfo {
  id:      string
  address: string
}

// ── Manager ───────────────────────────────────────────────────────────────────

const _wallets = new Map<string, KeyPair>()
let   _default = ''

/** Load all wallets from wallets.json or fallback to single-wallet env vars. */
export async function loadWallets(): Promise<void> {
  const walletsFile = process.env.WALLETS_FILE

  let configs: WalletConfig[]

  if (walletsFile && existsSync(walletsFile)) {
    // ── Multi-wallet mode ────────────────────────────────────────────────────
    console.log(`[wallet] Loading from ${walletsFile}`)
    const raw = JSON.parse(readFileSync(walletsFile, 'utf8')) as WalletConfig[]

    if (!Array.isArray(raw) || raw.length === 0)
      throw new Error(`${walletsFile} must be a non-empty JSON array`)

    // Validate IDs are unique
    const ids = raw.map(w => w.id)
    if (new Set(ids).size !== ids.length)
      throw new Error('Wallet IDs in wallets.json must be unique')

    configs = raw
  } else {
    // ── Single-wallet fallback ───────────────────────────────────────────────
    const mnemonic    = process.env.MNEMONIC
    const keyFilePath = process.env.KEY_FILE_PATH
    const keyFilePass = process.env.KEY_FILE_PASS

    if (!mnemonic && !keyFilePath)
      throw new Error('Set WALLETS_FILE, MNEMONIC, or KEY_FILE_PATH in your .env')

    configs = [{
      id:      'default',
      mnemonic:    mnemonic    ?? undefined,
      keyFile:     keyFilePath ?? undefined,
      keyPass:     keyFilePass ?? undefined,
    }]
  }

  // ── Load each wallet ───────────────────────────────────────────────────────
  for (const cfg of configs) {
    const kp = await loadOne(cfg)
    _wallets.set(cfg.id, kp)
    console.log(`[wallet] ✅ ${cfg.id.padEnd(12)} ${kp.addressHex}${cfg.comment ? '  (' + cfg.comment + ')' : ''}`)
  }

  _default = configs[0].id
  console.log(`[wallet] Default wallet: ${_default}  (${_wallets.size} total)`)
}

async function loadOne(cfg: WalletConfig): Promise<KeyPair> {
  if (!cfg.id || typeof cfg.id !== 'string')
    throw new Error('Each wallet entry must have a string "id"')

  if (cfg.mnemonic) {
    return walletFromMnemonic(cfg.mnemonic)
  }

  if (cfg.keyFile) {
    if (!cfg.keyPass)
      throw new Error(`Wallet "${cfg.id}": keyPass is required when using keyFile`)
    if (!existsSync(cfg.keyFile))
      throw new Error(`Wallet "${cfg.id}": keyFile not found at ${cfg.keyFile}`)
    const bytes = readFileSync(cfg.keyFile)
    return importKeyFile(new Uint8Array(bytes), cfg.keyPass)
  }

  throw new Error(`Wallet "${cfg.id}": must have either "mnemonic" or "keyFile"`)
}

// ── Accessors ─────────────────────────────────────────────────────────────────

/** Get a wallet by ID. Throws if not found. */
export function getWallet(id: string): KeyPair {
  const kp = _wallets.get(id)
  if (!kp) throw new Error(`Wallet "${id}" not found. Available: ${listWallets().map(w => w.id).join(', ')}`)
  return kp
}

/** Get the default (first) wallet. */
export function getDefaultWallet(): KeyPair {
  return getWallet(_default)
}

/** ID of the default wallet. */
export function defaultWalletId(): string {
  return _default
}

/** List all loaded wallets (id + address). */
export function listWallets(): WalletInfo[] {
  return Array.from(_wallets.entries()).map(([id, kp]) => ({
    id,
    address: kp.addressHex,
  }))
}

/** Check whether a wallet ID exists. */
export function hasWallet(id: string): boolean {
  return _wallets.has(id)
}
