interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * US drug price benchmarks — what a pharmacy PAYS and what Medicare PAYS OUT.
 *
 * Two different numbers that get confused for each other, and the pack's main
 * job is keeping them apart (fleet #618):
 *
 *   NADAC  National Average Drug Acquisition Cost. A survey of what retail
 *          pharmacies actually PAY wholesalers. Published weekly by CMS on
 *          data.medicaid.gov. Per unit, and the unit matters — EA/ML/GM.
 *   ASP    The Medicare Part B payment LIMIT: what Medicare pays a provider for
 *          a drug administered in a clinic. Quarterly, per HCPCS J-code, and by
 *          statute 106% of manufacturer-reported Average Sales Price.
 *
 * A generic tablet has a NADAC and no ASP; an infused oncology drug has an ASP
 * and usually no retail NADAC. Asking for the "price of Keytruda" means the ASP
 * limit; asking for the "price of atorvastatin" means NADAC. Every answer names
 * which benchmark it is and what vintage it carries.
 *
 * WHY THE TWO SOURCES ARE PLUMBED DIFFERENTLY. NADAC sits behind a real query
 * API (filter, sort, paginate) so it is read LIVE — no mirror to go stale, and
 * history is in the same dataset. ASP has no API whatsoever: CMS publishes one
 * ZIP per quarter containing .xls files and a "section 508 version" .csv, so it
 * is ingested into `asp_payment_limits` by scripts/ingest-asp-payment-limits.mjs
 * and read from Supabase here.
 *
 * TRAPS, all of them measured against the live sources:
 *
 * - THE DATASTORE API SILENTLY IGNORES UNKNOWN PARAMETERS. `?sort=-effective_date`
 *   returns HTTP 200 and UNSORTED rows, identical to `?zzznonsense=x`. The
 *   correct spelling is `sorts[0][property]` + `sorts[0][order]`. Getting this
 *   wrong does not fail — it quietly answers with an arbitrary week's price.
 * - THE NADAC DATASET ID ROTATES EVERY YEAR, and the year in its TITLE is not
 *   the range it covers: the dataset called "NADAC ... 2026" holds effective
 *   dates from 2025-01-01 to 2026-08-26. The id is resolved by title at call
 *   time rather than hardcoded, so January does not break this pack.
 * - NADAC CARRIES TWO DATES. `effective_date` is the week the price applies to;
 *   `as_of_date` is when CMS published it. The price answer is keyed on
 *   effective_date, and both are returned.
 * - ONE NDC HAS MANY WEEKS. A name search matches thousands of rows across every
 *   week in the dataset, so an unsorted query returns a real price from an
 *   arbitrary past week. Everything here resolves the LATEST effective_date
 *   first and queries that week.
 * - THE ASP PAYMENT LIMIT'S VINTAGE IS NOT ITS QUARTER. The CMS file says so
 *   itself — the file effective 2026-07-01 is "based on 1Q26 ASP data". The
 *   limit in force is derived from ASP data two quarters earlier, so comparing
 *   it against this week's NADAC is a six-month-wide comparison. Both quarters
 *   are always returned.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'US drug price benchmarks');
}

import { ENTITY_TYPES, resolveTypes, resolveState } from './b340.js';

const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const MEDICAID = 'https://data.medicaid.gov/api/1';
// Fallback only. Resolution is by title (see resolveNadacDataset) because the id
// changes every January; this is the last id verified by hand, so a metastore
// outage degrades to a stale-but-working lookup rather than a dead tool.
const NADAC_FALLBACK_ID = 'fbb83258-11c7-47f5-8b18-5f8e79f7e704';

const tools: McpToolExport['tools'] = [
  {
    name: 'nadac_price',
    description:
      'What a US retail pharmacy actually PAYS to acquire a drug — the National Average Drug Acquisition Cost (NADAC), surveyed and published weekly by CMS. Look up by drug name ("atorvastatin 20 mg", "Eliquis", "insulin glargine") or by NDC. NAME MATCHING IS LITERAL: NADAC lists brand products under their BRAND name and generics under the ingredient name, so "Eliquis" finds rows where "apixaban" finds none — if one returns nothing, try the other. Returns the most recent weekly price per NDC with its pricing unit (EA/ML/GM), brand-or-generic classification, and the week the price applies to. This is the ACQUISITION cost, not a retail price, not an insurance copay, and not what Medicare pays a clinic — for a drug given in a doctor\'s office or infusion centre see asp_payment_limit. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: 'Drug name or fragment, e.g. "atorvastatin 20 mg", "apixaban", "albuterol". Matched against the NDC description. Give either this or `ndc`.' },
        ndc: { type: 'string', description: 'National Drug Code. Any common format accepted — 11-digit "00093505610", dashed 5-4-2 "00093-5056-10", or 10-digit; it is normalised to the canonical 11-digit form.' },
        as_of: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Returns the pricing week in effect on that date instead of the newest. Use for "what did this cost in March".' },
        limit: { type: 'number', description: 'Max NDCs to return, 1–100 (default 20).' },
      },
    },
  },
  {
    name: 'nadac_history',
    description:
      'Weekly price history for one drug NDC — how the pharmacy acquisition cost (NADAC) moved over time. Use for "has the price of this generic gone up", shortage-driven price spikes, or generic erosion after a patent expiry. Returns one row per published week, oldest to newest, with the pricing unit and the percentage change across the window. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        ndc: { type: 'string', description: 'National Drug Code in any common format (11-digit, dashed 5-4-2, or 10-digit).' },
        weeks: { type: 'number', description: 'How many recent weekly observations to return, 1–260 (default 26).' },
      },
      required: ['ndc'],
    },
  },
  {
    name: 'asp_payment_limit',
    description:
      'What Medicare Part B PAYS for a drug administered by a provider — the quarterly ASP payment limit, set by statute at 106% of the manufacturer-reported Average Sales Price. Look up by HCPCS J-code ("J9271") or drug name ("pembrolizumab", "Keytruda"). This is the clinic/infusion benchmark: oncology drugs, biologics, injectables and vaccines. Returns the limit per its dosage unit, the quarter it is in force, AND the earlier quarter of ASP data it was derived from — those differ by two quarters and the gap matters. For retail pharmacy acquisition cost use nadac_price instead. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        hcpcs: { type: 'string', description: 'HCPCS code, e.g. "J9271" (pembrolizumab), "J0178" (aflibercept), "90632".' },
        drug: { type: 'string', description: 'Drug name or fragment matched against the short description, e.g. "pembrolizumab", "rituximab". Give either this or `hcpcs`.' },
        quarter: { type: 'string', description: 'Optional quarter as a date in it, or "YYYY-Qn" (e.g. "2026-Q1", "2026-01-01"). Defaults to the most recent quarter loaded.' },
        limit: { type: 'number', description: 'Max codes to return when searching by name, 1–100 (default 20).' },
      },
    },
  },
  {
    name: 'drug_price_compare',
    description:
      'Put the two US drug price benchmarks side by side for one drug — what a pharmacy pays to acquire it (NADAC, weekly) against what Medicare Part B pays a provider for it (ASP limit, quarterly). Use to see the spread between acquisition cost and reimbursement, or to check whether a drug is a retail or a clinic-administered product at all. States the vintage of each number and warns when they are measured months apart, because the ASP limit in force is derived from ASP data two quarters earlier. Returns whichever benchmarks exist — many drugs legitimately have only one. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: 'Drug name, e.g. "pembrolizumab", "atorvastatin", "rituximab".' },
        ndc: { type: 'string', description: 'Optional NDC to pin the NADAC side to one product.' },
      },
      required: ['drug'],
    },
  },
  {
    name: 'b340_covered_entities',
    description:
      'Find 340B drug pricing program covered entities registered with HRSA: hospitals, community health centers, Ryan White HIV clinics, family planning and STD grantees. Filter by state, entity type or name and get the 340B ID, registration start date, parent hospital, Medicare CCN, NPI numbers and how many contract pharmacies each one uses. Answers which providers can buy drugs at 340B ceiling prices in a given state, whether a named hospital participates, and when it joined.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Two-letter state or territory code, or a full state name ("TX" or "Texas").' },
        type: {
          type: 'string',
          description:
            'Entity type. Plain words work ("hospital", "health center", "Ryan White", "critical access", "homeless"), as do HRSA codes ("DSH", "CAH", "CH").',
        },
        name: { type: 'string', description: 'Match part of the entity or subsidiary name, e.g. "Cleveland Clinic".' },
        id340b: { type: 'string', description: 'Exact 340B ID, e.g. "DSH340075H".' },
        include_terminated: {
          type: 'boolean',
          description: 'Include entities no longer participating. Default false — 29,950 of 94,363 records are terminated registrations.',
        },
        limit: { type: 'number', description: 'Max rows, default 25, max 200.' },
      },
    },
  },
  {
    name: 'b340_contract_pharmacies',
    description:
      'List the contract pharmacies a 340B covered entity dispenses through, or work backwards from a pharmacy chain to the covered entities it serves. Returns pharmacy name, city, state, contract begin date and termination date. Answers how large a hospital 340B pharmacy network is, which chains a health center contracts with, and how many 340B relationships a chain like Walgreens or CVS holds in a state.',
    inputSchema: {
      type: 'object',
      properties: {
        id340b: { type: 'string', description: 'The covered entity, e.g. "DSH340075H". Give this or `pharmacy`.' },
        pharmacy: { type: 'string', description: 'Match part of a pharmacy name, e.g. "Walgreens". Give this or `id340b`.' },
        state: { type: 'string', description: 'Restrict to pharmacies in this state ("TX" or "Texas").' },
        include_terminated: { type: 'boolean', description: 'Include contracts whose termination date has passed. Default false.' },
        limit: { type: 'number', description: 'Max rows, default 25, max 200.' },
      },
    },
  },
];

// ---- helpers -------------------------------------------------------------

const clamp = (v: unknown, def: number, max: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;
};

/**
 * Canonical 11-digit NDC.
 *
 * NDCs travel in three shapes and they are NOT interchangeable as strings: the
 * dashed 5-4-2 "00093-5056-10", the 11-digit "00093505610", and 10-digit
 * variants that omit a leading zero from one of the three segments. A lookup
 * that compares raw strings misses the same product written another way and
 * returns a confident "no price found".
 */
function normalizeNdc(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{11}$/.test(s.replace(/\D/g, '')) && !s.includes('-')) return s.replace(/\D/g, '');
  const parts = s.split('-');
  if (parts.length === 3) {
    const [a, b, c] = parts;
    // 4-4-2, 5-3-2 and 5-4-1 all pad to 5-4-2.
    return `${a.padStart(5, '0')}${b.padStart(4, '0')}${c.padStart(2, '0')}`;
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 11) return digits;
  if (digits.length === 10) return `0${digits}`;
  return null;
}

async function getJson(url: string): Promise<any> {
  const res = await pwFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { throw new Error(`non-JSON from upstream: ${body.slice(0, 200)}`); }
}

/**
 * Find the current NADAC dataset id by TITLE.
 *
 * CMS publishes a new dataset per year with a fresh uuid, so a hardcoded id
 * dies every January. The title carries the year, so the newest one is
 * discoverable — and the discovery is the freshness check: if no NADAC dataset
 * is found at all, that is loud rather than an empty price list.
 */
let cachedDataset: { id: string; title: string; at: number } | null = null;
async function resolveNadacDataset(): Promise<{ id: string; title: string; resolved: 'by_title' | 'fallback' }> {
  if (cachedDataset && Date.now() - cachedDataset.at < 3_600_000) {
    return { id: cachedDataset.id, title: cachedDataset.title, resolved: 'by_title' };
  }
  try {
    const items = await getJson(`${MEDICAID}/metastore/schemas/dataset/items?show-reference-ids=false`);
    const nadac = (Array.isArray(items) ? items : [])
      .map((d: any) => ({ id: d.identifier, title: String(d.title ?? ''), year: Number((String(d.title ?? '').match(/\b(20\d{2})\b/) || [])[1]) }))
      // "First Time NADAC Rates" and "NADAC Comparison" are different products.
      .filter((d: any) => /^NADAC \(National Average Drug Acquisition Cost\)/i.test(d.title) && d.year)
      .sort((a: any, b: any) => b.year - a.year);
    if (nadac.length) {
      cachedDataset = { id: nadac[0].id, title: nadac[0].title, at: Date.now() };
      return { id: nadac[0].id, title: nadac[0].title, resolved: 'by_title' };
    }
  } catch { /* fall through */ }
  return { id: NADAC_FALLBACK_ID, title: 'NADAC (fallback id)', resolved: 'fallback' };
}

/** Datastore query. `sorts[n][...]` is the ONLY spelling that sorts — see header. */
async function nadacQuery(id: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return getJson(`${MEDICAID}/datastore/query/${id}/0?${qs}`);
}

// NOTE: there is deliberately no "latest week overall" helper.
//
// The obvious design — find max(effective_date), then filter that week — is
// WRONG here and fails silently. NADAC publishes a full weekly file plus tiny
// off-cycle correction files carrying a handful of NDCs, and they share the same
// effective_date column. Measured 2026-08-28:
//     2026-08-26 ->     77 rows   (a correction)
//     2026-08-19 -> 58,163 rows   (the real week)
//     2026-08-12 ->      6 rows   (a correction)
// So max(effective_date) lands on a 77-row file, and every drug not in it comes
// back "no price found" — indistinguishable from a drug NADAC does not cover.
// Instead: filter for the drug FIRST, sort by effective_date desc, and take the
// newest date present IN THE MATCHED SET.

const money = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const CLASSIFICATION: Record<string, string> = { G: 'generic', B: 'brand', 'B/G': 'brand and generic' };

function compactNadac(r: any) {
  return {
    ndc: r.ndc ?? null,
    description: r.ndc_description ?? null,
    nadac_per_unit: money(r.nadac_per_unit),
    // Without the unit the number is meaningless: 0.026 per EA (a tablet) and
    // 0.026 per ML are different products at different prices.
    pricing_unit: r.pricing_unit ?? null,
    classification: CLASSIFICATION[String(r.classification_for_rate_setting ?? '')] ?? r.classification_for_rate_setting ?? null,
    otc: r.otc === 'Y' ? true : r.otc === 'N' ? false : null,
    // effective_date is the week the price APPLIES to; as_of_date is when CMS
    // published it. They differ, and the first is the one that matters.
    effective_date: r.effective_date ?? null,
    published_as_of: r.as_of_date ?? null,
    corresponding_generic_per_unit: money(r.corresponding_generic_drug_nadac_per_unit),
    pharmacy_type: r.pharmacy_type_indicator ?? null,
  };
}

// ---- tools ---------------------------------------------------------------

async function nadacPrice(args: Record<string, unknown>) {
  const limit = clamp(args.limit, 20, 100);
  const asOf = typeof args.as_of === 'string' && /^\d{4}-\d{2}-\d{2}/.test(args.as_of) ? args.as_of : null;
  const rawNdc = typeof args.ndc === 'string' ? args.ndc : '';
  const drug = typeof args.drug === 'string' ? args.drug.trim() : '';
  if (!rawNdc && !drug) return { error: 'provide `drug` (a name) or `ndc`' };

  const ds = await resolveNadacDataset();
  const p: Record<string, string> = {
    // Over-fetch: one NDC has many weeks, so `limit` results would all be the
    // same product. Pull a deep sorted slice and reduce to the newest week here.
    limit: '500',
    'sorts[0][property]': 'effective_date',
    'sorts[0][order]': 'desc',
  };
  let i = 0;
  if (rawNdc) {
    const ndc = normalizeNdc(rawNdc);
    if (!ndc) return { error: `could not parse "${rawNdc}" as an NDC; expected 11-digit, dashed 5-4-2, or 10-digit` };
    p[`conditions[${i}][property]`] = 'ndc';
    p[`conditions[${i}][operator]`] = '=';
    p[`conditions[${i}][value]`] = ndc;
    i++;
  } else {
    p[`conditions[${i}][property]`] = 'ndc_description';
    p[`conditions[${i}][operator]`] = 'contains';
    p[`conditions[${i}][value]`] = drug.toUpperCase();
    i++;
  }
  if (asOf) {
    p[`conditions[${i}][property]`] = 'effective_date';
    p[`conditions[${i}][operator]`] = '<=';
    p[`conditions[${i}][value]`] = asOf;
  }

  const r = await nadacQuery(ds.id, p);
  const all = (r?.results ?? []).map(compactNadac);
  if (!all.length) {
    return {
      benchmark: 'NADAC — National Average Drug Acquisition Cost (what a retail pharmacy pays a wholesaler)',
      source: 'CMS, data.medicaid.gov, published weekly',
      dataset: ds.title,
      count: 0,
      // Do NOT assert a reason here. The obvious explanation — "not a retail
      // drug" — is wrong for the single most common cause, which is that NADAC
      // names BRAND products by their BRAND: "APIXABAN" matches 0 rows while
      // "ELIQUIS" matches 204. Stating the clinic-administered reason as fact
      // would be a confident wrong answer about a drug that is right there.
      note:
        `Nothing matched ${rawNdc ? `NDC ${rawNdc}` : `"${drug}"`} anywhere in "${ds.title}". ` +
        (rawNdc
          ? 'Check the NDC — NADAC covers retail outpatient products only, so a clinic-administered drug will not appear.'
          : 'Two common reasons, in order of likelihood: (1) NADAC lists BRAND products under their BRAND name and generics under the ingredient name, so searching "apixaban" returns nothing while "Eliquis" returns 204 rows — try the other name; (2) the drug is clinic-administered (most oncology and infused biologics), which have no retail NADAC and are priced by asp_payment_limit instead.'),
      searched_for: rawNdc ? normalizeNdc(rawNdc) : drug.toUpperCase(),
      prices: [],
    };
  }

  // Newest week present FOR THIS DRUG, not the newest week in the dataset.
  const week = all.reduce((m: string, x: any) => (x.effective_date > m ? x.effective_date : m), all[0].effective_date);
  const inWeek = all.filter((x: any) => x.effective_date === week);
  // One NDC can appear twice in a week across pharmacy types; keep one each.
  const seen = new Set<string>();
  const rows = inWeek.filter((x: any) => (seen.has(x.ndc) ? false : (seen.add(x.ndc), true))).slice(0, limit);

  return {
    benchmark: 'NADAC — National Average Drug Acquisition Cost (what a retail pharmacy pays a wholesaler)',
    source: 'CMS, data.medicaid.gov, published weekly',
    dataset: ds.title,
    pricing_week: week,
    ...(asOf ? { as_of_requested: asOf } : {}),
    distinct_ndcs_this_week: seen.size,
    count: rows.length,
    prices: rows,
    // Measured (fleet #2324): nadac_price is the #6 single-tool entry point
    // in 30d, 46 distinct external callers who stop after one week's price
    // and never ask whether that price moved. nadac_history is the same
    // dataset, keyed by ndc — pre-fill from the top row this call already
    // resolved (rows[0].ndc), the same way a caller comparing prices across
    // NDCs would pick the first hit to drill into.
    ...(rows.length > 0 && rows[0].ndc
      ? {
          next: {
            tool: 'nadac_history',
            args: { ndc: rows[0].ndc },
            why: 'Weekly price history for this NDC — has it gone up, is this a shortage-driven spike, generic erosion since patent expiry.',
          },
        }
      : {}),
  };
}

async function nadacHistory(args: Record<string, unknown>) {
  const weeks = clamp(args.weeks, 26, 260);
  const ndc = normalizeNdc(String(args.ndc ?? ''));
  if (!ndc) return { error: `could not parse "${args.ndc}" as an NDC; expected 11-digit, dashed 5-4-2, or 10-digit` };
  const ds = await resolveNadacDataset();
  const r = await nadacQuery(ds.id, {
    limit: String(weeks),
    'conditions[0][property]': 'ndc',
    'conditions[0][operator]': '=',
    'conditions[0][value]': ndc,
    'sorts[0][property]': 'effective_date',
    'sorts[0][order]': 'desc',
  });
  const rows = (r?.results ?? []).map(compactNadac).sort((a: any, b: any) => String(a.effective_date).localeCompare(String(b.effective_date)));
  if (!rows.length) return { benchmark: 'NADAC', ndc, count: 0, note: `No NADAC history for NDC ${ndc} in dataset "${ds.title}". Check the NDC, or the product may be clinic-administered (see asp_payment_limit).` };
  const first = rows[0], last = rows[rows.length - 1];
  const pct = first.nadac_per_unit && last.nadac_per_unit
    ? Number((((last.nadac_per_unit - first.nadac_per_unit) / first.nadac_per_unit) * 100).toFixed(2))
    : null;
  return {
    benchmark: 'NADAC — weekly pharmacy acquisition cost',
    source: 'CMS, data.medicaid.gov',
    dataset: ds.title,
    ndc,
    description: last.description,
    pricing_unit: last.pricing_unit,
    observations: rows.length,
    window: { from: first.effective_date, to: last.effective_date },
    change_pct: pct,
    // The dataset holds a rolling ~20 months, so a 260-week request cannot be
    // satisfied and saying so beats returning a short series as if complete.
    note: rows.length < weeks ? `Returned ${rows.length} of the ${weeks} weeks requested — that is every week this NDC appears in "${ds.title}", which holds a rolling window rather than full history.` : undefined,
    history: rows.map((x: any) => ({ effective_date: x.effective_date, nadac_per_unit: x.nadac_per_unit, pricing_unit: x.pricing_unit })),
  };
}

// ---- ASP (hosted) --------------------------------------------------------

/** The gateway injects Supabase credentials INTO `args` as `_supabaseUrl` /
 *  `_supabaseKey` (see MCP_PACKS `injectSupabase: true`), not as a separate
 *  context parameter — callTool only ever receives (name, args). */
async function pg(args: Record<string, unknown>, path: string): Promise<any[]> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('backing-store credentials not injected');
  const res = await pwFetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function compactAsp(r: any) {
  return {
    hcpcs: r.hcpcs,
    description: r.short_description,
    // The limit is PER THIS DOSAGE UNIT. J9271 is $60.645 per 1 MG, so a 200 MG
    // administration is 200x — returning the limit without the unit invites a
    // 200-fold error.
    payment_limit: r.payment_limit,
    per_dosage: r.dosage,
    currency: 'USD',
    coinsurance_pct: r.coinsurance_pct,
    effective_quarter: r.effective_quarter,
    effective_through: r.effective_end,
    // Two quarters earlier than the quarter above. See the header.
    derived_from_asp_data: r.asp_data_quarter,
    not_payable_under_part_b: r.not_payable || undefined,
    notes: r.notes || undefined,
  };
}

async function aspPaymentLimit(args: Record<string, unknown>) {
  const limit = clamp(args.limit, 20, 100);
  const hcpcs = typeof args.hcpcs === 'string' ? args.hcpcs.trim().toUpperCase() : '';
  const drug = typeof args.drug === 'string' ? args.drug.trim() : '';
  if (!hcpcs && !drug) return { error: 'provide `hcpcs` (e.g. "J9271") or `drug` (e.g. "pembrolizumab")' };

  let quarter: string | null = null;
  const qArg = typeof args.quarter === 'string' ? args.quarter.trim() : '';
  if (/^\d{4}-Q[1-4]$/i.test(qArg)) {
    const [y, q] = qArg.toUpperCase().split('-Q');
    quarter = `${y}-${String((Number(q) - 1) * 3 + 1).padStart(2, '0')}-01`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(qArg)) {
    const d = new Date(`${qArg}T00:00:00Z`);
    quarter = `${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  }
  if (!quarter) {
    const newest = await pg(args, 'asp_payment_limits?select=effective_quarter&order=effective_quarter.desc&limit=1');
    quarter = newest[0]?.effective_quarter ?? null;
    if (!quarter) return { error: 'no ASP quarters loaded' };
  }

  const filter = hcpcs
    ? `hcpcs=eq.${encodeURIComponent(hcpcs)}`
    : `short_description=ilike.${encodeURIComponent(`*${drug}*`)}`;
  const rows = await pg(args, `asp_payment_limits?${filter}&effective_quarter=eq.${quarter}&select=*&order=hcpcs.asc&limit=${limit}`);

  if (!rows.length) {
    const anyQ = await pg(args, `asp_payment_limits?${filter}&select=effective_quarter&order=effective_quarter.desc&limit=4`);
    return {
      benchmark: 'Medicare Part B ASP payment limit',
      quarter, count: 0,
      note: anyQ.length
        ? `Nothing for ${hcpcs || drug} in the quarter beginning ${quarter}, but it does appear in: ${[...new Set(anyQ.map((x: any) => x.effective_quarter))].join(', ')}. Pass one of those as \`quarter\`.`
        : `${hcpcs || drug} has no Part B payment limit in any loaded quarter. Part B covers provider-administered drugs; a retail pharmacy product is priced by nadac_price instead.`,
      limits: [],
    };
  }
  return {
    benchmark: 'Medicare Part B ASP payment limit — 106% of manufacturer-reported Average Sales Price, per statute',
    source: 'CMS ASP Pricing Files (quarterly)',
    quarter_in_force: quarter,
    derived_from_asp_data: rows[0].asp_data_quarter,
    vintage_note: rows[0].asp_data_quarter
      ? `The limit in force this quarter is computed from ${rows[0].asp_data_quarter} ASP data — roughly two quarters earlier. Comparing it with a current NADAC price spans that gap.`
      : undefined,
    count: rows.length,
    limits: rows.map(compactAsp),
  };
}

async function drugPriceCompare(args: Record<string, unknown>) {
  const drug = String(args.drug ?? '').trim();
  if (!drug) return { error: 'provide `drug`' };
  const [nadac, asp] = await Promise.all([
    nadacPrice({ drug: args.ndc ? undefined : drug, ndc: args.ndc, limit: 5 }).catch((e) => ({ error: String(e.message) })),
    aspPaymentLimit({ drug, limit: 5, _supabaseUrl: args._supabaseUrl, _supabaseKey: args._supabaseKey }).catch((e) => ({ error: String(e.message) })),
  ]);
  const nRows = (nadac as any).prices ?? [];
  const aRows = (asp as any).limits ?? [];

  // Deliberately NOT arithmetic on the two numbers. NADAC is per pricing unit
  // (EA/ML/GM) and ASP is per HCPCS dosage (often 1 MG) — they are different
  // denominators, and dividing one by the other would produce a confident,
  // meaningless "margin". The comparison this returns is what each benchmark
  // says and when, and the caller can reason about the rest.
  return {
    drug,
    retail_acquisition: nRows.length
      ? { benchmark: 'NADAC', pricing_week: (nadac as any).pricing_week, examples: nRows }
      : { benchmark: 'NADAC', available: false, reason: 'no retail NDC matched — typically means the drug is clinic-administered rather than dispensed by a pharmacy' },
    medicare_part_b: aRows.length
      ? { benchmark: 'ASP payment limit', quarter_in_force: (asp as any).quarter_in_force, derived_from_asp_data: (asp as any).derived_from_asp_data, examples: aRows }
      : { benchmark: 'ASP payment limit', available: false, reason: 'no Part B payment limit — typically means the drug is dispensed at retail rather than administered by a provider' },
    comparability_note:
      nRows.length && aRows.length
        ? `Both benchmarks exist for this drug, but they are NOT directly subtractable: NADAC is per pricing unit (${nRows[0].pricing_unit}) and the ASP limit is per HCPCS dosage (${aRows[0].per_dosage}), and they are measured months apart — NADAC week ${(nadac as any).pricing_week} against ASP data from ${(asp as any).derived_from_asp_data}.`
        : 'Only one benchmark exists for this drug, which is normal: retail products have a NADAC and provider-administered products have an ASP limit.',
  };
}

/** Newest successful load. Every 340B answer carries it, because the 340B data
 *  is refreshed by a person clicking a button — "how old is this" is a real
 *  question here in a way it is not for a nightly cron. */
async function b340AsOf(args: Record<string, unknown>): Promise<{ as_of: string | null; entities: number | null }> {
  const rows = await pg(args, 'b340_ingest_runs?status=eq.ok&select=as_of,entity_rows&order=finished_at.desc&limit=1');
  return { as_of: rows[0]?.as_of ?? null, entities: rows[0]?.entity_rows ?? null };
}

const pgLike = (v: string) => encodeURIComponent(`*${v.replace(/[*,()]/g, ' ').trim()}*`);

async function b340CoveredEntities(args: Record<string, unknown>) {
  const limit = clamp(args.limit, 25, 200);
  const filters: string[] = [];

  const stateArg = typeof args.state === 'string' ? args.state : '';
  if (stateArg) {
    const st = resolveState(stateArg);
    if (!st) {
      return {
        found: false,
        reason: 'unknown_state',
        hint: `"${stateArg}" is not a US state or territory. Use a two-letter code ("TX") or a full name ("Texas").`,
      };
    }
    filters.push(`street_state=eq.${st}`);
  }

  const typeArg = typeof args.type === 'string' ? args.type : '';
  if (typeArg) {
    const codes = resolveTypes(typeArg);
    if (!codes) {
      return {
        found: false,
        reason: 'unknown_entity_type',
        hint: `"${typeArg}" is not a 340B entity type. Try "hospital", "health center", "Ryan White", "family planning", or a HRSA code.`,
        entity_types: ENTITY_TYPES,
      };
    }
    filters.push(`entity_type=in.(${codes.join(',')})`);
  }

  const nameArg = typeof args.name === 'string' ? args.name.trim() : '';
  if (nameArg) filters.push(`or=(name.ilike.${pgLike(nameArg)},sub_name.ilike.${pgLike(nameArg)})`);

  const idArg = typeof args.id340b === 'string' ? args.id340b.trim().toUpperCase() : '';
  if (idArg) filters.push(`id340b=eq.${encodeURIComponent(idArg)}`);

  if (!args.include_terminated) filters.push('participating=is.true');

  if (filters.length === 0) {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Give at least one of state, type, name or id340b. The roster is 94,363 records.',
      entity_types: ENTITY_TYPES,
    };
  }

  // Columns are named, never `select=*`. The mirror holds no contact names or
  // phone numbers, and this is the second lock on that.
  const cols =
    'id340b,entity_type,name,sub_name,participating,participating_start_date,termination_date,termination_reason,' +
    'street_city,street_state,street_zip,cms_certification_number,rural,parent_id340b,npi_numbers,contract_pharmacy_count';

  const path = `b340_covered_entity?${filters.join('&')}&select=${cols}&order=name.asc&limit=${limit}`;
  const [rows, freshness] = await Promise.all([pg(args, path), b340AsOf(args).catch(() => ({ as_of: null, entities: null }))]);

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_match',
      hint: args.include_terminated
        ? 'No covered entity matches those filters.'
        : 'No PARTICIPATING covered entity matches those filters. Roughly a third of the roster is terminated registrations — retry with include_terminated: true to see whether one existed.',
      as_of: freshness.as_of,
    };
  }

  return {
    found: true,
    count: rows.length,
    truncated: rows.length === limit,
    as_of: freshness.as_of,
    source: 'HRSA OPAIS Covered Entity Daily Export',
    entities: rows.map((r: any) => ({
      id340b: r.id340b,
      name: r.name,
      subsidiary: r.sub_name || undefined,
      entity_type: r.entity_type,
      entity_type_label: ENTITY_TYPES[r.entity_type] || r.entity_type,
      city: r.street_city,
      state: r.street_state,
      zip: r.street_zip,
      participating: r.participating,
      participating_start_date: r.participating_start_date,
      terminated: r.termination_date || undefined,
      termination_reason: r.termination_reason || undefined,
      medicare_ccn: r.cms_certification_number || undefined,
      rural: r.rural ?? undefined,
      parent_id340b: r.parent_id340b || undefined,
      npi_numbers: r.npi_numbers?.length ? r.npi_numbers : undefined,
      contract_pharmacies: r.contract_pharmacy_count,
    })),
    note:
      'A 340B ID is per SITE, so one health system holds many. `parent_id340b` links a child site to its registered parent hospital.',
  };
}

async function b340ContractPharmacies(args: Record<string, unknown>) {
  const limit = clamp(args.limit, 25, 200);
  const id = typeof args.id340b === 'string' ? args.id340b.trim().toUpperCase() : '';
  const pharmacy = typeof args.pharmacy === 'string' ? args.pharmacy.trim() : '';
  if (!id && !pharmacy) {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Give `id340b` (a covered entity, e.g. "DSH340075H") or `pharmacy` (a chain name, e.g. "Walgreens"). Use b340_covered_entities to find the id.',
    };
  }

  const filters: string[] = [];
  if (id) filters.push(`id340b=eq.${encodeURIComponent(id)}`);
  if (pharmacy) filters.push(`name=ilike.${pgLike(pharmacy)}`);

  const stateArg = typeof args.state === 'string' ? args.state : '';
  if (stateArg) {
    const st = resolveState(stateArg);
    if (!st) return { found: false, reason: 'unknown_state', hint: `"${stateArg}" is not a US state or territory.` };
    filters.push(`state=eq.${st}`);
  }

  // A contract with a termination date in the past is over. The column is
  // populated for live contracts too (a scheduled end), so filtering on
  // "termination_date is null" would drop active ones — compare to today.
  if (!args.include_terminated) {
    const today = new Date().toISOString().slice(0, 10);
    filters.push(`or=(termination_date.is.null,termination_date.gt.${today})`);
  }

  const cols = 'id340b,pharmacy_id,contract_id,name,begin_date,termination_date,city,state,zip';
  const path = `b340_contract_pharmacy?${filters.join('&')}&select=${cols}&order=name.asc&limit=${limit}`;
  const [rows, freshness] = await Promise.all([pg(args, path), b340AsOf(args).catch(() => ({ as_of: null, entities: null }))]);

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_match',
      hint: id
        ? `No active contract pharmacy is recorded for ${id}. Many covered entities use none — check the entity exists with b340_covered_entities first.`
        : `No active 340B contract pharmacy matches "${pharmacy}".`,
      as_of: freshness.as_of,
    };
  }

  return {
    found: true,
    count: rows.length,
    truncated: rows.length === limit,
    as_of: freshness.as_of,
    source: 'HRSA OPAIS Covered Entity Daily Export',
    contracts: rows.map((r: any) => ({
      id340b: r.id340b,
      pharmacy: r.name,
      pharmacy_id: r.pharmacy_id,
      contract_id: r.contract_id,
      city: r.city,
      state: r.state,
      zip: r.zip,
      begin_date: r.begin_date,
      termination_date: r.termination_date || undefined,
    })),
    note:
      'One entity can hold several contracts with the same pharmacy, so pharmacy_id repeats; contract_id is what makes a row unique.',
  };
}

const callTool: McpToolExport['callTool'] = async (name, args) => {
  switch (name) {
    case 'nadac_price': return nadacPrice(args);
    case 'nadac_history': return nadacHistory(args);
    case 'asp_payment_limit': return aspPaymentLimit(args);
    case 'drug_price_compare': return drugPriceCompare(args);
    case 'b340_covered_entities': return b340CoveredEntities(args);
    case 'b340_contract_pharmacies': return b340ContractPharmacies(args);
    default: return { error: `unknown tool: ${name}` };
  }
};

export default { tools, callTool } satisfies McpToolExport;
