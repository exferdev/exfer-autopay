import type { Payment } from './queue.js'

const MAX_ATTEMPTS  = 5
const BASE_DELAY_MS = 2_000   // 2s, 4s, 8s, 16s, 32s

export interface WebhookPayload {
  id:           string
  ref:          string | null
  status:       'confirmed' | 'failed'
  tx_id?:       string
  fee?:         string
  error?:       string
  created_at:   number
  confirmed_at: number | null
}

function buildPayload(p: Payment): WebhookPayload {
  return {
    id:           p.id,
    ref:          p.ref,
    status:       p.status as 'confirmed' | 'failed',
    tx_id:        p.tx_id    ?? undefined,
    fee:          p.fee      ?? undefined,
    error:        p.error    ?? undefined,
    created_at:   p.created_at,
    confirmed_at: p.confirmed_at,
  }
}

/** Fire-and-forget webhook with exponential backoff. */
export function notify(payment: Payment): void {
  if (!payment.webhook_url) return
  void send(payment.webhook_url, buildPayload(payment))
}

async function send(url: string, payload: WebhookPayload, attempt = 1): Promise<void> {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.ok) {
      console.log(`[webhook] ✅ ${payload.id} → ${url} (attempt ${attempt})`)
      return
    }
    throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    const msg = (err as Error).message
    console.warn(`[webhook] ⚠️  ${payload.id} attempt ${attempt} failed: ${msg}`)

    if (attempt >= MAX_ATTEMPTS) {
      console.error(`[webhook] ❌ ${payload.id} giving up after ${MAX_ATTEMPTS} attempts`)
      return
    }

    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
    setTimeout(() => void send(url, payload, attempt + 1), delay)
  }
}
