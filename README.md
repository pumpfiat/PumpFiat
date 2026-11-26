# Pumpfiat website and referral service

Pumpfiat is a static-first marketing and resources site with a small Node.js service for the referral programme. The HTML source remains in the project root and page folders; the build assembles the shared site shell and writes deployable files to `dist/`.

## Requirements

- Node.js 22.13 or newer (the service uses the built-in `node:sqlite` module).
- `cwebp` only when generating or refreshing responsive WebP variants. Existing generated variants are used by the normal build.

## Run locally

```sh
PUMPFIAT_ADMIN_PASSWORD='use-a-private-local-password' npm start
```

Open `http://127.0.0.1:4174/`. The public campaign is at `/opportunities/osof-no-code-affiliate-campaign/`; the admin interface is at `/admin/`.

`npm start` builds the static site before starting the server. `npm run dev` starts the same server with Node's watch mode. The server binds to `0.0.0.0`; use a firewall or local proxy if it should only be reachable from the local machine.

## Project structure

- `index.html` and the root-level HTML files: landing, company, trust, legal, pricing, and product pages.
- Topic directories with `index.html`: articles and career listings/detail pages.
- `opportunities/`: public campaigns and the referral application.
- `admin/`: the private programme-management interface.
- `partials/`: shared header, footer, and cookie-choice markup.
- `assets/` and `images/`: logos, certifications, illustrations, and photos. Responsive WebP variants sit beside their original fallback files.
- `scripts/build-site.js`: assembles the shared shell, normalizes page metadata, prepares responsive images, and generates the sitemap and crawler policy.
- `scripts/check-site.js` and `tests/`: generated-site checks and referral-service tests.
- `server.js`: static file server and SQLite-backed referral/admin API.
- `dist/`: generated deployment output; do not edit it directly.

## Build and test

```sh
npm run build
npm test
```

The build produces plain HTML, CSS, JavaScript, and image files in `dist/`; it does not require a client-side framework. `npm test` builds first, runs the referral API tests, then checks generated-page links, HTML structure, landmarks, metadata, accessibility attributes, and sitemap exclusions.

When adding or replacing PNG/JPEG photos, run `npm run images` to create native-size and 480/960/1440-pixel WebP files beside each source (only sizes smaller than the source are generated). The HTML build uses available variants in `<picture>` with the original file as a fallback, adds intrinsic dimensions, and lazy-loads non-leading images. Keep image paths URL-safe and update all references when renaming files.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Port supplied by the hosting platform | Used when set |
| `PUMPFIAT_PORT` | Fallback HTTP listener port when `PORT` is unset | `4174` |
| `PUMPFIAT_ADMIN_PASSWORD` | Required password for administrator login | unset (admin login is unavailable) |
| `PUMPFIAT_SESSION_SECRET` | HMAC secret for referral/edit tokens | Persisted random secret in the database |
| `PUMPFIAT_PUBLIC_URL` | Public origin used when generating links and canonical URLs | `https://pumpfiat.com` for the build; relative referral links at runtime |
| `PUMPFIAT_REWARD_AMOUNT` | Default referral reward amount | `50` |
| `PUMPFIAT_DB_PATH` | Full path to the SQLite database | `./data/pumpfiat.sqlite` |
| `PUMPFIAT_DATA_DIR` | Directory for the SQLite database | `./data` |
| `PUMPFIAT_COOKIE_SECURE` | Force the `Secure` attribute on cookies | enabled in production |

Set a stable private session secret and use HTTPS in production. Persist the database directory across deployments and back it up according to the programme's retention needs. Do not put credentials in the repository.

The optional referral cookie is set only after consent. Declining does not prevent manual referral-code entry. The admin session cookie is separate and is only set after successful login.

## Deployment and URL handling

### Netlify + Render

The production configuration uses Netlify for the static site and Render for the referral API:

1. Deploy the repository to Netlify. `netlify.toml` builds and publishes `dist/` and proxies `/api/*` requests to `https://pumpfiat-api.onrender.com`, keeping browser requests same-origin.
2. In Render, create a Blueprint from this repository and its `render.yaml`. Keep the service name `pumpfiat-api` unless you also change the proxy target in `netlify.toml`.
3. On the first Blueprint setup, provide a strong `PUMPFIAT_ADMIN_PASSWORD` in Render. The Blueprint generates `PUMPFIAT_SESSION_SECRET`; neither secret belongs in the repository.
4. The Render service uses a persistent disk mounted at `/var/data` for SQLite. This requires a paid Render service plan; do not switch to ephemeral storage or the referral records can be lost.
5. Wait for `https://pumpfiat-api.onrender.com/api/config` to return JSON, then verify registration and admin login through the production site.

The Blueprint sets `PUMPFIAT_PUBLIC_URL` to `https://pumpfiat.com`. Change it in `render.yaml` if the canonical production domain differs. The API server honors Render's `PORT` environment variable; `PUMPFIAT_PORT` remains available for local use.

A static-only deployment serves the marketing pages but cannot operate the referral API or admin actions.

The server serves `/` from `index.html`, directory URLs from their `index.html`, and `404.html` with an HTTP 404 status for missing paths. It does not implement legacy URL redirects. The retired meta-refresh pages have been removed; configure explicit redirects in the hosting platform if old URLs must continue to resolve. `sitemap.xml` lists generated public pages; `robots.txt` excludes admin/API paths from crawling, but crawler directives do not provide access control.

## Referral administration

Participants register through the campaign page. The admin interface supports affiliate-status review, Gumroad CSV preview/import, rewards, and an audit log. Purchase IDs are unique, so re-importing a sale does not create duplicate sales or rewards. The programme database and Gumroad report data are handled server-side and are not embedded in the public frontend.
