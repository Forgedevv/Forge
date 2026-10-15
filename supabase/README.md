Supabase SQL migrations for FORGE live in `migrations/`.

## Database tests

`pnpm test` runs the database integration tests (`tests/db.test.ts`) only when `SUPABASE_DB_URL`
is set; they apply to that database. Stop the builder and the signer that use the same database
first: the job-function tests insert real jobs, and a running worker would take them.
