# Dashboard acionável — design

Data: 2026-09-17
Status: implementado

O `observability/README.md` descreve **como o sistema funciona**. Este documento
registra **por que ele é assim**: as decisões, as alternativas descartadas e o
que ficou de fora de propósito.

## O problema

O dashboard anterior tinha 35 painéis e não produzia ação. Cinco queixas
concretas:

1. Um dashboard agregando todas as contas é inútil — cada conta tem MCPs,
   plugins e configuração próprios; misturar torna o dado sem sentido.
2. "Skill X está gastando muito" isolado não decide nada: a mesma skill rodada
   em Opus/high numa task complexa infla a medida, e o painel não mostrava
   essas variáveis.
3. MCPs locais não tinham join com tokens.
4. Os gráficos não diziam se o ritmo estava alto ou baixo, perto ou longe do
   limite.
5. O padrão de tempo não era o dia corrente.

## Descobertas que mudaram o desenho

**O painel de MCP existente estava quebrado, e o README mentia sobre isso.**
O README afirmava que o log `tool_result` carregava o nome real da ferramenta.
Na versão instalada (2.1.236 / 2.1.267) ele redige para `mcp_tool`, igual às
métricas redigem para `custom`. Medido: ~85% dos tokens de MCP caíam num balde
anônimo. Não existe nome real de MCP em lugar nenhum da telemetria OTel.

**A fonte de verdade estava sendo desperdiçada.** O evento de log
`claude_code.api_request` já traz custo e tokens exatos *por requisição*, com
modelo, effort, skill, origem, sessão e prompt. O dashboard lia o Prometheus,
cujos contadores por sessão exigem `max_over_time` e nunca dão o total exato da
janela.

**O join com MCP existe fora do OTel.** Os transcripts locais têm o nome real e
um `requestId` que casa 1:1 com o `request_id` do `api_request`.

## Decisões

### 1. Loki (`api_request`) vira a fonte de todos os painéis

O Prometheus continua ingerindo (retenção longa, barata, e é dele que sai a
lista de contas para o gerador), mas saiu dos painéis. Mata o `max_over_time` e
dá granularidade por requisição.

**Alternativa descartada:** aposentar o pipeline OTel e usar só transcripts.
Eles têm tudo, mas perderíamos o `cost_usd` já calculado pela Anthropic (seria
preciso precificar por modelo na mão) e o tempo real.

### 2. transcript-exporter como segunda fonte, não substituta

**Alternativa descartada:** hook `PostToolUse` emitindo o nome real. É tempo
real e não depende do formato do JSONL, mas adiciona latência em *toda* chamada
de ferramenta, não é retroativo, e um hook lento degrada a sessão inteira.

**Atribuição de tokens:** o custo de uma ferramenta é o lado de entrada da
próxima mensagem do assistente — o que o modelo pagou para ler aquele resultado.
`cache_read` fica fora: interessa o custo marginal da chamada, não o arrasto nos
turnos seguintes. Isso faz o número divergir bastante do
`claude_code_token_usage_tokens_total` do Prometheus para o mesmo servidor; são
medidas diferentes, e só esta responde "quanto essa ferramenta me custou".

**Deduplicação por `tool_use_id`:** retomar uma sessão faz o Claude Code
reescrever o histórico inteiro num transcript novo — mesmo `request_id`, mesmo
`tool_use_id`, `session_id` diferente. Sem filtrar, cada retomada reconta todas
as ferramentas da sessão original. O mapa de deduplicação é semeado a partir do
próprio Loki quando está vazio, o que também torna a perda do volume de estado
inofensiva.

### 3. As gauges medem tokens novos, não tokens brutos

`cache_read` é ~97% do volume. Incluí-lo cravaria as gauges em 100%
permanentemente — a referência anterior (50M/5h) já estava em 145% no momento da
medição. As gauges usam entrada + saída + criação de cache.

> **Recalibrado depois.** Este documento chegou a registrar 5M/5h e 50M/7d. Esses
> números vieram de janelas MÓVEIS, que se mostraram a medida errada: a Anthropic
> usa bloco de 5h que reseta e semana com dia fixo. Com as janelas corretas, a
> calibração contra um `/usage` real (15% no bloco, 26% na semana) deu
> **1.750.000 por bloco de 5h e 21.500.000 por semana** — que é o que está em
> `grafana/account-limits.json`, a fonte de verdade. O limite varia por plano, por
> isso é por conta.

As janelas são fixas e ignoram o seletor de tempo: são janelas de limite, não de
análise.

### 4. O P75 é calculado pelo gerador, não pelo Grafana

O LogQL não calcula quantil de agregado: dá para tirar quantil dos valores
individuais, não dos baldes horários que o gráfico desenha.

**Alternativa descartada:** a transformação *Config from query results* do
Grafana alimentando um threshold dinâmico. Exigiria uma query que o LogQL não
sabe fazer.

O `dashboard-generator` já roda a cada 60s; ele calcula o P75 horário por conta
e injeta como threshold. O valor varia muito entre contas (473k vs 1,22M
tokens/h nas contas medidas), o que confirma que precisa ser por conta.

### 5. Skill deixa de ser um eixo solto

O painel de investigação cruza skill × modelo × effort × origem numa tabela só.
Um total por skill esconde exatamente a variável que explica o custo. Na prática
a mesma skill aparece barata em `repl_main_thread` e cara em
`agent:builtin:general-purpose` — a skill não é cara, os subagentes dela é que
são.

## O que ficou de fora, e por quê

**A coluna "vs. mediana histórica".** A ideia era comparar cada execução contra
a mediana da própria célula (skill+modelo+effort), acendendo só o anômalo. Exige
agregação em dois níveis: somar por execução e depois tirar a mediana dessas
somas. O LogQL não faz, e o caminho via transformações do Grafana precisaria de
um self-join por chave composta, que não existe sem plugin.

A tabela entregue resolve a parte que importava — as variáveis de confusão
ficam visíveis ao lado do custo. Para ter o desvio contra a mediana seria
preciso um job que precompute o rollup por execução. Não foi construído.

**Os 21 painéis removidos.** Tempo ativo, tokens/min, throughput, custo
acumulado por sessão, as tabelas de 90d, linhas de código. Nenhum deles
respondia a uma pergunta que levasse a uma ação.

## Limitação conhecida

O formato do JSONL de transcript não é documentado e pode mudar entre versões do
Claude Code. O exporter ignora linha que não parseia e segue; uma mudança de
formato se manifesta como o painel de MCP parando de crescer, não como erro.
