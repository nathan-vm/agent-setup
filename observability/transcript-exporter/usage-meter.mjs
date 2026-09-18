// Mede o consumo nas janelas que a Anthropic realmente usa para limitar.
//
// POR QUE ISSO EXISTE
// As gauges antes usavam janela móvel (`sum_over_time[5h]`), o que é outra coisa
// do que a Anthropic mede e dava número errado contra o `/usage`:
//
//   - O limite de 5h é um BLOCO: abre na primeira mensagem, expira 5h depois, e
//     o próximo bloco só abre na mensagem seguinte. Uma janela móvel de 5h soma
//     o fim do bloco anterior com o começo do atual.
//   - O limite semanal reseta num dia fixo. Uma janela móvel de 7 dias arrasta
//     consumo da semana passada.
//
// Achar a borda do bloco exige varrer a atividade procurando o intervalo em que
// o bloco anterior expirou — o LogQL não faz isso. Então quem calcula é este
// módulo, que publica o resultado de volta no Loki como uma linha por conta. As
// gauges viram uma leitura direta desse valor.
//
// O LIMITE EM SI não é exposto por telemetria nenhuma. As referências no
// dashboard foram calibradas comparando estes números com um `/usage` real.

const BLOCK_MS = 5 * 3600 * 1000;
const STREAM = 'claude-code-usage';
// Tokens que contam para o limite: entrada + saída + criação de cache. Leitura
// de cache fica fora — é ~97% do volume bruto e não é consumo novo.
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_tokens'];

function apiSelector(emailPattern) {
  return '{service_name="claude-code"} | event_name = `api_request`'
    + (emailPattern ? ` | user_email =~ \`${emailPattern}\`` : '');
}

function escapeRegex(value) {
  return value.replace(/[.+*?()|[\]{}\\^$]/g, '\\$&');
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
  // "or vector(0)" vai em CADA termo, não na soma.
  //
  // `unwrap` descarta a linha que não tem o campo, então um termo pode voltar
  // como vetor vazio. Em LogQL, A + B + C com qualquer operando vazio resulta
  // vazio — e um "or vector(0)" no fim zerava o TOTAL, mesmo com entrada e saída
  // cheias. A gauge de limite mostraria 0% para quem gastou de verdade, que é o
  // pior jeito possível de um medidor de limite falhar.
  const expr = TOKEN_FIELDS
    .map((field) => `(sum(sum_over_time(${selector} | unwrap ${field} [${seconds}s])) or vector(0))`)
    .join(' + ');
  const result = await lokiGet(lokiUrl, '/loki/api/v1/query', {
    query: expr,
    time: Math.round(nowMs / 1000),
  });
  return Number(result[0]?.value?.[1] ?? 0);
}

// Blocos de 5h se sucedem: um abre na primeira mensagem depois que o anterior
// expirou. Devolve o início do bloco ATIVO, ou null se nenhum está ativo (aí o
// consumo do bloco corrente é zero, não o resto do último bloco).
function currentBlockStart(activityMs, nowMs) {
  let start = null;
  for (const timestamp of activityMs) {
    if (start === null || timestamp >= start + BLOCK_MS) start = timestamp;
  }
  if (start === null || nowMs >= start + BLOCK_MS) return null;
  return start;
}

// Início da semana corrente: dia da semana e hora configuráveis, no fuso dado.
// A Anthropic reseta o limite semanal num dia fixo; qual é varia por conta, por
// isso é configurável em vez de fixo em segunda-feira.
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
  // 3 dias, não 10: só é preciso achar a borda do bloco de 5h ATUAL, e o
  // ladrilhamento se recorrige a cada intervalo ocioso de 5h — que sempre há em
  // 3 dias. Consultar 10 dias a cada passada era custo puro de bateria.
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
    let activity;
    let blockStart;
    let blockTokens;
    let weekTokens;
    try {
      activity = await activityTimestamps(lokiUrl, pattern, nowMs);
      blockStart = currentBlockStart(activity, nowMs);
      blockTokens = blockStart === null ? 0 : await sumTokens(lokiUrl, pattern, blockStart, nowMs);
      weekTokens = await sumTokens(lokiUrl, pattern, weekStart, nowMs);
    } catch (error) {
      // Isolado por conta: sem isto, uma conta com erro abortava o ciclo antes
      // de publicar, e TODAS as gauges ficavam obsoletas por causa de uma só.
      log(`uso de ${email} não medido nesta passada: ${error.message}`);
      continue;
    }
    values.push({
      email,
      meta: {
        block_tokens: String(Math.round(blockTokens)),
        week_tokens: String(Math.round(weekTokens)),
        // Quanto falta para o bloco expirar: é o "faltam X horas" que a gauge
        // de 5h sozinha não conta.
        block_remaining_s: String(blockStart === null ? 0 : Math.round((blockStart + BLOCK_MS - nowMs) / 1000)),
        block_elapsed_s: String(blockStart === null ? 0 : Math.round((nowMs - blockStart) / 1000)),
        week_elapsed_s: String(Math.round((nowMs - weekStart) / 1000)),
        block_active: String(blockStart !== null),
      },
    });
  }

  const payload = {
    streams: values.map(({ email, meta }) => ({
      stream: { service_name: STREAM, user_email: email },
      values: [[`${nowMs}000000`, 'usage', meta]],
    })),
  };
  if (dryRun) {
    log(`--dry-run: ${values.length} medição(ões) de uso NÃO publicadas`);
    return values.length;
  }
  const response = await fetch(new URL('/loki/api/v1/push', lokiUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    log(`medidor de uso não publicou: ${response.status} ${(await response.text()).slice(0, 160)}`);
    return 0;
  }
  return values.length;
}
