# DQL Deploy Runbook (Vercel)

Zielumgebung: **`https://dql.thoughtproof.ai`** — companion domain to `sentinel.thoughtproof.ai`.
Stack: Vercel Serverless Functions (Node 20), TypeScript, static OpenAPI.

Dieses Runbook ist das kanonische Setup. Es geht davon aus, dass du in die
ThoughtProof-Vercel-Org deployst und Zugriff auf das Cloudflare-DNS für
`thoughtproof.ai` hast.

---

## 0. Preflight (local)

```bash
git clone https://github.com/ThoughtProof/decision-quality-layer.git
cd decision-quality-layer
npm install

npm run typecheck   # tsc --noEmit
npm test            # 56/56 must pass (hermetic; no live LLM calls)
npm run build       # tsconfig.build.json → dist/
```

Rot? Nicht deployen. Erst grün machen.

---

## 1. Vercel Project erstellen

Einmalig — überspringen falls das Projekt schon existiert.

```bash
# Login (opens browser)
npx vercel login

# Von /decision-quality-layer aus:
npx vercel link
# Choose:
#   Scope       → thoughtproof
#   Link to existing? no
#   Project name → decision-quality-layer
#   Directory    → ./
```

Danach existiert `.vercel/project.json` (nicht committen — steht in `.gitignore`).

**Framework Preset**: Other / no framework. `vercel.json` reicht.
**Root Directory**: repo root.
**Build Command**: `npm run build`
**Output Directory**: leer lassen (nur Functions unter `/api`).
**Install Command**: `npm install`.
**Node Version**: 20.x.

---

## 2. Environment Variables

Setzen für **Production, Preview, Development** (alle drei Environments):

| Name             | Wert                          | Notes                                                                 |
|------------------|-------------------------------|-----------------------------------------------------------------------|
| `DQL_CASCADE`    | `pot-cli`                     | `stub` in Preview reicht, wenn keine Cost verbraucht werden soll      |
| `OPENAI_API_KEY` | `sk-...`                      | Für serv-nano (gpt-4o-mini). ThoughtProof-Org-Key.                    |
| `GROQ_API_KEY`   | `gsk_...`                     | Für serv-swift (llama-3.1-70b-versatile).                             |
| `NODE_ENV`       | `production` (auto)           | Setzt Vercel automatisch, nicht überschreiben.                        |

CLI-Weg (nur Prod):

```bash
npx vercel env add DQL_CASCADE production
npx vercel env add OPENAI_API_KEY production
npx vercel env add GROQ_API_KEY production
```

Verify:

```bash
npx vercel env ls
```

Siehe [`docs/ENV.md`](./ENV.md) für die vollständige Env-Referenz.

---

## 3. Custom Domain

Vercel-Dashboard → Project → Settings → Domains → `Add Domain` → `dql.thoughtproof.ai`.

Vercel gibt dann eine CNAME-Zieladresse aus (typisch `cname.vercel-dns.com`).

Cloudflare-DNS für `thoughtproof.ai`:

```
Type   Name  Content                Proxy    TTL
CNAME  dql   cname.vercel-dns.com   DNS only Auto
```

**Wichtig**: Proxy-Status **DNS only** (grau, kein orange), sonst kollidiert
Cloudflare mit Vercels TLS-Handshake. Genauso wie bei
`sentinel.thoughtproof.ai`.

TLS-Zertifikat wird von Vercel automatisch nachgezogen (LetsEncrypt, meist
< 60 s nach Propagation).

---

## 4. Deploy

**Preview** (jeder git push von einem non-main branch):

```bash
npx vercel
# → https://decision-quality-layer-git-<branch>-thoughtproof.vercel.app
```

**Production** (main branch):

```bash
npx vercel --prod
# → https://dql.thoughtproof.ai (nach DNS-Propagation)
# → https://decision-quality-layer.vercel.app (immer erreichbar)
```

Auto-Deploy: sobald `main` gepusht wird, deployt Vercel automatisch nach Prod
(sofern in den Git-Settings des Projects aktiviert).

---

## 5. Post-Deploy Smoketest

Sequenz gegen die Live-URL. **Alle fünf müssen grün sein**, bevor Spike-40
losgetreten wird.

```bash
BASE=https://dql.thoughtproof.ai

# 5.1  Discovery (index)
curl -s $BASE/ | jq
# expect: name "decision-quality-layer", version "0.2.0",
#         endpoints listed, openapi link.

# 5.2  Health
curl -s $BASE/dql/health | jq
# expect: {"status":"ok","service":"decision-quality-layer","version":"0.2.0",...}

# 5.3  OpenAPI
curl -s $BASE/openapi.json | jq '.info.title, .info.version'
# expect: "ThoughtProof Decision Quality Layer (DQL) API"
#         "0.2.0"

# 5.4  Axis metadata
curl -s $BASE/dql/axes | jq '.axes | length'
# expect: 5

# 5.5  Sandbox verify (free, no LLM cost)
curl -s -X POST $BASE/dql/verify \
  -H 'content-type: application/json' \
  -d '{
    "sandbox": true,
    "mandate": "Book a hotel under $200/night in Berlin",
    "proposed_action": "Book Hotel Adlon at $850/night",
    "reasoning": "It is a well-known hotel in Berlin.",
    "context": {}
  }' | jq '.aggregate.verdict, .axes | length'
# expect: "FAIL" (or "UNCERTAIN"), 5
```

Fehlerbild → siehe § Troubleshooting.

---

## 6. Regression-Run (Spike-40)

**Nur** wenn 5.1–5.5 grün.

```bash
# Local, gegen die Live-Cascade:
export DQL_BASE_URL=https://dql.thoughtproof.ai
export DQL_API_KEY=<falls im Handler geprüft; sonst leer lassen>

npm run scenarios:spike -- --limit 40
# → scenarios/last-run.json
```

Erwartungen (vgl. `docs/SPIKE-RESULTS.md`):

| Metric              | Baseline | Regression-Floor |
|---------------------|---------:|-----------------:|
| Parse-Rate          | 100 %    | 100 %            |
| Axis-Hit-Rate       | 95 %     | ≥ 90 %           |
| Mean pairwise corr  | 0.09     | ≤ 0.20           |

Rutscht eine Kennzahl unter Floor → deploy als **nicht** produktionsreif
markieren, Ursachen in `scenarios/last-run.json` prüfen (per-Case-Verdicts),
ggf. Cascade zurück auf `stub` und rausbugfixen.

Kosten: ~$2 pro Full-Run (40 × 2 LLM calls, gpt-4o-mini + llama-3.1-70b).

---

## 7. Rollback

Vercel-Dashboard → Deployments → letztes grünes Prod-Deploy → `Promote to Production`.
Dauer < 30 s, keine DNS-Änderung.

CLI-Alternative:

```bash
npx vercel rollback
```

---

## 8. Troubleshooting

**`/openapi.json` gibt 404**
→ `vercel.json` rewrite `/openapi.json → /api/openapi` prüfen. `api/openapi.ts`
muss existieren. Redeploy.

**`/dql/verify` gibt 500 mit `cascade_unavailable`**
→ `DQL_CASCADE` env fehlt / falsch. Auf `pot-cli` setzen und Vercel-Deploy
neu triggern (Env-Änderungen brauchen einen Redeploy).

**`/dql/verify` gibt `insufficient_upstream_credit`**
→ `OPENAI_API_KEY` oder `GROQ_API_KEY` invalidiert. Neuen Key setzen, Redeploy.

**TLS-Handshake schlägt fehl auf `dql.thoughtproof.ai`**
→ Cloudflare-Proxy-Status auf **DNS only** stellen (grau, kein orange).
Danach ~2 min warten und erneut curl.

**Spike-40 unter Floor**
→ Nicht panisch redeployen. Erst `scenarios/last-run.json` sichern, dann
Per-Case-Diff gegen das Baseline-JSON (im Repo unter `docs/SPIKE-RESULTS.md`)
laufen. Meist ist es 1–2 gekippte Axes, kein System-Regress.

---

## 9. Ownership

- **Vercel Project Owner**: ThoughtProof-Org (raul.jaeger@gmx.de)
- **DNS**: Cloudflare `thoughtproof.ai`, Zone-Owner ThoughtProof
- **Deploy-Freigabe**: Raul (main-push) + Hermes (manual `--prod`)
- **On-call**: Raul, Fallback Hermes
- **Post-mortem**: bei Prod-Incident innerhalb 24 h in `docs/incidents/YYYY-MM-DD-…md`
