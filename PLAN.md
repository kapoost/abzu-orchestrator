# Plan B — Abzu (orchestrator AdCP)

> **Abzu** = orchestrator (buyer-side / caller w terminologii AdCP). Pierwszy publicznie testowany agent w roli buyer-side w ekosystemie AdCP, z pełną integracją governance i własnym GUI (Sam · Jordan · Sponsor). Cel: zamknąć pętlę **brief → plan → discovery → check → buy → delivery → audit** end-to-end na żywym sellerze (`purrsonality-seller.fly.dev`) i własnym governance agencie.

**Stack:** TypeScript, `@adcp/sdk` 9.x, Astro+Cloudflare Pages dla GUI (spójność z purrsonality), Fly.io dla Abzu MCP backend (spójność z seller).

**Repo layout:**
```
agents/abzu/
  src/
    orchestrator/    # caller engine: discovery, planning, execution
    strategy/        # LLM strategy layer (brief → product ranking, proposal evaluation)
    mcp/             # opcjonalny MCP server po stronie Abzu (driving by operators)
    governance/      # client do governance agenta
  gui/               # Astro app (Sam/Jordan/Sponsor views) — albo osobny apps/abzu-gui/
  storyboards/       # własne storyboardy testowe (caller-side scripts)
  PLAN.md            # ten plik
```

---

## Workstreamy (mogą lecieć równolegle)

### WS-B0 — Repo bootstrap (Mira · 1 dzień, blocker dla wszystkich pozostałych)

- `agents/abzu/` jako pnpm workspace pod root `adcp/` (jeśli root nie jest workspace — wtedy standalone)
- TypeScript strict, ESM, vitest
- `@adcp/sdk@9.x` jako dependency, lock do tej samej minor co seller cache 3.1.0
- Skeleton `index.ts` + `package.json` + `tsconfig.json` + `vitest.config.ts`
- CI: GitHub Actions z `lint+typecheck+test+build` matrycą Node 20/22

**Definition of done:** `pnpm test` przechodzi z pustym test'em, `pnpm build` produkuje `dist/`, hello-world Express listening na `:8787`.

**Mira-Chen wymusza:** granica L3 (SDK robi protokół) vs L4 (my robimy biznes). Nie wsiąkamy w L0-L3.

---

### WS-B1 — Orchestrator core (Mira+Maruda · 4 dni, niezależny)

#### B1.1 Discovery
- `ADCPMultiAgentClient` z listą znanych sellerów (config-driven, na start: `purrsonality-seller.fly.dev`)
- Helpery: `list_creative_formats`, `list_authorized_properties`, `get_adcp_capabilities` cache'owane per agent
- Walidacja capabilities: zignoruj sellerów którzy nie wspierają wymaganych narzędzi

#### B1.2 Planning
- Brief intake schema (Zod) — kompatybilna z `test_rfp_response` input (advertiser, brief, budget, flight, channels, formats, audience, kpis)
- Plan resolver: brief → lista wywołań `get_products` per seller (z opcjonalnym `signal_id` z signals provider)
- Proposal evaluator: zbiera produkty od N sellerów, scoruje (KPI fit · price · format match), zwraca top-N

#### B1.3 Execution
- Pre-buy: `check_governance` (z WS-B2) z payloadem `create_media_buy` — handler na findings (must/should/may)
- Buy: `create_media_buy` z propagacją `governance_context` z findings
- Post-buy: `report_plan_outcome(outcome=completed)` natychmiast po sellera confirmacji buy
- Pull-loop: `get_media_buy_delivery` co X minut (konfigurowalne), `report_plan_outcome(outcome=delivery)` do governance

#### B1.4 Creative attach
- `sync_creatives` — przyjmuje creative payload od operatora (S1 mocked w GUI, S2 z creative provider)
- Lifecycle: pending → approved → live, polling/webhook

**DoD:** test integracyjny z `purrsonality-seller.fly.dev`: brief → get_products → mock check → create_media_buy → confirm media_buy_id → get_delivery (zwraca delivery dla zaplanowanej kampanii).

**Maruda wymusza:** pamiętamy `#2300` (responseEnhancer bypass) i `#2303` (sync_accounts blanket-skip) — czy w 9.x są zaszyte workarounds, czy potrzebujemy lokalnych guard'ów po stronie callera. Wyciąg gotchas z `adcp-client/CHANGELOG.md` przed kodowaniem.

---

### WS-B2 — Governance agent (Mira+Ghost+Harvey · 5 dni, niezależny od B1)

Pierwszy AdCP-aligned governance agent w naszym posiadaniu. Subject pod compliance `governance-spend-authority` + `governance-delivery-monitor`.

#### B2.1 Tools (MCP server)
- `sync_plans(plans[])` — rejestracja planu z budżetem, flight, country, brand, reallocation_threshold
- `check_governance(plan_id, caller, tool, payload)` — zwraca `verdict + findings + governance_context`
- `report_plan_outcome(plan_id, governance_context, outcome, ...)` — commit + delivery tracking
- `get_plan_audit_logs(plan_ids[], include_entries)` — pełen ledger

#### B2.2 Policy engine
- **Budget policy:** authority_limit per agent, plan budget cap, reallocation_threshold
- **Property policy:** approved/excluded publisher categories (z `brand.json`)
- **Regulatory policy:** seeded reg-set ze spec (US FHA/ECOA/EEOC/COPPA, EU DSA, GDPR Art 9) — read-only na start
- **Content standards:** stub, integracja w iteracji 2

#### B2.3 Modes (crawl/walk/run)
- Konfiguracja per plan: `audit | advisory | enforce`
- `audit`: zawsze approved, ale finding'i wyloguj
- `advisory`: realny verdict zwracany, ale callery mogą traktować non-blocking
- `enforce`: must = blocker, twarde stopnie

#### B2.4 Escalation
- Must-severity finding → async task (status `submitted → working`)
- Webhook do GUI (WS-B3) — Jordan dostaje kartę
- Resolution: GUI write → governance task resolved (approved + conditions, lub denied)

#### B2.5 Storage
- SQLite (modernc.org/sqlite jeśli Go; better-sqlite3 jeśli TS) — plan store + audit log
- Append-only events, kompozyt indeksów po plan_id+timestamp
- Backup: do `R2` snapshot dziennie

**DoD:** lokalny `governance.abzu.example` przechodzi vlasne storyboardy (3 minimalne: `governance_approved` happy, `governance_denied` hard stop, `governance_conditions` z eskalacją do GUI hook).

**Harvey kontrola:** plany budżetowe = umowy. Audit log musi mieć dla każdego entry: who (principal), when (ISO8601 UTC z millisek), what (tool+payload hash), why (finding refs), under what authority (policy_id). GDPR Art 22: jeśli brand jest w jurysdykcji EU → Annex III check przed `enforce`.

**Ghost kontrola:** kto autoryzuje wpis do governance? RFC 9421 podpis od orchestrator'a per tool call. Bez podpisu — reject z 401. Lista zaufanych callerów per plan.

---

### WS-B3 — GUI (Eleanor+Zara · 6 dni, blokowany przez B1+B2 dla pełnej funkcjonalności, ale mockowalny od dnia 1)

Trzy widoki, jeden app:

#### B3.1 Sam (operator)
- **Brief composer:** form z polami AdCP RFP schema (advertiser, brief NL, budget, flight, channels, formats, audience, KPIs), upload PDF→parsing przez LLM
- **Plan dashboard:** lista aktywnych planów, status (proposed/active/completed), budget burndown
- **Proposal review:** Abzu zwraca top-N produktów z N sellerów — Sam wybiera/odrzuca, Abzu wykonuje
- **Override:** Sam może wymusić ponowne `get_products` z innym briefem lub manual product pick

#### B3.2 Jordan (governance reviewer)
- **Escalation queue:** must-severity findings czekające na decyzję (sortowane po priority + age)
- **Finding card:** plan context, payload, policy które flagnęło, suggested resolution
- **Action:** approve / approve+conditions / deny — z polem na przyczynę
- **Policy editor:** edycja policies per brand (read-only w MVP, edycja w iter 2)

#### B3.3 Sponsor (read-only)
- **Live dashboard:** spend vs budget, impressions, delivery per seller, KPI tracking
- **Per-campaign drill-down:** audit timeline (plan registered → checks → buy → delivery)
- **Export:** CSV/PDF report

#### B3.4 Auth
- Magic-link login (resend.com lub similar) — MVP single-tenant, multi-tenant w iter 2
- Role-based ACL: sam_operator | jordan_reviewer | sponsor_readonly

#### B3.5 Stack
- Astro + Cloudflare Pages (spójność z purrsonality)
- Tailwind + shadcn/ui (terse, czytelne tabele)
- Realtime: SSE z Abzu backend dla escalation queue + delivery updates
- Persistencja: D1 (CF SQLite) dla preferences/sessions, governance trzyma plany u siebie

**DoD:** lokalny `localhost:4321` z trzema rolami przez query-param `?role=sam|jordan|sponsor`, integracja z lokalnym Abzu MCP i governance MCP, mockowane dane jeśli backendy down.

**Eleanor wymusza:** information density bez visual noise. Audit log to tabela, nie żaden "fancy timeline." Color tylko dla severity (must=red, should=amber, may=blue). Brak emojis.

**Zara wymusza:** LLM w briefie tylko jako "extract structure from PDF" — nie jako "wymyśl mi briefa." Halucynacje w briefie = błędna kampania. Strict schema validation post-LLM.

---

### WS-B4 — Multi-seller fan-out (Tomas · 3 dni, niezależny po B1.1)

- Konfiguracja `sellers.yaml` z listą sellerów (URL + auth + opcjonalne tagi: kraj, kategoria, lang)
- Równoległe `get_products` z timeoutem per seller, partial results jeśli >50% sellerów odpowiedziało
- Aggregator: deduplikacja produktów (po property_id), ranking cross-seller
- Cross-seller dedup w delivery (event_dedup_flow scenario)
- Pacing per seller — Abzu pilnuje że żaden seller nie dostarcza więcej niż jego share

**DoD:** test z `purrsonality-seller.fly.dev` + `test-agent.adcontextprotocol.org/sales/mcp` jako dwa sellery; brief idzie do obu, Abzu agreguje, GUI Sam'a pokazuje N proposali z M sellerów.

**Tomas wymusza:** fan-in pattern. Backpressure (jeśli seller padł — circuit breaker). Logi rankingu obserwowalne (Sam musi rozumieć czemu produkt X wygrał z Y).

---

### WS-B5 — Compliance & RFC (Axel+Hermiona · post-MVP, 2-3 tyg)

#### B5.1 Storyboardy własne (caller-side)
Definiujemy własną kategorię `orchestrator_agent` w `agents/abzu/storyboards/`. Format zgodny z `compliance/cache/.../universal/storyboard-schema.yaml`. Subject pod test: Abzu.

Storyboardy MVP (7):
1. `abzu_governance_approved` — happy path
2. `abzu_governance_denied_recovery` — Abzu redukuje i retryuje
3. `abzu_governance_escalation` — must → human → conditions → buy
4. `abzu_signal_driven_discovery` — signals.purrsonality → get_products z signal_id
5. `abzu_async_buy_lifecycle` — async polling poprawne
6. `abzu_delivery_reporting` — pull from seller, push to governance
7. `abzu_seller_impairment` — seller down → degraded mode

#### B5.2 Governance compliance
Abzu's governance side ma przejść:
- `governance-spend-authority/denied` ✅
- `governance-spend-authority/index` (escalation+conditions) ✅
- `governance-delivery-monitor/index` ✅

Run via `mcp__aao__evaluate_agent_quality` dla `governance.abzu.example`.

#### B5.3 RFC do upstream
Draft do `adcontextprotocol/adcp`: propozycja **`interaction_model: orchestrator_agent`** z compliance trackiem `buyer_governance_loop`. Abzu jako reference implementation. RFC template w `docs/governance/rfc-process.mdx`.

**Axel wymusza:** każdy storyboard musi mieć "sabotage assertion" — co psujemy żeby sprawdzić że pasuje (np. seller zwraca `must` findingsa → Abzu nie wykonuje buy). Behavior, not implementation.

**Hermiona wymusza:** każdy storyboard generuje wpis w `docs/abzu/scenarios/`, indeks zawsze świeży, brak orphan'ów.

---

### WS-B6 — Deploy (Conductor · 2 dni, blokowany przez B1+B2 dla prod)

- **Abzu MCP backend:** `abzu.fly.dev` (Fly.io, spójność z seller)
- **Governance agent:** `governance.abzu.fly.dev` (osobny apps Fly)
- **GUI:** `abzu.pages.dev` (Cloudflare Pages, custom domain `abzu.rocketscience.pl`)
- Secrets: Fly secrets dla Abzu+governance API keys, CF dla GUI session secret
- Blue-green dla Abzu (zero downtime przy bump SDK)
- Rollback procedure: `fly deploy --image=prev-sha`

**Conductor wymusza:** każdy WS musi mieć rollout plan ZANIM merge do main. Bez planu rollback'u nie deploy'ujemy.

---

## Persony — kto czego pilnuje (RACI)

| WS | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| B0 bootstrap | Mira | kapoost | — | wszyscy |
| B1 orchestrator | Mira+Maruda | kapoost | Tomas (data flow) | Axel |
| B2 governance | Mira+Ghost | kapoost | Harvey (compliance), Yuki (audit visibility) | Axel |
| B3 GUI | Eleanor+Zara | kapoost | Mira (API contract) | Sam-personas |
| B4 fan-out | Tomas | kapoost | Mira | Axel |
| B5 storyboards+RFC | Axel+Hermiona | kapoost | Lukasz-Mazur (contrarian on RFC), Hermes (decision) | upstream |
| B6 deploy | Conductor | kapoost | Mira | Maruda |

**Narady kontrolne:**
- **Pre-flight** (przed B0): Mira+Maruda+Tomas+Ghost — review tego planu, czerwone flagi
- **Mid-sprint** (po B1+B2 done): Axel — co psuje, co jeszcze nie ma testów
- **Pre-launch** (przed B6 prod): Hermes — RAPID czy ship, Lukasz-Mazur — kontra przed shipem
- **Post-mortem** (T+2 weeks): Yuki — co widzimy w logach, co nas zaskoczyło

---

## Timeline (4-6 tyg, 1 deweloper)

```
Tydzień 1:  B0 (1d) → B1 (4d, zaczyna od dnia 2)
            B2 (5d, zaczyna od dnia 2, równolegle do B1)
            B3 (mocked, zaczyna od dnia 2 z mock data)
Tydzień 2:  B1 done, integracja z B2 done
            B3 wired do realnych backendów
            B4 (3d, po B1.1)
Tydzień 3:  B3 finalizacja, manual QA, fixy
            B6 staging deploy
Tydzień 4:  B5 storyboardy (top 3 MVP)
            B6 prod deploy
Tydzień 5-6: B5 reszta storyboardów + RFC draft
            soft-launch z jednym brand (kapoost-demo)
```

## Krytyczne decyzje pre-flight (do narady)

1. **Czy Abzu eksponuje MCP w MVP?** — Argument za: spójność z Swivel'em, agencje mogą drive'ować Abzu jako narzędzie. Argument przeciw: scope creep, GUI wystarczy w MVP. Rekomendacja: **nie** — odłożyć do iter 2.

2. **Governance jako osobny `agents/governance/` czy podpakiet `agents/abzu/governance/`?** — Argument za rozdziałem: spec wymaga separation of duties, nie chcemy że Abzu kontroluje swoje sandalom. Argument za współlokacją: jeden deployment, jeden release cycle. Rekomendacja: **osobno** (`agents/governance/`), wspólny monorepo, osobne fly app.

3. **LLM model dla strategy layer** — Claude Sonnet 4.6 vs Opus 4.7 vs Haiku 4.5. Strategy = brief→ranking. Rekomendacja: Sonnet 4.6 dla ranking, Opus 4.7 tylko dla refinement gdy Sam prosi.

4. **Brand registry source-of-truth** — `brand.json` lokalne, czy AAO `resolve_brand`. Rekomendacja: lokalne `brands/kapoost-demo.json` na MVP, AAO consume w iter 2.

5. **Webhook receiver dla async tasks** — Abzu musi mieć publiczny endpoint do odbioru webhook'ów od seller'a (governance approved, delivery updates). Wymaga URL publicznego (fly), nie zadziała na localhost bez tunelu. Rekomendacja: ngrok w dev, fly w staging.

---

## Out of scope dla MVP (do iter 2+)

- Veles attestor integracja (per uzgodnienie)
- Multi-tenant accounts (single brand kapoost-demo)
- Sponsored Intelligence buy flow
- Creative provenance C2PA enforcement
- Brand-safety content classifier (LLM-driven brand suitability)
- Counter-offer negotiation (Abzu pisze do sellera „za drogo, daj -15%")
- Cross-brand portfolio optimization
- Reporting export do CRM/BI (Twenty, Metabase)
- Cron-driven plan refresh (auto-rebid)

---

## Definition of done dla całego Plan B

- Abzu uruchamia kampanię $X na `purrsonality-seller.fly.dev` z Sam'em w GUI
- Sam composuje brief, Abzu robi discovery, scoring, sam pyta o approval lub puszcza
- check_governance flaguje must-severity przy przekroczeniu limitu, Jordan otrzymuje task, zatwierdza, kampania rusza
- Delivery raportowana co X min, dashboard sponsor'a aktualny
- 6-month-later: audit log retrievalny po plan_id
- AAO `evaluate_agent_quality` na governance agent: 3 minimum tracki pass
- RFC draft otwarty w upstream (lub decyzja: parking, jak storyboards w pamięci `project_adcp_storyboards_parked.md`)

