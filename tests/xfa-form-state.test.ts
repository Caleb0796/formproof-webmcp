import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFormFieldDefinitionFromPdf,
  resolvePdfFieldLabel,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';
import type { PdfFieldDescriptor } from '../lib/pdf-engine';

function descriptor(
  overrides: Partial<PdfFieldDescriptor> = {},
): PdfFieldDescriptor {
  return {
    name: 'topmostSubform[0].Page1[0].f1_01[0]',
    type: 'text',
    current: '',
    options: [],
    choices: [],
    multiSelect: false,
    required: false,
    readOnly: false,
    humanOnly: false,
    page: 1,
    rect: { x: 10, y: 10, width: 100, height: 20 },
    maxLength: null,
    tooltip: null,
    xfaSpeak: null,
    xfaCaption: null,
    widgetCount: 1,
    widgets: [
      {
        page: 1,
        rect: { x: 10, y: 10, width: 100, height: 20 },
        hasAppearance: true,
        appearanceState: null,
        choiceValue: null,
      },
    ],
    ...overrides,
  };
}

void test('AcroForm tooltip remains authoritative over conflicting XFA text', () => {
  const field = descriptor({
    tooltip: 'Birth sex',
    xfaSpeak: 'Male',
    xfaCaption: 'Female',
  });

  assert.deepEqual(resolvePdfFieldLabel(field), {
    label: 'Birth sex',
    source: 'acroform_tooltip',
    xfaSearchAllowed: false,
  });
});

void test('long AcroForm help text blocks conflicting XFA fallback', () => {
  const field = descriptor({
    tooltip: 'Detailed PDF instruction '.repeat(10),
    xfaSpeak: 'Conflicting short label',
  });

  assert.deepEqual(resolvePdfFieldLabel(field), {
    label: field.name,
    source: 'field_name',
    xfaSearchAllowed: false,
  });
});

void test('bounded XFA speak and caption label fields with no usable tooltip', () => {
  const spoken = descriptor({
    xfaSpeak: ' Page 1.   First name and middle initial. ',
    xfaCaption: '(a) First name',
  });
  const captioned = descriptor({
    xfaSpeak: 'Detailed instruction '.repeat(20),
    xfaCaption: 'Employer identification number',
  });

  assert.deepEqual(resolvePdfFieldLabel(spoken), {
    label: 'Page 1. First name and middle initial.',
    source: 'xfa_speak',
    xfaSearchAllowed: true,
  });
  assert.equal(
    createFormFieldDefinitionFromPdf(spoken).label,
    'Page 1. First name and middle initial.',
  );
  assert.deepEqual(resolvePdfFieldLabel(captioned), {
    label: 'Employer identification number',
    source: 'xfa_caption',
    xfaSearchAllowed: true,
  });
});

void test('sentinel tooltips permit XFA fallback but visual punctuation does not become a label', () => {
  const field = descriptor({
    tooltip: 'undefined',
    xfaSpeak: ' '.repeat(4),
    xfaCaption: '$',
  });

  assert.deepEqual(resolvePdfFieldLabel(field), {
    label: field.name,
    source: 'field_name',
    xfaSearchAllowed: true,
  });
});
