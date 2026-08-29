import {
  EncryptedPDFError,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  StandardFonts,
} from 'pdf-lib';

export const PDF_ENGINE_SUPPORT = {
  formType: 'AcroForm',
  preservesInteractiveFields: true,
  unsupported: [
    'encrypted PDFs',
    'XFA forms',
    'signed PDFs',
    'signature writing',
    'characters outside the built-in WinAnsi appearance font',
  ],
} as const;

export type PdfFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'option_list'
  | 'signature'
  | 'unsupported';

export type PdfFieldValue = string | boolean | string[] | null;

export type PdfEngineErrorCode =
  | 'CRYPTO_UNAVAILABLE'
  | 'PDF_ENCRYPTED'
  | 'PDF_LOAD_FAILED'
  | 'PDF_XFA_UNSUPPORTED'
  | 'PDF_SIGNED_UNSUPPORTED'
  | 'FIELD_NOT_FOUND'
  | 'FIELD_READ_ONLY'
  | 'FIELD_HUMAN_ONLY'
  | 'FIELD_SIGNATURE_UNSUPPORTED'
  | 'FIELD_TYPE_UNSUPPORTED'
  | 'FIELD_VALUE_TYPE_INVALID'
  | 'FIELD_OPTION_INVALID'
  | 'FIELD_VALUE_TOO_LONG'
  | 'FIELD_GLYPH_UNSUPPORTED'
  | 'PDF_APPLY_FAILED'
  | 'PDF_VERIFY_FIELD_MISSING'
  | 'PDF_VERIFY_VALUE_MISMATCH'
  | 'PDF_VERIFY_WIDGET_MISSING'
  | 'PDF_VERIFY_WIDGET_PAGE_MISSING'
  | 'PDF_VERIFY_APPEARANCE_MISSING'
  | 'PDF_VERIFY_WIDGET_VALUE_MISMATCH';

export type PdfEngineWarningCode =
  | 'NO_ACROFORM_FIELDS'
  | 'SIGNATURE_FIELD_HUMAN_ONLY'
  | 'UNSUPPORTED_FIELD_TYPE'
  | 'WIDGET_PAGE_UNKNOWN'
  | 'APPEARANCE_UNAVAILABLE';

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfWidgetDescriptor {
  page: number | null;
  rect: PdfRect;
  hasAppearance: boolean;
}

export interface PdfChoiceDescriptor {
  value: string;
  label: string;
}

export interface PdfFieldDescriptor {
  name: string;
  type: PdfFieldType;
  current: PdfFieldValue;
  options: string[];
  choices: PdfChoiceDescriptor[];
  multiSelect: boolean;
  required: boolean;
  readOnly: boolean;
  humanOnly: boolean;
  page: number | null;
  rect: PdfRect | null;
  maxLength: number | null;
  tooltip: string | null;
  widgetCount: number;
  widgets: PdfWidgetDescriptor[];
}

export interface PdfEngineWarning {
  code: PdfEngineWarningCode;
  message: string;
  fieldName?: string;
}

export interface PdfInspection {
  sourceHash: string;
  pageCount: number;
  fieldCount: number;
  widgetCount: number;
  fields: PdfFieldDescriptor[];
  warnings: PdfEngineWarning[];
}

export interface VerifiedPdfField {
  name: string;
  type: PdfFieldType;
  value: PdfFieldValue;
  widgetCount: number;
  appearanceVerified: boolean;
}

export interface ApplyResult {
  bytes: Uint8Array;
  sourceHash: string;
  outputHash: string;
  fieldCount: number;
  widgetCount: number;
  verifiedFields: VerifiedPdfField[];
  warnings: PdfEngineWarning[];
}

export class PdfEngineError extends Error {
  readonly code: PdfEngineErrorCode;
  readonly fieldName?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PdfEngineErrorCode,
    message: string,
    options: {
      fieldName?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'PdfEngineError';
    this.code = code;
    this.fieldName = options.fieldName;
    this.details = options.details;

    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
      });
    }
  }
}

interface LoadedPdf {
  document: PDFDocument;
  form: ReturnType<PDFDocument['getForm']>;
}

const HUMAN_ONLY_MARKER = /\[\s*HUMAN[_ -]?ONLY\s*\]/i;

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PdfEngineError(
      'CRYPTO_UNAVAILABLE',
      'SHA-256 is unavailable in this browser context.',
    );
  }

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  let document: PDFDocument;

  try {
    document = await PDFDocument.load(copyBytes(bytes), {
      updateMetadata: false,
    });
  } catch (cause) {
    if (
      cause instanceof EncryptedPDFError ||
      (cause instanceof Error && /encrypted/i.test(cause.message))
    ) {
      throw new PdfEngineError(
        'PDF_ENCRYPTED',
        'Encrypted PDFs are not supported. Decrypt the file before importing it.',
        { cause },
      );
    }

    throw new PdfEngineError(
      'PDF_LOAD_FAILED',
      'The file could not be parsed as a PDF.',
      { cause },
    );
  }

  const acroFormDictionary = document.catalog.AcroForm();
  if (acroFormDictionary?.has(PDFName.of('XFA'))) {
    throw new PdfEngineError(
      'PDF_XFA_UNSUPPORTED',
      'XFA forms are not supported. Use a standard AcroForm PDF.',
    );
  }

  const form = document.getForm();
  ensureNoExistingSignatures(form);

  return { document, form };
}

function fieldType(field: PDFField): PdfFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'option_list';
  if (field instanceof PDFSignature) return 'signature';
  return 'unsupported';
}

function decodePdfText(value: unknown): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return null;
}

function fieldTooltip(field: PDFField): string | null {
  return decodePdfText(
    field.acroField.getInheritableAttribute(PDFName.of('TU')),
  );
}

function isHumanOnly(
  field: PDFField,
  type: PdfFieldType,
  tooltip: string | null,
): boolean {
  return (
    type === 'signature' ||
    HUMAN_ONLY_MARKER.test(field.getName()) ||
    (tooltip !== null && HUMAN_ONLY_MARKER.test(tooltip))
  );
}

function fieldChoices(field: PDFField): PdfChoiceDescriptor[] {
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    return field.acroField.getOptions().map(({ value, display }) => ({
      value: value.decodeText(),
      label: display.decodeText(),
    }));
  }
  if (field instanceof PDFRadioGroup) {
    return field.getOptions().map((value) => ({ value, label: value }));
  }
  return [];
}

function fieldAllowsMultiple(field: PDFField): boolean {
  return (
    (field instanceof PDFDropdown || field instanceof PDFOptionList) &&
    field.isMultiselect()
  );
}

function fieldValue(field: PDFField): PdfFieldValue {
  if (field instanceof PDFTextField) return field.getText() ?? '';
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? null;
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const selected = field.getSelected();
    if (field.isMultiselect()) return selected;
    return selected[0] ?? null;
  }
  return null;
}

function widgetAppearanceExists(widget: {
  getAppearances(): { normal: PDFStream | PDFDict } | undefined;
}): boolean {
  try {
    const normal = widget.getAppearances()?.normal;
    if (normal instanceof PDFStream) return normal.getContentsSize() > 0;
    if (normal instanceof PDFDict) return normal.keys().length > 0;
    return false;
  } catch {
    return false;
  }
}

function widgetRefs(field: PDFField): PDFRef[] {
  const kids = field.acroField.Kids();
  if (!kids) return [field.ref];

  const refs: PDFRef[] = [];
  for (let index = 0; index < kids.size(); index += 1) {
    const ref = kids.get(index);
    if (ref instanceof PDFRef) refs.push(ref);
  }
  return refs;
}

function describeWidgets(
  document: PDFDocument,
  field: PDFField,
): PdfWidgetDescriptor[] {
  const widgets = field.acroField.getWidgets();
  const refs = widgetRefs(field);
  const pages = document.getPages();

  return widgets.map((widget, index) => {
    const annotationRef = refs[index];
    let pageIndex = annotationRef
      ? pages.indexOf(document.findPageForAnnotationRef(annotationRef)!)
      : -1;

    if (pageIndex < 0) {
      const pageRef = widget.P();
      pageIndex = pageRef
        ? pages.findIndex((page) => page.ref.toString() === pageRef.toString())
        : -1;
    }

    return {
      page: pageIndex < 0 ? null : pageIndex + 1,
      rect: widget.getRectangle(),
      hasAppearance: widgetAppearanceExists(widget),
    };
  });
}

function describeField(
  document: PDFDocument,
  field: PDFField,
): PdfFieldDescriptor {
  const type = fieldType(field);
  const tooltip = fieldTooltip(field);
  const widgets = describeWidgets(document, field);
  const choices = fieldChoices(field);

  return {
    name: field.getName(),
    type,
    current: fieldValue(field),
    options: choices.map((choice) => choice.value),
    choices,
    multiSelect: fieldAllowsMultiple(field),
    required: field.isRequired(),
    readOnly: field.isReadOnly(),
    humanOnly: isHumanOnly(field, type, tooltip),
    page: widgets[0]?.page ?? null,
    rect: widgets[0]?.rect ?? null,
    maxLength:
      field instanceof PDFTextField ? (field.getMaxLength() ?? null) : null,
    tooltip,
    widgetCount: widgets.length,
    widgets,
  };
}

function inspectionWarnings(fields: PdfFieldDescriptor[]): PdfEngineWarning[] {
  const warnings: PdfEngineWarning[] = [];

  if (fields.length === 0) {
    warnings.push({
      code: 'NO_ACROFORM_FIELDS',
      message: 'The PDF does not contain any AcroForm fields.',
    });
  }

  for (const field of fields) {
    if (field.type === 'signature') {
      warnings.push({
        code: 'SIGNATURE_FIELD_HUMAN_ONLY',
        fieldName: field.name,
        message:
          'Signature fields are shown for review but can only be completed by a person.',
      });
    } else if (field.type === 'unsupported') {
      warnings.push({
        code: 'UNSUPPORTED_FIELD_TYPE',
        fieldName: field.name,
        message: 'This AcroForm field type cannot be filled by FormProof.',
      });
    }

    if (field.widgets.some((widget) => widget.page === null)) {
      warnings.push({
        code: 'WIDGET_PAGE_UNKNOWN',
        fieldName: field.name,
        message: 'At least one widget could not be mapped to a PDF page.',
      });
    }

    if (field.widgets.some((widget) => !widget.hasAppearance)) {
      warnings.push({
        code: 'APPEARANCE_UNAVAILABLE',
        fieldName: field.name,
        message:
          'At least one widget has no verifiable normal appearance stream.',
      });
    }
  }

  return warnings;
}

function inspectLoadedPdf(
  document: PDFDocument,
  form: ReturnType<PDFDocument['getForm']>,
  sourceHash: string,
): PdfInspection {
  const fields = form
    .getFields()
    .map((field) => describeField(document, field));
  return {
    sourceHash,
    pageCount: document.getPageCount(),
    fieldCount: fields.length,
    widgetCount: fields.reduce((total, field) => total + field.widgetCount, 0),
    fields,
    warnings: inspectionWarnings(fields),
  };
}

export async function inspectPdf(source: Uint8Array): Promise<PdfInspection> {
  const sourceHash = await sha256Hex(source);
  const { document, form } = await loadPdf(source);
  return inspectLoadedPdf(document, form, sourceHash);
}

function invalidValueType(fieldName: string, expected: string): PdfEngineError {
  return new PdfEngineError(
    'FIELD_VALUE_TYPE_INVALID',
    `Field "${fieldName}" expects ${expected}.`,
    { fieldName, details: { expected } },
  );
}

function validateText(
  descriptor: PdfFieldDescriptor,
  value: PdfFieldValue,
): string {
  if (value !== null && typeof value !== 'string') {
    throw invalidValueType(descriptor.name, 'a string or null');
  }

  const normalized = typeof value === 'string' ? value : '';
  const length = Array.from(normalized).length;
  if (descriptor.maxLength !== null && length > descriptor.maxLength) {
    throw new PdfEngineError(
      'FIELD_VALUE_TOO_LONG',
      `Field "${descriptor.name}" is limited to ${descriptor.maxLength} characters.`,
      {
        fieldName: descriptor.name,
        details: { actualLength: length, maxLength: descriptor.maxLength },
      },
    );
  }

  return normalized;
}

function validateChoice(
  descriptor: PdfFieldDescriptor,
  value: PdfFieldValue,
): string | string[] | null {
  const expected = descriptor.multiSelect
    ? 'a string array or null'
    : 'a string or null';
  let selections: string[];

  if (value === null) selections = [];
  else if (descriptor.multiSelect && Array.isArray(value)) {
    selections = [...value];
  } else if (!descriptor.multiSelect && typeof value === 'string') {
    selections = [value];
  } else throw invalidValueType(descriptor.name, expected);

  if (!selections.every((item) => typeof item === 'string')) {
    throw invalidValueType(descriptor.name, expected);
  }

  const invalid = selections.find(
    (selection) => !descriptor.options.includes(selection),
  );
  if (invalid !== undefined) {
    throw new PdfEngineError(
      'FIELD_OPTION_INVALID',
      `"${invalid}" is not an available option for field "${descriptor.name}".`,
      {
        fieldName: descriptor.name,
        details: { invalidOption: invalid, options: descriptor.options },
      },
    );
  }

  return descriptor.multiSelect ? selections : (selections[0] ?? null);
}

type ValidatedValue = string | boolean | string[] | null;

function validateValue(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: PdfFieldValue,
): ValidatedValue {
  if (field instanceof PDFTextField) {
    return validateText(descriptor, value);
  }

  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') {
      throw invalidValueType(descriptor.name, 'a boolean');
    }
    return value;
  }

  if (
    field instanceof PDFRadioGroup ||
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList
  ) {
    return validateChoice(descriptor, value);
  }

  throw new PdfEngineError(
    'FIELD_TYPE_UNSUPPORTED',
    `Field "${descriptor.name}" has an unsupported AcroForm type.`,
    { fieldName: descriptor.name, details: { type: descriptor.type } },
  );
}

function validateGlyphs(
  fieldName: string,
  textValues: string[],
  encode: (text: string) => unknown,
): void {
  for (const text of textValues) {
    try {
      encode(text);
    } catch (cause) {
      throw new PdfEngineError(
        'FIELD_GLYPH_UNSUPPORTED',
        `Field "${fieldName}" contains characters that cannot be rendered with the built-in PDF font.`,
        { fieldName, details: { value: text }, cause },
      );
    }
  }
}

function selectedChoiceValues(value: ValidatedValue): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function choiceLabel(descriptor: PdfFieldDescriptor, value: string): string {
  return (
    descriptor.choices.find((choice) => choice.value === value)?.label ?? value
  );
}

function appearanceTextValues(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: ValidatedValue,
): string[] {
  if (field instanceof PDFTextField) {
    return typeof value === 'string' ? [value] : [];
  }
  if (field instanceof PDFOptionList) {
    return descriptor.choices.map((choice) => choice.label);
  }
  if (field instanceof PDFDropdown) {
    return selectedChoiceValues(value).map((selection) =>
      choiceLabel(descriptor, selection),
    );
  }
  return [];
}

function decodedDefaultAppearance(field: PDFField): string | null {
  const appearance = field.acroField.DA();
  if (appearance instanceof PDFString || appearance instanceof PDFHexString) {
    return appearance.decodeText();
  }
  return null;
}

function fieldFontSize(appearance: string | null): number | null {
  if (!appearance) return null;

  const matches = [
    ...appearance.matchAll(/([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+Tf\b/g),
  ];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function preserveFieldTypography(
  field: PDFField,
  defaultAppearance: string | null,
  fontSize: number | null,
): void {
  if (fontSize === null) return;
  if (
    field instanceof PDFTextField ||
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList
  ) {
    if (defaultAppearance !== null) {
      field.acroField.setDefaultAppearance(defaultAppearance);
    }
    field.setFontSize(fontSize);
  }
}

function applyValue(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: ValidatedValue,
): void {
  if (field instanceof PDFTextField && typeof value === 'string') {
    field.setText(value);
    return;
  }

  if (field instanceof PDFCheckBox && typeof value === 'boolean') {
    if (value) field.check();
    else field.uncheck();
    return;
  }

  if (field instanceof PDFRadioGroup) {
    if (typeof value === 'string') field.select(value);
    else field.clear();
    return;
  }

  if (field instanceof PDFDropdown) {
    const labels = selectedChoiceValues(value).map((selection) =>
      choiceLabel(descriptor, selection),
    );
    if (labels.length === 0) field.clear();
    else field.select(labels.length === 1 ? labels[0] : labels);
    return;
  }

  if (field instanceof PDFOptionList) {
    const labels = selectedChoiceValues(value).map((selection) =>
      choiceLabel(descriptor, selection),
    );
    if (labels.length === 0) field.clear();
    else field.select(labels);
  }
}

function restoreChoiceExportValues(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: ValidatedValue,
): void {
  if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) return;

  const selections = selectedChoiceValues(value);
  const dictionary = field.acroField.dict;
  if (selections.length === 0) {
    dictionary.delete(PDFName.of('V'));
    dictionary.delete(PDFName.of('I'));
    return;
  }

  const encoded = selections.map((selection) =>
    PDFHexString.fromText(selection),
  );
  if (encoded.length === 1) {
    dictionary.set(PDFName.of('V'), encoded[0]);
    dictionary.delete(PDFName.of('I'));
    return;
  }

  dictionary.set(PDFName.of('V'), dictionary.context.obj(encoded));
  const indices = selections
    .map((selection) =>
      descriptor.choices.findIndex((choice) => choice.value === selection),
    )
    .sort((left, right) => left - right);
  dictionary.set(PDFName.of('I'), dictionary.context.obj(indices));
}

function valuesMatch(actual: PdfFieldValue, expected: ValidatedValue): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    const actualItems = Array.isArray(actual) ? [...actual].sort() : [];
    const expectedItems = Array.isArray(expected) ? [...expected].sort() : [];
    return JSON.stringify(actualItems) === JSON.stringify(expectedItems);
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function verifyButtonWidgetValues(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  expected: ValidatedValue,
): void {
  if (!(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) return;

  const states = field.acroField
    .getWidgets()
    .map((widget) => widget.getAppearanceState()?.decodeText() ?? null);

  if (field instanceof PDFCheckBox) {
    const matches = expected
      ? states.every((state) => state !== null && state !== 'Off')
      : states.every((state) => state === 'Off');
    if (matches) return;
  } else {
    const exportValues = field.acroField.getExportValues();
    const optionIndex =
      typeof expected === 'string'
        ? (exportValues ?? []).findIndex(
            (value) => value.decodeText() === expected,
          )
        : -1;
    const expectedAppearance =
      optionIndex >= 0
        ? (field.acroField.getOnValues()[optionIndex]?.decodeText() ?? expected)
        : expected;
    const matches =
      expected === null
        ? states.every((state) => state === 'Off')
        : states.some((state) => state === expectedAppearance) &&
          states.every(
            (state) => state === expectedAppearance || state === 'Off',
          );
    if (matches) return;
  }

  throw new PdfEngineError(
    'PDF_VERIFY_WIDGET_VALUE_MISMATCH',
    `Widget appearance states do not match field "${descriptor.name}".`,
    {
      fieldName: descriptor.name,
      details: { expected, states },
    },
  );
}

function ensureNoExistingSignatures(
  form: ReturnType<PDFDocument['getForm']>,
): void {
  const signedField = form
    .getFields()
    .find(
      (field) =>
        field instanceof PDFSignature &&
        field.acroField.V() !== undefined &&
        field.acroField.V() !== PDFNull,
    );

  if (signedField) {
    throw new PdfEngineError(
      'PDF_SIGNED_UNSUPPORTED',
      'Signed PDFs cannot be modified because saving would invalidate the existing signature.',
      { fieldName: signedField.getName() },
    );
  }
}

export async function applyApprovedValues(
  source: Uint8Array,
  values: Record<string, PdfFieldValue>,
): Promise<ApplyResult> {
  const sourceHash = await sha256Hex(source);
  const { document, form } = await loadPdf(source);

  const entries = Object.entries(values);
  if (entries.length === 0) {
    const unchanged = copyBytes(source);
    const inspection = inspectLoadedPdf(document, form, sourceHash);
    return {
      bytes: unchanged,
      sourceHash,
      outputHash: sourceHash,
      fieldCount: inspection.fieldCount,
      widgetCount: inspection.widgetCount,
      verifiedFields: [],
      warnings: inspection.warnings,
    };
  }

  const font = await document.embedFont(StandardFonts.Helvetica);
  const validated = new Map<
    string,
    {
      field: PDFField;
      descriptor: PdfFieldDescriptor;
      value: ValidatedValue;
      defaultAppearance: string | null;
      fontSize: number | null;
    }
  >();

  for (const [fieldName, requestedValue] of entries) {
    const field = form.getFieldMaybe(fieldName);
    if (!field) {
      throw new PdfEngineError(
        'FIELD_NOT_FOUND',
        `Field "${fieldName}" does not exist in this PDF.`,
        { fieldName },
      );
    }

    const descriptor = describeField(document, field);
    if (field instanceof PDFSignature) {
      throw new PdfEngineError(
        'FIELD_SIGNATURE_UNSUPPORTED',
        `Signature field "${fieldName}" must be completed by a person in a PDF reader.`,
        { fieldName },
      );
    }
    if (descriptor.readOnly) {
      throw new PdfEngineError(
        'FIELD_READ_ONLY',
        `Field "${fieldName}" is read-only.`,
        { fieldName },
      );
    }
    if (descriptor.humanOnly) {
      throw new PdfEngineError(
        'FIELD_HUMAN_ONLY',
        `Field "${fieldName}" is reserved for human completion.`,
        { fieldName },
      );
    }
    if (descriptor.type === 'unsupported') {
      throw new PdfEngineError(
        'FIELD_TYPE_UNSUPPORTED',
        `Field "${fieldName}" has an unsupported AcroForm type.`,
        { fieldName },
      );
    }

    const value = validateValue(field, descriptor, requestedValue);
    validateGlyphs(
      fieldName,
      appearanceTextValues(field, descriptor, value),
      (text) => font.encodeText(text),
    );
    const defaultAppearance = decodedDefaultAppearance(field);
    validated.set(fieldName, {
      field,
      descriptor,
      value,
      defaultAppearance,
      fontSize: fieldFontSize(defaultAppearance),
    });
  }

  try {
    for (const {
      field,
      descriptor,
      value,
      defaultAppearance,
      fontSize,
    } of validated.values()) {
      applyValue(field, descriptor, value);
      preserveFieldTypography(field, defaultAppearance, fontSize);
    }
    form.updateFieldAppearances(font);
    for (const { field, descriptor, value } of validated.values()) {
      restoreChoiceExportValues(field, descriptor, value);
    }
  } catch (cause) {
    if (cause instanceof PdfEngineError) throw cause;
    throw new PdfEngineError(
      'PDF_APPLY_FAILED',
      'The approved field values could not be applied to a fresh PDF copy.',
      { cause },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await document.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    });
  } catch (cause) {
    throw new PdfEngineError(
      'PDF_APPLY_FAILED',
      'The updated PDF could not be serialized.',
      { cause },
    );
  }

  const outputHash = await sha256Hex(bytes);
  const reopened = await loadPdf(bytes);
  const verifiedFields: VerifiedPdfField[] = [];

  for (const [fieldName, planned] of validated) {
    const reopenedField = reopened.form.getFieldMaybe(fieldName);
    if (!reopenedField) {
      throw new PdfEngineError(
        'PDF_VERIFY_FIELD_MISSING',
        `Field "${fieldName}" disappeared after saving the PDF.`,
        { fieldName },
      );
    }

    const descriptor = describeField(reopened.document, reopenedField);
    if (!valuesMatch(descriptor.current, planned.value)) {
      throw new PdfEngineError(
        'PDF_VERIFY_VALUE_MISMATCH',
        `Field "${fieldName}" did not retain its approved value after reopening.`,
        {
          fieldName,
          details: { expected: planned.value, actual: descriptor.current },
        },
      );
    }
    if (descriptor.widgetCount === 0) {
      throw new PdfEngineError(
        'PDF_VERIFY_WIDGET_MISSING',
        `Field "${fieldName}" has no widget after saving.`,
        { fieldName },
      );
    }
    if (descriptor.widgets.some((widget) => widget.page === null)) {
      throw new PdfEngineError(
        'PDF_VERIFY_WIDGET_PAGE_MISSING',
        `A widget for field "${fieldName}" is no longer attached to a page.`,
        { fieldName },
      );
    }
    if (descriptor.widgets.some((widget) => !widget.hasAppearance)) {
      throw new PdfEngineError(
        'PDF_VERIFY_APPEARANCE_MISSING',
        `A widget for field "${fieldName}" has no normal appearance stream after saving.`,
        { fieldName },
      );
    }

    verifyButtonWidgetValues(reopenedField, descriptor, planned.value);
    verifiedFields.push({
      name: fieldName,
      type: descriptor.type,
      value: descriptor.current,
      widgetCount: descriptor.widgetCount,
      appearanceVerified: true,
    });
  }

  const inspection = inspectLoadedPdf(
    reopened.document,
    reopened.form,
    outputHash,
  );

  return {
    bytes,
    sourceHash,
    outputHash,
    fieldCount: inspection.fieldCount,
    widgetCount: inspection.widgetCount,
    verifiedFields,
    warnings: inspection.warnings,
  };
}
