# RFC: `orchestrator-agent` specialism

> Paste this into a new issue at `adcontextprotocol/adcp` with title `RFC: orchestrator-agent specialism` and the `rfc` label. The body below follows the [proposal template](https://adcontextprotocol.org/docs/governance/rfc-process).

---

## Motivation

AdCP today gives **seller-side** roles a rich vocabulary of declarable specialisms (`sales-non-guaranteed`, `signal-marketplace`, `creative-template`, …) and a seller-perspective view of governance (`governance-aware-seller` — the seller that composes with a buyer's governance agent at `check_governance` time). It also gives **governance-side** agents two declarations covering pre-buy authority and delivery monitoring (`governance-spend-authority`, `governance-delivery-monitor`).

What's missing is the third actor: the **buyer-side orchestrator** that drives the end-to-end loop — brief intake → multi-seller discovery → pre-buy governance check → `create_media_buy` → `report_plan_outcome` → audit query. There is no specialism for this agent and consequently no compliance bundle that verifies the **loop semantics** an orchestrator must satisfy:

- That `check_governance` runs **before** the seller is dispatched (hard gate, not best-effort);
- That `governance_context` from a `denied` verdict prevents `create_media_buy` from firing (no silent allow);
- That `conditions` verdicts surface to the operator with explicit acknowledgement;
- That `report_plan_outcome` is appended for every committed buy (audit completeness);
- That a single seller's impairment does not block the brief (partial-failure resilience).

These invariants are observable but currently grade only as side effects of `governance-aware-seller` (which tests the seller's role in the loop, not the orchestrator's). A buyer agent today can technically participate in AdCP traffic without committing to any of the above — there is no compliance handle on the buyer-side composition contract.

This RFC formalizes the role as a first-class specialism so:
- Orchestrators can advertise the contract on `get_adcp_capabilities`;
- AAO's runner can grade the loop;
- Brand/agency operators picking an orchestrator have a verified compliance surface to read.

A reference implementation is live and passing the proposed storyboard bundle on the public AAO stack — see [Reference implementation](#reference-implementation) below.

## Scope

### 1. Add enum value to `specialism.json`

In `/schemas/source/enums/specialism.json` (and the generated `dist/` equivalents):

```diff
   "enum": [
     "audience-sync",
     "brand-rights",
     "collection-lists",
     "content-standards",
     "creative-ad-server",
     "creative-generative",
     "creative-template",
     "creative-transformers",
     "governance-aware-seller",
     "governance-delivery-monitor",
     "governance-spend-authority",
+    "orchestrator-agent",
     "property-lists",
     ...
   ],
   "enumDescriptions": {
     ...
+    "orchestrator-agent": "Buyer-side campaign orchestrator that composes seller, governance, and signal agents into a brief → plan → check → buy → outcome → audit loop. Required compliance contract: pre-buy governance check fires before any seller dispatch; `denied` verdicts block the buy; `conditions` verdicts surface to the operator with explicit acknowledgement; `report_plan_outcome` is appended for every committed buy; multi-seller partial failures do not block planning.",
     ...
   }
```

### 2. New compliance bundle directory

Create `/compliance/source/specialisms/orchestrator-agent/` containing **five baseline storyboards** that grade the loop semantics. The reference implementation already runs these end-to-end on a live stack; the YAML and validations below are direct ports (subject is `orchestrator-agent` not `media_buy_seller`).

| Storyboard | Validates |
|---|---|
| `governance_approved` | Happy path — brief → check (approved) → buy → outcome accepted → audit ledger has 1 check + 1 outcome |
| `governance_denied_recovery` | Gate fires on over-budget intent (HTTP 4xx semantics on the orchestrator's outward surface; **no** `media_buy_id` returned, **no** seller dispatch). Operator-mediated retry within authority succeeds. Audit shows both attempts |
| `governance_escalation` | `conditions` verdict surfaces to operator; resubmission with explicit `accept_conditions=true` proceeds; audit captures both checks plus the accepted outcome |
| `delivery_reporting` | After buy: pull `get_media_buy_delivery` from seller, push snapshot to governance via `report_plan_outcome(outcome=delivery)`. Audit ledger reflects the new outcome entry |
| `seller_impairment` | With ≥2 sellers configured and one returning an error on capabilities discovery, planning continues with proposals from the responsive seller; diagnostics flag the impaired one; `partial` resilience flag follows the multi-seller threshold |

Storyboard schema follows the existing `compliance/cache/{version}/universal/storyboard-schema.yaml`. Each step asserts behavior, not implementation — orchestrators may expose their loop through MCP tools, an HTTP API, or any other transport; the storyboards validate the **observable contract**, not a specific wire format.

### 3. New docs page

`/docs/agents/orchestrator.mdx` (or `/docs/agents/buyer-side/orchestrator.mdx`) documenting:
- The three-party loop with the orchestrator's responsibilities highlighted
- The five loop invariants listed in [Motivation](#motivation)
- Required and recommended capabilities to consume (`governance`, `media_buy`, optionally `signals`)
- Pointer to the compliance bundle and storyboard set

### 4. Normative text additions

In `/docs/governance/overview.mdx`, add a short section titled **"Buyer-side composition"** that names the orchestrator role and references the new specialism. The existing `governance-aware-seller` section already describes the seller's composition role; this is its buyer-side counterpart.

## Alternatives considered

### (A) Do nothing — orchestrators consume existing specialisms without declaring one

Buyer-side composition is already implicitly validated through `governance-aware-seller` tests (which require a buyer to drive `check_governance`). Adding a specialism could be seen as redundant.

**Rejected.** `governance-aware-seller` tests the *seller's* obligation to call `check_governance` and propagate the verdict; it doesn't test the buyer-side contract that the orchestrator MUST surface conditions to the operator, MUST run multi-seller fan-out with partial-failure resilience, or MUST emit outcome reports. Today an orchestrator can pass through governance-aware-seller flows by being a simple proxy that hands a media buy request to the seller and reads the response — it does not have to enforce the loop semantics on its own surface. Without an orchestrator-side bundle, the loop invariants are unobservable from the registry.

### (B) Generic `buyer-agent` specialism

A broader claim covering any buyer-side AdCP participant — DSPs, single-publisher direct-buy tools, campaign manager UIs, multi-seller orchestrators.

**Rejected.** Buyer agents span a wider design space than this RFC addresses. A DSP doing real-time auction bidding has different obligations (latency budgets, bid-stream conformance) than a campaign-governance orchestrator. A single-publisher direct-buy tool has no multi-seller obligations. Forcing them under one specialism dilutes the compliance contract — what would the bundle test that applies to all three? Better to introduce role-specific specialisms incrementally as they materialize; `orchestrator-agent` is the one with a clear, testable contract today.

### (C) `interaction_model: orchestrator_agent` on agent-card instead of a specialism

PLAN B5.3 of the reference implementation originally proposed this framing. `interaction_model` is a per-agent scalar describing how a single agent participates in a flow; specialisms is a multi-claim enum that AAO uses to route storyboard bundles.

**Rejected.** AAO's compliance runner discovers applicable storyboards by walking `capabilities.specialisms` (per `mcp__aao__evaluate_agent_quality` source). An `interaction_model` value would not be picked up by the existing routing logic; we'd need a separate registration path. Better to use the established mechanism. (If a future RFC introduces `interaction_model` discriminators for orthogonal reasons, this specialism remains independent of that addition.)

### (D) Test the loop only at the seller side via cross-step assertions

The `governance_aware_seller/governance_denied` storyboard already enforces "once a plan is denied, no subsequent step in the same run may acquire a resource for that plan" via the `governance.denial_blocks_mutation` invariant. Could the buyer-side contract piggyback on these?

**Partially.** The invariant tests *what happened to the resource* (the seller didn't issue a media_buy_id), not *what the orchestrator did before the seller call* (whether it consulted governance at all, surfaced findings, captured an outcome). The seller-side test is necessary but not sufficient for grading buyer-side composition. The two surfaces are complementary: keep both.

## Compatibility impact

**Non-breaking.** This RFC is purely additive:

- New enum value in `specialism.json` — readers that don't recognize it default to ignoring (treat as opaque label, per the schema's `enumDescriptions` contract).
- New compliance bundle directory — agents that don't declare `orchestrator-agent` see no change in their AAO grading.
- New docs page — no removal or alteration of existing content.
- The `governance-aware-seller` storyboards are unchanged; no cross-bundle assertion rewrites.

No downstream implementer is forced to update code to keep working. Implementers wanting the new compliance contract opt in by declaring the specialism.

## Reference implementation

A live reference orchestrator is available for protocol review and AAO grading:

- **Governance side** (specialism `governance-spend-authority`): `https://governance.rocketscience.pl/mcp` — passing AAO 3.1 compliance grade: 33/33 core, 18/18 campaign-governance, 6/7 error-handling (the remaining failure is a per-agent commercial gate test whose semantics are sales-side rather than governance-side; classified as false-positive for this role).
- **Orchestrator API** (would declare `orchestrator-agent` if this RFC lands): `https://api.rocketscience.pl` — HTTP surface today; an MCP wrapper is planned for the next iteration so the orchestrator can also be reached through standard AdCP transports.
- **Operator GUI** (Sam/Jordan/Sponsor views): `https://abzu.rocketscience.pl`.

The five proposed storyboards run green against the public stack in ~19 s parallel:

```
Storyboard                       Result  Steps  Validations
abzu_governance_approved         PASS        4  24/24
abzu_governance_denied_recovery  PASS        5  20/20
abzu_governance_escalation       PASS        5  20/20
abzu_delivery_reporting          PASS        5  16/16
abzu_seller_impairment           PASS        2  9/9
Summary: 5/5 runnable PASS
```

Source for the storyboards, the storyboard runner, and the orchestrator itself is offered to the AAO community as a contribution path for the compliance bundle directory.

## Reviewer checklist

- [x] Motivation is clear and not redundant with existing functionality — distinguishes the orchestrator's loop semantics from the seller's role and from `governance-aware-seller`.
- [x] Scope is specific enough to implement without further clarification — names the enum file, the bundle directory, the docs page, and the five baseline storyboards.
- [x] Alternatives section covers at least one non-obvious alternative — (D) addresses the case where seller-side cross-step assertions could be argued to cover the buyer contract.
- [x] Compatibility impact accurately states breaking vs. non-breaking — purely additive enum value + new directory + new docs.
- [x] Wire-format or schema snippet included — diff against `specialism.json` shown in [Scope §1](#1-add-enum-value-to-specialismjson).

## Out of scope (deferred RFCs)

These were considered but excluded to keep this RFC focused:

1. **`async_buy_lifecycle` storyboard** — orchestrator handling of the `submitted` task arm on `create_media_buy`. The reference implementation has the polling logic (`waitForCompletion`) and a documentation-only storyboard, but the live run requires a seller fixture that emits `submitted`, which isn't part of the current reference stack. Add to the bundle when a `submitted`-capable seller fixture lands in the universal storyboards.
2. **`signal_driven_discovery` storyboard** — orchestrator threading a `signal_id` from a signals provider into `get_products`. Requires a signals provider in the test seller registry; defer to a follow-up RFC paired with that fixture.
3. **`buyer-agent` umbrella specialism** — see alternative (B). Worth proposing if/when DSP-side, ad-server-side, or single-publisher buyer agents materialize with their own compliance contracts.

---

## Sample storyboard YAMLs

For reference during WG review, the five baseline storyboards live in the orchestrator-agent reference repo at:

- `storyboards/abzu_governance_approved.yaml`
- `storyboards/abzu_governance_denied_recovery.yaml`
- `storyboards/abzu_governance_escalation.yaml`
- `storyboards/abzu_delivery_reporting.yaml`
- `storyboards/abzu_seller_impairment.yaml`

Each uses the `orchestrator_agent/<scenario>` ID convention and follows the universal storyboard schema. They are runnable against the public reference stack via the runner described in the repo. On acceptance of this RFC the YAMLs will be ported (renaming `orchestrator_agent/` → upstream's `orchestrator-agent/` convention, swapping `http_method` + `http_path` extensions for whichever transport the upstream compliance runner adopts for buyer-side agents).
