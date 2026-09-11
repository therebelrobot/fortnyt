# Handoff: fortnyt

Prompt for a Claude Code session continuing this project. Read this whole file before changing anything.

## Your first 3 steps

1. Run `npm install && npm run typecheck && npm test`. Expected result: typecheck clean, `# pass 28`, `# fail 0`.
2. Run `DATA_DIR=./data-demo npm run demo:seed && DATA_DIR=./data-demo npm run dev`, then open <http://localhost:5173> and click through every view in the sidebar.
3. Read `src/server/engine.ts` top to bottom. Every number in the UI comes from it.

## Current state (v0.1.0)

**Built and verified.** Checked against demo data in headless Chromium: 0 console errors across all views, at 1360 px, at 390 px, and in dark mode.

- Server, engine, SimpleFIN sync, rules, people, cash reserves, and the per-person view.
- Views: This period, Calendar (week / pay period / month), Ledger, Dial, Sankey, Reserves, Budget, Setup.
- Docker, compose, CI, release workflow, README.

**Not verified in this environment:**

| What | Why it's untested | How to verify |
|---|---|---|
| `docker build` | no Docker available | run `npm run docker:build` |
| Node 24 runtime | only Node 22.22 available; built-in SQLite works on both | run the built image |
| Real SimpleFIN traffic | the sandbox could not reach the Bridge | connect a real token; the client is covered by mocked-fetch tests |

## Decisions you must not reverse

Each one prevents a specific bug that was designed around.

1. **Money is integer cents; SimpleFIN amounts are parsed digit by digit (`shared/money.ts`).** Parsing with floats turns `0.29` into 28.999… and loses cents.
2. **Calendar dates are `YYYY-MM-DD` strings and all arithmetic goes through day numbers (`shared/dates.ts`).** `Date` math across a DST change makes a 14-day pay period 13 or 15 days long.
3. **Daily rate = amount ÷ cycle length, for both envelopes and funds (`dailyRates`).** This is the only reason a year of biweekly periods adds up exactly to 12 × the monthly amount. Don't switch to "monthly × 12 ÷ 26 per paycheck".
4. **On-date lines match the nearest due date within ± the match window, across period boundaries (`effectiveDate`).** Removing this sends early paychecks and rent-on-the-30th into the wrong pay period.
5. **Reserves clamp at zero; an overrun becomes a shortfall charged to that period.** Letting a reserve go negative double-counts money: once in the period that overran, again as later periods refill it.
6. **Only reserves held in in-budget accounts are subtracted in the cash check (`heldInBudget`).** Money already moved to an out-of-budget savings account is not in the balances, so subtracting it again understates free cash.
7. **Projected future fund-line bills are subtracted only on the Reserves page (`simulatePot(..., projectBills = true)`), never in period assessments.** Subtracting them in periods would overstate free cash by the bill amount.
8. **The per-person view scales data before the engine runs (`applyLens`); the engine itself knows nothing about people.** Keep lens logic out of `assessPeriod`, or the shares stop summing to the household total. That property is tested.
9. **Rules never touch transactions with `assigned_by = 'manual'`.** Overwriting hand assignments destroys trust in the tool.
10. **Pending-transaction cleanup runs only for accounts with no errors in that sync.** Otherwise an incomplete bank response deletes real pending spending.
11. **SimpleFIN request budget: 20 per rolling 24 h, 89-day chunks, 5-day overlap, a random sync minute.** The Bridge disables tokens that overuse the API.
12. **Credentials move from the Access URL into an `Authorization` header (`fetchAccounts`).** Node's `fetch` rejects URLs that contain credentials.
13. **Zod schemas never use `.default()`.** Defaults on a schema reused for updates silently overwrite fields the client didn't send.
14. **File paths resolve from `process.cwd()`, never `import.meta.url`.** esbuild flattens the server into one file, so `import.meta.url` points somewhere different in dev and in Docker.
15. **Import specifiers have no `.js` extensions** (`moduleResolution: bundler`).
16. **No chart library.** The Dial and Sankey are hand-drawn SVG. The Sankey needs no layout solver because every flow is a tree; keep each column stacked in parent order and bands never cross.

## Manual test checklists

### A. Pay-period math (demo data)
- [ ] This period: the headline equals *Coming in* minus *Counts as* for all lines, minus unplanned spending. Check with a calculator.
- [ ] Ribbon: a sun icon on the payday; today highlighted; open circles for bills not yet paid.
- [ ] Assign one "LANTERN COFFEE" to *Fun money*. The headline doesn't change (the envelope already held that money) and the uncategorized count drops by 1.
- [ ] Previous period: envelopes show *Closed* and count only what was actually spent.

### B. Calendar
- [ ] Month view: pay-period bands alternate color along the top of each day; paydays have a gold left edge.
- [ ] Planned items show dashed; transactions solid; unassigned transactions gold.
- [ ] Pay period view shows exactly 14 days, starting on the payday.
- [ ] Clicking a day opens its detail below the grid, with assignment pickers.

### C. People
- [ ] Switch *Showing* to Leif. Emergency-fund contributions show 45% ($90 of $200); Travel fund shows 100%.
- [ ] In the Ledger with Leif selected, joint-account rows show "of $X" (the full amount) under the share.
- [ ] Setup: change Rowan's share to 60% and Leif's to 40%. Every Leif number moves; the household view doesn't.

### D. Reserves
- [ ] Reserves page: Car's history dips at the tire purchase; the projected (dashed) part dips on the next insurance due date.
- [ ] Ledger: assign any expense to "Car" under *Paid from / into a reserve*. The period's unplanned spending drops and Car's balance drops by the same amount.
- [ ] Assign a larger amount than Car holds. The period shows a reserve shortfall line and the headline drops by exactly the overrun.

### E. SimpleFIN (real token)
- [ ] Connecting imports accounts. Setup shows "Encrypted with FORTNYT_SECRET" when the secret is set.
- [ ] Pasting the same token again gives the "already claimed" error that mentions someone else may have claimed it.
- [ ] *Requests, last 24 h* increases by 1 per sync; the 21st request in 24 h is refused with a message.
- [ ] A pending transaction you assign by hand keeps its assignment after it posts.

### F. Mobile (390 px)
- [ ] Nothing scrolls sideways except the Sankey, which scrolls inside its own box.
- [ ] Transaction tables stack: description and amount on one line, the picker underneath.

## Next work (ranked)

1. **Pin GitHub Actions to commit SHAs.**
   - `release.yml` calls `therebelrobot/.github/...@main`: pin it to a commit SHA.
   - `ci.yml` uses `actions/checkout@v5` and `actions/setup-node@v5` by tag: run `npx pin-github-action .github/workflows/*.yml`.
   - SHAs weren't written in by hand because a wrong one fails the whole workflow.
2. **Per-line share overrides** (e.g. utilities split 70/30 while everything else is 55/45). Add an `item_shares` table read inside `applyLens` item weights. About 30 min.
3. **"Skip this occurrence"** for a bill that won't happen this cycle. Today an unpaid past bill stays *Past due* and committed.
4. **Envelope rollover (optional per line).** Carry an unspent envelope balance into the next period.
5. **Occurrence override in the UI.** The API already accepts `occurrenceDate` on a transaction; add a picker for "this payment covers the Oct 1 rent".
