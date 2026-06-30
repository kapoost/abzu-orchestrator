# Abzu — Reference Implementation Demo

Pełna pętla AdCP 3.1 **brief → discover → governance check → media buy → delivery → audit** na czterech żywych agentach.

## Aktorzy

| Rola | Agent | URL |
|---|---|---|
| Seller | Purrsonality | `https://seller.purrsonality.rocketscience.pl/mcp` |
| Buyer (orchestrator) | Abzu | `https://api.rocketscience.pl/mcp` (MCP) / `https://api.rocketscience.pl` (HTTP) |
| Governance | Abzu Governance | `https://governance.rocketscience.pl/mcp` |
| GUI | Abzu GUI | `https://abzu.rocketscience.pl/{sam,jordan,sponsor}` |

Wszyscy widoczni publicznie w [AAO registry](https://agenticadvertising.org/dashboard/agents). Seller, signals, governance trzymają badge AdCP 3.1.

## Pre-flight (30s)

```sh
curl -s https://seller.purrsonality.rocketscience.pl/.well-known/healthz
curl -s https://signals.purrsonality.rocketscience.pl/.well-known/healthz
curl -s https://governance.rocketscience.pl/.well-known/healthz
curl -s https://api.rocketscience.pl/ | jq
```

Każdy zwraca `{ok:true,...}`. Abzu zwraca też liczbę zarejestrowanych sellerów.

## Ścieżka A — CLI storyboard (deterministyczny, ~30s)

Najszybsza demonstracja całej pętli end-to-end:

```sh
cd agents/abzu
ABZU_BASE_URL=https://api.rocketscience.pl bun run storyboards/cli.ts governance_approved
```

Oczekiwany output:

```
storyboard: orchestrator_agent/governance_approved
overall: PASS
  [pass] sync_plan      (HTTP 200, 4/4)   — plan zarejestrowany w governance
  [pass] planning_brief (HTTP 200, 6/6)   — Abzu pyta sellera o produkty, ranking
  [pass] buy            (HTTP 200, 8/8)   — governance approves → create_media_buy → outcome
  [pass] audit_query    (HTTP 200, 6/6)   — audit ledger zawiera oba zdarzenia
```

Inne scenariusze (negatywne):
```sh
bun run storyboards/cli.ts governance_denied_recovery   # hard stop
bun run storyboards/cli.ts governance_escalation        # must-severity → human-in-loop
bun run storyboards/cli.ts seller_impairment             # creative rejected → swap
bun run storyboards/cli.ts async_buy_lifecycle           # submitted → working → completed
bun run storyboards/cli.ts delivery_reporting            # delivery snapshots
```

## Ścieżka B — GUI walk-through (publiczność widzi co się dzieje)

**Kolejność JEST ważna** — governance w `enforce` mode wymaga zarejestrowanego planu zanim buy w ogóle dotknie sellera. Jordan najpierw, Sam potem.

1. **Jordan (governance reviewer)** — `https://abzu.rocketscience.pl/jordan`
   - Wypełnij plan form: `plan_id` (np. `demo-2026-06`), budget cap, flight window, brand domain
   - Klik register → Abzu woła governance `sync_plans` → plan **active**
   - Escalation queue: must-severity findings z aktywnych planów (puste w happy path)
2. **Sam (operator)** — `/sam`
   - Pole `plan_id` auto-fill'uje się ostatnim zarejestrowanym planem (z session storage); jeśli pusto — wklej ten sam ID co Jordan
   - Wypełnij brief composer (advertiser, budget ≤ plan cap, flight ⊂ plan window)
   - Submit → Abzu fan'uje po sellerach → ranked proposals
   - Wybierz proposal → Execute buy → governance approves → seller dostaje create_media_buy
3. **Sponsor (audit viewer)** — `/sponsor`
   - Audit ledger per plan: checks, outcomes, budget burndown

### Negatywny scenariusz (też wartościowy do pokazania)

Wejdź na `/sam` BEZ rejestrowania planu w Jordan. Auto-generowany `plan_<timestamp>` poleci do governance, dostaniesz:

```json
HTTP 409 · governance_denied
{
  "findings": [{
    "category_id": "plan_registration",
    "policy_id": "plan.exists",
    "severity": "critical",
    "explanation": "Plan ... is not registered. Call sync_plans first."
  }],
  "mode": "enforce"
}
```

To jest demonstracja governance gate w akcji — zero traffic do sellera, hard stop, audit-grade findings dla audience.

## Inspection points (co pokazać publiczności obok demo)

- **AAO public dashboard**: `https://agenticadvertising.org/dashboard/agents` — 4 agentów Łukasza, badges 3.1, compliance scores
- **AAO live evaluate**: `mcp__aao__evaluate_agent_quality` — pełen storyboard suite (seller 184/193 ≈ 95%)
- **Seller live ad slot**: `https://purrsonality.rocketscience.pl` — quiz cat → wynik → embedded banner z `/live/result-slot` (live creative przez seller's wbudowany adserver)
- **Governance audit log** (raw): `GET https://api.rocketscience.pl/governance/audit?plan_ids=<plan_id>&include_entries=true` — chronologiczny ledger

## Architektura — slide-friendly summary

```
┌─────────────┐   brief    ┌──────────────┐  get_products ┌──────────────┐
│ Operator UI │ ──────────►│     Abzu     │ ─────────────►│  Purrsonality │
│ (Sam/GUI)   │            │ orchestrator │◄────────────  │     Seller    │
└─────────────┘            └──────┬───────┘  proposals    └──────┬────────┘
                                  │                              │
              check_governance    │           create_media_buy   │
              report_plan_outcome │       (w/ governance_context)│
                                  ▼                              │
                          ┌──────────────┐                       │
                          │ Abzu Gov     │                       │
                          │ (audit log,  │                       │
                          │  spend cap)  │                       │
                          └──────────────┘                       │
                                                                 ▼
                                                        live banner
                                                  purrsonality.rocketscience.pl
                                                       (wbudowany adserver)
```

## Co działa, czego nie ma (transparentność)

**Działa:**
- AdCP 3.1 compliance: seller (badge media-buy), signals (badge signals), governance (badge governance-spend-authority)
- Pełen E2E loop (5 storyboardów przechodzi)
- Tri-rola GUI
- Audit ledger
- Live adserver w sellerze (`/live/result-slot`, `/serve`, `/click`)

**Świadomie nie:**
- Pełen katalog produktów sellera (jeden placement — testowy seller, nie real publisher)
- Bragent (SI brand agent) — specialism `sponsored-intelligence` jeszcze nie w AAO catalog
- Veles attestor signing — Phase A wired w sellerze, demo 2026-07-09
- OAuth client_credentials JWT na governance (na razie versioned bearer pattern)
