import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { config } from './config.js'
import { loadWallets } from './wallet.js'
import { startFlushers, recoverProcessing } from './flusher.js'
import routes from './routes.js'

async function main() {
  // ── 1. Load all wallets ────────────────────────────────────────────────────
  await loadWallets()

  // ── 2. HTTP server ─────────────────────────────────────────────────────────
  const app = express()
  app.set('trust proxy', 1)

  // CORS — allow file:// and localhost for local testing.
  // Set CORS_ORIGINS=https://yoursite.com for production.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

  app.use((req, res, next) => {
    const origin = req.headers.origin ?? ''
    const isAllowed =
      origin === 'null' ||
      allowedOrigins.includes(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin',  origin || '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })

  // Rate limiting — prevent brute force / abuse
  // POST /pay:   60 requests per minute per IP
  // Other GET:   300 requests per minute per IP
  app.use('/pay', rateLimit({
    windowMs: 60_000,
    limit:    60,
    message:  { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders:   false,
  }))
  app.use(rateLimit({
    windowMs: 60_000,
    limit:    300,
    message:  { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders:   false,
  }))

  app.use(express.json())
  app.use(routes)

  app.listen(config.port, '127.0.0.1', () => {
    console.log(`[http] Listening on 127.0.0.1:${config.port}`)
  })

  // ── 3. Recover any payments stuck in 'processing' from previous run ────────
  await recoverProcessing()

  // ── 4. Start one flusher loop per wallet ───────────────────────────────────
  startFlushers()

  // Keep the process alive
  await new Promise(() => {})
}

main().catch(err => {
  console.error('[fatal]', err)
  process.exit(1)
})
