import { Router, type Request, type Response, type NextFunction } from 'express'
import { parseExfer } from 'exfer-js'
import { config } from './config.js'
import { enqueue, getById, getByRef, countByStatus, countByStatusForWallet } from './queue.js'
import { signal } from './flusher.js'
import { listWallets, hasWallet, defaultWalletId } from './wallet.js'

const router = Router()

// ── Middleware: IP whitelist ──────────────────────────────────────────────────

function ipGuard(req: Request, res: Response, next: NextFunction): void {
  if (config.allowedIps.length === 0) { next(); return }

  const ip    = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
             ?? req.ip
             ?? req.socket.remoteAddress
             ?? ''
  const clean = ip.replace(/^::ffff:/, '')

  if (!config.allowedIps.includes(clean)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

// ── Middleware: API key auth ──────────────────────────────────────────────────

function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  const token  = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (token !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

router.use(ipGuard, auth)

// ── POST /pay ─────────────────────────────────────────────────────────────────
//
// Body: { to: string, amount: string, webhook?: string, ref?: string }
//
// amount is in EXFER (human-readable), e.g. "1.5"

router.post('/pay', (req: Request, res: Response): void => {
  const { to, amount, wallet, webhook, ref } = req.body as {
    to?:      string
    amount?:  string
    wallet?:  string   // wallet id — defaults to first wallet
    webhook?: string
    ref?:     string
  }

  const errors: string[] = []

  // Validate address
  if (!to)
    errors.push('to is required')
  else if (!/^[0-9a-fA-F]{64}$/.test(to))
    errors.push('to must be a 64-character hex address')

  // Validate amount
  if (!amount) {
    errors.push('amount is required')
  } else {
    try {
      const parsed = parseExfer(amount)
      if (parsed <= 0n) errors.push('amount must be greater than 0')
    } catch {
      errors.push(`amount "${amount}" is not a valid EXFER value`)
    }
  }

  // Validate wallet id
  const walletId = wallet ?? defaultWalletId()
  if (!hasWallet(walletId)) {
    const available = listWallets().map(w => w.id).join(', ')
    errors.push(`wallet "${walletId}" not found. Available: ${available}`)
  }

  // Validate webhook URL
  if (webhook) {
    try { new URL(webhook) }
    catch { errors.push('webhook must be a valid https:// URL') }
  }

  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') })
    return
  }

  // Enqueue and wake the correct wallet's flusher
  const payment = enqueue({
    to_address:  to!,
    amount:      amount!,
    wallet_id:   walletId,
    webhook_url: webhook,
    ref,
  })

  signal(walletId)

  res.status(202).json({
    id:         payment.id,
    status:     payment.status,
    ref:        payment.ref,
    wallet:     payment.wallet_id,
    to:         payment.to_address,
    amount:     payment.amount,
    created_at: payment.created_at,
  })
})

// ── GET /status/:id ───────────────────────────────────────────────────────────

router.get('/status/:id', (req: Request, res: Response): void => {
  const payment = getById(req.params.id)

  if (!payment) {
    res.status(404).json({ error: 'Payment not found' })
    return
  }

  res.json({
    id:           payment.id,
    ref:          payment.ref,
    status:       payment.status,
    to:           payment.to_address,
    amount:       payment.amount,
    tx_id:        payment.tx_id,
    fee:          payment.fee,
    error:        payment.error,
    retries:      payment.retries,
    created_at:   payment.created_at,
    confirmed_at: payment.confirmed_at,
  })
})

// ── GET /ref/:ref ─────────────────────────────────────────────────────────────
// Fetch all payments sharing the same caller-supplied ref

router.get('/ref/:ref', (req: Request, res: Response): void => {
  const payments = getByRef(req.params.ref)
  res.json({ count: payments.length, payments })
})

// ── GET /health ───────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response): void => {
  try {
    const wallets = listWallets()
    const overall = countByStatus()
    const perWallet = wallets.map(w => ({
      id:      w.id,
      address: w.address,
      queue:   countByStatusForWallet(w.id),
    }))
    res.json({ ok: true, wallets: perWallet, total: overall })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

export default router
