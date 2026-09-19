# drug-prices

US drug price benchmarks: what a pharmacy **pays** to acquire a drug, and what
Medicare Part B **pays out** for one administered by a provider. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

These are two different numbers that are routinely confused for each other, and
keeping them apart is most of what this pack does.

| | NADAC | ASP payment limit |
|---|---|---|
| Answers | what a retail pharmacy pays a wholesaler | what Medicare pays a clinic |
| Cadence | weekly | quarterly |
| Keyed by | NDC | HCPCS (J-code) |
| Typical drug | generic tablets, retail products | oncology, biologics, infusions, vaccines |
| Source | CMS via data.medicaid.gov | CMS ASP Pricing Files (ZIP) |

A generic tablet has a NADAC and no ASP. An infused oncology drug has an ASP and
usually no retail NADAC. `drug_price_compare` reports whichever exist and says
why the other is missing, rather than returning an empty result.

## Tools

- `nadac_price(drug | ndc, as_of?, limit?)` — current acquisition cost per unit
- `nadac_history(ndc, weeks?)` — weekly price series and % change
- `asp_payment_limit(hcpcs | drug, quarter?, limit?)` — Part B limit per dosage unit
- `drug_price_compare(drug, ndc?)` — both benchmarks side by side, with vintages

## Plumbing

NADAC is read **live** — data.medicaid.gov exposes a real query API (filter,
sort, paginate) and the dataset holds ~20 months, so there is nothing to mirror.
ASP has **no API at all**: CMS publishes one ZIP per quarter, so it is ingested
into `asp_payment_limits` by `scripts/ingest-asp-payment-limits.mjs` and read
from Supabase.

```bash
node scripts/ingest-asp-payment-limits.mjs            # current quarter
node scripts/ingest-asp-payment-limits.mjs --back=5   # backfill
```

## Traps

Every one of these was hit while building the pack, and each produced a
**confident wrong answer** rather than an error.

**The newest NADAC week is usually a correction file, not a week.** NADAC
publishes the full weekly file plus tiny off-cycle corrections sharing the same
`effective_date` column. Measured 2026-08-28: `2026-08-26` → 77 rows,
`2026-08-19` → 58,163 rows, `2026-08-12` → 6 rows. The obvious design — take
`max(effective_date)`, then filter — lands on the 77-row file and reports "no
price found" for almost every drug, which is indistinguishable from a drug NADAC
does not cover. Filter for the drug **first**, then take the newest date in the
matched set.

**The datastore API silently ignores unknown parameters.** `?sort=-effective_date`
returns HTTP 200 with *unsorted* rows — byte-identical to `?zzznonsense=x`. The
only spelling that sorts is `sorts[0][property]` + `sorts[0][order]`. A typo here
does not fail; it quietly answers with an arbitrary week's price.

**The NADAC dataset id rotates every January, and the year in the title is not
the range it covers.** The dataset called "NADAC … 2026" holds effective dates
from 2025-01-01 to 2026-08-26. The id is resolved by title at call time, with the
last known id as a fallback, so January does not break the pack.

**NADAC carries two dates.** `effective_date` is the week the price applies to;
`as_of_date` is when CMS published it. Prices key on the first; both are
returned.

**The ASP payment limit's vintage is not its quarter.** The CMS file states it:
the file effective 2026-07-01 is *"based on 1Q26 ASP data"*. The limit in force
is derived from ASP data roughly two quarters earlier, so comparing it against
this week's NADAC spans about six months. Both quarters are always returned.

**The ASP CSV is windows-1252, not UTF-8**, and carries a `0xA0` inside a real
value (`"1 million\xa0PFU"`). Reading it as UTF-8 throws — and worse, `grep`
silently *aborts* on the illegal byte, which is how `J9271` first appeared to be
missing from a file that contains it.

**The ASP CSV header is not row 1** (nine rows of notes precede it, and the count
varies by quarter), and the inner filename carries a per-quarter build date
(`…File 061626.csv`). Both are matched by pattern, never by offset or literal
name. CMS is also inconsistent about a `-final-file` suffix on the ZIP, so both
spellings are tried.

**NADAC names brand products by their BRAND, not their ingredient.** `APIXABAN`
matches 0 rows; `ELIQUIS` matches 204. A generic-name search for a
still-branded drug therefore returns a confident empty, and the tempting
explanation — "must be clinic-administered" — is simply wrong for that case. The
empty-result note offers both possibilities in order of likelihood rather than
asserting one.

**NDCs travel in three shapes** — dashed 5-4-2, 11-digit, and 10-digit variants
missing a leading zero — and they are not interchangeable as strings. All are
normalised to canonical 11-digit.

**`payment_limit` is per its `dosage` unit.** J9271 is $60.645 per **1 MG**, so a
200 MG administration is 200×. Returning the limit without the unit invites a
200-fold error, so the two always travel together.

**`drug_price_compare` deliberately does no arithmetic** between the two
benchmarks. NADAC is per pricing unit (EA/ML/GM) and ASP is per HCPCS dosage —
different denominators, measured months apart. Dividing one by the other would
produce a confident, meaningless "margin".

## 340B covered entities

`b340_covered_entities` and `b340_contract_pharmacies` read a mirror of HRSA
OPAIS: **94,363 covered entity registrations** (64,413 currently participating)
and **398,441 contract-pharmacy links**, as of the 2026-09-07 export.

A 340B ID is per SITE, not per organisation — one health system holds many, and
`parent_id340b` links a child site to its registered parent hospital. Roughly a
third of the roster is terminated registrations, so both tools exclude them
unless you ask; a "no match" answer says so explicitly rather than implying the
entity never existed.

`type` takes plain words — `"hospital"`, `"health center"`, `"Ryan White"`,
`"critical access"` — as well as HRSA's 23 codes, and `state` takes `"Texas"` as
happily as `"TX"`. An unrecognised value is REFUSED with the list of valid ones
rather than silently ignored, because an ignored filter returns a full unfiltered
result set with a clean 200, which reads as a real answer.

**No contact people.** The export carries `authorizingOfficial` and
`primaryContact` — 94,363 named individuals with direct phone numbers. Neither
is ingested and there is no column for them, so no query can return one. See the
migration header.

### How it stays fresh — a person clicks a button

The 340B data here is refreshed by a human, on purpose, roughly monthly:

1. `.github/workflows/340b-refresh-reminder.yml` runs on the 1st and files a
   fleet task **only if** no load has landed in 25 days and no such ask is
   already open.
2. Someone clicks *Covered Entity Daily Export (JSON)* at
   <https://340bopais.hrsa.gov/Reports> and runs
   `bash scripts/340b-drop.sh ~/Downloads/340B_CoveredEntityJson_Daily_*.zip`.
3. `.github/workflows/340b-ingest.yml` parses, loads and closes the task.

`as_of` comes from the export FILENAME, never from the load date, so a file that
sat in a Downloads folder for a week cannot overstate freshness. The loader
refuses to swap in a roster under 50,000 entities, so a truncated download fails
loudly instead of quietly shrinking the data. Every response carries `as_of`.

### Why it is not automated

Specified in fleet #618, probed in #633: the export cannot be fetched by
anything we run.
**Re-verified 2026-09-01 (fleet #804) and 2026-09-07 (fleet #633): still true.**

HRSA OPAIS (`340bopais.hrsa.gov`) is **Blazor Server**, not client-rendered as
first recorded here. `/Reports` ships `_framework/blazor.web.js` (a .NET 8+
Blazor Web App), and the SignalR circuit endpoint is live.

**The 411 this file used to cite as proof proves nothing — do not repeat that
probe.** A bodyless `POST` to *any* path on the host answers **411 Length
Required** from the edge, including a path that does not exist. Send an empty
body with `Content-Length: 0` and the paths separate cleanly (measured
2026-09-01):

| Path | Bodyless POST | `POST -d ''` |
|---|---|---|
| `/_blazor/negotiate?negotiateVersion=1` | 411 | **200** `{"negotiateVersion":1,"connectionId":"…","connectionToken":"…","availableTransports":[WebSockets, ServerSentEvents, LongPolling]}` |
| `/DXXRDV` | 411 | 404, 0 bytes |
| `/nonexistentpath123` | 411 | 404, 0 bytes |

`/DXXRDV` is worth naming because `/Reports` loads the DevExpress Web Document
Viewer scripts, and that control normally *does* mount an HTTP controller under
that path — an inviting-looking REST door that OPAIS has not opened.

**There is no request to reproduce.** Loading `/Reports` in a browser, clearing
the network log and clicking *Covered Entity Daily Export (JSON)* records **zero
HTTP requests** — filtered on everything, and on `_blazor` specifically. The file
comes back over the WebSocket that was already open from page load, and a
WebSocket frame is not an HTTP request. HRSA's own FAQ says the same in words: no
direct download URL, and "postbacks and button clicks must be done in the context
of a current session and view state".

**Correction, measured 2026-09-07 (fleet #633, Alaric): the blocker is the
STATEFUL CIRCUIT, not the WebSocket.** This file used to say a WebSocket transport
is "why curl, a Worker and a cron all have nothing to call." That reason is wrong,
and it is wrong in the same way as the 411 it replaced — it names a symptom the
next re-prober will disprove in one command. `negotiate` advertises **three**
transports, not one: `WebSockets`, `ServerSentEvents` **and `LongPolling`**.
LongPolling is ordinary HTTP POST/GET, so a Worker *can* drive this circuit. The
reason not to is what a caller would have to do once connected: replay the Blazor
component handshake, read the button's component id out of a binary render batch,
dispatch a synthetic UI event against it, and reassemble a streamed file from
circuit frames. That is emulating a stateful UI session, and it breaks on any
component change — **silently**, returning a shrinking entity list rather than an
error. The verdict is unchanged and the evidence for it is now the right evidence:
this is not blocked on transport, it is blocked on being a scraper of a live UI.

**No mirror exists either**, re-checked 2026-09-01: the HRSA Data Warehouse
download catalogue (`data.hrsa.gov/data/download`, 452 KB of listing, 125 dataset
labels) contains the string `340b` **zero** times; the healthdata.gov Socrata
catalogue answers `?q=340B` with `resultSetSize: 1`, and that single hit is the
`data.hrsa.gov (HRSA Data Warehouse)` *link* entry, not a dataset;
`catalog.data.gov/api/3/action/package_search` 404s at the API itself;
`data.hrsa.gov/api/views.json` and the obvious bulk paths 404.

**So the answer was a human in the loop, and that is now built** (Bruce agreed to
click it monthly, 2026-09-07). 340B registrations move on quarterly cycles — the
export is nightly because it is regenerated nightly, not because the roster
churns — so a monthly click gives a real table with an honest `as_of` and no
scraper of a stateful app that would break silently on the next component
change. See "How it stays fresh" above.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "drug-prices": {
      "url": "https://gateway.pipeworx.io/drug-prices/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/drug-prices/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nadac_price \
  -H 'Content-Type: application/json' \
  -d '{"drug":"atorvastatin 20 mg"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nadac_price`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "drug-prices": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-drug-prices"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-drug-prices
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Drug Prices data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
