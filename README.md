# NFT Collateral Lending — Selected Modules

Selected frontend and backend modules from a **crypto / NFT lending platform** where users borrow against NFTs, publish collection offers, accept loan requests, and manage active loans.

> This repository highlights core pieces of a larger Next.js + Node.js product (full monorepo not included). Paths like `@/hooks` and `../models` refer to that larger app context.

## Tech stack

- **Frontend:** Next.js, React, TypeScript, wagmi, React Hook Form
- **Backend:** Node.js, Sequelize, MySQL/PostgreSQL
- **Web3:** ERC-20 approvals, wallet message signing, smart-contract calls
- **Integrations:** OpenSea, SimpleHash, AWS S3, Twitter API, email / push notifications

## What’s in this repo

| File | Role |
|------|------|
| `BorrowLoan.tsx` | Borrower UI — NFT selection, loan terms, quick-loan / form modals |
| `useMakeOfferCollection.ts` | Hook to create collection-level loan offers (sign + ERC-20 checks) |
| `loanController.js` | Loan lifecycle API (requests, active loans, receipts, reminders) |
| `collectionController.js` | Collection offers and active-loan listings by contract address |
| `opensea.js` | OpenSea API helpers (collection offers, chain-aware base URL) |
| `fill-collections-data-v4.js` | Seed/sync collection metadata via SimpleHash |

## Key features (platform)

- NFT-backed borrowing flow
- Collection-based loan offers
- Wallet authentication and message signing
- ERC-20 balance and allowance checks
- Loan lifecycle management
- NFT metadata refresh
- Email and push notifications

## Author

**codemaster8899**
