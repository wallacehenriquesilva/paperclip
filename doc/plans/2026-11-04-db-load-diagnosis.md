# Diagnóstico de carga do banco de produção — 2026-11-04

Instância: `paperclip-production-db` (RDS PostgreSQL, db.m7g.large — 2 vCPU, 8 GB RAM).

## Sintoma (CloudWatch, 18:00–20:45 UTC)

| Métrica | Valor | Leitura |
|---|---|---|
| DBLoad | ~10–12 sessões ativas | ~6× o nº de vCPUs (`DBLoadRelativeToNumVCPUs` ≈ 6) |
| DBLoadCPU / DBLoadNonCPU | ~0,6–1,2 / ~10–11 | quase toda a carga é **espera**, não CPU |
| CPUUtilization | 40–50% | CPU não é o gargalo |
| ReadIOPS / ReadThroughput | ~3 mil/s / ~34 MB/s | leitura de disco constante |
| DiskQueueDepth | 20–37 | fila de I/O |
| ReadLatency | 4–7 ms | |

A carga caiu para ~1,4 entre ~18:05 e 18:40 e voltou às 18:45, junto com uma queda nas
conexões (10 → 8 → 10): ela vem do trabalho contínuo de UI/agentes, não de uma request pontual.

## Método

O role SSO MARTECH não tem acesso ao Performance Insights (`pi:DescribeDimensionKeys` negado).
Diagnóstico feito com consultas **somente leitura** às views de estatística do Postgres, rodadas de
dentro do container de produção via SSM (`docker exec … node script.mjs` usando o driver `postgres`
do app, `statement_timeout` 10s):

- `pg_stat_activity`: 10 amostras a cada 1,5 s das queries ativas e seus wait events;
- `pg_stat_user_tables` / `pg_statio_user_tables`: scans sequenciais e blocos lidos do disco;
- `pg_stat_statements`: **não instalado** neste banco.

Cache hit geral: 98,55%. Os ~1,5% de miss em cima de um volume enorme de leituras são o que
satura o disco.

## Resultado — quem ocupa o banco

Distribuição das ~130 sessões ativas amostradas:

| % | Query | Wait events | Origem |
|---|---|---|---|
| **~57%** | Listagem de issues (`issueListSelect` … `ORDER BY priority, canonicalLastActivityAt`) | `IO:DataFileRead`, `IPC:MessageQueueSend` (parallel scan), `IO:BufFileWrite` (sort em disco) | `server/src/services/issues.ts` → `list()` |
| **~31%** | `heartbeat_runs where company_id = $1 and context_snapshot ->> 'issueId' = $2` | `IPC:BufferIO`, `IO:DataFileRead` | `server/src/services/heartbeat.ts` (~5389, 5689, 8633, 9162) |
| **~9%** | `agent_wakeup_requests where company_id = $1 and idempotency_key = $2 and status in (…)` | `IO:DataFileRead` | `recovery/successful-run-handoff.ts:267`, `recovery/run-liveness-continuations.ts:77` |

### 1. Listagem de issues (principal)

- Cada chamada leva **9–10 s**; 2–3 rodam ao mesmo tempo o tempo todo.
- Chamada pela UI (inbox `touchedByUserId=me`, listas por status, sub-issues `parentId=`) e por
  agentes (~85 chamadas em 10 min).
- A ordenação usa "última atividade" = `GREATEST(updated_at, max(comment), max(activity_log))`,
  calculada com **duas subconsultas correlacionadas por issue que bate no filtro**. A empresa
  `577031e5` tem **146 mil issues** → ~290 mil subconsultas por request.
- Pior: a query ordenava a **linha larga inteira**, incluindo o preview da descrição
  (`convert_to(description …)`), o que obriga o banco a ler o texto TOAST de todas as issues
  candidatas e a fazer o sort em disco (`BufFileWrite`). A tabela `issues` tem 1,5 GB, a maior
  parte em TOAST (631 M blocos TOAST lidos do disco desde o último reset).

Volume por empresa: `577031e5` 146k, `f0273d0c` 98k, `c0e08d60` 97k, `016d617f` 27k, `f6d9bdef` 25k.

### 2. Runs por issue

O índice parcial `heartbeat_runs_company_context_issue_id_idx` existe e é usado (670k scans), mas
a query traz o `context_snapshot` inteiro (JSONB grande, em TOAST) de uma tabela de **9,2 GB**.
`heartbeat_runs` é a tabela com mais blocos lidos do disco (7,4 bi heap + 2,0 bi TOAST).

### 3. Wakeups por idempotency key

A coluna `idempotency_key` não tinha índice → cada chamada fazia seq scan de
`agent_wakeup_requests` (1 GB, 1,4 M linhas).

### Outros pontos observados (não tratados)

- `issue_documents`: 106 M seq scans, 11 trilhões de tuplas lidas (tabela pequena, 179 MB, quase
  sempre em cache, mas é CPU desperdiçada).
- `secret_access_events`: 55k seq scans, 45 bi tuplas lidas, quase sem uso de índice.
- `projects`, `issue_approvals`, `session`: milhões de seq scans em tabelas minúsculas (barato).

## Correções aplicadas

1. **Listagem de issues em duas fases** (`issues.ts` → `list()`), sem mudar schema:
   1. seleciona só `id` com o mesmo `WHERE`/`ORDER BY`/`LIMIT`/`OFFSET` (sort estreito);
   2. carrega as colunas completas só dos ids da página (≤ 1000) e reordena em memória.
   O resultado é idêntico. Quando não há `limit` (chamadas internas), mantém a query antiga, para
   não montar um `IN` gigante. As subconsultas de "última atividade" continuam e são o próximo
   alvo (ver abaixo).
2. **Índice `agent_wakeup_requests_company_idempotency_key_idx`** em
   `(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL`:
   - criado em produção com `CREATE INDEX CONCURRENTLY` (sem lock de escrita);
   - migration `0101_wakeup_idempotency_key_idx.sql` com `IF NOT EXISTS` (no-op em produção,
     cria normalmente em ambientes novos).

Deploy das correções 1 e 3: imagem `sha256:ee66ecbf…`, restart às 21:30 UTC, saudável às 21:33
(rollback: `:prev` = `sha256:c8b4e83a…`). Índice criado às 21:13 (`CONCURRENTLY`, 123 s, 18 MB).

Primeira medição pós-deploy (CloudWatch, média de 15 min 21:41–21:56 vs. 19:30–21:00): DBLoad
~10 → 4,1; DBLoadNonCPU ~9,5 → 2,8; ReadIOPS ~2.800 → ~1.180/s; DiskQueueDepth ~11 → 2,2;
CPU ~25–42% → ~51%.

## Item 2 — causa real e correção

Deploy: imagem `sha256:4d583451…`, restart às 22:07 UTC, saudável às 22:10
(rollback: `:prev` = `sha256:ee66ecbf…`, a imagem com os itens 1 e 3).

A query amostrada é `getLatestIssueRun` (`server/src/services/recovery/service.ts`):
`… where company_id = $1 and context_snapshot ->> 'issueId' = $2 order by created_at desc, id desc limit 1`.

O `EXPLAIN` em produção mostrou que o planner **não** usa o índice por issue. Ele faz
`Index Scan Backward using heartbeat_runs_company_created_idx` com `Filter` no JSON, ou seja,
percorre as runs da empresa da mais nova para a mais velha, detoastando o `context_snapshot` de
cada uma até achar a issue:

- issue com run recente: rápido (0,7 ms);
- issue cuja última run é antiga, ou **sem runs**: varre as ~900k runs da empresa (9,2 GB com
  TOAST). Foram observadas execuções de **1 a 2,5 minutos** segurando snapshots.

Correção: ordenar por `(created_at + interval '0 seconds') desc`. A expressão impede o planner de
usar o índice por data e o força a usar `heartbeat_runs_company_context_issue_id_idx`, seguido de
um sort minúsculo. Resultado idêntico. `EXPLAIN ANALYZE` em produção:

| Caso | Antes | Depois |
|---|---|---|
| Issue sem runs (pior caso) | varredura da empresa inteira (minutos) | **1,2 ms** |
| Issue mais movimentada (3 dias) | — | 0,04 ms |

As demais queries com `context_snapshot ->> 'issueId'` (heartbeat.ts) filtram por status "vivos",
que têm índice próprio e retornam poucas linhas, então não sofrem do mesmo problema.

Testes: recovery/heartbeat/liveness passam 241/242. A falha (`heartbeat-comment-wake-batching >
promotes deferred comment wakes…`, timeout de 90 s) acontece igual sem a mudança, então já existia.

## Próximos passos sugeridos (não aplicados)

- **Remover as subconsultas de "última atividade" do sort**: guardar `last_activity_at`
  desnormalizado na issue (atualizado em comentário/activity). Exige migration + backfill de
  ~456k linhas. Fazer em lotes e fora do horário, com plano próprio.
- Instalar `pg_stat_statements` no parameter group para ter ranking de queries sem amostragem
  manual. Exige reboot da instância.
- Dar ao role acesso de leitura ao Performance Insights (`pi:DescribeDimensionKeys`,
  `pi:GetResourceMetrics`).
