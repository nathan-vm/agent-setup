// Measures consumption over the windows Anthropic actually enforces.
//
// WHY THIS EXISTS
// The gauges used to use a rolling window (`sum_over_time[5h]`), which measures
// something different from what Anthropic does and disagreed with `/usage`:
//
//   - The 5h limit is a BLOCK: it opens on the first message, expires 5h later,
//     and the next block only opens on the following message. A rolling 5h window
//     adds the tail of one block to the head of the next.
//   - The weekly limit resets on a fixed day. A rolling 7-day window drags in
//     consumption from last week.
//
// Finding the block boundary means scanning activity for the gap where the
// previous block expired — LogQL cannot do that. So this module computes it and
// publishes the result back into Loki as one line per account. The gauges then
// become a direct read of that value.
//
// THE LIMIT ITSELF is not exposed by any telemetry. The dashboard's reference
// values were calibrated by comparing these numbers against a real `/usage`.

const BLOCK_MS = 5 * 3600 * 1000;
const STREAM = 'claude-code-usage';
// Tokens that count toward the limit: input + output + cache creation. Cache
// reads are excluded — they are ~97% of the raw volume and are not new spend.
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_tokens'];

function apiSelector(emailPattern) {
  return '{service_name="claude-code"} | event_name = `api_request`'
    + (emailPattern ? ` | user_email =~ \`${emailPattern}\`` : '');
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

async function sumTokens(lokiUrl, emailPattern, sinceMs, nowMs) {
  const seconds = Math.max(Math.round((nowMs - sinceMs) / 1000), 60);
  const selector = apiSelector(emailPattern);
  // "or vector(0)" goes on EACH term, not on the sum.
  //
  // `unwrap` drops a line that lacks the field, so a term can come back as an
  // empty vector. In LogQL, A + B + C with any empty operand is empty — and an
  // "or vector(0)" at the end zeroed the TOTAL even when input and output were
  // full. The limit gauge would read 0% for someone who actually spent, which is
  // the worst possible way for a usage meter to fail.
  const expr = TOKEN_FIELDS
    .map((field) => `(sum(sum_over_time(${selector} | unwrap ${field} [${seconds}s])) or vector(0))`)
    .join(' + ');
  const result = await lokiGet(lokiUrl, '/loki/api/v1/query', {
    query: expr,
    time: Math.round(nowMs / 1000),
  });
  return Number(result[0]?.value?.[1] ?? 0);
}

// 5h blocks follow one another: a block opens on the first message after the
// previous one expired. Returns the start of the ACTIVE block, or null when none
// is active (in which case current-block consumption is zero, not the remainder
// of the last block).
function currentBlockStart(activityMs, nowMs) {
  let start = null;
  for (const timestamp of activityMs) {
    if (start === null || timestamp >= start + BLOCK_MS) start = timestamp;
  }
  if (start === null || nowMs >= start + BLOCK_MS) return null;
  return start;
}

// Start of the current week: weekday and hour are configurable, in the given
// timezone offset. Anthropic resets the weekly limit on a fixed day; which day
// varies per account, hence configurable rather than hardcoded to Monday.
function currentWeekStart(nowMs, { weekStartDay, weekStartHour, tzOffsetHours }) {
  const offsetMs = tzOffsetHours * 3600 * 1000;
  const local = new Date(nowMs + offsetMs);
  const localMidnight = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), weekStartHour,
  );
  let start = localMidnight - offsetMs;
  const daysSince = (local.getUTCDay() - weekStartDay + 7) % 7;
  start -= daysSince * 24 * 3600 * 1000;
  if (start > nowMs) start -= 7 * 24 * 3600 * 1000;
  return start;
}

async function accountsWithData(lokiUrl, nowMs) {
  const result = await lokiGet(lokiUrl, '/loki/api/v1/query', {
    query: `sum by (user_email) (count_over_time(${apiSelector(null)} [7d]))`,
    time: Math.round(nowMs / 1000),
  });
  return result.map((series) => series.metric?.user_email).filter(Boolean);
}

async function activityTimestamps(lokiUrl, emailPattern, nowMs) {
  // 3 days, not 10: all we need is the boundary of the CURRENT 5h block, and the
  // tiling self-corrects at every 5h idle gap — of which there is always one in
  // 3 days. Querying 10 days on every pass was pure battery cost.
  const result = await lokiGet(lokiUrl, '/loki/api/v1/query_range', {
    query: `sum(count_over_time(${apiSelector(emailPattern)} [5m]))`,
    start: Math.round(nowMs / 1000) - 3 * 24 * 3600,
    end: Math.round(nowMs / 1000),
    step: 300,
  });
  return (result[0]?.values ?? [])
    .filter(([, value]) => Number(value) > 0)
    .map(([timestamp]) => Math.round(Number(timestamp) * 1000));
}

export async function publishUsage({ lokiUrl, weekStartDay, weekStartHour, tzOffsetHours, log, dryRun = false }) {
  const nowMs = Date.now();
  const emails = await accountsWithData(lokiUrl, nowMs);
  if (!emails.length) return 0;

  const weekStart = currentWeekStart(nowMs, { weekStartDay, weekStartHour, tzOffsetHours });
  const values = [];

  for (const email of emails) {
    const pattern = escapeRegex(email);
    let blockStart;
    let blockTokens;
    let weekTokens;
    try {
      const activity = await activityTimestamps(lokiUrl, pattern, nowMs);
      blockStart = currentBlockStart(activity, nowMs);
      blockTokens = blockStart === null ? 0 : await sumTokens(lokiUrl, pattern, blockStart, nowMs);
      weekTokens = await sumTokens(lokiUrl, pattern, weekStart, nowMs);
    } catch (error) {
      // Isolated per account: without this, one failing account aborted the cycle
      // before publishing and EVERY gauge went stale because of a single one.
      log(`usage for ${email} not measured this pass: ${error.message}`);
      continue;
    }
    values.push({
      email,
      meta: {
        block_tokens: String(Math.round(blockTokens)),
        week_tokens: String(Math.round(weekTokens)),
        // How long until the block expires: this is the "X hours left" that the
        // 5h gauge alone cannot tell you.
        block_remaining_s: String(blockStart === null ? 0 : Math.round((blockStart + BLOCK_MS - nowMs) / 1000)),
        block_elapsed_s: String(blockStart === null ? 0 : Math.round((nowMs - blockStart) / 1000)),
        week_elapsed_s: String(Math.round((nowMs - weekStart) / 1000)),
        block_active: String(blockStart !== null),
      },
    });
  }

  if (dryRun) {
    log(`--dry-run: ${values.length} usage measurement(s) NOT published`);
    return values.length;
  }
  const payload = {
    streams: values.map(({ email, meta }) => ({
      stream: { service_name: STREAM, user_email: email },
      values: [[`${nowMs}000000`, 'usage', meta]],
    })),
  };
  const response = await fetch(new URL('/loki/api/v1/push', lokiUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    log(`usage meter did not publish: ${response.status} ${(await response.text()).slice(0, 160)}`);
    return 0;
  }
  return values.length;
}
