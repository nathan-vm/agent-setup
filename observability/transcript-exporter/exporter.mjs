#!/usr/bin/env node
// Exporta as chamadas de ferramenta dos transcripts do Claude Code para o Loki.
//
// POR QUE ISSO EXISTE
// O Claude Code redige o nome de servidores MCP configurados localmente em TODA
// a telemetria OTel: nas métricas do Prometheus `mcp_server_name` vira "custom",
// e desde a versão 2.1.x o log `tool_result` também redige `tool_name` para
// "mcp_tool". Resultado: ~85% dos tokens gastos em MCP caem num balde único e
// anônimo. Os transcripts locais (`<config>/projects/<slug>/<session>.jsonl`)
// guardam o nome real (mcp__<servidor>__<tool>), então esta é a única fonte
// possível para atribuir tokens por servidor/ferramenta MCP.
//
// O QUE ELE EMITE
// Uma linha Loki por bloco `tool_use`, no stream service_name="claude-code-tools",
// com o nome real da ferramenta e os tokens atribuídos a ela. O `request_id`
// casa 1:1 com o atributo `request_id` do evento `api_request` que o próprio
// Claude Code manda por OTel, então os dois lados são combináveis.
//
// COMO OS TOKENS SÃO ATRIBUÍDOS
// O custo de uma ferramenta é o que o modelo pagou para LER o resultado dela:
// o lado de entrada (input_tokens + cache_creation_input_tokens) da PRÓXIMA
// mensagem do assistente na mesma trilha. Com várias ferramentas em paralelo na
// mesma mensagem, esse total é dividido proporcionalmente ao tamanho de cada
// resultado. `cache_read` fica de fora de propósito: interessa o custo marginal
// da chamada, não o arrasto dela nos turnos seguintes.
//
// Uso:
//   node exporter.mjs            # roda em loop
//   node exporter.mjs --once     # uma passada e sai
//   node exporter.mjs --dry-run  # não escreve no Loki nem no estado
//   node exporter.mjs --rescan   # relê os transcripts do zero, preservando a
//                                # deduplicação (para gerar um tipo de registro
//                                # novo a partir do histórico)

import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { publishUsage } from './usage-meter.mjs';
import { join, dirname, basename } from 'node:path';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const PROJECTS_DIR = process.env.TRANSCRIPTS_DIR || join(CONFIG_DIR, 'projects');
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:47100';
const STATE_FILE = process.env.STATE_FILE || join(CONFIG_DIR, '.transcript-exporter-state.json');
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 2000);
// Um grupo pendente sem "próxima mensagem do assistente" depois disso é
// considerado órfão (sessão encerrada no meio) e sai com atribuição zero.
const ORPHAN_AFTER_MS = Number(process.env.ORPHAN_AFTER_MS || 15 * 60 * 1000);
// Por quanto tempo lembrar de um tool_use_id já exportado, para não contar duas
// vezes uma sessão retomada (ver dedupe abaixo). Alinhado com a retenção do Loki.
const DEDUP_DAYS = Number(process.env.DEDUP_DAYS || 90);
// Reset do limite semanal da Anthropic: dia da semana (0=domingo) e hora local.
// Varia por conta; ajuste se o seu /usage discordar.
const WEEK_START_DAY = Number(process.env.WEEK_START_DAY || 1);
const WEEK_START_HOUR = Number(process.env.WEEK_START_HOUR || 0);
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS || -3);
// Janela para descobrir a conta de uma sessão. O Loki de fábrica recusa consultas
// acima de 30d (max_query_length); o loki-config.yaml deste stack levanta esse
// teto, mas o padrão aqui fica seguro para um Loki sem aquele config.
const EMAIL_LOOKBACK_HOURS = Number(process.env.EMAIL_LOOKBACK_HOURS || 720);

const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
// Reimportação: apaga o que este exportador já escreveu no Loki e reconstrói do
// zero a partir dos transcripts. Existe porque o Loki é append-only — uma
// correção na atribuição de conta (ou na de tokens) não alcança o que já foi
// gravado. DESTRUTIVO: só o stream deste exportador, mas sem volta.

// Releitura NÃO destrutiva: zera os offsets dos arquivos mas preserva o mapa de
// deduplicação. Serve para gerar registros de um tipo novo (ex.: tokens por
// skill) a partir do histórico, sem reescrever o que já foi exportado — a
// dedup barra o que já existe e deixa passar só o que é realmente novo.
const RESCAN = process.argv.includes('--rescan');
// Nome do stream onde este exportador escreve. É VERSIONADO de propósito.
//
// O Loki não sabe substituir dados derivados: a API de exclusão marca uma janela
// e passa a filtrá-la em tempo de query, e um pedido já processado não pode mais
// ser removido — qualquer reimportação com timestamp histórico cai dentro da
// janela e fica invisível PARA SEMPRE. Aprendido na marra.
//
// Então reimportar = escrever num nome novo. Bump EXPORTER_STREAM no
// docker-compose (o mesmo valor vai para o dashboard-generator, que aponta os
// painéis para lá) e o exportador reconstrói do zero. A geração antiga fica
// órfã e some sozinha com a retenção de 90d.
const STREAM = process.env.EXPORTER_STREAM || 'claude-code-exporter-1';
const STREAM_LABELS = { service_name: STREAM, kind: 'tools' };
// Segundo stream: tokens por skill com o nome REAL. O Claude Code redige skill de
// plugin para "third-party" no api_request, igual faz com MCP — numa conta que só
// usa skills de plugin, o painel inteiro colapsa numa linha só. O nome real está
// no input do tool_use "Skill" dentro do transcript.
const SKILL_STREAM_LABELS = { service_name: STREAM, kind: 'skills' };

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------- estado

const emptyState = () => ({
  version: 2, files: {}, sessionEmail: {}, seen: {}, otelSkills: {},
  // sessionId -> [nomes reais de skill de plugin]. PRECISA sobreviver entre
  // passadas: a linha do transcript que revela o nome real é lida uma única vez,
  // mas os eventos OTel daquela sessão continuam chegando por dias. Sem
  // persistir, toda passada seguinte rotulava aquelas requisições como
  // "third-party" — e o dedup por request_id trava o nome errado para sempre.
  pluginSkills: {},
});

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    // v1 nao tinha o mapa `seen`. Migrar em vez de descartar: recomecar do zero
    // relê todos os transcripts e duplica tudo que ja esta no Loki.
    if (parsed?.version === 1 || parsed?.version === 2) {
      return { ...emptyState(), ...parsed, version: 2 };
    }
    log(`estado com versão inesperada (${parsed?.version}); recomeçando do zero`);
  } catch (error) {
    if (error.code !== 'ENOENT') log(`estado ilegível (${error.message}); recomeçando do zero`);
  }
  return emptyState();
}

async function saveState(state) {
  if (DRY_RUN) return;
  await mkdir(dirname(STATE_FILE), { recursive: true });
  // Grava em arquivo temporário e renomeia: um kill no meio da escrita não
  // deixa um estado truncado que faria o exportador reprocessar tudo.
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, STATE_FILE);
}

// ---------------------------------------------------------- transcripts

// Varredura RECURSIVA, e a partir de uma raiz que pode conter vários diretórios
// de config montados lado a lado. Duas coisas que a versão anterior perdia:
//
//   - transcripts de subagente, que ficam em <sessão>/subagents/*.jsonl, um
//     nível mais fundo do que ela olhava;
//   - um segundo diretório de config (ex.: ~/.claude-work ao lado de
//     ~/.claude-personal), quando se usa contas diferentes por contexto.
//
// Custou caro descobrir: faltavam 331 chamadas de um único servidor MCP.
async function findTranscripts(dir = PROJECTS_DIR, depth = 0) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (depth === 0) log(`diretório de transcripts não existe: ${dir}`);
      return found;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) found.push(...await findTranscripts(full, depth + 1));
    } else if (entry.name.endsWith('.jsonl')) {
      found.push(full);
    }
  }
  return found;
}

function parseToolName(name) {
  // mcp__<servidor>__<ferramenta>. O nome da ferramenta pode conter "__",
  // então divide só nas duas primeiras ocorrências.
  if (!name?.startsWith('mcp__')) return { toolSource: 'builtin', mcpServer: '', mcpTool: '' };
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return { toolSource: 'mcp', mcpServer: rest, mcpTool: '' };
  return { toolSource: 'mcp', mcpServer: rest.slice(0, sep), mcpTool: rest.slice(sep + 2) };
}

function blockSize(block) {
  const content = block?.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (typeof part === 'string') return sum + part.length;
      if (part?.type === 'text') return sum + (part.text?.length || 0);
      return sum + JSON.stringify(part ?? '').length;
    }, 0);
  }
  return JSON.stringify(content ?? '').length;
}

// Atribui os tokens de entrada da próxima mensagem do assistente às ferramentas
// chamadas no grupo, proporcional ao tamanho do resultado de cada uma.
function settle(group, inputTokens) {
  const total = group.calls.reduce((sum, call) => sum + call.resultBytes, 0);
  return group.calls.map((call) => ({
    timestampNs: `${Date.parse(call.timestamp)}000000`,
    line: call.toolName,
    meta: {
      session_id: group.sessionId,
      request_id: group.requestId,
      tool_use_id: call.toolUseId,
      tool_name: call.toolName,
      tool_source: call.toolSource,
      mcp_server: call.mcpServer,
      mcp_tool: call.mcpTool,
      model: group.model,
      effort: group.effort,
      query_source: group.isSidechain ? 'subagent' : 'main',
      git_branch: group.gitBranch,
      project: group.project,
      result_bytes: String(call.resultBytes),
      // Divisão proporcional. Sem nenhum byte de resultado (todas vazias),
      // divide igualmente para não perder o total.
      tokens_attributed: String(
        Math.round(total > 0 ? (inputTokens * call.resultBytes) / total : inputTokens / group.calls.length),
      ),
    },
  }));
}

// Lê um transcript a partir do offset guardado e devolve os registros prontos.
// `pending` guarda, entre execuções, os grupos que ainda esperam a próxima
// mensagem do assistente — sem isso um tool_use na virada do poll ficaria órfão.
async function processTranscript(path, fileState, pluginSkills) {
  const records = [];
  // Grupos pendentes são separados por trilha: a thread principal não pode ser
  // fechada pela primeira mensagem de um subagente, que é outra conversa.
  const pending = { main: fileState.pending?.main ?? null, sub: fileState.pending?.sub ?? null };
  // Skill ativa por trilha. Vale da chamada do tool "Skill" até a próxima — é o
  // mesmo comportamento que o Claude Code usa no skill_name do api_request, onde
  // uma skill marca centenas de requisições seguidas.
  const activeSkill = { main: fileState.activeSkill?.main ?? '', sub: fileState.activeSkill?.sub ?? '' };
  let offset = fileState.offset ?? 0;

  const { size } = await stat(path);
  if (size < offset) {
    // Arquivo encolheu: foi truncado ou substituído. Recomeça.
    log(`${basename(path)} encolheu (${size} < ${offset}); relendo do início`);
    offset = 0;
    pending.main = pending.sub = null;
    activeSkill.main = activeSkill.sub = '';
  }
  // activeSkill precisa voltar também aqui: este é o caminho mais comum (arquivo
  // sem novidade entre polls), e omiti-lo apagava a skill ativa lembrada, fazendo
  // a atribuição cair de volta em "third-party".
  if (size === offset) return { records, offset, pending, activeSkill };

  const stream = createReadStream(path, { start: offset, encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = 0;
  let pendente = 0;

  for await (const line of lines) {
    // O readline entrega a última linha mesmo sem "\n" final — é o caso normal
    // aqui, já que o Claude Code escreve nestes arquivos ao mesmo tempo. Contar
    // o "\n" antes de saber se ele existe deixava o offset 1 byte à frente do
    // arquivo, e o primeiro byte do que fosse escrito depois era pulado: a
    // entrada inteira se perdia, em silêncio.
    //
    // Por isso o tamanho da linha fica "pendente" e só vira offset quando a
    // PRÓXIMA linha chega, o que prova que a anterior terminou em "\n".
    consumed += pendente;
    pendente = Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // linha parcial ou corrompida; a próxima passada pega
    }

    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const track = entry.isSidechain ? 'sub' : 'main';

    if (entry.type === 'assistant') {
      const usage = message.usage;
      // Candidato a registro de skill. O filtro de verdade é o OTel, aplicado
      // depois em resolveSkillScope(): a skill pode ser ativada proativamente,
      // sem chamada do tool "Skill", e confiar só no transcript erra feio (medido:
      // -87% numa skill, -100% em outras duas). Aqui só se coleta; quem decide o
      // escopo e o nome final é o OTel.
      // Skill de plugin vista nesta sessão. Não vira registro: os números de
      // skill saem do OTel (ver rebuildSkillRecords). Aqui só se anota o nome
      // real, que é o que o OTel redige.
      if (entry.sessionId && activeSkill[track]?.includes(':')) {
        (pluginSkills[entry.sessionId] ??= new Set()).add(activeSkill[track]);
      }
      if (usage && pending[track]) {
        const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        records.push(...settle(pending[track], inputTokens));
        pending[track] = null;
      }
      const calls = content
        .filter((block) => block?.type === 'tool_use')
        .map((block) => ({
          toolUseId: block.id || '',
          toolName: block.name || '',
          resultBytes: 0,
          timestamp: entry.timestamp,
          ...parseToolName(block.name),
        }));
      // A chamada do tool "Skill" traz o nome real no input.
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
          activeSkill[track] = String(block.input.skill);
        }
      }
      if (calls.length) {
        pending[track] = {
          sessionId: entry.sessionId || '',
          requestId: entry.requestId || '',
          model: message.model || '',
          effort: entry.perTurnEffort || entry.effort || '',
          gitBranch: entry.gitBranch || '',
          project: entry.cwd ? basename(entry.cwd) : '',
          isSidechain: Boolean(entry.isSidechain),
          at: Date.parse(entry.timestamp) || Date.now(),
          calls,
        };
      }
    } else if (entry.type === 'user' && pending[track]) {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const call = pending[track].calls.find((candidate) => candidate.toolUseId === block.tool_use_id);
        if (call) call.resultBytes = blockSize(block);
      }
    }
  }

  return { records, offset: offset + consumed, pending, activeSkill };
}

// ------------------------------------------------------------------ Loki

async function lokiQuery(path, params) {
  const url = new URL(path, LOKI_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Loki ${response.status} em ${path}: ${(await response.text()).slice(0, 200)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

// Transcripts não guardam a conta. O evento api_request que o Claude Code manda
// por OTel guarda, e compartilha o session_id — então a conta vem de lá, uma vez
// por sessão. Sem isso o painel de MCP não filtraria por conta como os demais.
async function resolveEmails(state, sessionIds) {
  const missing = sessionIds.filter((id) => id && !state.sessionEmail[id]);
  if (!missing.length) return;
  const end = Date.now() * 1e6;
  const start = end - EMAIL_LOOKBACK_HOURS * 3600 * 1e9;
  for (const sessionId of missing) {
    try {
      const body = await lokiQuery('/loki/api/v1/query_range', {
        query: `{service_name="claude-code"} | session_id = \`${sessionId}\` | user_email != \`\``,
        start: String(start),
        end: String(end),
        limit: '1',
        direction: 'backward',
      });
      const email = body?.data?.result?.[0]?.stream?.user_email;
      // Marca como resolvida mesmo sem achar, senão toda passada reconsulta
      // sessões que nunca mandaram telemetria OTel.
      state.sessionEmail[sessionId] = email || '';
    } catch (error) {
      log(`não consegui resolver a conta da sessão ${sessionId.slice(0, 8)}: ${error.message}`);
    }
  }
}

// Reconstrói o mapa `seen` a partir do que já está no Loki. Roda quando o mapa
// está vazio mas já existe dado exportado: upgrade de estado antigo, volume de
// estado perdido, ou alguém apagou o arquivo. Sem isso, qualquer um desses casos
// reimportaria o histórico por cima do que já está lá.
async function seedSeenFromLoki(state) {
  const windowMs = DEDUP_DAYS * 24 * 3600 * 1000;
  const step = 24 * 3600 * 1000; // um dia por consulta, para não estourar o limite de linhas
  let total = 0;
  for (let offset = 0; offset < windowMs; offset += step) {
    const end = Date.now() - offset;
    const start = end - step;
    let body;
    try {
      body = await lokiQuery('/loki/api/v1/query_range', {
        query: `{service_name="${STREAM}"}`,
        start: String(start * 1e6),
        end: String(end * 1e6),
        limit: '5000',
        direction: 'backward',
      });
    } catch (error) {
      // "continue" e não "return": abortar tudo no primeiro erro deixava os dias
      // restantes sem semear, e a guarda de startup nunca mais permite tentar —
      // aquelas chamadas voltariam como duplicatas de verdade.
      log(`janela de semeadura falhou (${error.message}); seguindo para a próxima`);
      continue;
    }
    for (const stream of body?.data?.result ?? []) {
      const id = stream.stream?.tool_use_id;
      if (!id) continue;
      for (const [timestampNs] of stream.values ?? []) {
        state.seen[id] = Math.round(Number(timestampNs) / 1e6);
        total += 1;
      }
    }
  }
  if (total) log(`deduplicação semeada com ${Object.keys(state.seen).length} chamada(s) já no Loki`);
}

// Sessões anteriores ao stack não têm evento OTel, então o session_id não
// resolve a conta. Mas o projeto resolve: se todas as sessões JÁ atribuídas de um
// diretório pertencem à mesma conta, as órfãs daquele diretório são dela também.
// Só atribui quando não há ambiguidade — projeto com duas contas fica sem.
// Medido nesta máquina: recupera 81% das linhas órfãs, 0 ambíguas.
// `batch` é o lote que está sendo exportado agora. Sem ele, uma importação do
// zero nunca infere nada: o mapa sairia só do que já está no Loki, que está
// vazio justamente porque é o primeiro import.
async function projectOwners(lokiUrl, batch = []) {
  const owners = new Map();
  const end = Date.now();
  const start = end - DEDUP_DAYS * 24 * 3600 * 1000;
  let body;
  try {
    body = await lokiQuery('/loki/api/v1/query_range', {
      query: `{service_name="${STREAM}", kind="tools"}`,
      start: String(start * 1e6),
      end: String(end * 1e6),
      limit: '5000',
      direction: 'backward',
    });
  } catch (error) {
    log(`histórico do Loki indisponível para o mapa projeto→conta (${error.message});`
      + ' usando só o lote atual');
    body = null;
  }
  const seen = new Map();
  const note = (project, email) => {
    if (!project || !email) return;
    if (!seen.has(project)) seen.set(project, new Set());
    seen.get(project).add(email);
  };
  for (const stream of body?.data?.result ?? []) {
    note(stream.stream?.project, stream.stream?.user_email);
  }
  for (const record of batch) note(record.meta.project, record.meta.user_email);
  for (const [project, emails] of seen) {
    if (emails.size === 1) owners.set(project, [...emails][0]);
  }
  return owners;
}

// Os números por skill vêm do OTel, não do transcript.
//
// Tentei o contrário primeiro e estava errado: o transcript não espelha o OTel
// (subagentes e sessões rotacionadas não aparecem nele), e skill pode ser
// ativada proativamente, sem chamada do tool "Skill" — medido, a atribuição por
// transcript errava -87% numa skill e -100% em outras duas.
//
// Então este passo relê do Loki as requisições que o OTel marcou com skill e as
// republica com UM ajuste: o Claude Code troca o nome de skill de PLUGIN por
// "third-party", e o transcript sabe qual era. Assim o painel de skills fecha
// exatamente com a tabela de detalhamento semanal, que lê a mesma fonte.
async function rebuildSkillRecords(state, pluginSkills, fullHistory) {
  const out = [];
  // Varre o OTel direto, e não a lista de sessões vinda dos transcripts: nem
  // toda sessão tem transcript nesta máquina (outra config dir, arquivo
  // rotacionado), e ir por sessão perdia dois terços do volume.
  const days = fullHistory ? DEDUP_DAYS : 2;
  const LIMIT = 5000;

  // O Loki corta a resposta no limite de entradas, e uma janela cheia volta
  // truncada em silêncio — foi assim que 39% do volume sumiu. Quando a janela
  // satura, ela é dividida ao meio e refeita.
  async function fetchWindow(start, end, depth = 0) {
    let body;
    try {
      body = await lokiQuery('/loki/api/v1/query_range', {
        query: '{service_name="claude-code"} | event_name = `api_request` | skill_name != ``',
        start: String(start * 1e6),
        end: String(end * 1e6),
        limit: String(LIMIT),
      });
    } catch (error) {
      log(`skills do OTel indisponíveis nessa janela: ${error.message}`);
      return [];
    }
    const streams = body?.data?.result ?? [];
    const total = streams.reduce((sum, stream) => sum + (stream.values?.length ?? 0), 0);
    if (total >= LIMIT && end - start > 60_000 && depth < 12) {
      const meio = Math.floor((start + end) / 2);
      return [...await fetchWindow(start, meio, depth + 1),
              ...await fetchWindow(meio, end, depth + 1)];
    }
    return streams;
  }

  const step = 24 * 3600 * 1000;
  for (let offset = 0; offset < days * step; offset += step) {
    const end = Date.now() - offset;
    const streams = await fetchWindow(end - step, end);
    for (const stream of streams) {
      const meta = stream.stream ?? {};
      const sessionId = meta.session_id || '';
      // "third-party" só pode ser desfeito se a sessão usou exatamente uma
      // skill de plugin — com duas, não dá para saber qual é qual.
      const candidatos = pluginSkills[sessionId];
      const real = candidatos?.size === 1 ? [...candidatos][0] : null;
      const skill = meta.skill_name === 'third-party' && real ? real : (meta.skill_name || '');
      if (!skill || !meta.request_id) continue;
      // "dono" como campo próprio, em vez de deixar o dashboard filtrar por
      // regex sobre o nome. O valor do filtro no Grafana é serializado numa
      // string "texto : valor" separada por vírgula, e um valor com ":" dentro
      // (que é o caso de "superpowers:.*") é truncado na releitura — o filtro
      // passava a não casar com nada.
      const dono = skill.includes(':') ? skill.split(':')[0] : 'local';
      for (const [timestampNs] of stream.values ?? []) {
        out.push({
          stream: SKILL_STREAM_LABELS,
          dedupKey: `skill:${meta.request_id}`,
          timestampNs,
          line: skill,
          meta: {
            skill,
            skill_owner: dono,
            session_id: sessionId,
            request_id: meta.request_id,
            model: meta.model || '',
            effort: meta.effort || '',
            query_source: meta.query_source || '',
            project: '',
            tokens: String(
              Number(meta.input_tokens || 0)
              + Number(meta.output_tokens || 0)
              + Number(meta.cache_creation_tokens || 0),
            ),
            user_email: meta.user_email || '',
            account_source: 'otel',
          },
        });
      }
    }
  }
  return out;
}

async function pushToLoki(records) {
  if (!records.length || DRY_RUN) return;
  // Ordena por timestamp antes de empurrar. O Loki rejeita escrita muito fora de
  // ordem dentro de um stream, e o backfill inicial varre vários arquivos que se
  // intercalam no tempo.
  const ordered = [...records].sort((a, b) => Number(BigInt(a.timestampNs) - BigInt(b.timestampNs)));
  for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
    const chunk = ordered.slice(i, i + BATCH_SIZE);
    // Os registros vão para streams diferentes (ferramentas e skills), então
    // agrupa por stream antes de montar o payload.
    const byStream = new Map();
    for (const record of chunk) {
      const labels = record.stream ?? STREAM_LABELS;
      const key = JSON.stringify(labels);
      if (!byStream.has(key)) byStream.set(key, { stream: labels, values: [] });
      byStream.get(key).values.push([record.timestampNs, record.line, record.meta]);
    }
    const payload = { streams: [...byStream.values()] };
    // No cold start o Loki aceita conexão antes do ingester estar pronto e
    // responde "empty ring". A imagem dele não tem shell utils para um
    // healthcheck do compose, então quem espera é aqui.
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      const response = await fetch(new URL('/loki/api/v1/push', LOKI_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
      if (response.ok) { lastError = null; break; }
      lastError = `push falhou ${response.status}: ${(await response.text()).slice(0, 200)}`;
      // 4xx é payload inválido: repetir não resolve.
      if (response.status >= 400 && response.status < 500) break;
    }
    if (lastError) throw new Error(lastError);
  }
}

// ------------------------------------------------------------------ loop

// Retomar uma sessão (`claude --resume`, fork) faz o Claude Code reescrever o
// histórico inteiro num transcript NOVO: mesmo request_id, mesmo tool_use_id e
// mesmo timestamp, só o session_id muda. Sem filtrar isso, cada retomada conta
// de novo todas as ferramentas da sessão original e infla a atribuição.
// O tool_use_id é único por chamada de verdade, então ele é a chave.
function dropAlreadySeen(state, records) {
  const cutoff = Date.now() - DEDUP_DAYS * 24 * 3600 * 1000;
  for (const id of Object.keys(state.seen)) {
    if (state.seen[id] < cutoff) delete state.seen[id];
  }
  const fresh = [];
  const novos = new Map();
  for (const record of records) {
    const id = record.dedupKey || record.meta.tool_use_id;
    if (!id) { fresh.push(record); continue; }
    if (state.seen[id] || novos.has(id)) continue;
    novos.set(id, Math.round(Number(record.timestampNs) / 1e6));
    fresh.push(record);
  }
  return { fresh, novos };
}

async function runPass(state) {
  // Precisa ser lido ANTES de processar os transcripts: processá-los popula
  // state.files, e a varredura completa do histórico passava a se achar uma
  // passada incremental — silenciosamente só os 2 últimos dias entravam.
  const primeiraPassada = Object.keys(state.files).length === 0;
  const files = await findTranscripts();
  const collected = [];
  // Avanço de offset e marcas de deduplicação ficam aqui até o push dar certo.
  // Antes eram aplicados direto em `state`; se o Loki estivesse fora do ar, o
  // objeto em memória já tinha avançado e aqueles registros nunca mais eram
  // relidos enquanto o processo vivesse — perda silenciosa e definitiva.
  const atualizacoes = new Map();
  // sessionId -> Set(nomes reais). Semeado do estado persistido e devolvido para
  // ele no fim da passada.
  const pluginSkills = {};
  for (const [sessionId, nomes] of Object.entries(state.pluginSkills ?? {})) {
    pluginSkills[sessionId] = new Set(nomes);
  }

  for (const path of files) {
    const fileState = state.files[path] ?? { offset: 0, pending: null, activeSkill: null };
    try {
      const { records, offset, pending, activeSkill } = await processTranscript(path, fileState, pluginSkills);

      // Grupo pendente velho demais = sessão que acabou sem resposta do
      // assistente. Sai com atribuição zero para não sumir da contagem.
      for (const track of ['main', 'sub']) {
        const group = pending[track];
        if (group && Date.now() - group.at > ORPHAN_AFTER_MS) {
          records.push(...settle(group, 0));
          pending[track] = null;
        }
      }

      collected.push(...records);
      // Guardado à parte: só entra no estado depois que o push confirmar.
      atualizacoes.set(path, { offset, pending, activeSkill });
    } catch (error) {
      log(`falha lendo ${basename(path)}: ${error.message}`);
    }
  }

  collected.push(...await rebuildSkillRecords(state, pluginSkills, primeiraPassada));

  const { fresh, novos: novosVistos } = dropAlreadySeen(state, collected);
  const skipped = collected.length - fresh.length;
  if (skipped) log(`${skipped} chamada(s) ignorada(s): já exportadas (sessão retomada)`);
  const confirmar = () => {
    for (const [path, st] of atualizacoes) state.files[path] = st;
    for (const [id, ts] of novosVistos) state.seen[id] = ts;
    for (const [sessionId, nomes] of Object.entries(pluginSkills)) {
      state.pluginSkills[sessionId] = [...nomes];
    }
  };
  if (!fresh.length) {
    // Nada novo para escrever, mas o offset dos arquivos avançou.
    if (collected.length) { confirmar(); await saveState(state); }
    return 0;
  }
  collected.length = 0;
  collected.push(...fresh);

  await resolveEmails(state, [...new Set(collected.map((record) => record.meta.session_id))]);
  for (const record of collected) {
    if (record.meta.user_email) continue; // skills já vêm com a conta do OTel
    record.meta.user_email = state.sessionEmail[record.meta.session_id] || '';
    record.meta.account_source = record.meta.user_email ? 'otel' : '';
  }

  // Segunda tentativa para o que o OTel não resolveu: dono do projeto.
  if (collected.some((record) => !record.meta.user_email)) {
    const owners = await projectOwners(LOKI_URL, collected);
    for (const record of collected) {
      if (record.meta.user_email) continue;
      const owner = owners.get(record.meta.project);
      if (!owner) continue;
      record.meta.user_email = owner;
      // Marcado para ser auditável: essa conta foi inferida, não observada.
      record.meta.account_source = 'projeto';
    }
  }

  if (DRY_RUN) summarize(collected);
  await pushToLoki(collected);
  // Só agora: o push deu certo.
  confirmar();
  await saveState(state);
  return collected.length;
}

// Em --dry-run, mostra o que seria escrito: é assim que se confere a
// atribuição de tokens sem sujar o Loki.
function summarize(records) {
  const tally = (rows, keyOf, valueOf) => {
    const acc = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      const entry = acc.get(key) ?? { n: 0, tokens: 0 };
      entry.n += 1;
      entry.tokens += valueOf(row);
      acc.set(key, entry);
    }
    return [...acc.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  };
  const show = (title, rows) => {
    if (!rows.length) return;
    const total = rows.reduce((sum, [, entry]) => sum + entry.tokens, 0);
    log(`--- ${title}: ${total.toLocaleString('pt-BR')} tokens ---`);
    for (const [key, entry] of rows.slice(0, 20)) {
      log(`  ${key.padEnd(36)} ${String(entry.n).padStart(5)}x  ${entry.tokens.toLocaleString('pt-BR').padStart(12)} tokens`);
    }
  };
  const tools = records.filter((record) => record.meta.tool_name);
  const skills = records.filter((record) => record.meta.skill);
  show('FERRAMENTAS', tally(tools,
    (r) => (r.meta.tool_source === 'mcp' ? `mcp:${r.meta.mcp_server}` : `builtin:${r.meta.tool_name}`),
    (r) => Number(r.meta.tokens_attributed)));
  show('SKILLS', tally(skills, (r) => r.meta.skill, (r) => Number(r.meta.tokens)));
}



async function main() {
  log(`transcripts: ${PROJECTS_DIR}`);
  log(`loki: ${LOKI_URL}${DRY_RUN ? '  (dry-run)' : ''}`);
  const state = await loadState();
  if (RESCAN) {
    log('RELEITURA: zerando offsets, preservando a deduplicação');
    state.files = {};
  }
  const firstRun = Object.keys(state.files).length === 0;
  if (firstRun) log('primeira execução: importando o histórico completo de transcripts');
  if (!Object.keys(state.seen).length) await seedSeenFromLoki(state);

  for (;;) {
    try {
      const count = await runPass(state);
      if (count) log(`${count} chamada(s) de ferramenta exportada(s)`);
    } catch (error) {
      log(`passada falhou: ${error.message}`);
    }
    // O medidor de uso não depende de transcript novo: ele mede o que o OTel já
    // registrou, e precisa republicar mesmo numa passada sem nada para exportar.
    try {
      await publishUsage({
        dryRun: DRY_RUN,
        lokiUrl: LOKI_URL,
        weekStartDay: WEEK_START_DAY,
        weekStartHour: WEEK_START_HOUR,
        tzOffsetHours: TZ_OFFSET_HOURS,
        log,
      });
    } catch (error) {
      log(`medidor de uso falhou: ${error.message}`);
    }
    if (ONCE) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
