# fortnyt

Self-hosted budgeting for people who are paid every two weeks and billed every month.

It combines your planned budget with real bank transactions from [SimpleFIN Bridge](https://beta-bridge.simplefin.org/) and answers one question per pay period: **how much money isn't spoken for yet?**

- **Views:** this pay period, calendar (week / pay period / month), ledger, dial (ring chart), Sankey, reserves, budget, setup.
- **Households:** several people, each with their own accounts and lines, shared costs split by percentage, and a per-person view of everything.
- **Cash reserves:** named pots (emergency fund, car, travel) that budget lines save into and bills get paid from.
- **Runtime:** one Node process, one SQLite file, no external services besides SimpleFIN. Unlicense.

---

## Quick start

### Try it with demo data (no bank needed)

1. `npm install`
2. `DATA_DIR=./data-demo npm run demo:seed`, which creates two people, four accounts, three reserves, and about 100 days of made-up transactions.
3. `DATA_DIR=./data-demo npm run dev`, then open <http://localhost:5173>.

### Run it for real (Docker, e.g. on a Raspberry Pi)

1. `cp .env.example .env`, then set `FORTNYT_SECRET` (`openssl rand -base64 32`) and `APP_PASSWORD`.
2. `mkdir -p data && sudo chown 1000:1000 data`, because the container runs as uid 1000.
3. `docker compose up -d`, then open `http://<docker-host>:8080`.
4. **Budget:** enter one real payday. Every pay period starts on a payday.
5. **Setup → Bank connection:** paste a SimpleFIN Setup Token.
6. **Budget:** add your income and expense lines.

### Develop

| Command | What it does |
|---|---|
| `npm run dev` | API server (tsx watch, port 8080) and Vite (port 5173, proxies `/api`) |
| `npm test` | 28 engine, SimpleFIN, and sync tests (node:test) |
| `npm run typecheck` | `tsc --noEmit` over server, client, tests, scripts |
| `npm run build` | `dist/public` (client) and `dist/server.mjs` (one bundled file) |
| `npm start` | runs the built server |
| `npm run docker:build` / `docker:run` / `docker:push` | local image, run it, multi-arch push |
| `npm run release:patch` then `npm run release:tags` | bump, tag `vX.Y.Z`, push; CI builds and publishes the image with signed provenance |

Requires Node ≥ 22.13 for built-in `node:sqlite`. The Docker image uses Node 24 (current LTS).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FORTNYT_SECRET` | none | Encrypts the stored SimpleFIN access URL (AES-256-GCM). Keep it: losing it means reconnecting with a new Setup Token. |
| `APP_PASSWORD` / `APP_USER` | none / `fortnyt` | HTTP Basic login for the whole app. `/api/health` stays open for the container healthcheck. |
| `FORTNYT_TZ` | `America/New_York` | Time zone on first start; decides which calendar day a bank transaction lands on. |
| `DATA_DIR` | `./data` | Where `fortnyt.db` lives. |
| `STATIC_DIR` | `./dist/public` | Built client. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |
| `SYNC_SCHEDULER` | on | `off` disables automatic syncing. |
| `FORTNYT_TODAY` | none | Pins "today" to a `YYYY-MM-DD`. For demos and screenshots only. |

---

## How the budget works

### Pay periods

A pay period starts on a payday and ends the day before the next one. You set one real payday and the interval: 7, 14, or 28 days.

### The headline number

```
not spoken for = income counted − committed − unplanned spending + unplanned income − reserve shortfall
```

- **Income counted:**
  - A paycheck that arrived counts its real amount.
  - One still expected counts the planned amount.
  - One that is overdue past its match window counts 0, so you're never told you have money that didn't arrive.
- **Committed:** what each budget line holds back (see the three modes below).
- **Unplanned:** transactions not assigned to any line or reserve.
- **Never counted:** transfers and ignored transactions.

Below the headline, a **cash check** compares against the bank. It takes the current balances of in-budget accounts, adds paychecks still expected, and subtracts what's still owed this period and what reserves are holding. The result is what's actually free right now.

### Three ways a line lands in pay periods

This is how biweekly pay and monthly bills coexist.

| Mode | Use for | How it lands | What it commits |
|---|---|---|---|
| **On its date** | rent, phone, subscriptions | The whole amount lands in the pay period containing the due date. | The planned amount until a matching transaction appears, then the real amount. |
| **Envelope** | groceries, gas, fun money | The amount is spread per day across its cycle. $600/month is $19.35/day in a 31-day month and $21.43/day in February, and a year of periods adds up to exactly $7,200. Spending counts in the period it happens. | While the period is open: the larger of budget and spent. Once closed: what was spent. |
| **Fund** | car insurance, annual renewals | Every period saves its daily share into a reserve. | Always the share. The bill is paid out of the reserve, not the period it lands in. |

### Match windows

A transaction assigned to an on-date line counts toward the **nearest due date within ± N days** (default 5), even across a pay-period boundary. So a paycheck deposited a day early, or rent paid on the 30th for the 1st, lands where it belongs. Ties go to the later date.

### Rules

Rules assign transactions automatically. The first matching rule wins: lowest priority number first, then oldest. A rule can match on:
- text: contains, starts with, exact, or regex;
- direction: money in or out;
- amount range;
- account.

Rules never overwrite anything you assigned by hand. Use "Make a rule" next to any transaction to create one; the dialog previews how many past transactions it would match.

---

## People and shared costs

- **Share percentage:** each person has a share of shared costs, e.g. 55 / 45. Shares should add up to 100; Setup warns if they don't.
- **Ownership:** lines, accounts, and reserves each belong to one person or are shared. A shared account is labeled "joint".
- **"Showing" (sidebar):** switches every view to one person's share:
  - things they own count 100%;
  - shared things count at their share %;
  - things someone else owns are left out.
- **How a transaction's share is decided:** by its budget line if it has one, otherwise its reserve, otherwise its account. Half the rent is each person's even when one of them pays it.
- **Shares add up:** tests confirm everyone's shares sum back to the household total.
- **Own pay schedule (optional):** a person paid every 1, 2, or 4 weeks can have their own payday, and their view uses their own pay periods. Someone paid monthly or twice a month keeps the household periods; their paychecks are ordinary income lines.

## Cash reserves

A reserve has an opening balance and date, an optional target, an owner, and **where the money sits**:

- **Earmarked inside an in-budget account** (e.g. car money that stays in checking). Feed it with **fund lines**. The cash check holds its balance back.
- **In a separate account** marked outside the budget (e.g. high-yield savings). Feed it with an **on-date line** such as "To emergency fund, every payday", matched to the transfer. The cash check ignores it, because that money already left.

Money in:
- daily shares from fund lines;
- paid contributions from on-date lines;
- positive transactions assigned straight to the reserve (interest, refunds).

Money out:
- bills on its fund lines;
- anything you assign as "paid from reserve X". Example: tires paid from the Car reserve don't count as unplanned spending.

A reserve can't go below zero. If a bill overruns it, the overrun counts against that pay period as a shortfall. The Reserves page shows balances, target progress, and a balance history 6 periods back and 6 ahead; the projected part includes upcoming bills. It also compares each holding account's bank balance against what its reserves claim.

A fund line with no reserve picked keeps a private pot of its own, so a single sinking fund needs no setup.

---

## SimpleFIN

- **Setup Token:** create one in the Bridge and paste it in Setup. It works once: fortnyt exchanges it for an Access URL and stores that, encrypted if `FORTNYT_SECRET` is set.
- **Error handling:** a 403 on claim means the token was already used, possibly by someone else. The app says so and tells you to disable it in the Bridge. 402 and 403 on sync, and the Bridge's per-account error messages, are shown in Setup.
- **Request budget:** the Bridge disables tokens that make far more than ~24 requests a day, so fortnyt:
  - syncs every 6 hours (configurable, minimum 2) at a random fixed minute, away from the top of the hour;
  - refuses a manual sync that would exceed **20 requests in 24 h**;
  - overlaps each sync with the last by 5 days;
  - splits history into 89-day requests. The first sync imports 89 days, which is exactly one request.
- **Pending transactions:** when a pending transaction posts under a new id, the pending copy is removed. Any assignment you made by hand moves to the posted copy (same account, same amount, within 5 days). This only happens for accounts the bank reported as complete in that sync.

---

## Architecture

```
src/shared/   types, date math (day numbers, DST-proof), money parsing (no floats), recurrence
src/server/   engine.ts (all budget math, pure), rules, db (node:sqlite + migrations), repo,
              simplefin (protocol v2 client), sync (scheduler, quota), secrets, validate (zod), app (Hono)
src/client/   React 19 + Vite, hash routing, hand-drawn SVG charts (no chart library)
test/         engine + SimpleFIN/sync tests with a mocked fetch
scripts/      dev runner, esbuild server bundle, demo seeder
```

Money is integer cents everywhere. Calendar dates are `YYYY-MM-DD` strings, and all date arithmetic goes through day numbers.

## Limits worth knowing

- **No split overrides per line:** one share percentage per person applies to everything shared.
- **Pending transactions** count toward the budget; bank balances may or may not include them yet, depending on the bank.
- **Envelopes don't roll over:** an unspent envelope doesn't carry into the next period. The cash check reflects real accumulated money instead.
