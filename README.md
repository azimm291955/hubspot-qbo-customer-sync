# hubspot-qbo-customer-sync

Sales asks for a new wholesale customer by @-mentioning finance in a HubSpot note. This job, on a Vercel cron, builds the customer in QuickBooks Online and replies on the HubSpot record. Nobody re-keys a customer by hand.

## What it does each run

1. Finds new HubSpot notes that @-mention the finance owner and ask to build a customer.
2. Reads the company and contacts the note is attached to.
3. Looks the customer up in QuickBooks by **state license number**, not by name, so the same buyer never gets created twice under a slightly different spelling.
4. If it's new, creates it with the payment terms named in the note (Net 15, Net 30, COD…), email, phone and billing address.
5. Replies on the HubSpot company with the result, or with exactly what's missing.
6. Retries anything it couldn't finish on the next run.

Runs hourly during the business day (`vercel.json`).

## Design choices

- **The license number is the key.** Cannabis wholesale customers are licensed entities; matching on name is how duplicates happen.
- **Ask, don't guess.** A request missing a license number or company name gets a reply naming what's missing, and stays pending until it's fixed.
- **Dry run first.** With `DRY_RUN=1` it reports every customer it would create and every reply it would post, and changes nothing.
- **Rotating refresh token.** QuickBooks issues a new refresh token on every use. The job stores the latest one in Vercel Blob with its run state, so it never gets locked out.
- **No secrets in code.** Every credential comes from environment variables; see `.env.example`.

## Setup

```bash
cp .env.example .env    # fill in, keep DRY_RUN=1 for the first runs
vercel env add ...      # same values in the Vercel project
vercel deploy
```

## Stack

Node 22 · Vercel Functions + Cron · Vercel Blob · HubSpot CRM API v3/v4 · QuickBooks Online API v3
