# Agents Observability

Stack local para acompanhar **sessões de CLI de coding assistant** — quanto cada
sessão consome do limite e como ela é usada. Hoje ingere Claude Code; outras
ferramentas entram depois pelos próprios adaptadores.

Caminho: Claude Code → OTel Collector → Prometheus (métricas) + Loki (logs) →
Grafana. Em paralelo, o **transcript-exporter** lê os transcripts locais e
publica no Loki duas coisas que a telemetria OTel não dá: os nomes reais de
ferramentas MCP e o consumo nas janelas de limite reais.

## Serviços

| Serviço             | URL / porta                                        | Papel |
|---------------------|----------------------------------------------------|-------|
| OTel Collector      | `localhost:47317` (gRPC), `localhost:47318` (HTTP) | ponto único de ingestão OTLP |
| Grafana             | http://localhost:47300                             | dashboards (anônimo como Viewer, `admin`/`admin` para editar) |
| Prometheus          | http://localhost:47909                             | métricas, retenção 90d |
| Loki                | http://localhost:47100                             | logs e eventos, retenção 90d |
| transcript-exporter | —                                                  | nomes reais de ferramenta + medidor de uso |
| dashboard-generator | —                                                  | um dashboard por conta, a cada 60s |

## Subir

```sh
cd observability
docker compose up -d
```

Os diretórios de config do Claude Code a varrer ficam no `.env`
(`CLAUDE_DIR_A` e `CLAUDE_DIR_B`). São **dois** porque é comum ter contas
separadas por contexto — `~/.claude-personal` e `~/.claude-work`, por exemplo —
e cada uma tem seus próprios transcripts. Se você só usa um, aponte os dois para
o mesmo caminho: a deduplicação cuida da leitura repetida.

Varrer só um diretório é uma falha silenciosa: nada quebra, os painéis
simplesmente mostram uma fração do uso. Aqui faltavam 331 chamadas de um único
servidor MCP — o painel dizia 4 mil tokens onde o real era 268 mil.

## Ligar a telemetria em toda sessão

```sh
cd ..   # se você ainda está em observability/, volte para a raiz do repo
cat observability/claude-telemetry.fish >> ~/.config/fish/config.fish
```

Abra um terminal novo (ou `source ~/.config/fish/config.fish`). O primeiro ponto
chega em ~10s do primeiro prompt. Conferir: `claude --debug` sem erros de
`[3P telemetry]`; no Prometheus, `claude_code_cost_usage_USD_total` retorna séries.

---

## Um dashboard por conta — e só

Não existe dashboard "todas as contas". Cada conta tem MCPs, plugins e
configuração próprios, e os números não se somam de forma útil.

O `dashboard-generator` sobe junto com o stack e roda a cada 60s. Na primeira vez
que uma conta nova manda dados, o dashboard dela aparece em ~1min como
**"Claude Code — <email>"**.

A fonte única é `grafana/templates/claude-code.json`. Ele fica **fora** de
`grafana/dashboards/` de propósito: aquele é o diretório provisionado, e um
template lá viraria um dashboard a mais, com filtro de conta vazio. O gerador lê
o template e troca o que é da conta:

- fixa o filtro de conta num email;
- injeta o **P75 horário daquela conta** como linha de corte nos painéis de ritmo;
- injeta as **referências de limite daquela conta** (ver abaixo);
- popula o seletor de servidor MCP com o que a conta usou de fato.

Rodar na mão: `node grafana/generate-account-dashboards.mjs`. Contas que somem
dos dados têm o arquivo removido na execução seguinte. Os arquivos gerados contêm
emails, são específicos da máquina e estão no `.gitignore`.

---

## As janelas de limite (e por que a janela móvel estava errada)

A Anthropic limita em duas janelas, e **nenhuma das duas é uma janela móvel**:

- **Bloco de 5h**: abre na primeira mensagem, expira 5h depois. O próximo bloco
  só abre na mensagem seguinte. Um `sum_over_time[5h]` soma o fim de um bloco com
  o começo do outro — mede outra coisa.
- **Semana**: reseta num dia fixo. Um `sum_over_time[7d]` arrasta consumo da
  semana passada.

Achar a borda do bloco exige varrer a atividade procurando o intervalo em que o
anterior expirou. O LogQL não faz isso, então quem calcula é o **usage-meter**
(dentro do transcript-exporter): a cada passada ele mede as duas janelas por
conta e publica o resultado de volta no Loki, no stream
`service_name="claude-code-usage"`. As gauges viram uma leitura direta desse
valor.

O dia e a hora do reset semanal são configuráveis no serviço
(`WEEK_START_DAY`, padrão 1 = segunda; `WEEK_START_HOUR`, padrão 0;
`TZ_OFFSET_HOURS`, padrão -3).

### As referências de limite

**A Anthropic não expõe o limite por telemetria nenhuma**, e ele varia por plano.
As referências ficam em `grafana/account-limits.json`, por conta, em tokens novos.
Esse arquivo **não é versionado** (contém emails, mesma regra dos dashboards
gerados) — copie o modelo na primeira vez:

```sh
cp grafana/account-limits.example.json grafana/account-limits.json
```

Para calibrar: rode `/usage` na conta, anote as duas percentagens, e compare com
o que o medidor publicou naquele instante:

```
{service_name="claude-code-usage"} | user_email = `<email>`
```

Então `limite = tokens_do_medidor / (percentual_do_usage / 100)`. A referência da
conta pessoal foi calibrada assim em 2026-09-17 e bateu em 26,3% contra 26% do
`/usage`. Contas sem entrada no arquivo usam o bloco `default`.

### Por que "tokens novos"

As janelas contam **entrada + saída + criação de cache**. Leitura de cache fica
fora: é ~97% do volume bruto e não é consumo novo, só o rearrasto de contexto já
pago. Incluí-la cravaria as gauges em 100% permanentemente.

---

## As duas fontes de dado

### OTel — o que o Claude Code manda sozinho

O evento que interessa é o `claude_code.api_request`: **uma linha por requisição
à API**, com `cost_usd`, os quatro tipos de token, `model`, `effort`, `speed`,
`duration_ms`, `query_source`, `skill_name`, `session_id`, `prompt_id` e
`request_id`. Todos os painéis leem dele.

É exato por requisição, ao contrário das métricas do Prometheus, que são
contadores por sessão que ficam stale ~5min depois de a sessão acabar. O
Prometheus continua no stack (ingestão barata, retenção longa, e é dele que sai a
lista de contas), mas saiu dos painéis.

### transcript-exporter — o que o OTel redige

O Claude Code **redige o nome de servidores MCP configurados localmente em toda a
telemetria OTel**: `mcp_server_name` vira `custom` nas métricas, e desde a versão
2.1.x o `tool_name` do log `tool_result` vira `mcp_tool`. Sobra só
`mcp_server_scope`. Medido nesta máquina: **~85% dos tokens de MCP caíam no balde
`custom`**. É redação de privacidade intencional, sem env var para desligar.

A mesma redação vale para **skills de plugin**, que viram `third-party` no
`skill_name` do `api_request`.

Os transcripts locais guardam os dois nomes reais. O exporter varre **recursivamente** os diretórios de config montados em
`/transcripts` e publica em
`{service_name="$EXPORTER_STREAM"}`, com o label `kind` separando `tools` (uma
linha por bloco `tool_use`) de `skills` (uma linha por mensagem do assistente,
com os tokens atribuídos à skill ativa). O nome do stream é **versionado** — ver
"Releitura e reimportação" abaixo. A cola com o OTel
é o `request_id`, que existe igual nos dois lados.

#### Como os tokens são atribuídos a uma ferramenta

O custo de uma ferramenta é **o que o modelo pagou para ler o resultado dela**: o
lado de entrada (`input_tokens + cache_creation_input_tokens`) da **próxima**
mensagem do assistente na mesma trilha. Com várias ferramentas em paralelo, esse
total é dividido proporcional ao tamanho de cada resultado. `cache_read` fica de
fora de propósito.

Trilhas de subagente são contabilizadas separadas da principal, senão a primeira
mensagem de um subagente fecharia a atribuição da ferramenta chamada acima.

#### Deduplicação

Retomar uma sessão faz o Claude Code reescrever o histórico inteiro num
transcript novo: mesmo `request_id`, mesmo `tool_use_id`, `session_id` diferente.
Sem filtrar, cada retomada reconta tudo. A chave é o `tool_use_id`, e o mapa é
semeado a partir do próprio Loki quando está vazio — o que também torna a perda
do volume de estado inofensiva (relê tudo, reconhece o que já está lá, grava
zero duplicata).

#### Como a conta de cada chamada é descoberta

Transcripts não guardam a conta. São duas tentativas, em ordem, e o campo
`account_source` em cada linha registra qual delas valeu:

1. **`otel`** — pelo `session_id`, consultando o evento `api_request` no Loki.
   É o caminho exato.
2. **`projeto`** — os transcripts vão mais para trás do que a telemetria, e
   sessões anteriores ao stack não têm evento OTel nenhum. Para essas, vale o
   dono do diretório: se todas as sessões já atribuídas de um projeto pertencem
   à mesma conta, as órfãs dali são dela também. Projeto com duas contas fica
   sem atribuição — a inferência só age quando não há ambiguidade. O mapa é
   montado do histórico no Loki **e do lote sendo importado**, senão uma
   importação do zero nunca inferiria nada. Medido nesta máquina: 1.231 de 1.492
   registros órfãos recuperados, 0 ambíguos.

O que sobra sem conta (projetos que nunca tiveram sessão com telemetria) existe
no Loki mas não aparece nos dashboards por conta.

#### Releitura e reimportação

O Loki é append-only, e o exporter guarda o offset no fim de cada transcript —
um restart não relê nada. Duas operações cobrem isso.

**Releitura** (`--rescan`): zera os offsets e relê tudo, preservando a
deduplicação. Serve para gerar um tipo de registro **novo** a partir do histórico
sem reescrever nada do que já existe:

```sh
docker compose run --rm transcript-exporter node /work/exporter.mjs --rescan --once
```

**Reimportação**: para refazer a derivação inteira (por exemplo, depois de mudar
como a conta ou os tokens são atribuídos), suba a geração do stream — edite
`EXPORTER_STREAM` no **`.env`**, que é a fonte única lida pelos dois serviços que
a usam. Depois apague o estado e suba; o `up -d` recria os dois serviços sozinho
porque a variável mudou:

```sh
docker compose stop transcript-exporter && docker compose rm -f transcript-exporter
docker volume rm agents-observability_exporter-state
docker compose up -d
```

A geração antiga fica órfã e some sozinha com a retenção de 90 dias.

> **Por que não usar a API de exclusão do Loki.** A tentação é apagar o stream e
> reimportar no mesmo nome. Não funciona, e falha de um jeito silencioso: um
> pedido de exclusão marca uma janela de tempo e o Loki passa a **filtrá-la em
> tempo de query** — o stream parece vazio, mas qualquer coisa reimportada com
> timestamp histórico cai dentro da janela e nasce invisível. Pior: um pedido já
> processado **não pode ser removido** (`deletion of request which is in process
> or already processed is not allowed`), então aquela janela fica cega para
> sempre naquele stream. Por isso a geração vai no nome.

---

## Os painéis

Onze painéis em cinco seções, duas delas fechadas por padrão. A ordem responde,
de cima para baixo: *quanto ainda posso gastar* → *no que está indo* → *o ritmo
está alto?*

Dois filtros no topo, **Servidor MCP** e **Dono da skill**, ambos em "Todos" por
padrão. Eles afetam só as tabelas granulares; o resto do dashboard ignora.

### Visão geral

| Painel | O que decide |
|--------|--------------|
| **Limite do bloco de 5h — % usado** | Quanto do bloco corrente já foi consumido. Se nenhum bloco está aberto, é zero — não sobra do anterior. |
| **Limite semanal — % usado** | Quanto do limite semanal já foi consumido desde o reset. |
| **Cache reutilizado** | Fatia da entrada que veio de cache já pago. |
| **Tokens por modelo** (donut) | Para onde o consumo foi. |

As gauges mostram **% usado**, não % restante, de propósito: é a mesma leitura do
`/usage`, então dá para conferir uma contra a outra sem inverter na cabeça. O
valor é travado em 100% — estourar o limite não é "mais de 100% do limite", é
simplesmente estourado. LogQL não tem `clamp_max`, então o travamento sai de
`(vector(100) < x) or x`.

O donut é em **tokens, não em dólar**: numa assinatura de valor fixo o que acaba
é o limite, e o dólar não decide nada.

#### Seção "Detalhamento semanal" (fechada por padrão)

Uma tabela com todo o consumo da semana, quebrado **do maior escopo para o
menor**: `Modelo | Effort | Origem | Skill | % do limite semanal`. É o recorte
mais granular da visão geral — responde *por que* o limite está sendo consumido —
e por isso fica logo abaixo dela, mas fechada: é consulta pontual, não leitura do
dia a dia.

Não há coluna de ferramenta: o evento que contabiliza 100% do consumo não carrega
qual ferramenta foi usada. Esse recorte vive na tabela "Tokens por ferramenta
MCP", com atribuição própria.

A tabela cobre **todo** o consumo, não só o que rodou dentro de alguma skill:
requisições sem skill aparecem com a coluna Skill vazia. Por isso o total do
rodapé fecha com a gauge de limite semanal — conferido nesta máquina: 30,37% na
tabela contra 30,37% na gauge. Isso vale enquanto a faixa de tempo for a semana
corrente (o padrão); em outra faixa a soma passa a ser daquele período.

**A coluna Skill aqui é a do OTel, redigida.** Diferente da tabela "Tokens por
skill", que usa o nome real vindo do transcript, aqui skill de plugin aparece
como `third-party`. A razão é o fechamento: só o OTel contabiliza 100% do
consumo, e misturar as duas fontes quebraria a soma. Para saber qual skill está
por trás de `third-party`, a tabela de Skills e ferramentas responde.

Um total por skill não diz se o gasto veio do modelo, do effort ou de
subagentes; aqui essas variáveis estão sempre na mesma linha. É comum a mesma
skill aparecer barata em `repl_main_thread` e cara em
`agent:builtin:general-purpose` — a skill não é cara, os subagentes dela é que
são. A origem fica crua de propósito, para mostrar **qual** subagente rodou.

### Skills e ferramentas

| Painel | O que decide |
|--------|--------------|
| **Tokens por skill** (tabela) | Qual skill consome mais, com o nome real. |
| **Tokens por servidor MCP** (tabela) | Qual servidor consome mais. Clicar no nome filtra a seção de detalhe. |
| **Tokens por origem** (donut) | Thread principal, subagentes ou chamadas auxiliares. |

Abaixo deles, na seção fechada **"Ferramentas MCP — detalhe por ferramenta"**,
uma tabela com o nível mais fino: quanto cada chamada específica custou. Mesmo
padrão do detalhamento semanal — o recorte granular fica fechado, logo abaixo do
painel que ele detalha.

As tabelas trazem uma barra dentro da célula e vêm ordenadas do maior para o
menor. Tabela e não gráfico de barras por dois motivos práticos: ela ordena
nativamente, e dá largura inteira ao nome — numa barra os nomes eram cortados nos
primeiros caracteres.

Os filtros do topo agem aqui: **Dono da skill** restringe a um plugin (ex.:
`superpowers`) ou às skills locais; **Servidor MCP** restringe tanto a tabela-resumo
de servidores quanto a de ferramentas — selecionar um servidor colapsa a
tabela-resumo a uma linha só, que é o efeito esperado de clicar no nome dela. O valor de cada opção é um regex aplicado direto no matcher do
LogQL (`superpowers:.*`, `[^:]+` para skill sem plugin, `.*` para todos), o que
evita precisar de qualquer label novo no dado.

**Sobre os números de skill.** O painel lê o stream do transcript-exporter, mas
os valores vêm do próprio OTel — o exporter republica a atribuição do evento
`api_request` trocando só o nome, para desfazer a redação de skill de plugin.
Isso é o que faz a tabela de skills fechar exatamente com o detalhamento semanal:
conferido, `dip-code-review` 2.840.009 nos dois lados, e assim por diante.

Tentei o contrário primeiro — derivar a atribuição do transcript — e estava
errado: skill pode ser ativada **proativamente**, sem chamada do tool `Skill`, e
o transcript não cobre todas as requisições (subagentes e sessões rotacionadas
ficam de fora). A atribuição por transcript errava −87% numa skill e −100% em
outras duas. O transcript hoje serve só para dizer **qual** skill de plugin
rodou em cada sessão, e o nome só é restaurado quando a sessão usou exatamente
uma — com duas, não dá para saber qual é qual.

O painel de MCP continua com atribuição própria do transcript (marginal de
leitura do resultado), que é outra medida e não tem equivalente no OTel.

O donut de origem agrupa o `query_source`, que no Loki vem detalhado
(`repl_main_thread`, `agent:builtin:general-purpose`, `agent_summary`, …):
`repl_main_thread` → **main**, `agent:*` → **subagent**, o resto → **auxiliary**.

### Ritmo de consumo

Dois gráficos de linha em tokens/hora, medidos em **janelas fixas de 15
minutos**. Períodos sem uso caem para zero (`or vector(0)`), não viram lacuna. O
segundo separa entrada de saída (azul = entrada, roxo = saída).

A janela é fixa, e não `$__interval`, por um motivo específico: as linhas de
corte são pré-calculadas, e só fazem sentido se forem calculadas sobre
exatamente a mesma distribuição que o gráfico desenha. A mesma atividade medida
em janelas diferentes dá taxas horárias muito diferentes — nesta máquina, a P75
do consumo saltou de 473k (janelas de 1h) para 810k (janelas de 5min), porque um
pico de 5 minutos tem taxa horária muito maior do que a mesma atividade diluída
numa hora. 15 minutos é o meio-termo: 1h borrava um pico de 5min num bloco
retangular de 1h de largura, 5min ficava ruidoso demais.

O preço disso é que em faixas muito largas (30d) o passo do gráfico fica maior
que 15min e a série passa a ser uma amostragem das taxas, não uma cobertura
contínua.

### As duas linhas de corte

Ambas calculadas pelo `dashboard-generator` sobre o histórico de 7 dias **da
conta**, a cada 60s, **descartando os períodos parados** — incluir zeros puxaria
os quantis para baixo e a linha passaria a dizer apenas "está usando", não "está
usando muito":

| Linha | O que é | O que significa |
|---|---|---|
| amarela | P75 | Acima dela, você está no quarto mais intenso do seu normal. |
| laranja | Q3 + 1,5×IQR (cerca de Tukey) | Acima dela não é "intenso", é atípico. Vale olhar o que rodou ali. |

Conferido contra a série real desta máquina: 25% das amostras acima da amarela
(que é o que P75 quer dizer) e 5% acima da laranja.

Os valores variam bastante entre contas — 765k/1,71M numa, 1,89M/4,43M noutra —
que é o motivo de serem por conta e não constantes.

O painel de entrada/saída tem linhas **próprias de cada série**, calculadas só
sobre ela. Entrada e saída têm ordens de grandeza bem diferentes — nesta máquina,
P75 de 45k para entrada contra 144k para saída — então usar o corte do total ali
compararia coisas diferentes.

Quantil de agregado não existe em LogQL (dá para tirar quantil dos valores
individuais, não dos baldes que o gráfico desenha), por isso o cálculo mora no
gerador.

### Faixa de tempo

O padrão é **`now/w+9h+24h` → `now`** (semana corrente, a partir de segunda às
9h). O seletor traz também *Dia corrente* (`now/d+9h`), *5 horas*, *24 horas*,
*7 dias* e *30 dias*.

Chamada MCP e execução de skill são esparsas — é por isso que o padrão é a
semana.

A semana e não o dia porque **skill e MCP são esparsos**: num dia sem uso de MCP,
ou num dia em que nenhuma skill rodou, esses painéis abriam vazios — e um
dashboard que abre vazio não serve para nada. A semana mantém o recorte "agora"
e ainda tem o que mostrar.

As gauges de limite **ignoram esse seletor**: as janelas delas são as da
Anthropic, não as da análise.

---

## Adicionar outras ferramentas depois

- **GitHub Copilot** — sem telemetria local. Consultar a Copilot Metrics API com
  um scraper que exponha `/metrics`.
- **OpenAI Codex CLI** — sem OTEL nativo. Parsear o JSONL de sessão.
- Dar a todo adaptador um label `tool="…"`.

## Parar / resetar

```sh
docker compose down           # para, mantém os dados
docker compose down -v        # para, apaga tudo
```

## Armadilhas conhecidas

**`allowUiUpdates` tem que ser `false`.** Com `true`, na primeira vez que um
dashboard é tocado pela UI o Grafana desvincula ele do provisionamento
(`meta.provisioned` vira `false`) e passa a servir a cópia do banco para sempre —
o arquivo muda e nada acontece. Como estes dashboards são regerados a cada 60s, a
cópia do banco nunca deve ganhar da do arquivo. Para conferir o que está sendo
realmente servido (e não só o que está no arquivo):

```sh
curl -s -u admin:admin http://localhost:47300/api/dashboards/uid/cc-<slug> \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["meta"]["provisioned"], d["dashboard"]["version"])'
```

**Query `instant` estraga o nome das séries.** O Loki devolve frames
`numeric-multi` em queries instant; o Grafana junta esses frames num só e renomeia
os campos para `Value #A`, jogando fora o nome do `legendFormat`. Todos os
painéis usam `range`, menos a tabela de investigação — lá `range` renderizaria
uma linha por passo do gráfico em vez de uma por combinação.

## Consumo de recursos

O stack roda o dia inteiro numa máquina de desenvolvedor, então o que pesa não é
CPU de pico — é **frequência de acordar**. Cada tarefa periódica impede a CPU de
ficar ociosa, e isso é bateria.

As cadências foram calibradas para o dado ser útil, não para ser instantâneo:

| Componente | Intervalo | Por quê |
|---|---|---|
| Claude Code → collector | 60s (métricas), 30s (logs) | roda em TODA sessão; era 10s/5s |
| `transcript-exporter` | 120s | cada passada varre centenas de transcripts |
| `dashboard-generator` | 600s | sobe um processo Node e consulta 7–30 dias |
| Grafana reprovisiona | 300s | relê e reparseia todos os dashboards do disco |
| Prometheus scrape | 60s | só serve para listar contas; os painéis leem do Loki |
| Compactor do Loki | 600s | padrão da imagem |
| Auto-refresh do dashboard | 300s | cada refresh dispara ~14 queries |

Isso é **~82% menos acordadas por hora** do que a configuração inicial (1740 →
306). O Grafana também tem desligados o alerting unificado (mantém um agendador
rodando mesmo sem regras), as checagens de versão e o envio de analytics.

Em repouso, o stack fica em torno de **700 MiB** e CPU perto de zero. Se precisar
de dado mais fresco pontualmente, aumente o refresh na própria aba do Grafana em
vez de baixar os intervalos de novo.

## Notas

- Portas no host: 47300 (Grafana), 47317/47318 (OTLP), 47909 (Prometheus),
  47100 (Loki).
- Grafana roda anônimo (Viewer) com `admin`/`admin` para edição — só aceitável em
  localhost.
- `loki-config.yaml` desvia do padrão da imagem em quatro pontos, comentados no
  arquivo: aceita amostras antigas (backfill), tira o teto de janela de consulta,
  liga retenção de 90d, e sobe o `ingester.max_chunk_age` — sem isso o Loki
  recusa com HTTP 400 todo backfill histórico assim que o stream tem uma linha
  recente (escrita fora de ordem só é aceita dentro de meia `max_chunk_age` do
  ponto mais recente).
