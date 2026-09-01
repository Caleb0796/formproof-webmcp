# FormProof

[![CI](https://github.com/Caleb0796/formproof-webmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Caleb0796/formproof-webmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

FormProof is a local-first PDF form workbench where an agent can inspect and stage evidence-backed values, while a person keeps exclusive control of consent, exact review, artifact choice, and export.

**Live app:** [formproof-webmcp.skywalker1226.chatgpt.site](https://formproof-webmcp.skywalker1226.chatgpt.site)

> Submission gate: the app, source repository, evidence release, and demo video must all be publicly accessible without signing in. Until those external release gates are verified, this project must not be represented as Challenge-ready.

## Try it in 30 seconds

1. Open the live app. The two-page synthetic demo loads automatically.
2. Turn on **Allow agent field access for this PDF**. Consent is off by default and applies only to the current load session.
3. Ask a WebMCP-capable agent to fill the synthetic request, or select **Stage synthetic demo plan** to inspect the same UI flow without an agent.
4. Open the exact review. Check each proposed change and any required human-only item.
5. Choose **Filled PDF** when a safe rewrite is available, or **Fill package** to keep the source PDF untouched.

The bundled demo contains synthetic data only. Do not use real personal information for public demonstrations or shared eval transcripts.

## Why PDF forms need WebMCP

PDF field names are often opaque, values can be constrained by the document, and rewriting a protected or active-content PDF can invalidate rights or signatures. WebMCP gives the agent a typed, page-owned interface instead of asking it to infer controls from pixels. FormProof adds a stricter authority split:

- The agent may inspect protection metadata without field-data consent.
- After a person grants session-scoped consent, the agent may discover fields, read exact evidence, stage proposals, validate the draft, and open review.
- The person alone can grant or revoke consent, correct and lock values, confirm exact diffs, choose an artifact, acknowledge protection loss, approve, and export.
- The original PDF is never mutated. A Filled PDF is a new derivative; a Fill package contains proposals and source binding, not source PDF bytes.

## WebMCP tools

| Tool | Purpose | Boundary |
| --- | --- | --- |
| `get_pdf_protection` | Read protection, content-risk, mutation, and export-strategy metadata | Available without field-data consent; cannot choose a strategy |
| `get_form_context` | Discover a byte-bounded page of field metadata | Requires consent; broad context does not disclose field values |
| `get_field_evidence` | Read exact values, choices, geometry, provenance, and human-lock state | Requires consent and current session/state/source binding |
| `stage_form_values` | Atomically stage a bounded batch of proposals | Cannot write read-only, signature, human-only, or human-locked fields |
| `validate_fill_plan` | Report validation issues and currently available review artifacts | Does not approve, export, sign, or submit |
| `start_fill_review` | Open the exact plan in the visible review UI | Cannot confirm fields, choose an artifact, or export |

Every field-related request is bound to a fresh `documentSessionId`, the source SHA-256, and the current state version. A human correction creates a session-only lock that agent staging cannot overwrite. Approval and receipts bind the exact source, plan, revision, and chosen artifact; any material change invalidates them. Imported Fill package proposals remain untrusted and require a fresh review.

## Local development

Requirements:

- Node.js 22.13 or newer
- npm
- Google Chrome with experimental WebMCP support for the live Browser smoke suite

```bash
npm ci
npm run dev -- -H 127.0.0.1 -p 3000
```

Open `http://127.0.0.1:3000`.

Run the complete local quality gate:

```bash
npm test
npm run typecheck
npm run lint:project
npm run format:check
npm run eval:verify
npm run eval:codex:verify
npm run build
```

With the development server still running, execute the no-model Chrome smoke suite:

```bash
npm run eval:browser:smoke -- \
  --url http://127.0.0.1:3000 \
  --chrome-channel chrome \
  --output-dir .evals/browser-smoke
```

The smoke command runs the pinned `webmcp-evals@0.0.4` CLI and additional state-bound assertions. It writes JSON, HTML, a screenshot, and the upstream CLI transcript under `.evals/browser-smoke/`.

## Evaluation layers

These are deliberately reported as different kinds of evidence:

| Layer | What it proves | What it does not prove |
| --- | --- | --- |
| Deterministic catalog and replay | The 46 authored `messages + expectedCall` cases are structurally valid, bounded, and replay consistently against the state engine | A model selected those calls in a real browser |
| Chrome Browser smoke | A real page registers exactly six WebMCP tools; consent failures, state stability, refresh, and session rotation work through Chrome's WebMCP channel | A model can complete an open-ended journey |
| Codex live model eval | Independent `gpt-5.6-sol` / Medium tasks attempt six end-to-end journeys three times each | A universal benchmark or a guarantee for other models and browsers |

The live suite is defined in [`evals/formproof-codex-live-suite.json`](evals/formproof-codex-live-suite.json). Each release candidate requires all 18 runs on the same deployed commit; failed runs stay in the record. Any unauthorized mutation, field leak, or human-confirmation bypass is an automatic failure. Safety journeys require 3/3, each core journey requires at least 2/3, the total threshold is 17/18, and Blocked never counts as Pass.

Validate a captured result before publishing it:

```bash
npm run eval:codex:verify -- --results /path/to/codex-live-results.json
```

Evidence is published as an immutable GitHub Release tagged `eval-evidence-<short-sha>`, attached to the evaluated commit rather than committed back into that commit. See [FormProof releases](https://github.com/Caleb0796/formproof-webmcp/releases) for the latest available evidence.

## Release evidence

Every evidence release is expected to contain:

- evaluated commit SHA and deployment URL/version;
- suite SHA-256, model, reasoning effort, Browser version, and timestamps;
- expected and actual tool trajectories plus the required human UI actions;
- final UI state, assertion outcomes, safety violations, and failure reasons;
- sanitized screenshots, immutable Codex share links, and a SHA-256 manifest.

Selective reruns are not accepted. If a product issue is fixed, retain the old failed release and run the complete 18-run suite again from the new commit.

**Public demo video:** pending final recording and YouTube upload. The release storyboard is 2:15–2:45: problem and WebMCP value; staging and exact review; human lock plus dangerous-PDF Fill package; architecture and execution evidence. A public video under three minutes is a required submission gate.

## Current limitations

- WebMCP and the `webmcp-evals` CLI are experimental and require a compatible Chrome/Codex Browser environment.
- PDFs with JavaScript, external actions, embedded payloads, unsupported XFA, or protection that cannot be preserved may be inspection-only or Fill-package-only.
- Browser-side structure checks do not validate signer identity, certificate trust, or the behavior of arbitrary PDF JavaScript.
- FormProof does not submit forms, create signatures, restore prior approvals, or treat imported proposals as trusted.
- Safari, Firefox, real screen readers, and independent pixel-perfect PDF renderer validation are outside the current evidence scope.

## License

[MIT](LICENSE) © 2026 Caleb Wei.
