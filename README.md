# exfer-autopay

[![version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/exferdev/exfer-autopay/releases)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Automatic payment queue service for the [Exfer](https://exfer.org) blockchain. Accepts HTTP payment requests, batches them together, broadcasts to the network, and notifies via webhook on confirmation.

Built on the [exfer-js](https://github.com/exferdev/exfer-js) SDK.

## Features

- **Auto-batching** — queued payments are merged into a single Batch transaction (up to 200 recipients), sharing one fee
- **Confirmation-driven** — the next batch fires immediately after the previous one is confirmed; no timers, no races
- **Multi-wallet** — configure multiple hot wallets; each wallet runs an independent flusher loop without blocking the others
- **Persistent queue** — SQLite storage, no payment records lost on restart
- **Startup recovery** — on restart, automatically checks in-flight payments against the chain and either marks them confirmed or re-queues them for broadcast
- **Webhook callbacks** — push notifications on success or failure with exponential-backoff retry
- **Zero native deps** — uses Node.js 22.5+ built-in `node:sqlite`; no native compilation required

## Requirements

- Node.js ≥ 22.5 (24 LTS recommended)
- Ubuntu 24.04 or any Linux distribution supporting Node.js

---

## Project Structure

```
exfer-autopay/
├── src/
│   ├── index.ts          # Entry: HTTP server + recovery + flusher startup
│   ├── config.ts         # Environment variable loading and validation
│   ├── queue.ts          # SQLite queue (node:sqlite built-in)
│   ├── wallet.ts         # Multi-wallet loading and management
│   ├── flusher.ts        # Core: batch send + confirmation polling + recovery
│   ├── routes.ts         # HTTP routes: /pay /status /ref /health
│   └── webhook.ts        # Webhook callbacks with exponential-backoff retry
├── systemd/
│   └── exfer-autopay.service
├── .env.example
├── wallets.example.json
├── api-docs.html         # Local API documentation (open in browser)
└── test.html             # Browser-based local test panel
```

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/exferdev/exfer-autopay.git
cd exfer-autopay
npm install
```

### 2. Configure Wallets

**Multi-wallet mode** (recommended):

```bash
cp wallets.example.json wallets.json
nano wallets.json
```

```json
[
  {
    "id": "main",
    "comment": "Default wallet",
    "mnemonic": "word1 word2 ... word24"
  },
  {
    "id": "hot1",
    "comment": "Hot wallet 1",
    "mnemonic": "other word1 word2 ... word24"
  },
  {
    "id": "hot2",
    "comment": "Key file wallet",
    "keyFile": "/etc/exfer-autopay/hot2.key",
    "keyPass": "your-passphrase"
  }
]
```

**Single-wallet mode** — set in `.env`:

```env
MNEMONIC="word1 word2 ... word24"
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

Minimum required:

```env
WALLETS_FILE=./wallets.json
API_KEY=your-secret-key-here   # generate: openssl rand -hex 32
PORT=3888
```

### 4. Start

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

### 5. Verify

```bash
curl http://127.0.0.1:3888/health \
  -H "Authorization: Bearer your-secret-key-here"
```

```json
{
  "ok": true,
  "wallets": [
    {
      "id": "main",
      "address": "a7165f01...951162",
      "queue": { "pending": 0, "processing": 0, "confirmed": 0, "failed": 0 }
    }
  ],
  "total": { "pending": 0, "processing": 0, "confirmed": 0, "failed": 0 }
}
```

---

## API Reference

All endpoints require an API key header:

```
Authorization: Bearer <API_KEY>
```

### POST /pay — Submit a payment

```bash
curl -X POST https://pay.exfer.dev/pay \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "to":      "64-char hex recipient address",
    "amount":  "1.5",
    "wallet":  "main",
    "ref":     "order_001",
    "webhook": "https://your.server/payment/callback"
  }'
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `to` | string | ✓ | Recipient address (64-char hex) |
| `amount` | string | ✓ | Amount in EXFER (e.g. `"1.5"`) |
| `wallet` | string | — | Wallet ID; defaults to the first wallet |
| `ref` | string | — | Your business order ID for lookup |
| `webhook` | string | — | URL to notify when payment settles |

**Response 202:**

```json
{
  "id":         "pay_eba99ba6f4a16478",
  "status":     "pending",
  "ref":        "order_001",
  "wallet":     "main",
  "to":         "64-char address",
  "amount":     "1.5",
  "created_at": 1780553055604
}
```

---

### GET /status/:id — Query payment status

```bash
curl https://pay.exfer.dev/status/pay_eba99ba6f4a16478 \
  -H "Authorization: Bearer your-key"
```

```json
{
  "id":           "pay_eba99ba6f4a16478",
  "ref":          "order_001",
  "status":       "confirmed",
  "wallet":       "main",
  "to":           "64-char address",
  "amount":       "1.5",
  "tx_id":        "on-chain transaction ID",
  "fee":          "0.00000069",
  "error":        null,
  "retries":      0,
  "created_at":   1780553055604,
  "confirmed_at": 1780553068000
}
```

**Payment statuses:**

| Status | Description |
|--------|-------------|
| `pending` | Waiting to be included in the next batch |
| `processing` | Broadcast; awaiting on-chain confirmation |
| `confirmed` | Confirmed on chain ✅ |
| `failed` | Retries exhausted; permanently failed ❌ |

---

### GET /ref/:ref — Query by business ref

```bash
curl https://pay.exfer.dev/ref/order_001 \
  -H "Authorization: Bearer your-key"
```

```json
{
  "count": 1,
  "payments": [{ "id": "pay_xxx", "status": "confirmed", "amount": "1.5", ... }]
}
```

---

### GET /health — Health check

Returns all wallet addresses and queue counts per status.

---

## Webhook Notifications

A POST request is sent to the `webhook` URL when a payment reaches a terminal state. Retried up to 5 times with exponential backoff (2s / 4s / 8s / 16s / 32s).

**Success:**

```json
{
  "id":           "pay_eba99ba6f4a16478",
  "ref":          "order_001",
  "status":       "confirmed",
  "tx_id":        "on-chain transaction ID",
  "fee":          "0.00000069",
  "created_at":   1780553055604,
  "confirmed_at": 1780553068000
}
```

**Failure:**

```json
{
  "id":           "pay_eba99ba6f4a16478",
  "ref":          "order_001",
  "status":       "failed",
  "error":        "No confirmed UTXOs available — wallet may have insufficient balance",
  "created_at":   1780553055604,
  "confirmed_at": null
}
```

---

## Multi-Wallet Routing

Each wallet has its own independent flusher loop:

```
POST /pay { "wallet": "main" }  →  main wallet queue
POST /pay { "wallet": "hot1" }  →  hot1 wallet queue
POST /pay {                  }  →  default wallet (first entry in wallets.json)
```

**Wallet changes require a restart** (no payments are lost — they persist in SQLite):

| Action | Steps |
|--------|-------|
| Add wallet | Edit `wallets.json` → restart |
| Modify wallet | Verify no pending/processing payments → modify → restart |
| Remove wallet | Verify no pending/processing payments → remove → restart |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WALLETS_FILE` | — | Path to multi-wallet JSON config (takes priority) |
| `MNEMONIC` | — | Single-wallet 24-word mnemonic |
| `KEY_FILE_PATH` | — | Single-wallet `.key` file path |
| `KEY_FILE_PASS` | — | Password for `.key` file |
| `API_KEY` | **required** | HTTP authentication key |
| `ALLOWED_IPS` | `""` | Comma-separated IP whitelist; empty = allow all |
| `CORS_ORIGINS` | `""` | Comma-separated allowed CORS origins |
| `RPC_URL` | `https://rpc.exfer.dev` | Exfer node JSON-RPC endpoint |
| `API_URL` | `https://api.exfer.dev` | Exfer Explorer REST API endpoint |
| `PORT` | `3888` | HTTP listening port |
| `MAX_BATCH_SIZE` | `200` | Maximum recipients per batch transaction |
| `CONFIRM_TIMEOUT_SEC` | `300` | Confirmation timeout in seconds |
| `MAX_RETRIES` | `3` | Maximum retry attempts before marking failed |
| `POLL_INTERVAL_MS` | `3000` | Confirmation polling interval (ms) |
| `DB_PATH` | `./data/queue.db` | SQLite database path |

---

## systemd Service

```bash
sudo cp systemd/exfer-autopay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable exfer-autopay
sudo systemctl start exfer-autopay

# Logs
sudo journalctl -u exfer-autopay -f
```

---

## How It Works

```
POST /pay arrives
  → Written to SQLite queue (status: pending)
  → Signals the flusher for that wallet

Flusher loop (one per wallet, independent):
  1. Dequeue up to 200 pending payments
  2. buildBatchTransaction (auto 2-pass fee estimation via exfer-js)
  3. Broadcast to Exfer node
  4. Poll for on-chain confirmation every 3 s
  5. Confirmed → mark confirmed, fire webhooks
  6. Failed    → retry; on exhaustion → mark failed, fire webhooks
  7. Loop immediately if more pending, otherwise sleep until signalled

Startup recovery:
  → Scan all payments stuck in 'processing' from previous run
  → Query on-chain status for each
    ✅ Confirmed → write confirmed record + fire webhook
    ❌ Not found → reset to pending for re-broadcast
```

---

## Development

```bash
npm install        # install dependencies
npm run dev        # development mode with hot reload
npm run lint       # TypeScript type check
npm run build      # build for production
```

Open `api-docs.html` in a browser for the full API reference.
Open `test.html` in a browser for an interactive test panel.

---

## License

MIT © [exferdev](https://github.com/exferdev)
