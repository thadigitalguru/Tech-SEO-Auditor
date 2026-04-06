# Deploy

## Required environment variables

- `DATABASE_URL`: Vercel Postgres or another PostgreSQL connection string.
- `CLERK_PUBLISHABLE_KEY`: Clerk frontend key.
- `CLERK_SECRET_KEY`: Clerk backend key.

## Optional environment variables

- `OPENAI_API_KEY`: Enables AI-generated summaries.
- `OPENAI_MODEL`: Overrides the default OpenAI model.
- `AUDIT_E2E_MODE`: Use `1` only for local smoke tests; keep it unset in production.

## Vercel setup

1. Connect the GitHub repository to Vercel.
2. Add the environment variables above in the Vercel project settings.
3. Verify the production `DATABASE_URL` points at a live PostgreSQL instance.
4. Deploy from the main branch or your release branch.

## Database notes

- The app uses Prisma with a PostgreSQL adapter.
- If your PostgreSQL provider requires SSL mode settings, use the provider-recommended connection string.
- If you see PostgreSQL SSL warnings in local smoke tests, they are typically a connection-string compatibility warning rather than a build failure.

## Validation before release

- `pnpm lint`
- `pnpm test -- --runInBand`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test:e2e`
