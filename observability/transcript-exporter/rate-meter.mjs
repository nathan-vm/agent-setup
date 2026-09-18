// Publishes the smoothed consumption rate (tokens/hour) per account.
//
// WHY THIS EXISTS
// The rate panel used to compute `sum_over_time(tokens[15m]) * 4` directly in
// LogQL. That is a boxcar: a burst enters the window and the value jumps, then it
// sits flat until the burst slides out and the value falls off a cliff. Measured
// on real data, the curve dropped 30x in a single 5-minute step when a session
// stopped, and peaks towered ~10x over the P75 cutline — so the line sat squashed
// at the floor of the chart and crossing it meant nothing.
//
// What the panel is for is reading speed: "right now I am fast" or "right now I am
// slow", so a human can judge whether that speed is warranted (a session firing
// many tools, or an agent that quietly spawned 30 subagents). That needs inertia:
// stopping should decelerate the curve, not teleport it to zero.
//
// So the rate is an exponentially weighted moving average. LogQL has no EWMA,
// which is why it is computed here and published back into Loki.
//
// The half-life is part of the STREAM LABELS on purpose. Loki cannot replace
// derived data, so changing the half-life would otherwise mix two different maths
// in one series; with it as a label, a new value simply starts a new stream and
// the old one ages out with retention.

const STREAM = 'claude-code-rate';
const BUCKET_S = 300;
// Same definition of "new tokens" used by the gauges and the limit references.
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_tokens'];

function apiSelector(emailPattern) {
  return '{service_name="claude-code"} | event_name = `api_request` '
    + `| user_email =~ \`${emailPattern}\``;
}

function escapeRegex(value) {
  return value.replace(/[.+*?()|[\]{}\\^$`]/g, '\\$&');
}

async function lokiGet(lokiUrl, path, params) {
  const url = new URL(path, lokiUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Loki ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Loki status=${body.status}`);
  return body.data?.result ?? [];
}

// Buckets of BUCKET_S seconds, as tokens/hour. `or vector(0)` on each term is
// required twice over: it fills idle buckets with a real zero (so the EWMA decays
// instead of skipping), and it keeps one field with no samples from emptying the
// whole sum, which is how LogQL treats A + B + C.
async function rateBuckets(lokiUrl, emailPattern, fields, startS, endS) {
  const selector = apiSelector(emailPattern);
  const expr = fields
    .map((field) => `(sum(sum_over_time(${selector} | unwrap ${field} [${BUCKET_S}s])) or vector(0))`)
    .join(' + ');
  const result = await lokiGet(lokiUrl, '/loki/api/v1/query_range', {
    query: expr, start: startS, end: endS, step: BUCKET_S,
  });
  const perHour = 3600 / BUCKET_S;
  return (result[0]?.values ?? []).map(([ts, value]) => [
    Math.round(Number(ts)), Number(value) * perHour,
  ]);
}

// Loki caps a range query's point count, so long backfills are fetched a day at a
// time and stitched back together in order.
async function rateBucketsOver(lokiUrl, emailPattern, fields, fromS, toS) {
  const out = [];
  const DAY = 24 * 3600;
  for (let start = fromS; start < toS; start += DAY) {
    out.push(...await rateBuckets(lokiUrl, emailPattern, fields, start, Math.min(start + DAY, toS)));
  }
  return out;
}

function ewma(points, halfLifeS) {
  const alpha = 1 - Math.exp((-Math.LN2 * BUCKET_S) / halfLifeS);
  let value = 0;
  return points.map(([ts, raw]) => {
    value = alpha * raw + (1 - alpha) * value;
    return [ts, value];
  });
}

// Published points are aligned to the bucket grid and never re-published: the
// state remembers the last timestamp written per account, so a restart does not
// duplicate a series that Loki cannot deduplicate on its own.
export async function publishRate({ lokiUrl, halfLifeS, halfLifeLabel, backfillDays, state, log, dryRun = false }) {
  const nowS = Math.floor(Date.now() / 1000);
  const label = halfLifeLabel;
  const accounts = await lokiGet(lokiUrl, '/loki/api/v1/query', {
    query: 'sum by (user_email) (count_over_time({service_name="claude-code"} '
      + '| event_name = `api_request` [7d]))',
    time: nowS,
  });
  const emails = accounts.map((series) => series.metric?.user_email).filter(Boolean);
  if (!emails.length) return 0;

  state.ratePublished ??= {};
  const streams = [];

  for (const email of emails) {
    const key = `${label}:${email}`;
    const last = state.ratePublished[key] ?? 0;
    // Warm-up matters: an EWMA started cold reads far too low for its first
    // half-lives. Always recompute from well before the first point to publish.
    const warmup = Math.max(6 * 3600, halfLifeS * 8);
    const from = last ? last - warmup : nowS - backfillDays * 24 * 3600;
    const pattern = escapeRegex(email);
    let total; let input; let output;
    try {
      [total, input, output] = await Promise.all([
        rateBucketsOver(lokiUrl, pattern, TOKEN_FIELDS, from, nowS),
        rateBucketsOver(lokiUrl, pattern, ['input_tokens'], from, nowS),
        rateBucketsOver(lokiUrl, pattern, ['output_tokens'], from, nowS),
      ]);
    } catch (error) {
      // Isolated per account, for the same reason as the usage meter: one failing
      // account must not keep every other account's rate from being published.
      log(`rate for ${email} not measured this pass: ${error.message}`);
      continue;
    }
    const smoothTotal = ewma(total, halfLifeS);
    const byTs = {
      input: new Map(ewma(input, halfLifeS)),
      output: new Map(ewma(output, halfLifeS)),
    };
    const fresh = smoothTotal.filter(([ts]) => ts > last);
    if (!fresh.length) continue;

    streams.push({
      stream: { service_name: STREAM, user_email: email, halflife: label },
      values: fresh.map(([ts, value]) => [`${ts}000000000`, 'rate', {
        rate: String(Math.round(value)),
        rate_input: String(Math.round(byTs.input.get(ts) ?? 0)),
        rate_output: String(Math.round(byTs.output.get(ts) ?? 0)),
      }]),
    });
    if (!dryRun) state.ratePublished[key] = fresh[fresh.length - 1][0];
    if (!last) log(`rate: backfilled ${fresh.length} point(s) for ${email}`);
  }

  if (!streams.length) return 0;
  if (dryRun) {
    const n = streams.reduce((sum, s) => sum + s.values.length, 0);
    log(`--dry-run: ${n} rate point(s) NOT published`);
    return n;
  }
  const response = await fetch(new URL('/loki/api/v1/push', lokiUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streams }),
  });
  if (!response.ok) {
    log(`rate meter did not publish: ${response.status} ${(await response.text()).slice(0, 160)}`);
    return 0;
  }
  return streams.reduce((sum, s) => sum + s.values.length, 0);
}
