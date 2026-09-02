import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

import {
  approveDraftFromUi,
  correctDraftFieldFromUi,
  createFormFieldDefinitionFromPdf,
  createFormState,
  exportApprovedPdfFromUi,
  exportFillPackageFromUi,
  getChoiceLabelReviewNotice,
  getReleaseGate,
  stageFieldUpdates,
  validateDraft,
  type FieldUpdate,
  type FormFieldValue,
  type FormState,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';
import type {
  ApplyResult,
  PdfChoiceDescriptor,
  PdfFieldValue,
  PdfInspection,
} from '../lib/pdf-engine';
import type {
  FormProofToolResponse,
  FormProofWebMcpAdapter,
} from '../lib/webmcp';

const { inspectPdf } = (await import(
  new URL('../lib/pdf-engine.ts', import.meta.url).href
)) as typeof import('../lib/pdf-engine');
const {
  FORMPROOF_WEBMCP_TOOL_NAMES,
  FORMPROOF_MAX_RESPONSE_BYTES,
  FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  createFieldChoiceCursor,
  createFieldEvidenceToolData,
  createFormContextToolData,
  createFormProofToolDefinitions,
  parseFieldChoiceCursor,
  parseFormContextCursor,
} = (await import(
  new URL('../lib/webmcp.ts', import.meta.url).href
)) as typeof import('../lib/webmcp');
const { formatCount } = (await import(
  new URL('../lib/utils.ts', import.meta.url).href
)) as typeof import('../lib/utils');

const FIELD = {
  legalName: 'frm.q7f1',
  email: 'frm.p0x4',
  contact: 'frm.m2k9',
  consent: 'frm.c8v3',
  housing: 'frm.r4d6',
  caseId: 'frm.s1u2',
  support: 'frm.l9n5',
  notes: 'frm.t3w8',
  witness: 'frm.h6b0',
  status: 'frm.f2e4',
  signature: 'frm.z5a7',
} as const;

interface StagedDemo {
  source: Uint8Array;
  inspection: PdfInspection;
  initialState: FormState;
  stagedState: FormState;
}

interface CompletedDemo extends StagedDemo {
  values: Record<string, PdfFieldValue>;
  applyResult: ApplyResult;
  releasedState: FormState;
}

const STATIC_XFA_CHOICE_FIELD = 'Root[0].Choice[0]';

async function createStaticXfaChoicePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([320, 180]);
  const form = document.getForm();
  const field = form.createRadioGroup(STATIC_XFA_CHOICE_FIELD);
  field.addOptionToPage('1', page, {
    x: 40,
    y: 100,
    width: 18,
    height: 18,
  });
  field.addOptionToPage('2', page, {
    x: 80,
    y: 100,
    width: 18,
    height: 18,
  });
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/"><subform name="Root"><exclGroup name="Choice"><field name="Gender"><ui><checkButton/></ui><caption><value><text>FEMALE</text></value></caption><assist><toolTip>Conflicting MALE tooltip</toolTip></assist><items><text>1</text></items></field><field name="Gender"><items><integer>2</integer></items><assist><toolTip>Conflicting FEMALE tooltip</toolTip></assist><caption><value><text>MALE</text></value></caption><ui><checkButton/></ui></field></exclGroup></subform></template>`;
  const templateRef = document.context.register(
    document.context.flateStream(template),
  );
  form.acroForm.dict.set(
    PDFName.of('XFA'),
    document.context.obj([PDFString.of('template'), templateRef]),
  );
  return Uint8Array.from(
    await document.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    }),
  );
}

interface AuthoredEvalCall {
  functionName: string;
  arguments: {
    cursor?: string;
    limit?: number;
    queries?: string[];
    agentWritableOnly?: boolean;
    fieldNames?: string[];
  };
  mockOutput: {
    documentSessionId?: string;
    data: unknown;
  };
}

interface AuthoredEvalCase {
  name: string;
  messages: AuthoredEvalMessage[];
  expectedCall: AuthoredEvalCall[];
}

interface AuthoredEvalMessage {
  role?: string;
  type: string;
  name?: string;
  content?: string;
  arguments?: {
    expectedStateVersion?: number;
    expectedSourceHash?: string;
    updates?: FieldUpdate[];
  };
  response?: Record<string, unknown>;
}

interface AuthoredLocalTransition {
  caseName: string;
  trigger: {
    messageIndex: number;
    role: 'user';
    type: 'message';
    content: string;
  };
  actor: 'human';
  source: 'human_ui';
  event: 'correct_draft_field';
  fieldName: string;
  value: FormFieldValue;
  from: { stateVersion: number; sourceHash: string; planHash: string };
  to: { stateVersion: number; sourceHash: string; planHash: string };
  provenance: { kind: 'human_entry'; confidence: 1 };
  humanPinned: true;
}

interface AuthoredLocalTransitionFile {
  schemaVersion: 1;
  transitions: AuthoredLocalTransition[];
}

async function replayAuthoredJourneyHistory(
  initialState: FormState,
  evaluation: AuthoredEvalCase,
  localTransition?: AuthoredLocalTransition,
): Promise<FormState> {
  let current = initialState;
  let transitionApplied = false;
  for (const [index, message] of evaluation.messages.entries()) {
    const response = evaluation.messages[index + 1];
    if (
      message.type === 'functioncall' &&
      message.name === 'stage_form_values' &&
      response?.type === 'functionresponse' &&
      response.name === message.name &&
      response.response?.ok === true
    ) {
      const arguments_ = message.arguments;
      if (
        arguments_?.expectedStateVersion === undefined ||
        arguments_.expectedSourceHash === undefined ||
        arguments_.updates === undefined
      ) {
        assert.fail(`${evaluation.name} has an incomplete historical stage.`);
      }
      const staged = await stageFieldUpdates(current, {
        expectedStateVersion: arguments_.expectedStateVersion,
        expectedSourceHash: arguments_.expectedSourceHash,
        actor: 'agent',
        updates: arguments_.updates,
      });
      assert.equal(staged.ok, true, evaluation.name);
      if (!staged.ok) throw new Error('Authored historical staging failed.');
      current = staged.state;
      assert.equal(response.response.stateVersion, current.stateVersion);
      assert.equal(response.response.sourceHash, current.source.sourceHash);
    }

    if (localTransition?.trigger.messageIndex !== index) continue;
    assert.equal(localTransition.caseName, evaluation.name);
    assert.equal(localTransition.actor, 'human');
    assert.equal(localTransition.source, 'human_ui');
    assert.equal(localTransition.event, 'correct_draft_field');
    assert.equal(localTransition.humanPinned, true);
    assert.deepEqual(
      {
        role: message.role,
        type: message.type,
        content: message.content,
      },
      {
        role: localTransition.trigger.role,
        type: localTransition.trigger.type,
        content: localTransition.trigger.content,
      },
    );
    assert.deepEqual(localTransition.from, {
      stateVersion: current.stateVersion,
      sourceHash: current.source.sourceHash,
      planHash: current.planHash,
    });
    const corrected = await correctDraftFieldFromUi(current, {
      expectedStateVersion: current.stateVersion,
      expectedSourceHash: current.source.sourceHash,
      expectedPlanHash: current.planHash,
      fieldName: localTransition.fieldName,
      value: localTransition.value,
    });
    assert.equal(corrected.ok, true, evaluation.name);
    if (!corrected.ok) throw new Error('Authored UI correction failed.');
    current = corrected.state;
    assert.deepEqual(localTransition.to, {
      stateVersion: current.stateVersion,
      sourceHash: current.source.sourceHash,
      planHash: current.planHash,
    });
    assert.deepEqual(current.draft[localTransition.fieldName], {
      fieldName: localTransition.fieldName,
      value: localTransition.value,
      actor: localTransition.actor,
      provenance: localTransition.provenance,
    });
    transitionApplied = true;
  }
  assert.equal(
    transitionApplied,
    localTransition !== undefined,
    evaluation.name,
  );
  return current;
}

function draftValues(state: FormState): Record<string, PdfFieldValue> {
  const values: Record<string, PdfFieldValue> = {};
  for (const [fieldName, staged] of Object.entries(state.draft)) {
    values[fieldName] = Array.isArray(staged.value)
      ? [...staged.value]
      : (staged.value as Exclude<FormFieldValue, readonly string[]>);
  }
  return values;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function fieldCombinations(
  fieldNames: readonly string[],
  maximumSize: number,
): string[][] {
  const combinations: string[][] = [];
  const visit = (start: number, selected: string[]) => {
    if (selected.length > 0) combinations.push([...selected]);
    if (selected.length === maximumSize) return;
    for (let index = start; index < fieldNames.length; index += 1) {
      selected.push(fieldNames[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return combinations;
}

async function loadStagedDemo(): Promise<StagedDemo> {
  const source = new Uint8Array(
    await readFile(new URL('../public/demo-form.pdf', import.meta.url)),
  );
  const inspection = await inspectPdf(source);
  const initialState = await createFormState(
    {
      fileName: 'residential-support-intake.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
      loadedAt: '2026-08-29T19:00:00.000Z',
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );

  const staged = await stageFieldUpdates(initialState, {
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.legalName,
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.email,
        value: 'ada@example.test',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.contact,
        value: 'Phone',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.consent,
        value: true,
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.housing,
        value: 'rent',
        provenance: {
          kind: 'source_document',
          confidence: 0.96,
          evidence: ['page 1 housing section'],
        },
      },
      {
        fieldName: FIELD.support,
        value: ['Utilities', 'Transportation'],
        provenance: {
          kind: 'agent_inference',
          confidence: 0.74,
          rationale:
            'The request mentions utility arrears and travel barriers.',
        },
      },
      {
        fieldName: FIELD.notes,
        value: 'Needs a follow-up call.',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('Valid cross-layer staging failed.');

  return {
    source,
    inspection,
    initialState,
    stagedState: staged.state,
  };
}

void test('formats singular and plural UI counts', () => {
  assert.equal(formatCount(0, 'field'), '0 fields');
  assert.equal(formatCount(1, 'field'), '1 field');
  assert.equal(formatCount(2, 'field'), '2 fields');
  assert.equal(formatCount(1, 'entry', 'entries'), '1 entry');
  assert.equal(formatCount(2, 'entry', 'entries'), '2 entries');
});

void test('keeps public safety claims within the WebMCP tool boundary', async () => {
  const [workbench, demoGenerator, layout, webMcpSource] = await Promise.all([
    readFile(
      new URL('../components/formproof-workbench.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../scripts/create-demo-form.py', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/webmcp.ts', import.meta.url), 'utf8'),
  ]);
  const publicCopy = `${workbench}\n${demoGenerator}\n${layout}\n${webMcpSource}`;

  for (const overclaim of [
    'Stays in this browser',
    'Field values do not leave the page.',
    'human approval boundary the agent cannot cross',
    'APPROVAL IS NEVER AN AGENT TOOL',
    'Only the human UI can approve or export',
    'human_review_only',
    'human-only approval',
    'Human-only gate',
    'Release gate open',
    'Verified export receipt',
  ]) {
    assert.equal(
      publicCopy.includes(overclaim),
      false,
      `public copy overclaims: ${overclaim}`,
    );
  }

  assert.match(workbench, /PDF bytes stay in this browser/);
  assert.match(workbench, /Approval and export stay outside its tool surface/);
  assert.match(
    workbench,
    /browser automation outside that tool boundary could still operate\s+the visible UI/,
  );
  assert.match(
    webMcpSource,
    /This WebMCP tool cannot approve or export; those controls exist only in the UI/,
  );
  assert.match(webMcpSource, /approvalBoundary: 'ui_approval_only'/);
  assert.match(
    demoGenerator,
    /requested field data may be shared with the active agent/,
  );
  assert.match(demoGenerator, /APPROVAL \/ EXPORT ARE NOT WEBMCP TOOLS/);
  assert.match(workbench, /documentState\?\.kind !== 'demo'/);
  assert.match(workbench, /documentState\?\.kind === 'demo'/);
  assert.match(workbench, /Load built-in demo/);
  assert.match(workbench, /Staged fields/);
  assert.match(workbench, /Completeness/);
  assert.match(workbench, /Not assessed beyond PDF required flags/);
  assert.match(workbench, /human_completion_required/);
  assert.doesNotMatch(workbench, /appearances (?:are )?verified/iu);
  assert.match(workbench, /normal appearance streams are present/iu);
  assert.match(workbench, /visual rendering is not independently checked/iu);
  assert.match(layout, /Human-approved PDF form filling with WebMCP/u);
  assert.doesNotMatch(publicCopy, /Agent-safe PDF filling|failed safely/u);
  for (const outcome of [
    'Filled PDF permitted by document policy',
    'Plain derivative permitted after confirmation',
    'Original-untouched fill package',
  ]) {
    assert.equal(
      workbench.includes(outcome),
      true,
      `missing UI outcome: ${outcome}`,
    );
  }
  for (const protectionLabel of [
    'Protection type:',
    'Allowed mutations:',
    'Export strategies:',
    'Signature impact:',
    'Human confirmation:',
  ]) {
    assert.equal(
      workbench.includes(protectionLabel),
      true,
      `missing UI protection label: ${protectionLabel}`,
    );
  }
  assert.match(
    workbench,
    /protection\.evidence\.xfaPresent[\s\S]*?protection\.protectionType === 'none'[\s\S]*?The source contains XFA\.[\s\S]*?The source contains XFA and the protection shown below\./u,
  );
  assert.match(workbench, /exportStrategies\.length ===\s*0/u);
  assert.match(workbench, /protectionType ===\s*'unknown'/u);
  assert.match(workbench, /Unknown protection remains inspection-only/u);
  assert.match(workbench, /no agent-writable addressable fields/u);
  assert.match(
    workbench,
    /getChoiceLabelReviewNotice\(\s*descriptor\?\.choices \?\? \[\],\s*\)/u,
  );
  assert.equal(workbench.match(/\{choiceLabelReviewNotice &&/gu)?.length, 2);
});

void test('explains PDF content-risk blocks with exhaustive human-readable counts', async () => {
  const [workbench, styles] = await Promise.all([
    readFile(
      new URL('../components/formproof-workbench.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  ]);

  const copyStart = workbench.indexOf('const CONTENT_RISK_REASON_COPY = {');
  const copyEnd = workbench.indexOf(
    'const GENERIC_CONTENT_RISK_COPY',
    copyStart,
  );
  assert.ok(copyStart >= 0 && copyEnd > copyStart);
  const reasonCopy = workbench.slice(copyStart, copyEnd);
  assert.match(reasonCopy, /satisfies Record<\s*PdfContentRiskReasonCode,/u);
  for (const [code, singular, plural] of [
    ['javascript_present', 'JavaScript action', 'JavaScript actions'],
    ['external_link_present', 'external link', 'external links'],
    [
      'dangerous_or_unknown_action_present',
      'dangerous or unrecognized action',
      'dangerous or unrecognized actions',
    ],
    ['embedded_file_present', 'embedded file', 'embedded files'],
    ['associated_file_present', 'associated file', 'associated files'],
    [
      'file_attachment_present',
      'file attachment annotation',
      'file attachment annotations',
    ],
    ['rich_media_present', 'rich-media item', 'rich-media items'],
    ['multimedia_present', 'multimedia item', 'multimedia items'],
    [
      'unclassified_payload_entry',
      'unclassified payload entry',
      'unclassified payload entries',
    ],
  ]) {
    assert.equal(reasonCopy.includes(`${code}: {`), true, code);
    assert.equal(reasonCopy.includes(`singular: '${singular}'`), true, code);
    assert.equal(reasonCopy.includes(`plural: '${plural}'`), true, code);
  }

  const formatterStart = workbench.indexOf(
    'function describeContentRiskReason(',
  );
  const formatterEnd = workbench.indexOf(
    '\nfunction protectionOutcome(',
    formatterStart,
  );
  assert.ok(formatterStart >= 0 && formatterEnd > formatterStart);
  const formatter = workbench.slice(formatterStart, formatterEnd);
  assert.match(formatter, /formatCount\(reason\.count, copy\.singular/u);
  assert.match(formatter, /reasons\.map\(describeContentRiskReason\)/u);
  assert.match(formatter, /descriptions\.join\(', '\)/u);
  assert.match(formatter, /GENERIC_CONTENT_RISK_COPY/u);

  const restrictionsStart = workbench.indexOf('<b>Content restrictions:</b>');
  const restrictionsEnd = workbench.indexOf('</p>', restrictionsStart);
  assert.ok(restrictionsStart >= 0 && restrictionsEnd > restrictionsStart);
  const restrictions = workbench.slice(restrictionsStart, restrictionsEnd);
  assert.match(restrictions, /PDF protection and content/u);
  assert.match(restrictions, /risk\s+are evaluated separately\./u);
  assert.match(
    workbench,
    /Interactive preview and PDF\s+rewriting are blocked because FormProof detected/u,
  );

  const previewStart = workbench.indexOf(
    '<div className="paper-frame pdf-frame">',
  );
  const previewEnd = workbench.indexOf('</article>', previewStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  const preview = workbench.slice(previewStart, previewEnd);
  assert.match(preview, /blocksInteractivePreview/u);
  assert.match(preview, /aria-live="polite"/u);
  assert.match(preview, /className="content-risk-list"/u);
  assert.match(
    preview,
    /aria-label="Reasons PDF preview and rewriting are blocked"/u,
  );
  assert.match(preview, /contentRiskReasons\.map\(\(reason\) =>/u);
  assert.match(preview, /describeContentRiskReason\(reason\)/u);
  assert.match(
    preview,
    /Counts are detector findings; categories can overlap/u,
  );
  assert.match(preview, /fillPackageAvailable/u);
  assert.doesNotMatch(preview, />\s*\{reason\.code\}\s*</u);

  const sourceLoadStart = workbench.indexOf('const loadSource = useCallback(');
  const sourceLoadEnd = workbench.indexOf(
    'const loadDemo = useCallback(',
    sourceLoadStart,
  );
  assert.ok(sourceLoadStart >= 0 && sourceLoadEnd > sourceLoadStart);
  const sourceLoad = workbench.slice(sourceLoadStart, sourceLoadEnd);
  assert.match(
    sourceLoad,
    /const sourceUrl = inspection\.contentRisk\.blocksInteractivePreview\s*\? null\s*: URL\.createObjectURL/u,
  );

  const buttonNoteStart = workbench.indexOf(
    '<p className="button-note">',
    previewEnd,
  );
  const buttonNoteEnd = workbench.indexOf('</p>', buttonNoteStart);
  assert.ok(buttonNoteStart >= 0 && buttonNoteEnd > buttonNoteStart);
  const buttonNote = workbench.slice(buttonNoteStart, buttonNoteEnd);
  assert.match(buttonNote, /contentRiskDescription/u);
  assert.match(buttonNote, /fillPackageAvailable/u);
  assert.doesNotMatch(
    workbench,
    />\s*(?:Ignore content risk|Rewrite anyway)\s*</u,
  );

  const explanationStart = styles.indexOf('.content-risk-explanation {');
  const explanationEnd = styles.indexOf('.preview-switch {', explanationStart);
  assert.ok(explanationStart >= 0 && explanationEnd > explanationStart);
  const explanationStyles = styles.slice(explanationStart, explanationEnd);
  assert.match(explanationStyles, /width: min\(100%, 38rem\)/u);
  assert.match(explanationStyles, /max-width: 100%/u);
  assert.match(explanationStyles, /overflow-wrap: anywhere/u);
  assert.match(explanationStyles, /text-align: left/u);
  assert.match(explanationStyles, /\.content-risk-list \{/u);
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*?\.pdf-empty \{\s*padding: 18px 14px;/u,
  );
});

void test('distinguishes policy permission from validation readiness in every UI branch', async () => {
  const [workbench, styles, verifier] = await Promise.all([
    readFile(
      new URL('../components/formproof-workbench.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(
      new URL('../scripts/verify-codex-evidence.ts', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(workbench, /Filled PDF permitted by document policy/u);
  assert.match(workbench, /Plain derivative permitted after confirmation/u);
  assert.doesNotMatch(workbench, /Filled PDF available/u);
  assert.doesNotMatch(
    workbench,
    /Plain derivative available after confirmation/u,
  );
  assert.doesNotMatch(`${workbench}\n${verifier}`, /\(s\)/u);

  const summaryStart = workbench.indexOf('const validationErrors =');
  const summaryEnd = workbench.indexOf(
    'const pendingHumanCompletionNames',
    summaryStart,
  );
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
  const summary = workbench.slice(summaryStart, summaryEnd);
  assert.match(
    summary,
    /filter\(\(\{ severity \}\) => severity === 'error'\)/u,
  );
  assert.match(
    summary,
    /every\(\(\{ code \}\) => code === 'required_missing'\)/u,
  );
  assert.match(
    summary,
    /formatCount\(validationErrors\.length, 'PDF-required field'\)/u,
  );
  assert.match(summary, /'is' : 'are'\} still blank/u);
  assert.match(
    summary,
    /formatCount\(validationErrors\.length, 'PDF validation blocker'\)/u,
  );
  assert.match(summary, /'remains' : 'remain'/u);
  assert.match(summary, /fields\[issue\.fieldName\]\?\.label\.trim\(\)/u);
  assert.match(summary, /label !== issue\.fieldName/u);
  assert.match(
    summary,
    /return issue\.message\.replaceAll\(issue\.fieldName, 'Unnamed PDF field'\)/u,
  );
  assert.match(summary, /strategy === 'filled_pdf'/u);
  assert.match(summary, /strategy === 'confirmed_plain_derivative_pdf'/u);
  assert.match(summary, /fillPackageAvailable/u);
  assert.match(summary, /draftEntries\.length > 0/u);
  assert.match(summary, /PDF artifacts cannot be exported/u);
  assert.match(summary, /Stage values before reviewing/u);
  assert.match(
    summary,
    /exportStrategies\.length \?\? 0\) > 0[\s\S]*?!hasBlockedPdfContent[\s\S]*?validationErrors\.length > 0/u,
  );

  const renderedStart = workbench.indexOf('{showValidationBlockerSummary ? (');
  const renderedEnd = workbench.indexOf('{releaseOpen &&', renderedStart);
  assert.ok(renderedStart >= 0 && renderedEnd > renderedStart);
  const rendered = workbench.slice(renderedStart, renderedEnd);
  assert.match(rendered, /className="validation-blocker-summary"/u);
  assert.match(rendered, /<output aria-live="polite">/u);
  assert.match(rendered, /aria-live="polite"/u);
  assert.match(
    rendered,
    /<section\s+className="validation-blocker-list-scroll"/u,
  );
  assert.match(rendered, /aria-label="Fields blocking PDF validation"/u);
  assert.match(rendered, /tabIndex=\{0\}/u);
  assert.match(rendered, /<ul className="validation-blocker-list">/u);
  assert.match(rendered, /validationBlockerItems\.map/u);
  assert.match(rendered, /validationBlockerGuidance/u);
  assert.match(rendered, /hasBlockedPdfContent/u);
  assert.match(
    rendered,
    /Document policy permits an original-untouched fill package after values are staged and a person reviews them/u,
  );
  assert.doesNotMatch(rendered, /fill package remains available/iu);

  assert.match(
    workbench,
    /isRequiredMissing\s*\? fillPackageAvailable[\s\S]*?If you choose a fill package[\s\S]*?A PDF artifact cannot be exported/u,
  );
  assert.match(
    workbench,
    /!isHumanCompletion && isRequiredMissing[\s\S]*?fillPackageAvailable[\s\S]*?A fill package can be reviewed only as incomplete[\s\S]*?A PDF artifact cannot be exported/u,
  );
  assert.match(
    workbench,
    /fillPackageAvailable\s*\? 'Resolve required-field blockers[\s\S]*?An incomplete original-untouched fill package can still be reviewed\.'[\s\S]*?: 'Resolve required-field blockers before creating a PDF artifact\.'/u,
  );

  const styleStart = styles.indexOf('.validation-blocker-summary {');
  const styleEnd = styles.indexOf('.draft-card {', styleStart);
  assert.ok(styleStart >= 0 && styleEnd > styleStart);
  const blockerStyles = styles.slice(styleStart, styleEnd);
  assert.match(blockerStyles, /max-width: 100%/u);
  assert.match(blockerStyles, /max-height: 112px/u);
  assert.match(blockerStyles, /overflow-y: auto/u);
  assert.match(blockerStyles, /overscroll-behavior: contain/u);
  assert.match(
    blockerStyles,
    /\.validation-blocker-list-scroll:focus-visible/u,
  );
  assert.match(blockerStyles, /overflow-wrap: anywhere/u);
  assert.doesNotMatch(blockerStyles, /#fbf0ed|#773b2f/u);
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*?\.validation-blocker-summary \{\s*padding: 10px;/u,
  );
});

void test('binds data consent and every mutable workflow to one load session', async () => {
  const workbench = await readFile(
    new URL('../components/formproof-workbench.tsx', import.meta.url),
    'utf8',
  );
  const bindingStart = workbench.indexOf('function bindingFailure(');
  const bindingEnd = workbench.indexOf(
    '\nfunction stateErrorFailure(',
    bindingStart,
  );
  assert.ok(bindingStart >= 0 && bindingEnd > bindingStart);
  const binding = workbench.slice(bindingStart, bindingEnd);
  const sessionCheck = binding.indexOf('expectedDocumentSessionId');
  const sourceCheck = binding.indexOf('expectedSourceHash');
  const versionCheck = binding.indexOf('expectedStateVersion');
  assert.ok(
    sessionCheck >= 0 &&
      sourceCheck > sessionCheck &&
      versionCheck > sourceCheck,
  );

  const beginLoadStart = workbench.indexOf('const beginLoad = useCallback(');
  const beginLoadEnd = workbench.indexOf(
    'const loadSource = useCallback(',
    beginLoadStart,
  );
  assert.ok(beginLoadStart >= 0 && beginLoadEnd > beginLoadStart);
  const beginLoad = workbench.slice(beginLoadStart, beginLoadEnd);
  assert.match(beginLoad, /stateRef\.current = null/u);
  assert.match(beginLoad, /agentDataConsentSessionRef\.current = null/u);
  assert.match(beginLoad, /agentDataConsentGenerationRef\.current \+= 1/u);
  assert.match(beginLoad, /setAgentDataAccessGranted\(false\)/u);
  assert.match(beginLoad, /pdfInspectionAbortRef\.current\?\.abort\(\)/u);
  assert.match(beginLoad, /pdfInspectionWorkerRef\.current\?\.terminate\(\)/u);

  assert.equal(
    workbench.match(
      /agentDataConsentSessionRef\.current !== current\.documentSessionId/gu,
    )?.length,
    6,
  );
  assert.match(workbench, /Off by default and reset on every load/u);
  assert.match(workbench, /new Worker\(/u);
  assert.doesNotMatch(workbench, /\binspectPdf\s*\(/u);
});

void test('rejects staged values when consent changes before commit', async () => {
  const workbench = await readFile(
    new URL('../components/formproof-workbench.tsx', import.meta.url),
    'utf8',
  );
  const stageStart = workbench.indexOf('stageFormValues(input, context) {');
  const stageEnd = workbench.indexOf(
    '\n\n      validateFillPlan(input) {',
    stageStart,
  );
  assert.ok(stageStart >= 0 && stageEnd > stageStart);
  const stageAdapter = workbench.slice(stageStart, stageEnd);
  const awaitIndex = stageAdapter.indexOf('await stageFieldUpdates(');
  const captureIndex = stageAdapter.indexOf(
    'const consentGeneration = agentDataConsentGenerationRef.current;',
  );
  const recheckIndex = stageAdapter.indexOf(
    'agentDataConsentGenerationRef.current !== consentGeneration',
  );
  const commitIndex = stageAdapter.indexOf('commitState(result.state)');
  assert.ok(
    captureIndex >= 0 &&
      awaitIndex > captureIndex &&
      recheckIndex > awaitIndex &&
      commitIndex > recheckIndex,
  );

  const { initialState } = await loadStagedDemo();
  const runRace = async (regrant: boolean) => {
    let current = initialState;
    let consentSessionId: string | null = initialState.documentSessionId;
    let consentGeneration = 1;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const adapter: FormProofWebMcpAdapter = {
      getFormContext: async () => {
        throw new Error('not used');
      },
      getFieldEvidence: async () => {
        throw new Error('not used');
      },
      async stageFormValues(input) {
        const snapshot = current;
        const capturedSessionId = consentSessionId;
        const capturedGeneration = consentGeneration;
        markStarted();
        await gate;
        const staged = await stageFieldUpdates(snapshot, {
          expectedStateVersion: input.expectedStateVersion,
          expectedSourceHash: input.expectedSourceHash,
          actor: 'agent',
          updates: input.updates,
        });
        if (
          consentSessionId !== snapshot.documentSessionId ||
          consentSessionId !== capturedSessionId ||
          consentGeneration !== capturedGeneration
        ) {
          return {
            ok: false,
            stateVersion: current.stateVersion,
            sourceHash: current.source.sourceHash,
            documentSessionId: current.documentSessionId,
            error: { code: 'consent_required' },
          };
        }
        if (!staged.ok) throw new Error('consent race fixture failed to stage');
        current = staged.state;
        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          documentSessionId: current.documentSessionId,
          data: { changedFields: staged.changedFields },
        };
      },
      validateFillPlan: async () => {
        throw new Error('not used');
      },
      startFillReview: async () => {
        throw new Error('not used');
      },
    };
    const stageTool = createFormProofToolDefinitions(
      adapter,
      () => undefined,
      new AbortController().signal,
    ).find(({ name }) => name === 'stage_form_values');
    assert.ok(stageTool);
    const call = stageTool.execute({
      expectedDocumentSessionId: initialState.documentSessionId,
      expectedStateVersion: initialState.stateVersion,
      expectedSourceHash: initialState.source.sourceHash,
      updates: [
        {
          fieldName: FIELD.legalName,
          value: 'Ada Lovelace',
          provenance: { kind: 'user_instruction', confidence: 1 },
        },
      ],
    });
    await started;
    consentSessionId = null;
    consentGeneration += 1;
    if (regrant) {
      consentSessionId = initialState.documentSessionId;
      consentGeneration += 1;
    }
    release();
    const response = await call;
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'CONSENT_REQUIRED');
    assert.equal(response.stateVersion, initialState.stateVersion);
    assert.equal(current.stateVersion, initialState.stateVersion);
    assert.deepEqual(current.draft, initialState.draft);
  };

  await runRace(false);
  await runRace(true);
});

void test('delegates upload identity to PDF inspection and renders multiline review values exactly', async () => {
  const [workbench, styles] = await Promise.all([
    readFile(
      new URL('../components/formproof-workbench.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  ]);

  const uploadStart = workbench.indexOf('const onFileChosen = useCallback(');
  const uploadEnd = workbench.indexOf(
    'const onFillPackageChosen = useCallback(',
    uploadStart,
  );
  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
  const upload = workbench.slice(uploadStart, uploadEnd);
  assert.doesNotMatch(upload, /file\.type|endsWith\(['"]\.pdf['"]\)/u);
  assert.doesNotMatch(upload, /Choose a PDF file\./u);
  const sizeCheck = upload.indexOf('file.size > MAX_PDF_BYTES');
  const reset = upload.indexOf('const generation = beginLoad()');
  const bytesRead = upload.indexOf('await file.arrayBuffer()');
  assert.ok(sizeCheck >= 0 && reset > sizeCheck && bytesRead > reset);
  assert.match(
    upload,
    /await loadSource\([\s\S]*?new Uint8Array\(await file\.arrayBuffer\(\)\)[\s\S]*?'upload'/u,
  );
  assert.match(workbench, /accept="application\/pdf,\.pdf"/u);

  const loadSourceStart = workbench.indexOf('const loadSource = useCallback(');
  const loadSourceEnd = workbench.indexOf(
    'const loadDemo = useCallback(',
    loadSourceStart,
  );
  assert.ok(loadSourceStart >= 0 && loadSourceEnd > loadSourceStart);
  const loadSource = workbench.slice(loadSourceStart, loadSourceEnd);
  const emptyCheck = loadSource.indexOf('bytes.byteLength === 0');
  const workerStart = loadSource.indexOf('new Worker(');
  assert.ok(emptyCheck >= 0 && workerStart > emptyCheck);
  assert.match(
    loadSource,
    /The selected file is empty\. Choose a non-empty PDF\./u,
  );
  assert.match(loadSource, /new Worker\(/u);
  assert.match(loadSource, /worker\.postMessage\(transferableBytes/u);

  const editorStart = workbench.indexOf('function HumanCorrectionEditor(');
  const editorEnd = workbench.indexOf(
    'export function FormProofWorkbench()',
    editorStart,
  );
  assert.ok(editorStart >= 0 && editorEnd > editorStart);
  const editor = workbench.slice(editorStart, editorEnd);
  assert.match(editor, /field\.type === 'text' && multiline/u);
  assert.match(editor, /<Textarea[\s\S]*?rows=\{4\}/u);
  assert.match(editor, /: field\.type === 'text' \? \(\s*<Input/u);
  assert.equal(editor.match(/maxLength=\{field\.maxLength\}/gu)?.length, 2);
  assert.match(workbench, /multiline=\{isMultiline\}/u);
  assert.match(
    workbench,
    /className=\{`mini-diff\$\{isMultiline \? ' is-multiline' : ''\}`\}/u,
  );
  assert.match(
    workbench,
    /className=\{`full-diff\$\{isMultiline \? ' is-multiline' : ''\}`\}/u,
  );

  const miniMultilineStart = styles.indexOf('.mini-diff.is-multiline span,');
  const miniMultilineEnd = styles.indexOf('.mini-diff svg', miniMultilineStart);
  assert.ok(miniMultilineStart >= 0 && miniMultilineEnd > miniMultilineStart);
  const miniMultiline = styles.slice(miniMultilineStart, miniMultilineEnd);
  assert.match(miniMultiline, /overflow-wrap: anywhere/u);
  assert.match(miniMultiline, /white-space: pre-wrap/u);
  assert.doesNotMatch(miniMultiline, /white-space: nowrap/u);

  const fullMultilineStart = styles.indexOf('.full-diff.is-multiline > span,');
  const fullMultilineEnd = styles.indexOf('.full-diff svg', fullMultilineStart);
  assert.ok(fullMultilineStart >= 0 && fullMultilineEnd > fullMultilineStart);
  const fullMultiline = styles.slice(fullMultilineStart, fullMultilineEnd);
  assert.match(fullMultiline, /overflow-wrap: anywhere/u);
  assert.match(fullMultiline, /white-space: pre-wrap/u);

  const reviewBodyStart = workbench.indexOf(
    '<div className="review-dialog-body">',
  );
  const reviewBodyEnd = workbench.indexOf('<DialogFooter>', reviewBodyStart);
  assert.ok(reviewBodyStart >= 0 && reviewBodyEnd > reviewBodyStart);
  const reviewBody = workbench.slice(reviewBodyStart, reviewBodyEnd);
  assert.match(reviewBody, /This plan contains/u);
  assert.match(reviewBody, /Choose the artifact yourself/u);
  assert.match(reviewBody, /aria-label="Artifact choice"/u);
  assert.match(reviewBody, /Original-untouched fill package:/u);

  const reviewDialogStart = styles.indexOf('.review-dialog {');
  const reviewDialogEnd = styles.indexOf(
    ".review-dialog [data-slot='dialog-title']",
    reviewDialogStart,
  );
  assert.ok(reviewDialogStart >= 0 && reviewDialogEnd > reviewDialogStart);
  const reviewDialog = styles.slice(reviewDialogStart, reviewDialogEnd);
  assert.match(
    reviewDialog,
    /grid-template-rows: auto auto minmax\(0, 1fr\) auto/u,
  );
  assert.match(reviewDialog, /\.review-dialog-body \{/u);
  assert.match(reviewDialog, /min-height: 0/u);
  assert.match(reviewDialog, /overflow-y: auto/u);
  assert.match(
    reviewDialog,
    /\.review-dialog-body > \.review-checklist \{[\s\S]*?overflow: visible/u,
  );
});

void test('denies framing without constraining the PDF preview or inspection worker', async () => {
  const { default: nextConfig } = (await import(
    new URL('../next.config.ts', import.meta.url).href
  )) as typeof import('../next.config');
  const headers = await nextConfig.headers?.();

  assert.deepEqual(headers, [
    {
      source: '/',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: "frame-ancestors 'none'",
        },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
    {
      source: '/:path*',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: "frame-ancestors 'none'",
        },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
  ]);
});

void test('preserves exact-SOM static XFA choice label sources in the fill package and reviewer notice', async () => {
  const source = await createStaticXfaChoicePdf();
  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.evidence.xfaPresent, true);
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
  const descriptor = inspection.fields.find(
    ({ name }) => name === STATIC_XFA_CHOICE_FIELD,
  );
  assert.notEqual(descriptor, undefined);
  if (descriptor === undefined) {
    throw new Error('Static XFA choice field was not inspected.');
  }
  assert.deepEqual(descriptor.choices, [
    {
      value: '1',
      label: 'FEMALE',
      labelSource: 'xfa_static_exact_som',
    },
    {
      value: '2',
      label: 'MALE',
      labelSource: 'xfa_static_exact_som',
    },
  ]);

  const initial = await createFormState(
    {
      fileName: 'static-xfa-choice.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: STATIC_XFA_CHOICE_FIELD,
        value: '1',
        provenance: {
          kind: 'agent_inference',
          confidence: 0.9,
          rationale: 'The supplied record uses the AcroForm value 1.',
        },
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('Static XFA choice did not stage.');
  const exported = await exportFillPackageFromUi(staged.state, source, {
    confirmedFieldNames: [STATIC_XFA_CHOICE_FIELD],
    createdAt: '2026-08-30T20:00:00.000Z',
  });
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('Static XFA fill package did not export.');
  assert.equal(exported.result.manifest.schemaVersion, 4);

  const stagedChoices = exported.result.manifest.plan.stagedFields[0].choices;
  const reviewChoices = exported.result.manifest.plan.humanSteps[0].choices;
  assert.deepEqual(stagedChoices, descriptor.choices);
  assert.deepEqual(reviewChoices, descriptor.choices);
  assert.notEqual(stagedChoices, descriptor.choices);
  assert.notEqual(stagedChoices[0], descriptor.choices[0]);
  assert.equal(
    stagedChoices.every(
      ({ labelSource }) => labelSource === 'xfa_static_exact_som',
    ),
    true,
  );
  assert.equal(
    getChoiceLabelReviewNotice(stagedChoices),
    'These option labels come from static XFA captions matched by the full SOM field name and complete AcroForm value set. FormProof did not execute XFA scripts, calculations, validation, dynamic choices, or layout. Compare the options with the original form before confirming.',
  );
  assert.equal(
    getChoiceLabelReviewNotice([
      { value: '1', label: '1', labelSource: 'acroform' },
    ]),
    null,
  );
  const limitations = exported.result.manifest.limitations.join('\n');
  assert.match(
    limitations,
    /Choice values, choice-to-widget mappings, and appearance states come from the AcroForm structure/u,
  );
  assert.match(
    limitations,
    /bounded static XFA exclGroup caption.*full SOM field name and complete AcroForm value set match exactly/u,
  );
  assert.match(
    limitations,
    /XFA scripts, calculations, validation, dynamic choices, and layout are not executed/u,
  );
  assert.doesNotMatch(limitations, /XFA choices/u);
});

void test('gives the UI reviewer scoped discard and correction controls', async () => {
  const workbench = await readFile(
    new URL('../components/formproof-workbench.tsx', import.meta.url),
    'utf8',
  );

  assert.match(workbench, /discardDraftFields/);
  assert.match(workbench, /Reject proposal/u);
  assert.match(workbench, /Discard all staged values/u);
  assert.match(
    workbench,
    /Confirm discard \$\{formatCount\([\s\S]*?'staged value'\)\}/u,
  );
  assert.match(workbench, /if \(discardAllArmed\)/u);
  assert.match(
    workbench,
    /The plan changed, so review closed and every confirmation was cleared/u,
  );

  const correctionStart = workbench.indexOf(
    'const correctProposal = useCallback(',
  );
  const correctionEnd = workbench.indexOf(
    'const rejectProposals = useCallback(',
    correctionStart,
  );
  assert.ok(correctionStart >= 0 && correctionEnd > correctionStart);
  const correctionHandler = workbench.slice(correctionStart, correctionEnd);
  assert.match(
    correctionHandler,
    /await correctDraftFieldFromUi\(current, \{/u,
  );
  assert.match(correctionHandler, /expectedPlanHash:\s*current\.planHash/u);
  assert.doesNotMatch(
    correctionHandler,
    /\b(?:stageFieldUpdates|discardDraftFields)\(/u,
  );
  assert.equal(workbench.match(/\bcorrectDraftFieldFromUi\(/gu)?.length, 1);
  assert.match(
    workbench,
    /onSave=\{\(value\) =>\s*void correctProposal\(fieldName, value\)/u,
  );
  assert.match(workbench, /Correct value/u);
  assert.match(workbench, /Save human correction/u);
  assert.match(workbench, /Remove correction &amp; let agent suggest/u);
  assert.match(workbench, /session-scoped human correction/u);
  assert.match(
    correctionHandler,
    /The plan changed, review closed, and every confirmation was cleared\. The source PDF remains untouched\./u,
  );

  const commitStateStart = workbench.indexOf(
    'const commitState = useCallback(',
  );
  const commitStateEnd = workbench.indexOf(
    'const closeReview = useCallback(',
    commitStateStart,
  );
  assert.ok(commitStateStart >= 0 && commitStateEnd > commitStateStart);
  const commitState = workbench.slice(commitStateStart, commitStateEnd);
  assert.match(correctionHandler, /commitState\(result\.state\)/u);
  assert.match(commitState, /binding\.planHash !== next\.planHash/u);
  assert.match(commitState, /setReviewOpen\(false\)/u);
  assert.match(commitState, /setConfirmedFields\(new Set\(\)\)/u);

  assert.deepEqual(FORMPROOF_WEBMCP_TOOL_NAMES, [
    'get_pdf_protection',
    'get_form_context',
    'get_field_evidence',
    'stage_form_values',
    'validate_fill_plan',
    'start_fill_review',
  ]);
  assert.equal(
    FORMPROOF_WEBMCP_TOOL_NAMES.some((name) =>
      /unlock|correct|correction/iu.test(name),
    ),
    false,
  );
});

void test('wires scoped context and artifact-specific review boundaries through the workbench adapter', async () => {
  const workbench = await readFile(
    new URL('../components/formproof-workbench.tsx', import.meta.url),
    'utf8',
  );

  const contextStart = workbench.indexOf('getFormContext(input) {');
  const contextEnd = workbench.indexOf('getFieldEvidence(input) {');
  assert.ok(contextStart >= 0 && contextEnd > contextStart);
  const contextAdapter = workbench.slice(contextStart, contextEnd);
  assert.match(
    contextAdapter,
    /parseFormContextCursor\(\s*input\.cursor,\s*\{\s*documentSessionId:\s*current\.documentSessionId,\s*sourceHash:\s*current\.source\.sourceHash,\s*stateVersion:\s*current\.stateVersion,\s*\},\s*input,\s*\)/u,
  );
  assert.match(contextAdapter, /cursor\.code === 'stale_state'/u);
  assert.match(contextAdapter, /form state changed.*first page/u);
  assert.match(
    contextAdapter,
    /createFormContextToolData\(\s*current,\s*inspection,\s*offset,\s*input\.limit,\s*input,\s*\)/u,
  );
  assert.match(contextAdapter, /offset > data\.pagination\.total/u);

  const openReviewStart = workbench.indexOf('const openReview = useCallback(');
  const openReviewEnd = workbench.indexOf(
    'const resetOutput = useCallback(() => {',
  );
  assert.ok(openReviewStart >= 0 && openReviewEnd > openReviewStart);
  const openReview = workbench.slice(openReviewStart, openReviewEnd);
  assert.match(
    openReview,
    /const preferredStrategy = initialExportStrategy\(inspection\)/u,
  );
  assert.match(openReview, /setSelectedExportStrategy\(null\)/u);
  assert.match(openReview, /reviewBindingsMatch\(reviewBindingRef\.current/u);
  assert.match(openReview, /dismissedReviewBindingRef\.current/u);
  assert.doesNotMatch(openReview, /PDF_ACTION_UNSUPPORTED|will not export/u);

  const validationStart = workbench.indexOf('validateFillPlan(input) {');
  const reviewStart = workbench.indexOf('startFillReview(input) {');
  const adapterEnd = workbench.indexOf(
    '\n    };\n\n    void register',
    reviewStart,
  );
  assert.ok(
    validationStart >= 0 &&
      reviewStart > validationStart &&
      adapterEnd > reviewStart,
  );
  const validationAdapter = workbench.slice(validationStart, reviewStart);
  assert.match(validationAdapter, /readyForReview:/u);
  assert.match(
    validationAdapter,
    /reviewArtifacts = inspection\?\.protection\.exportStrategies/u,
  );
  assert.match(validationAdapter, /reviewArtifacts\.length > 0/u);
  assert.match(validationAdapter, /exportStrategySelection: 'human_ui_only'/u);

  const reviewAdapter = workbench.slice(reviewStart, adapterEnd);
  assert.match(
    reviewAdapter,
    /if \(reviewArtifacts\.length === 0\) \{[\s\S]*?'review_not_ready'[\s\S]*?no available artifact strategy[\s\S]*?\}/u,
  );
  assert.match(reviewAdapter, /exportStrategySelection: 'human_ui_only'/u);

  assert.match(workbench, /agentMaySelectExportStrategy: false/u);
  assert.match(workbench, /exportFillPackageFromUi\(current, source/u);
  assert.match(workbench, /getArtifactReviewFieldNames\(formState\)/u);
  assert.match(workbench, /Required field is blank/u);
  assert.match(workbench, /fill package can be reviewed only as incomplete/u);
  assert.match(workbench, /not established; unknown protection remains/u);
  assert.match(workbench, /exportApprovedDerivativePdfFromUi/u);
  assert.match(
    workbench,
    /selectedCreatesPdf &&[\s\S]*?!validation\?\.canApprove \|\| hasBlockedPdfContent/u,
  );
});

void test('keeps real WebMCP discovery and evidence atomic under the target budget', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const adapter: FormProofWebMcpAdapter = {
    getFormContext(input) {
      const parsed =
        input.cursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFormContextCursor(
              input.cursor,
              {
                documentSessionId: initialState.documentSessionId,
                sourceHash: initialState.source.sourceHash,
                stateVersion: initialState.stateVersion,
              },
              input,
            );
      if (!parsed.ok) {
        return {
          ok: false,
          stateVersion: initialState.stateVersion,
          sourceHash: initialState.source.sourceHash,
          error: {
            code: parsed.code,
            message: 'The field cursor is invalid for this context scope.',
          },
        };
      }
      return {
        ok: true,
        stateVersion: initialState.stateVersion,
        sourceHash: initialState.source.sourceHash,
        data: createFormContextToolData(
          initialState,
          inspection,
          parsed.offset,
          input.limit,
          input,
        ),
      };
    },
    getFieldEvidence(input) {
      return {
        ok: true,
        stateVersion: initialState.stateVersion,
        sourceHash: initialState.source.sourceHash,
        data: createFieldEvidenceToolData(
          initialState,
          inspection,
          input.fieldNames,
        ),
      };
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const tools = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  );
  const context = tools.find(({ name }) => name === 'get_form_context');
  const evidence = tools.find(({ name }) => name === 'get_field_evidence');
  assert.ok(context);
  assert.ok(evidence);

  const discoveredNames: string[] = [];
  let firstContextPage = true;
  let cursor: string | null = null;
  do {
    const response: FormProofToolResponse = await context.execute(
      cursor === null ? {} : { cursor },
    );
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error('Real context projection failed.');
    assert.equal(response.outputTruncated, false);
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `context response used ${serializedBytes(response)} bytes`,
    );
    const data = response.data as {
      fields: Array<Record<string, unknown>>;
      pagination: {
        returned: number;
        total: number;
        nextCursor: string | null;
      };
      validation?: {
        structurallyValid: boolean;
        completionStatus: 'incomplete' | 'unknown';
        ruleCoverage: 'pdf_required_flags_only';
        formCompletenessAssessed: false;
      };
    };
    assert.equal(data.pagination.returned, data.fields.length);
    if (firstContextPage) {
      assert.deepEqual(data.validation, {
        blockerCount: initialState.validation.blockerCount,
        reviewCount: initialState.validation.reviewCount,
        structurallyValid: false,
        completionStatus: 'incomplete',
        ruleCoverage: 'pdf_required_flags_only',
        formCompletenessAssessed: false,
        canApprove: initialState.validation.canApprove,
        canOpenReview: false,
        blockingFieldNames: initialState.validation.issues
          .filter(({ severity }) => severity === 'error')
          .map(({ fieldName }) => fieldName),
        reviewFieldNames: initialState.validation.reviewFieldNames,
      });
      assert.equal('valid' in data.validation!, false);
      firstContextPage = false;
    }
    for (const field of data.fields) {
      assert.equal(typeof field.name, 'string');
      assert.equal(typeof field.label, 'string');
      assert.equal(typeof field.type, 'string');
      assert.equal(typeof field.required, 'boolean');
      assert.equal(typeof field.readOnly, 'boolean');
      assert.equal(typeof field.humanOnly, 'boolean');
      discoveredNames.push(field.name as string);
    }
    cursor = data.pagination.nextCursor;
  } while (cursor !== null);

  assert.deepEqual(
    discoveredNames,
    inspection.fields.map(({ name }) => name),
  );
  assert.equal(new Set(discoveredNames).size, discoveredNames.length);

  const queryScope = {
    queries: ['contact'],
    agentWritableOnly: true,
    limit: 1,
  } as const;
  const firstQueryPage = await context.execute(queryScope);
  assert.equal(firstQueryPage.ok, true);
  if (!firstQueryPage.ok) throw new Error('Scoped context search failed.');
  const firstQueryData = firstQueryPage.data as {
    fields: Array<{ name: string; matchedQueries: string[] }>;
    pagination: { returned: number; total: number; nextCursor: string | null };
    search: {
      matchMethod: 'lexical';
      agentWritableOnly: true;
      queries: Array<{ query: string; matchCount: number }>;
    };
  };
  assert.deepEqual(firstQueryData.fields, [
    {
      name: FIELD.contact,
      label: 'Preferred contact method',
      type: 'dropdown',
      matchedQueries: ['contact'],
      currentValueAvailable: true,
    },
  ]);
  assert.deepEqual(firstQueryData.search, {
    matchMethod: 'lexical',
    agentWritableOnly: true,
    queries: [{ query: 'contact', matchCount: 2 }],
  });
  assert.equal(firstQueryData.pagination.returned, 1);
  assert.equal(firstQueryData.pagination.total, 2);
  assert.ok(firstQueryData.pagination.nextCursor);

  const secondQueryPage = await context.execute({
    ...queryScope,
    cursor: firstQueryData.pagination.nextCursor,
  });
  assert.equal(secondQueryPage.ok, true);
  if (!secondQueryPage.ok) {
    throw new Error('Scoped context pagination failed.');
  }
  const secondQueryData = secondQueryPage.data as {
    fields: Array<{ name: string }>;
    pagination: { returned: number; total: number; nextCursor: string | null };
  };
  assert.deepEqual(
    secondQueryData.fields.map(({ name }) => name),
    [FIELD.consent],
  );
  assert.deepEqual(secondQueryData.pagination, {
    returned: 1,
    total: 2,
    nextCursor: null,
  });

  const mismatchedQueryScope = await context.execute({
    ...queryScope,
    queries: ['review'],
    cursor: firstQueryData.pagination.nextCursor,
  });
  assert.equal(mismatchedQueryScope.ok, false);
  if (mismatchedQueryScope.ok) {
    throw new Error('A cursor was accepted under a different query scope.');
  }
  assert.equal(mismatchedQueryScope.error.code, 'INVALID_INPUT');
  assert.equal(mismatchedQueryScope.nextAction, 'fix_tool_input');

  const evidenceResponse = await evidence.execute({
    expectedDocumentSessionId: initialState.documentSessionId,
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: initialState.source.sourceHash,
    fieldNames: [FIELD.legalName, FIELD.email, FIELD.consent],
  });
  assert.equal(evidenceResponse.ok, true);
  if (!evidenceResponse.ok) throw new Error('Real evidence projection failed.');
  assert.equal(evidenceResponse.outputTruncated, false);
  assert.ok(
    serializedBytes(evidenceResponse) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `evidence response used ${serializedBytes(evidenceResponse)} bytes`,
  );
  const evidenceData = evidenceResponse.data as {
    untrustedPdfContent: boolean;
    fields: Array<{
      name: string;
      rect: unknown;
      constraints: {
        choices: Array<{ value: string; label?: string }>;
      };
    }>;
  };
  assert.equal(evidenceData.untrustedPdfContent, true);
  assert.equal(
    evidenceData.fields.every(({ rect }) => rect !== null),
    true,
  );
  const housingResponse = await evidence.execute({
    expectedDocumentSessionId: initialState.documentSessionId,
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: initialState.source.sourceHash,
    fieldNames: [FIELD.housing],
  });
  assert.equal(housingResponse.ok, true);
  if (!housingResponse.ok) throw new Error('Housing evidence failed.');
  assert.equal(housingResponse.outputTruncated, false);
  assert.ok(
    serializedBytes(housingResponse) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  );
  const housingField = (
    housingResponse.data as {
      fields: Array<{
        constraints: { choices: Array<{ value: string; label?: string }> };
      }>;
    }
  ).fields[0];
  assert.deepEqual(housingField.constraints.choices, [
    { value: 'rent' },
    { value: 'own' },
    { value: 'other' },
  ]);

  for (const fieldNames of fieldCombinations(discoveredNames, 3)) {
    const response = await evidence.execute({
      expectedDocumentSessionId: initialState.documentSessionId,
      expectedStateVersion: initialState.stateVersion,
      expectedSourceHash: initialState.source.sourceHash,
      fieldNames,
    });
    assert.equal(
      response.ok,
      true,
      `evidence failed for ${fieldNames.join(',')}`,
    );
    if (!response.ok) throw new Error('Evidence combination failed.');
    assert.equal(response.outputTruncated, false);
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `${fieldNames.join(',')} used ${serializedBytes(response)} bytes`,
    );
  }

  const longText = '表单😀\\"'.repeat(300);
  const longState: FormState = {
    ...initialState,
    source: { ...initialState.source, fileName: longText },
    fields: {
      ...initialState.fields,
      [FIELD.legalName]: {
        ...initialState.fields[FIELD.legalName],
        label: longText,
        sourceValue: longText,
      },
    },
  };
  const longInspection: PdfInspection = {
    ...inspection,
    fields: inspection.fields.map((field) =>
      field.name === FIELD.legalName ? { ...field, current: longText } : field,
    ),
  };
  const longData = createFormContextToolData(longState, longInspection, 0, 6);
  const longResponse = {
    ok: true,
    stateVersion: longState.stateVersion,
    sourceHash: longState.source.sourceHash,
    nextAction: 'get_field_evidence',
    data: longData,
    outputTruncated: false,
  };
  assert.ok(
    serializedBytes(longResponse) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `adversarial context used ${serializedBytes(longResponse)} bytes`,
  );
  const projectedLongField = longData.fields.find(
    (field) => 'name' in field && field.name === FIELD.legalName,
  );
  assert.notEqual(projectedLongField, undefined);
  assert.equal(projectedLongField && 'label' in projectedLongField, false);
  assert.equal(
    projectedLongField && 'labelTruncated' in projectedLongField,
    false,
  );
  assert.equal(
    projectedLongField && 'detailAvailableVia' in projectedLongField
      ? projectedLongField.detailAvailableVia
      : null,
    'get_field_evidence',
  );
  assert.equal(
    projectedLongField && 'currentValueAvailable' in projectedLongField
      ? projectedLongField.currentValueAvailable
      : false,
    true,
  );
  assert.equal(
    projectedLongField && 'currentValue' in projectedLongField,
    false,
  );
});

void test('keeps journey read mocks aligned with the real demo projector', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const [officialEvaluations, localEvaluations, localTransitionFile] =
    await Promise.all([
      readFile(
        new URL('../evals/formproof-evals.json', import.meta.url),
        'utf8',
      ).then((value) => JSON.parse(value) as AuthoredEvalCase[]),
      readFile(
        new URL('../evals/formproof-local-evals.json', import.meta.url),
        'utf8',
      ).then((value) => JSON.parse(value) as AuthoredEvalCase[]),
      readFile(
        new URL('../evals/formproof-local-transitions.json', import.meta.url),
        'utf8',
      ).then((value) => JSON.parse(value) as AuthoredLocalTransitionFile),
    ]);
  const evaluations = [...officialEvaluations, ...localEvaluations];
  const localTransitions = new Map(
    localTransitionFile.transitions.map((transition) => [
      transition.caseName,
      transition,
    ]),
  );
  const appliedLocalTransitions = new Set<string>();

  for (const evaluation of evaluations.filter(({ name }) =>
    name.startsWith('[journey]'),
  )) {
    const localTransition = localTransitions.get(evaluation.name);
    const journeyState = await replayAuthoredJourneyHistory(
      initialState,
      evaluation,
      localTransition,
    );
    if (localTransition !== undefined) {
      appliedLocalTransitions.add(evaluation.name);
    }
    const contextCalls = evaluation.expectedCall.filter(
      ({ functionName }) => functionName === 'get_form_context',
    );
    assert.ok(contextCalls.length > 0);
    for (const call of contextCalls) {
      const documentSessionId = call.mockOutput.documentSessionId ?? '';
      assert.match(documentSessionId, /^[a-f0-9]{32}$/u);
      const projectedState = {
        ...journeyState,
        documentSessionId,
      };
      const cursor = call.arguments.cursor;
      const parsed =
        cursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFormContextCursor(
              cursor,
              {
                documentSessionId,
                sourceHash: projectedState.source.sourceHash,
                stateVersion: projectedState.stateVersion,
              },
              call.arguments,
            );
      assert.equal(parsed.ok, true, `${evaluation.name} has an invalid cursor`);
      if (!parsed.ok) throw new Error('Authored context cursor was invalid.');
      const actual = createFormContextToolData(
        projectedState,
        inspection,
        parsed.offset,
        call.arguments.limit ?? 6,
        call.arguments,
      );
      assert.deepEqual(
        call.mockOutput.data,
        actual,
        `${evaluation.name} does not match the real context projector`,
      );
    }
    for (const call of evaluation.expectedCall.filter(
      ({ functionName }) => functionName === 'get_field_evidence',
    )) {
      assert.ok(call.arguments.fieldNames);
      assert.deepEqual(
        call.mockOutput.data,
        createFieldEvidenceToolData(
          journeyState,
          inspection,
          call.arguments.fieldNames,
        ),
        `${evaluation.name} does not match the real evidence projector`,
      );
    }
  }
  assert.deepEqual(
    [...appliedLocalTransitions].sort(),
    [...localTransitions.keys()].sort(),
  );
});

void test('paginates long choice evidence without losing exact values', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const choices: PdfChoiceDescriptor[] = Array.from(
    { length: 20 },
    (_, index) => ({
      value: `option-${index}-${'值'.repeat(24)}`,
      label: `Choice ${index} ${'说明'.repeat(12)}`,
      labelSource: 'acroform',
    }),
  );
  const choiceValues = choices.map(({ value }) => value);
  const state: FormState = {
    ...initialState,
    fields: {
      ...initialState.fields,
      [FIELD.housing]: {
        ...initialState.fields[FIELD.housing],
        options: choiceValues,
      },
    },
  };
  const choiceInspection: PdfInspection = {
    ...inspection,
    fields: inspection.fields.map((field) =>
      field.name === FIELD.housing
        ? { ...field, choices, options: choiceValues }
        : field,
    ),
  };
  const adapter: FormProofWebMcpAdapter = {
    getFormContext: async () => {
      throw new Error('not used');
    },
    getFieldEvidence(input) {
      const parsed =
        input.choiceCursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFieldChoiceCursor(
              input.choiceCursor,
              state.documentSessionId,
              state.source.sourceHash,
              input.fieldNames[0],
            );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('Generated choice cursor was invalid.');
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFieldEvidenceToolData(
          state,
          choiceInspection,
          input.fieldNames,
          parsed.offset,
        ),
      };
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const evidence = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_field_evidence');
  assert.ok(evidence);

  const collected: Array<{ value: string; label: string }> = [];
  let choiceCursor: string | null = null;
  do {
    const response: FormProofToolResponse = await evidence.execute({
      expectedDocumentSessionId: state.documentSessionId,
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      fieldNames: [FIELD.housing],
      ...(choiceCursor === null ? {} : { choiceCursor }),
    });
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error('Choice evidence page failed.');
    assert.equal(response.outputTruncated, false);
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `choice evidence used ${serializedBytes(response)} bytes`,
    );
    const field: {
      constraints: {
        choices: Array<{ value: string; label: string }>;
        choicePage?: { nextCursor: string | null };
      };
    } = (
      response.data as {
        fields: Array<{
          constraints: {
            choices: Array<{ value: string; label: string }>;
            choicePage?: { nextCursor: string | null };
          };
        }>;
      }
    ).fields[0];
    collected.push(...field.constraints.choices);
    choiceCursor = field.constraints.choicePage?.nextCursor ?? null;
    assert.equal(
      response.nextAction,
      choiceCursor === null ? 'stage_form_values' : 'get_field_evidence',
    );
  } while (choiceCursor !== null);

  assert.deepEqual(
    collected,
    choices.map(({ value, label }) => ({ value, label })),
  );
});

void test('reports an overlong field name without silently skipping it', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const original = inspection.fields[0];
  const longName = 'field-'.padEnd(1_000, 'x');
  const state = await createFormState(initialState.source, [
    {
      ...initialState.fields[original.name],
      name: longName,
      label: 'Long canonical field name',
      required: false,
    },
  ]);
  const longInspection: PdfInspection = {
    ...inspection,
    fieldCount: 1,
    widgetCount: 1,
    fields: [
      {
        ...original,
        name: longName,
        required: false,
        current: '',
      },
    ],
  };
  const adapter: FormProofWebMcpAdapter = {
    getFormContext(input) {
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFormContextToolData(
          state,
          longInspection,
          0,
          input.limit,
          input,
        ),
      };
    },
    getFieldEvidence: async () => {
      throw new Error('not used');
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const context = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_form_context');
  assert.ok(context);

  const response = await context.execute({ limit: 1 });
  assert.equal(response.ok, true);
  if (!response.ok) throw new Error('Long-name context failed.');
  assert.equal(response.outputTruncated, false);
  assert.ok(serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES);
  const data = response.data as {
    fields: Array<{
      agentAddressable: false;
      nameLength: number;
      name?: string;
    }>;
    pagination: {
      returned: number;
      total: number;
      nextCursor: string | null;
    };
  };
  assert.equal(data.fields[0].agentAddressable, false);
  assert.equal(data.fields[0].nameLength, longName.length);
  assert.equal('name' in data.fields[0], false);
  assert.deepEqual(data.pagination, {
    returned: 1,
    total: 1,
    nextCursor: null,
  });
});

void test('never repeats an unreturnable choice cursor', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const original = inspection.fields[0];
  const longName = 'choice-field-'.padEnd(256, 'n');
  const oversizedValue = 'v'.repeat(1_201);
  const choices = [
    {
      value: oversizedValue,
      label: 'L'.repeat(180),
      labelSource: 'acroform' as const,
    },
    { value: 'safe', label: 'Safe choice', labelSource: 'acroform' as const },
  ];
  const initial = await createFormState(initialState.source, [
    {
      name: longName,
      label: 'F'.repeat(180),
      type: 'dropdown',
      required: false,
      readOnly: false,
      humanOnly: false,
      options: choices.map(({ value }) => value),
      multiSelect: false,
      sourceValue: null,
    },
  ]);
  const state: FormState = {
    ...initial,
    draft: {
      [longName]: {
        fieldName: longName,
        value: 'draft',
        actor: 'agent',
        provenance: {
          kind: 'agent_inference',
          confidence: 0.7,
          evidence: ['E'.repeat(120), 'S'.repeat(120)],
          rationale: 'R'.repeat(180),
        },
      },
    },
  };
  const choiceInspection: PdfInspection = {
    ...inspection,
    fieldCount: 1,
    widgetCount: 1,
    fields: [
      {
        ...original,
        name: longName,
        type: 'dropdown',
        required: false,
        current: '',
        options: choices.map(({ value }) => value),
        choices,
        multiSelect: false,
        maxLength: null,
        tooltip: 'T'.repeat(180),
      },
    ],
  };
  const adapter: FormProofWebMcpAdapter = {
    getFormContext: async () => {
      throw new Error('not used');
    },
    getFieldEvidence(input) {
      const parsed =
        input.choiceCursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFieldChoiceCursor(
              input.choiceCursor,
              state.documentSessionId,
              state.source.sourceHash,
              longName,
            );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('Choice cursor was invalid.');
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFieldEvidenceToolData(
          state,
          choiceInspection,
          input.fieldNames,
          parsed.offset,
        ),
      };
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const evidence = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_field_evidence');
  assert.ok(evidence);

  const response = await evidence.execute({
    expectedDocumentSessionId: state.documentSessionId,
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    fieldNames: [longName],
  });
  assert.equal(response.ok, true);
  if (!response.ok) throw new Error('Oversized choice evidence failed.');
  assert.equal(response.outputTruncated, false);
  assert.ok(serializedBytes(response) <= FORMPROOF_MAX_RESPONSE_BYTES);
  const page = (
    response.data as {
      fields: Array<{
        constraints: {
          choicePage: {
            returned: number;
            unavailableChoiceCount: number;
            nextCursor: string | null;
          };
        };
      }>;
    }
  ).fields[0].constraints.choicePage;
  assert.ok(page.returned + page.unavailableChoiceCount > 0);
  assert.notEqual(
    page.nextCursor,
    createFieldChoiceCursor(
      0,
      state.documentSessionId,
      state.source.sourceHash,
      longName,
    ),
  );
});

async function completeDemo(): Promise<CompletedDemo> {
  const stagedDemo = await loadStagedDemo();
  const { inspection, source, stagedState } = stagedDemo;
  const validation = validateDraft(stagedState);
  const approved = approveDraftFromUi(stagedState, {
    expectedStateVersion: stagedState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    expectedPlanHash: stagedState.planHash,
    approvedBy: 'local reviewer',
    approvedAt: '2026-08-29T19:05:00.000Z',
    confirmedFieldNames: [
      ...new Set([
        ...Object.keys(stagedState.draft),
        ...validation.reviewFieldNames,
      ]),
    ],
  });
  assert.equal(
    approved.ok,
    true,
    approved.ok ? undefined : JSON.stringify(approved.errors),
  );
  if (!approved.ok) throw new Error('Exact-plan UI approval failed.');

  const values = draftValues(approved.state);
  const success = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(success.ok, true);
  if (!success.ok) throw new Error('Trusted UI export failed.');
  assert.equal(success.result.sourceHash, inspection.sourceHash);
  assert.equal(getReleaseGate(success.state).open, true);

  return {
    ...stagedDemo,
    values,
    applyResult: success.result,
    releasedState: success.state,
  };
}

void test('carries the real demo PDF through exact human approval and the release gate', async () => {
  const stagedDemo = await loadStagedDemo();
  const { initialState, inspection, stagedState } = stagedDemo;

  assert.equal(initialState.source.sourceHash, inspection.sourceHash);
  assert.equal(Object.keys(initialState.fields).length, inspection.fieldCount);
  const initialBlockers = initialState.validation.issues.filter(
    ({ severity }) => severity === 'error',
  );
  assert.equal(initialState.validation.blockerCount, 4);
  assert.deepEqual(
    initialBlockers.map(({ fieldName }) => fieldName).sort(),
    [FIELD.legalName, FIELD.email, FIELD.consent, FIELD.housing].sort(),
  );
  assert.deepEqual(
    initialBlockers.map(({ fieldName }) => [
      fieldName,
      initialState.fields[fieldName]?.label,
    ]),
    [
      [FIELD.consent, 'Permission to contact about this request'],
      [FIELD.email, 'Email address'],
      [FIELD.legalName, 'Legal name'],
      [FIELD.housing, 'Current housing arrangement'],
    ],
  );
  assert.equal(
    initialBlockers.some(({ fieldName }) => fieldName === FIELD.signature),
    false,
  );
  assert.deepEqual(initialState.validation.reviewFieldNames, [FIELD.signature]);
  assert.equal(initialState.fields[FIELD.witness].humanOnly, true);
  assert.equal(initialState.fields[FIELD.signature].type, 'signature');

  const validation = validateDraft(stagedState);
  assert.equal(validation.blockerCount, 0);
  assert.equal(validation.canApprove, true);
  assert.deepEqual(validation.reviewFieldNames, [
    FIELD.consent,
    FIELD.support,
    FIELD.contact,
    FIELD.email,
    FIELD.legalName,
    FIELD.housing,
    FIELD.notes,
    FIELD.signature,
  ]);
  assert.equal(
    validation.issues.some(
      ({ code, fieldName }) =>
        code === 'human_completion_required' && fieldName === FIELD.signature,
    ),
    true,
  );

  const incompleteApproval = approveDraftFromUi(stagedState, {
    expectedStateVersion: stagedState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    expectedPlanHash: stagedState.planHash,
    approvedBy: 'local reviewer',
    confirmedFieldNames: [FIELD.support],
  });
  assert.equal(incompleteApproval.ok, false);
  if (incompleteApproval.ok) {
    throw new Error('Incomplete review confirmation was accepted.');
  }
  assert.equal(
    incompleteApproval.errors.some(({ code }) => code === 'review_unconfirmed'),
    true,
  );

  const completed = await completeDemo();
  assert.equal(completed.applyResult.sourceHash, inspection.sourceHash);
  assert.notEqual(
    completed.applyResult.outputHash,
    completed.applyResult.sourceHash,
  );
  assert.equal(
    completed.applyResult.verifiedFields.length,
    Object.keys(completed.values).length,
  );
  assert.ok(
    completed.applyResult.verifiedFields.every(
      ({ normalAppearancePresent }) => normalAppearancePresent,
    ),
  );
  assert.equal(
    completed.releasedState.approval?.planHash,
    stagedState.planHash,
  );
  assert.equal(
    completed.releasedState.output?.outputHash,
    completed.applyResult.outputHash,
  );
  assert.equal(
    completed.releasedState.verification?.outputHash,
    completed.applyResult.outputHash,
  );
  assert.equal(getReleaseGate(completed.releasedState).open, true);
});

void test('round-trips canonical clears using inspected choice multiplicity', async () => {
  const { inspection, source, stagedState } = await loadStagedDemo();
  assert.equal(stagedState.fields[FIELD.contact].multiSelect, false);
  assert.equal(stagedState.fields[FIELD.support].multiSelect, true);

  const cleared = await stageFieldUpdates(stagedState, {
    expectedStateVersion: stagedState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.support,
        value: null,
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.notes,
        value: null,
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) throw new Error('Canonical clear staging failed.');
  assert.equal(cleared.state.draft[FIELD.contact].value, 'Phone');
  assert.deepEqual(cleared.state.draft[FIELD.support].value, []);
  assert.equal(cleared.state.draft[FIELD.notes].value, '');

  const validation = validateDraft(cleared.state);
  const approved = approveDraftFromUi(cleared.state, {
    expectedStateVersion: cleared.state.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    expectedPlanHash: cleared.state.planHash,
    approvedBy: 'local reviewer',
    confirmedFieldNames: [
      ...new Set([
        ...Object.keys(cleared.state.draft),
        ...validation.reviewFieldNames,
      ]),
    ],
  });
  assert.equal(
    approved.ok,
    true,
    approved.ok ? undefined : JSON.stringify(approved.errors),
  );
  if (!approved.ok) throw new Error('Canonical clear approval failed.');

  const exported = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('Canonical clear export failed.');
  assert.equal(getReleaseGate(exported.state).open, true);

  const outputInspection = await inspectPdf(exported.result.bytes);
  const outputByName = new Map(
    outputInspection.fields.map((field) => [field.name, field] as const),
  );
  assert.equal(outputByName.get(FIELD.contact)?.current, 'Phone');
  assert.deepEqual(outputByName.get(FIELD.support)?.current, []);
  assert.equal(outputByName.get(FIELD.notes)?.current, '');
});

void test('a real draft mutation revokes approval, output, and verification', async () => {
  const completed = await completeDemo();
  const released = completed.releasedState;
  assert.equal(getReleaseGate(released).open, true);

  const mutation = await stageFieldUpdates(released, {
    expectedStateVersion: released.stateVersion,
    expectedSourceHash: released.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.legalName,
        value: 'Grace Hopper',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(mutation.ok, true);
  if (!mutation.ok) throw new Error('Real draft mutation failed.');

  assert.equal(mutation.state.stateVersion, released.stateVersion + 1);
  assert.notEqual(mutation.state.planHash, released.planHash);
  assert.equal(mutation.state.approval, null);
  assert.equal(mutation.state.output, null);
  assert.equal(mutation.state.verification, null);
  assert.equal(getReleaseGate(mutation.state).open, false);
});

void test('agent staging rejects human-only and signature fields atomically', async () => {
  const source = new Uint8Array(
    await readFile(new URL('../public/demo-form.pdf', import.meta.url)),
  );
  const inspection = await inspectPdf(source);
  const state = await createFormState(
    {
      fileName: 'demo-form.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );

  const rejected = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.legalName,
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.witness,
        value: 'AL',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.signature,
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error('Unsafe mixed batch was accepted.');

  assert.equal(rejected.state, state);
  assert.equal(rejected.state.stateVersion, 0);
  assert.equal(rejected.state.planHash, state.planHash);
  assert.deepEqual(Object.keys(rejected.state.draft), []);
  assert.equal(JSON.stringify(rejected.state.draft), '{}');
  assert.equal(
    rejected.errors.some(
      ({ code, fieldName }) =>
        code === 'human_only' && fieldName === FIELD.witness,
    ),
    true,
  );
  assert.equal(
    rejected.errors.some(
      ({ code, fieldName }) =>
        code === 'signature_locked' && fieldName === FIELD.signature,
    ),
    true,
  );
});
