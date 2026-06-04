import crypto from 'crypto'
import {
  ExferRestClient,
  ExferRpcClient,
  buildBatchTransaction,
  formatExfer,
  parseExfer,
} from 'exfer-js'
import { config } from './config.js'
import { getWallet, listWallets } from './wallet.js'
import {
  getPending,
  getByBatch,
  getProcessing,
  markProcessing,
  markConfirmed,
  markBatchFailed,
  resetToPending,
} from './queue.js'
import { notify } from './webhook.js'

// ── Clients ───────────────────────────────────────────────────────────────────

const rest = new ExferRestClient(config.apiUrl)
const rpc  = new ExferRpcClient(config.rpcUrl)

// ── Per-wallet signal (wake up a specific flusher) ────────────────────────────

const _wakers = new Map<string, (() => void) | null>()

/** Wake the flusher for a specific wallet immediately. */
export function signal(walletId: string): void {
  const wake = _wakers.get(walletId)
  if (wake) { wake(); _wakers.set(walletId, null) }
}

async function sleep(walletId: string, ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms)
    _wakers.set(walletId, () => { clearTimeout(t); resolve() })
  })
}

// ── Confirmation polling ──────────────────────────────────────────────────────

async function waitForConfirmation(txId: string): Promise<boolean> {
  const deadline = Date.now() + config.confirmTimeoutSec * 1_000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, config.pollIntervalMs))
    try {
      const confs = await rest.getConfirmations(txId)
      if (confs >= 1) return true
    } catch (err) {
      console.warn(`[flusher] poll error: ${(err as Error).message}`)
    }
  }
  return false
}

// ── Single flush cycle for one wallet ────────────────────────────────────────

async function flush(walletId: string): Promise<boolean> {
  const pending = getPending(walletId, config.maxBatchSize)
  if (pending.length === 0) return false

  const batchId = `batch_${crypto.randomBytes(6).toString('hex')}`
  const ids     = pending.map(p => p.id)

  console.log(`[${walletId}] Starting batch ${batchId} — ${pending.length} payment(s)`)
  markProcessing(ids, batchId)

  try {
    const wallet     = getWallet(walletId)
    const recipients = pending.map(p => ({
      address: p.to_address,
      amount:  parseExfer(p.amount),
    }))

    // Fetch UTXOs for this wallet
    const utxoData = await rest.getAddressUtxosRest(wallet.addressHex)
    if (utxoData.utxos.length === 0)
      throw new Error('No confirmed UTXOs — wallet may have insufficient balance')

    // Build & sign
    const signed = await buildBatchTransaction({
      utxos:         utxoData.utxos,
      recipients,
      privateKey:    wallet.privateKey,
      publicKey:     wallet.publicKey,
      senderAddress: wallet.address,
    })

    const feeStr = formatExfer(signed.fee)
    console.log(`[${walletId}] txId=${signed.txId}  fee=${feeStr} EXFER`)

    // Broadcast — if the tx is already in mempool from a previous attempt,
    // don't treat it as a failure; just continue polling for confirmation.
    let txId: string
    try {
      const result = await rpc.sendRawTransaction(signed.txHex)
      txId = result.tx_id ?? signed.txId
      console.log(`[${walletId}] Broadcast OK — txId: ${txId}`)
    } catch (broadcastErr) {
      const msg = (broadcastErr as Error).message ?? ''
      if (msg.toLowerCase().includes('already in mempool')) {
        txId = signed.txId
        console.log(`[${walletId}] Already in mempool, continuing to poll — txId: ${txId}`)
      } else {
        throw broadcastErr
      }
    }

    // Wait for confirmation
    const confirmed = await waitForConfirmation(txId)

    if (confirmed) {
      markConfirmed(batchId, txId, feeStr)
      console.log(`[${walletId}] ✅ Batch ${batchId} confirmed`)
      for (const p of getByBatch(batchId)) notify(p)
    } else {
      throw new Error(`Confirmation timed out after ${config.confirmTimeoutSec}s (txId: ${txId})`)
    }

  } catch (err) {
    const error = (err as Error).message
    console.error(`[${walletId}] ❌ Batch ${batchId} failed: ${error}`)
    markBatchFailed(batchId, error)
    for (const p of getByBatch(batchId)) {
      if (p.status === 'failed') notify(p)
    }
  }

  return true
}

// ── Single wallet loop ────────────────────────────────────────────────────────

async function runWalletLoop(walletId: string): Promise<void> {
  console.log(`[${walletId}] Flusher started`)
  _wakers.set(walletId, null)

  while (true) {
    try {
      const didWork = await flush(walletId)
      if (!didWork) {
        // Nothing pending — sleep until a new payment signals this wallet
        await sleep(walletId, 60_000)
      }
      // If work was done, immediately check again (more may have accumulated)
    } catch (err) {
      console.error(`[${walletId}] Unexpected error:`, (err as Error).message)
      await sleep(walletId, 5_000)
    }
  }
}

// ── Start all wallet flushers ─────────────────────────────────────────────────

// ── Startup recovery ──────────────────────────────────────────────────────────

/**
 * Called once at startup. Finds all payments stuck in 'processing' from
 * a previous run and resolves them:
 *
 *   - tx_id present + confirmed on chain  → mark confirmed, fire webhook
 *   - tx_id present + NOT confirmed       → reset to pending (re-broadcast)
 *   - tx_id missing (crash before broadcast) → reset to pending
 */
export async function recoverProcessing(): Promise<void> {
  const stuck = getProcessing()
  if (stuck.length === 0) {
    console.log('[recovery] No stuck payments — clean startup ✅')
    return
  }

  console.log(`[recovery] Found ${stuck.length} stuck payment(s) from previous run`)

  // Group by batch_id (payments in the same batch share a tx_id)
  const batches = new Map<string, typeof stuck>()
  for (const p of stuck) {
    const key = p.batch_id ?? p.id   // batch_id is always set for processing payments
    const arr = batches.get(key) ?? []
    arr.push(p)
    batches.set(key, arr)
  }

  for (const [batchId, payments] of batches) {
    const txId = payments[0].tx_id

    if (!txId) {
      // Service crashed before broadcast — safe to retry
      console.log(`[recovery] Batch ${batchId}: no tx_id → reset to pending`)
      resetToPending(batchId)
      continue
    }

    // Check whether the tx landed on chain
    try {
      const confs = await rest.getConfirmations(txId)

      if (confs >= 1) {
        // Already confirmed — just didn't get to write it before crash
        const fee = payments[0].fee ?? '?'
        markConfirmed(batchId, txId, fee)
        console.log(`[recovery] Batch ${batchId}: confirmed on chain (txId: ${txId}) ✅`)
        for (const p of getByBatch(batchId)) notify(p)
      } else {
        // Broadcast but unconfirmed — may or may not be in mempool
        // Safest: reset to pending so the flusher re-broadcasts
        console.log(`[recovery] Batch ${batchId}: unconfirmed → reset to pending (txId: ${txId})`)
        resetToPending(batchId)
      }
    } catch (err) {
      // Network error during recovery — reset to pending, let flusher retry
      console.warn(`[recovery] Batch ${batchId}: check failed (${(err as Error).message}) → reset to pending`)
      resetToPending(batchId)
    }
  }

  console.log('[recovery] Done ✅')
}

/** Start one independent flusher loop per loaded wallet. */
export function startFlushers(): void {
  const wallets = listWallets()
  console.log(`[flusher] Starting ${wallets.length} wallet flusher(s)`)
  for (const { id } of wallets) {
    void runWalletLoop(id)   // intentionally non-blocking
  }
}
