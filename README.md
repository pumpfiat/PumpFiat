# PumpFiat Osof No Code affiliate system

This project serves the existing static PumpFiat website and adds a persistent SQLite-backed referral and Gumroad reconciliation backend.

## Run locally

```bash
cd PumpFiat
PUMPFIAT_ADMIN_PASSWORD='replace-with-a-private-password' npm start
```

Open `http://127.0.0.1:4174/opportunities/osof-no-code-affiliate-campaign/`.
Open `http://127.0.0.1:4174/admin/` for administration.

## Configuration

- `PUMPFIAT_PORT`: HTTP port; defaults to `4174`.
- `PUMPFIAT_ADMIN_PASSWORD`: required for administrator login.
- `PUMPFIAT_SESSION_SECRET`: optional secret used to protect participant edit tokens.
- `PUMPFIAT_PUBLIC_URL`: optional public origin, for example `https://pumpfiat.com`.
- `PUMPFIAT_REWARD_AMOUNT`: optional reward amount; defaults to `50`.
- `PUMPFIAT_DB_PATH`: optional SQLite database path.
- `PUMPFIAT_DATA_DIR`: optional database directory; defaults to `./data`.

The public registration, gumroad details, CSV import and reward operations are API-backed. No Gumroad API credentials or participant database is exposed to the frontend.

## Gumroad CSV reconciliation

Export the Gumroad sales report, open **Gumroad import** in the admin dashboard, and upload the CSV. Review and correct the detected column mapping, preview the matches and confirm the import. Purchase IDs are unique; replaying a CSV does not create duplicate sales or rewards.
