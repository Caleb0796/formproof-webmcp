import assert from 'node:assert/strict';
import test from 'node:test';

import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';

import {
  applyApprovedValues,
  inspectPdf,
  PdfEngineError,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/pdf-engine.ts';
import {
  createFormState,
  createFormFieldDefinitionFromPdf,
  stageFieldUpdates,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';

const FIELD_NAME = 'topmostSubform[0].Page1[0].f1_01[0]';

async function xfaPdf(
  template: string,
  tooltip: string | null = null,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const field = form.createTextField(FIELD_NAME);
  if (tooltip !== null) {
    field.acroField.dict.set(PDFName.of('TU'), PDFString.of(tooltip));
  }
  field.addToPage(page, {
    x: 40,
    y: 700,
    width: 240,
    height: 24,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  const templateRef = document.context.register(
    document.context.flateStream(template),
  );
  form.acroForm.dict.set(
    PDFName.of('XFA'),
    document.context.obj([PDFString.of('template'), templateRef]),
  );
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function textPdf(
  fieldName: string,
  tooltip: string | null = null,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const field = document.getForm().createTextField(fieldName);
  if (tooltip !== null) {
    field.acroField.dict.set(PDFName.of('TU'), PDFString.of(tooltip));
  }
  field.addToPage(page, {
    x: 40,
    y: 700,
    width: 240,
    height: 24,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function xfaRadioPdf(
  template: string,
  options: readonly string[] = ['A', 'B'],
  fieldName = 'Root[0].Choice[0]',
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const field = form.createRadioGroup(fieldName);
  for (const [index, option] of options.entries()) {
    field.addOptionToPage(option, page, {
      x: 40 + index * 30,
      y: 700,
      width: 18,
      height: 18,
      borderWidth: 1,
      borderColor: rgb(0, 0, 0),
    });
  }
  const templateRef = document.context.register(
    document.context.flateStream(template),
  );
  form.acroForm.dict.set(
    PDFName.of('XFA'),
    document.context.obj([PDFString.of('template'), templateRef]),
  );
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function xfaDropdownPdf(template: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const field = form.createDropdown('Root[0].Choice[0]');
  field.addOptions(['1', '2']);
  field.addToPage(page, {
    x: 40,
    y: 700,
    width: 120,
    height: 24,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  const templateRef = document.context.register(
    document.context.flateStream(template),
  );
  form.acroForm.dict.set(
    PDFName.of('XFA'),
    document.context.obj([PDFString.of('template'), templateRef]),
  );
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

const VALID_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform">
    <subform name="Page1">
      <field name="f1_01">
        <assist><speak>Page 1. First name and middle initial.</speak></assist>
        <caption><value><text>(a) First name</text></value></caption>
      </field>
    </subform>
  </subform>
</template>`;

void test('attaches bounded XFA semantics by exact SOM name without changing the writable name', async () => {
  const source = await xfaPdf(VALID_TEMPLATE);
  const snapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];

  assert.equal(field.name, FIELD_NAME);
  assert.equal(field.xfaSpeak, 'Page 1. First name and middle initial.');
  assert.equal(field.xfaCaption, '(a) First name');
  assert.equal(
    createFormFieldDefinitionFromPdf(field).label,
    'Page 1. First name and middle initial.',
  );
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
  assert.match(
    inspection.warnings.find(
      ({ code }) => code === 'XFA_PRESENT_INSPECTION_ONLY',
    )?.message ?? '',
    /1 of 1 AcroForm fallback fields/u,
  );

  await assert.rejects(
    applyApprovedValues(source, { [FIELD_NAME]: 'Must not be written' }),
    (error: unknown) =>
      error instanceof PdfEngineError && error.code === 'PDF_XFA_UNSUPPORTED',
  );
  assert.deepEqual(source, snapshot);
});

void test('keeps disabled XFA speak discovery-only without changing field authority or protection', async () => {
  const discoveryText = 'First name and middle initial';
  const source = await xfaPdf(`<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01">
      <assist><speak disable="1" priority="custom">${discoveryText}</speak></assist>
    </field>
  </subform></subform>
</template>`);

  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];
  const definition = createFormFieldDefinitionFromPdf(field);

  assert.equal(field.name, FIELD_NAME);
  assert.equal(field.xfaSomNameMatched, true);
  assert.equal(field.xfaSpeak, null);
  assert.equal(field.xfaCaption, null);
  assert.deepEqual(field.discoveryAliases, [
    { value: discoveryText, source: 'xfa_disabled_speak' },
  ]);
  assert.equal(field.humanOnly, false);
  assert.equal(field.readOnly, false);
  assert.equal(definition.label, FIELD_NAME);
  assert.deepEqual(definition.identityReviewReasons, ['xfa_disabled_speak']);
  assert.equal(inspection.protection.protectionType, 'none');
  assert.deepEqual(inspection.protection.allowedMutations, [
    'inspect_fields',
    'stage_field_values',
    'create_fill_package',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
  assert.equal(inspection.protection.signatureImpact, 'none');
  assert.equal(inspection.protection.requiresHumanConfirmation, false);
  assert.equal(inspection.protection.evidence.xfaPresent, true);
});

void test('suppresses disabled XFA discovery text behind any real tooltip', async () => {
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01">
      <assist><speak disable="1">Untrusted nearby instruction</speak></assist>
    </field>
  </subform></subform>
</template>`;

  for (const tooltip of [
    'Printed applicant name',
    `Detailed authoritative PDF help ${'x'.repeat(200)}`,
  ]) {
    const inspection = await inspectPdf(await xfaPdf(template, tooltip));
    const field = inspection.fields[0];

    assert.equal(field.xfaSpeak, null);
    assert.equal(field.discoveryAliases, undefined);
  }
});

void test('adds only an exact whole-token SSN discovery alias', async () => {
  const exactInspection = await inspectPdf(await textPdf('Applicant SSN 1'));
  const exactField = exactInspection.fields[0];

  assert.deepEqual(exactField.discoveryAliases, [
    {
      value: 'social security number',
      source: 'standard_initialism',
    },
  ]);
  assert.equal(exactField.xfaSpeak, null);
  assert.equal(exactField.xfaCaption, null);
  assert.equal(
    createFormFieldDefinitionFromPdf(exactField).label,
    'Applicant SSN 1',
  );

  for (const nearName of [
    'Applicant SSN1',
    'ApplicantSSN',
    'Applicant SSNs',
    'Applicant ssn 1',
  ]) {
    const inspection = await inspectPdf(await textPdf(nearName));
    assert.equal(
      inspection.fields[0].discoveryAliases,
      undefined,
      `${nearName} must not expand as SSN`,
    );
  }
});

void test('rejects agent staging when XFA field restrictions cannot be resolved', async () => {
  const source = await xfaPdf(`<!DOCTYPE template [<!ENTITY x "unsafe">]>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01"><assist><speak>&x;</speak></assist></field>
  </subform></subform>
</template>`);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.fields[0].name, FIELD_NAME);
  assert.equal(inspection.fields[0].xfaSpeak, null);
  assert.equal(inspection.fields[0].xfaCaption, null);
  assert.equal(inspection.fields[0].humanOnly, true);
  assert.ok(
    inspection.warnings.some(
      ({ code, message }) =>
        code === 'XFA_SEMANTICS_UNAVAILABLE' &&
        message.includes('template_unsafe_xml'),
    ),
  );
  assert.deepEqual(inspection.protection.allowedMutations, ['inspect_fields']);
  assert.deepEqual(inspection.protection.exportStrategies, []);

  const state = await createFormState(
    {
      fileName: 'unresolved-xfa.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD_NAME,
        value: 'Must not be staged',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['Unresolved XFA regression value'],
        },
      },
    ],
  });
  assert.equal(staged.ok, false);
  if (staged.ok) throw new Error('Unresolved XFA field was agent-writable');
  assert.deepEqual(
    staged.errors.map(({ code }) => code),
    ['human_only'],
  );
});

void test('reserves an exact XFA signature label for human completion', async () => {
  const source = await xfaPdf(`<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01"><assist><speak>Signature of applicant</speak></assist></field>
  </subform></subform>
</template>`);
  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];

  assert.equal(field.xfaSomNameMatched, true);
  assert.equal(field.humanOnly, true);
  assert.equal(
    createFormFieldDefinitionFromPdf(field).label,
    'Signature of applicant',
  );
  assert.ok(
    inspection.warnings.some(
      ({ code, fieldName }) =>
        code === 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY' && fieldName === FIELD_NAME,
    ),
  );

  const state = await createFormState(
    {
      fileName: 'xfa-signature.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD_NAME,
        value: 'Must not be staged',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['Synthetic regression value'],
        },
      },
    ],
  });
  assert.equal(staged.ok, false);
  if (staged.ok) throw new Error('XFA signature text was agent-writable');
  assert.deepEqual(
    staged.errors.map(({ code }) => code),
    ['human_only'],
  );
});

void test('reserves an exact XFA signature widget even without a signature label', async () => {
  const source = await xfaPdf(`<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01">
      <ui><signature/></ui>
      <assist><speak>Approval control</speak></assist>
    </field>
  </subform></subform>
</template>`);
  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];

  assert.equal(field.xfaSomNameMatched, true);
  assert.equal(field.xfaSignatureWidget, true);
  assert.equal(field.humanOnly, true);
  assert.ok(
    inspection.warnings.some(
      ({ code, fieldName, message }) =>
        code === 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY' &&
        fieldName === FIELD_NAME &&
        message.includes('XFA declares'),
    ),
  );

  const state = await createFormState(
    {
      fileName: 'xfa-signature-widget.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD_NAME,
        value: 'Must not be staged',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['Synthetic signature-widget regression value'],
        },
      },
    ],
  });
  assert.equal(staged.ok, false);
  if (staged.ok) throw new Error('XFA signature widget was agent-writable');
  assert.deepEqual(
    staged.errors.map(({ code }) => code),
    ['human_only'],
  );
});

void test('does not discard XFA signature safety when other semantics are unsupported', async () => {
  const source = await xfaPdf(`<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01"><ui><signature/></ui></field>
    <subformSet name="Unsupported"><subform name="Child"/></subformSet>
  </subform></subform>
</template>`);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.fields[0].humanOnly, true);
  assert.equal(inspection.fields[0].xfaSignatureWidget, undefined);
  assert.deepEqual(inspection.protection.allowedMutations, ['inspect_fields']);
  assert.ok(
    inspection.warnings.some(
      ({ code, message }) =>
        code === 'XFA_SEMANTICS_UNAVAILABLE' &&
        message.includes('template_structure_unsupported'),
    ),
  );
});

void test('honors exact XFA access restrictions for writable AcroForm fallbacks', async () => {
  const source = await xfaPdf(`<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform" access="protected"><subform name="Page1">
    <field name="f1_01" access="open">
      <assist><speak>Protected value</speak></assist>
    </field>
  </subform></subform>
</template>`);
  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];

  assert.equal(field.readOnly, true);
  assert.equal(field.humanOnly, false);

  const state = await createFormState(
    {
      fileName: 'xfa-protected.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD_NAME,
        value: 'Must not be staged',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['XFA access regression value'],
        },
      },
    ],
  });
  assert.equal(staged.ok, false);
  if (staged.ok) throw new Error('XFA-protected field was agent-writable');
  assert.deepEqual(
    staged.errors.map(({ code }) => code),
    ['read_only'],
  );
});

void test('rejects every radio option when one exact XFA group member is restricted', async () => {
  const source = await xfaRadioPdf(`<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="Root">
    <exclGroup name="Choice">
      <assist><speak>Choose access</speak></assist>
      <field name="A" access="protected"/>
      <field name="B" access="open"/>
    </exclGroup>
  </subform>
</template>`);
  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];

  assert.equal(field.name, 'Root[0].Choice[0]');
  assert.equal(field.type, 'radio');
  assert.deepEqual(field.options, ['A', 'B']);
  assert.equal(field.xfaSomNameMatched, true);
  assert.equal(field.readOnly, true);
  assert.equal(field.humanOnly, false);

  const state = await createFormState(
    {
      fileName: 'xfa-radio-member-access.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  for (const value of ['A', 'B']) {
    const staged = await stageFieldUpdates(state, {
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      actor: 'agent',
      updates: [
        {
          fieldName: field.name,
          value,
          provenance: {
            kind: 'user_instruction',
            confidence: 1,
            evidence: [`XFA radio access regression ${value}`],
          },
        },
      ],
    });
    assert.equal(staged.ok, false);
    if (staged.ok)
      throw new Error(`XFA-protected radio option ${value} staged`);
    assert.deepEqual(
      staged.errors.map(({ code }) => code),
      ['read_only'],
    );
  }
});

void test('does not let conflicting XFA signature text override an AcroForm tooltip', async () => {
  const source = await xfaPdf(
    `<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="topmostSubform"><subform name="Page1">
    <field name="f1_01"><assist><speak>Signature of applicant</speak></assist></field>
  </subform></subform>
</template>`,
    'Printed applicant name',
  );
  const inspection = await inspectPdf(source);
  const field = inspection.fields[0];

  assert.equal(field.xfaSomNameMatched, true);
  assert.equal(field.humanOnly, false);
  assert.equal(
    createFormFieldDefinitionFromPdf(field).label,
    'Printed applicant name',
  );
  assert.equal(
    inspection.warnings.some(
      ({ code }) => code === 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY',
    ),
    false,
  );
});

const STATIC_CHOICE_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
  <subform name="Root">
    <exclGroup name="Choice">
      <field name="Gender">
        <ui><checkButton/></ui>
        <caption><value><text>FEMALE</text></value></caption>
        <assist><toolTip>Conflicting MALE tooltip</toolTip></assist>
        <items><text>1</text></items>
      </field>
      <field name="Gender">
        <items><integer>2</integer></items>
        <assist><toolTip>Conflicting FEMALE tooltip</toolTip></assist>
        <caption><value><text>MALE</text></value></caption>
        <ui><checkButton/></ui>
      </field>
    </exclGroup>
  </subform>
</template>`;

void test('uses static XFA captions only for an exact radio SOM and complete export-value set', async () => {
  const inspection = await inspectPdf(
    await xfaRadioPdf(STATIC_CHOICE_TEMPLATE, ['1', '2']),
  );
  const field = inspection.fields[0];

  assert.equal(field.name, 'Root[0].Choice[0]');
  assert.equal(field.type, 'radio');
  assert.deepEqual(field.choices, [
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
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
  assert.match(
    inspection.warnings.find(
      ({ code }) => code === 'XFA_PRESENT_INSPECTION_ONLY',
    )?.message ?? '',
    /bounded static captions were recovered for 1 radio groups/u,
  );
});

void test('keeps every AcroForm label when static XFA matching is partial or not exact', async () => {
  const cases = [
    {
      name: 'partial AcroForm set',
      source: () => xfaRadioPdf(STATIC_CHOICE_TEMPLATE, ['1', '3']),
      expectedValues: ['1', '3'],
    },
    {
      name: 'duplicate normalized captions with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<text>FEMALE</text>',
            '<text>SAME</text>',
          ).replace('<text>MALE</text>', '<text> SAME </text>'),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'duplicate case-folded captions with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<text>FEMALE</text>',
            '<text>SAME</text>',
          ).replace('<text>MALE</text>', '<text>same</text>'),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'visually empty caption with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<text>FEMALE</text>',
            '<text>&#x200B;</text>',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'hidden field with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<field name="Gender">',
            '<field name="Gender" presence="hidden">',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'inactive caption with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<caption><value><text>FEMALE</text>',
            '<caption presence="inactive"><value><text>FEMALE</text>',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'invisible items with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<items><text>1</text>',
            '<items presence="invisible"><text>1</text>',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'conditional group with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<exclGroup name="Choice">',
            '<exclGroup name="Choice" relevant="print">',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'hidden ancestor with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<subform name="Root">',
            '<subform name="Root" presence="hidden">',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'conditional ancestor with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<subform name="Root">',
            '<subform name="Root" relevant="print">',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'dynamic items reference with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<items><text>1</text>',
            '<items ref="$record.dynamic"><text>1</text>',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'display-only items value with exact SOM and complete values',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace(
            '<items><text>1</text>',
            '<items save="0"><text>1</text>',
          ),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'non-exact SOM',
      source: () =>
        xfaRadioPdf(
          STATIC_CHOICE_TEMPLATE.replace('name="Choice"', 'name="Other"'),
          ['1', '2'],
        ),
      expectedValues: ['1', '2'],
    },
    {
      name: 'non-radio AcroForm field',
      source: () => xfaDropdownPdf(STATIC_CHOICE_TEMPLATE),
      expectedValues: ['1', '2'],
    },
  ];

  for (const candidate of cases) {
    const inspection = await inspectPdf(await candidate.source());
    assert.deepEqual(
      inspection.fields[0].choices,
      candidate.expectedValues.map((value) => ({
        value,
        label: value,
        labelSource: 'acroform',
      })),
      candidate.name,
    );
    assert.match(
      inspection.warnings.find(
        ({ code }) => code === 'XFA_PRESENT_INSPECTION_ONLY',
      )?.message ?? '',
      /bounded static captions were recovered for 0 radio groups/u,
      candidate.name,
    );
  }
});
