# Project name

FormProof

# Tagline

A local-first PDF form workbench where agents stage evidence-backed values and people retain consent, exact review, artifact choice, and export.

# About the project

## Inspiration

PDF forms are a poor fit for visual guesswork: field names can be opaque, allowed values can be constrained, and rewriting protected or active-content documents can invalidate rights or signatures. FormProof explores how WebMCP can give an agent a typed, page-owned interface while keeping consequential choices with the person using the form.

## What it does

FormProof loads a fillable PDF locally in the browser, inspects its fields and protection state, and lets an agent propose evidence-backed values without approving or exporting anything. The original PDF is never mutated. Depending on the document, the person can produce a new filled derivative or a Fill package that leaves the source PDF untouched.

The six WebMCP tools are:

- `get_pdf_protection` reads protection, content-risk, mutation, and export-strategy metadata without field-data consent.
- `get_form_context` discovers a byte-bounded page of field metadata after consent.
- `get_field_evidence` reads exact values, choices, geometry, provenance, and human-lock state after consent.
- `stage_form_values` atomically stages a bounded batch of proposals.
- `validate_fill_plan` reports validation issues and available review artifacts.
- `start_fill_review` opens the exact staged plan in the visible review UI.

Within the WebMCP tool surface, the agent can inspect, stage, validate, and open review. Only the person can grant or revoke field-data consent, correct and lock values, confirm exact changes, choose the artifact, acknowledge protection loss, approve, and export. Every field-related request is bound to a document session, source SHA-256, and state version.

## How we built it

The application is written in React and TypeScript, built with Vite and Vinext, styled with Tailwind CSS and Base UI/shadcn components, and uses `pdf-lib` for PDF processing. The deployment integration uses OpenAI Sites and the Cloudflare Vite plugin/Workers runtime. WebMCP definitions expose closed, bounded schemas, and the state engine binds consent, proposals, review, approval, and output receipts to the current source and revision.

## Challenges we ran into

The hardest part was preserving usefulness without overstating authority. PDF protection, signatures, XFA, active content, embedded payloads, ambiguous field labels, and human-only fields all need different treatment. We also had to keep tool results within byte budgets, prevent stale calls from crossing document sessions, preserve human corrections against later agent staging, and make imported Fill package proposals explicitly untrusted.

## Accomplishments that we're proud of

FormProof registers exactly six WebMCP tools while leaving approval and export outside their tool surface. The repository has 310 passing local tests, 46 deterministic `messages + expectedCall` cases, and a no-model Chrome Browser smoke suite that exercises all six tools plus consent and state boundaries. CI runs the test, typecheck, project lint, formatting, deterministic evaluation, Codex result-contract verification, build, and Chrome smoke gates.

The security review status note dated 2026-09-01 records SEC-01, SEC-02, SEC-04 through SEC-08, ROB-01, and PRIV-01 as addressed or fixed; TM-01 is scoped to the WebMCP tool surface, and DEPLOY-01 is verified on the live origin. SEC-03 is mitigated by a bounded preflight in a terminable worker, with export paths still re-parsing on the main thread. HARD-01, a cumulative staged-value budget hardening item, remains open.

## What we learned

A safe agent workflow needs more than a tool schema. It needs explicit authority boundaries, session-scoped consent, exact evidence, compare-and-swap state binding, visible human review, source-bound artifacts, and evaluation layers that say both what they prove and what they do not prove.

## What's next

Next steps are to measure and address the HARD-01 cumulative budget, move the remaining export re-parse paths covered by SEC-03 off the main thread, and publish a full 18-run Codex live evidence release only after it satisfies the repository's result contract.

# Built with

React 19, TypeScript 5, Vite 8, Vinext, Tailwind CSS 4, Base UI, shadcn, pdf-lib, WebMCP, OpenAI Sites, Cloudflare Workers, webmcp-evals

# Testing instructions for judges

## ChatGPT built-in browser path

1. Enable site tools for `formproof-webmcp.skywalker1226.chatgpt.site`.
2. Open the full live URL: [https://formproof-webmcp.skywalker1226.chatgpt.site](https://formproof-webmcp.skywalker1226.chatgpt.site).
3. Confirm that the two-page synthetic demo loads, then turn on **Allow agent field access for this PDF**.
4. Paste the suggested prompt below into the agent.
5. After the agent opens review, continue with the human-only steps below.

## Chrome flag path

Start Google Chrome with the experimental `--enable-features=WebMCP` flag, open [https://formproof-webmcp.skywalker1226.chatgpt.site](https://formproof-webmcp.skywalker1226.chatgpt.site), reload if needed, enable **Allow agent field access for this PDF**, and use the same prompt. The repository's Browser smoke suite was verified with Google Chrome 152 using this flag.

## Suggested prompt

```
Inspect this PDF form. Stage these values and cite the evidence for each: legal name "Avery Chen", email "avery@example.test", preferred contact "Email", permission to contact = yes, current housing "rent", requested support "Rent assistance" and "Utilities", context for reviewer "Temporary rent support requested while a new work schedule begins." Then validate the plan and open review. Stop there: I will confirm each value, choose the output, and export myself.
```

## What to look at

- Field-data consent is off by default and resets on every PDF load.
- The tool-status badge reports six WebMCP tools when registration succeeds.
- The review queue shows the before/after value, confidence or review status, and supporting evidence for each staged proposal.
- The exact-review dialog binds the source hash, plan hash, and revision.
- A human correction is labeled **Human locked** and cannot be overwritten by later agent staging in that session.
- The artifact choice distinguishes a rewritten PDF from a Fill package that leaves the original PDF untouched.

## Human-only steps

The person must grant consent, inspect and correct proposals, confirm or reject each exact change, complete any human-only item, choose the output artifact, acknowledge any required protection loss or content risk, approve the exact plan, and trigger export. None of those approval or export actions is exposed as a FormProof WebMCP tool.

The bundled demo and evaluation fixtures contain synthetic data only. Do not enter real personal information in a public demonstration or shared evaluation transcript.

# Links

- Live app: [https://formproof-webmcp.skywalker1226.chatgpt.site](https://formproof-webmcp.skywalker1226.chatgpt.site)
- Repository: [https://github.com/Caleb0796/formproof-webmcp](https://github.com/Caleb0796/formproof-webmcp)
