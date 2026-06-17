# Electric + Postgres test fixture

A real (no-mocks) ElectricSQL shape server in front of a Postgres-of-record,
for testing the smithers electric-proxy (`packages/electric-proxy`).

## What's here

- `docker-compose.yml` — `postgres` (16-bookworm, `wal_level=logical`) +
  `electric` (electricsql/electric 1.7.1).
- `initdb/001_smithers_min.sql` — minimal `_smithers_runs` + `_smithers_events`
  DDL, mounted into Postgres' `/docker-entrypoint-initdb.d` so the schema exists
  on first boot.
- `smoke.ts` — throwaway bun script that drives the smithers proxy against this
  real Electric and prints status + body.

## Bring it up / tear it down

```sh
# up (use a -p project name so concurrent runs don't collide)
docker compose -f deploy/electric/docker-compose.yml -p smithers-electric-test up -d

# tear down + drop the volume (so initdb re-runs next time)
docker compose -f deploy/electric/docker-compose.yml -p smithers-electric-test down -v
```

## Env vars / ports

| Var                     | Default | Meaning                                   |
| ----------------------- | ------- | ----------------------------------------- |
| `SMITHERS_PG_PORT`      | `54329` | host port for Postgres (container `5432`) |
| `SMITHERS_ELECTRIC_PORT`| `30001` | host port for Electric HTTP (container `3000`) |

Fixed Postgres credentials (fixture only): user `smithers`, password
`smithers_pw`, db `smithers`.

## wal_level=logical / publication requirement (design §5.3, §11 item 7)

Electric streams changes via Postgres **logical replication**, so Postgres MUST
run with `wal_level=logical` (plus enough `max_wal_senders` /
`max_replication_slots`). The compose `command:` sets these. Electric then
creates and manages **its own publication and replication slot** at startup
against the `DATABASE_URL` you give it; you do not pre-create them. PGlite (the
local-dev store) cannot be an Electric source for this reason — Electric needs a
real Postgres WAL.

## Opening a shape directly (Electric 1.7 HTTP API)

```sh
# initial snapshot of a table; offset=-1 means "from the beginning"
curl -i 'http://localhost:30001/v1/shape?table=_smithers_runs&offset=-1'
```

Electric returns the rows as a JSON array of change messages and sets
`electric-handle` + `electric-offset` response headers used for follow-up
live-tail requests (`&handle=<h>&offset=<o>&live`).

## Opening the same shape through the smithers proxy

`smoke.ts` configures `createSmithersElectricProxy` with
`electricUrl: 'http://localhost:30001/v1/shape'` and an `authenticate` that
returns granted run ids; the proxy fills the `runs` shape's
`run_id IN ({run_ids})` where-template from those grants and forwards to real
Electric. Run it with `bun deploy/electric/smoke.ts`.
