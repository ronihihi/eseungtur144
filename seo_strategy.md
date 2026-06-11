# SEO Strategy

## In scope
- Public brand entry routes served by the frontend SPA shell
- Authentication route (`/auth`) for brand discoverability and shareability checks
- Public signing route (`/sign/:token`) for crawl-control, privacy-sensitive indexation, and share-preview checks
- Shared frontend shell metadata and public assets (`index.html`, favicon, Open Graph asset)

## Out of scope
- Authenticated dashboard routes (`/`, `/documents/**` after login)
- Admin routes (`/admin/**`)
- Internal API endpoints under `/api/**`, except where they influence crawlability of public pages

## Target audience
- Teams and organizations sending documents for e-signature
- Recipients opening public signing links from email

## Primary keywords
- e-signature workflow
- document signing
- team e-signature
- PDF signing

## Notes
- The frontend is a Vite + React SPA with Wouter routing.
- Public tokenized signing URLs are intended for direct-access workflows, not organic discovery, so crawl-control matters as much as discoverability.
- Tokenized signing URLs should be treated as non-indexable and excluded from sitemaps, social previews, and AI crawler discovery.

## Dismissed categories
- (None yet)
