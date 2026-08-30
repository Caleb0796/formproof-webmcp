import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';
import { SaxesParser, type SaxesTagNS } from 'saxes';

const MAX_TEMPLATE_BYTES = 4 * 1024 * 1024;
const MAX_COMPRESSED_TEMPLATE_BYTES = 4 * 1024 * 1024;
const MAX_XML_NODES = 100_000;
const MAX_XML_DEPTH = 64;
const MAX_SOM_CANDIDATES = 10_000;
const MAX_GENERATED_SOM_CHARACTERS = 2 * 1024 * 1024;
const MAX_SPEAK_TEXT = 2_000;
const MAX_CAPTION_TEXT = 512;
const MAX_DISCOVERY_SPEAK_TEXT = 180;
const MAX_DISCOVERY_SPEAK_CHARACTERS = 256 * 1024;
const MAX_STATIC_CHOICE_VALUE_TEXT = 512;
const MAX_STATIC_CHOICES_PER_GROUP = 256;
const MAX_STATIC_CHOICE_GROUP_CHARACTERS = 64 * 1024;
const MAX_STATIC_CHOICE_CHARACTERS = 256 * 1024;
const XFA_TEMPLATE_NAMESPACES = new Set([
  'http://www.xfa.org/schema/xfa-template/3.3/',
  'http://www.xfa.org/schema/xfa-template/3.6/',
]);
const UNSAFE_XML_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)(?:\s|>)/iu;
const XML_NAME_WITHOUT_COLON =
  /^[A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}][-.0-9A-Z_a-z\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c-\u200d\u203f-\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]*$/u;

export interface XfaFieldSemantics {
  readonly speak: string | null;
  readonly caption: string | null;
  readonly discoverySpeak?: string;
  readonly staticChoices?: readonly XfaStaticChoice[];
}

export interface XfaStaticChoice {
  readonly value: string;
  readonly label: string;
}

export type XfaSemanticsUnavailableReason =
  | 'acroform_missing'
  | 'xfa_missing'
  | 'xfa_not_packet_array'
  | 'xfa_packet_array_malformed'
  | 'template_packet_missing'
  | 'template_packet_duplicate'
  | 'template_packet_decode_failed'
  | 'template_packet_filter_unsupported'
  | 'template_packet_compressed_too_large'
  | 'template_packet_too_large'
  | 'template_invalid_utf8'
  | 'template_unsafe_xml'
  | 'template_malformed_xml'
  | 'template_namespace_unsupported'
  | 'template_node_limit_exceeded'
  | 'template_depth_limit_exceeded'
  | 'template_invalid_som_name'
  | 'template_occurrence_unsupported'
  | 'template_structure_unsupported'
  | 'template_semantic_budget_exceeded'
  | 'template_processing_failed';

export interface XfaSemanticsResult {
  readonly status: 'available' | 'unavailable';
  readonly reason: XfaSemanticsUnavailableReason | null;
  readonly byExactSomName: Map<string, XfaFieldSemantics>;
  readonly humanOnlyExactSomNames: ReadonlySet<string>;
  readonly readOnlyExactSomNames: ReadonlySet<string>;
  readonly candidateCount: number;
  readonly duplicateCount: number;
}

interface OccurrenceScope {
  readonly counts: Map<string, number>;
}

interface SomContainer {
  subformCount: number;
}

interface TextCollector {
  value: string;
  pendingSpace: boolean;
  overflowed: boolean;
  readonly limit: number;
}

interface RawTextCollector {
  value: string;
  overflowed: boolean;
  readonly limit: number;
}

interface StaticChoiceGroupState {
  readonly terminal: TerminalState;
  readonly choices: XfaStaticChoice[];
  directFieldCount: number;
  characterCount: number;
  valid: boolean;
}

interface StaticChoiceFieldState {
  readonly group: StaticChoiceGroupState;
  uiCount: number;
  checkButtonCount: number;
  captionCount: number;
  captionValueCount: number;
  captionTextCount: number;
  itemsCount: number;
  itemScalarCount: number;
  label: string | null;
  value: string | null;
  valid: boolean;
}

type StaticChoiceRole =
  | 'group'
  | 'field'
  | 'ui'
  | 'checkButton'
  | 'checkButtonBorder'
  | 'caption'
  | 'captionValue'
  | 'captionText'
  | 'items'
  | 'itemScalar'
  | 'assist'
  | 'assistText'
  | 'traversal'
  | 'leaf'
  | 'invalid';

type StaticChoiceCaptureState =
  | {
      readonly kind: 'label';
      readonly field: StaticChoiceFieldState;
      readonly collector: TextCollector;
      hasNestedElement: boolean;
    }
  | {
      readonly kind: 'value';
      readonly field: StaticChoiceFieldState;
      readonly collector: RawTextCollector;
      hasNestedElement: boolean;
    };

interface TerminalState {
  readonly somName: string;
  customSpeak: string | null;
  speakPriority: string | null;
  speakDisabled: boolean;
  speakControlSupported: boolean;
  toolTip: string | null;
  caption: string | null;
  speakCaptured: boolean;
  toolTipCaptured: boolean;
  captionCaptured: boolean;
  humanOnly: boolean;
  readOnly: boolean;
  staticChoices: readonly XfaStaticChoice[] | null;
}

interface CaptureState {
  readonly kind: 'speak' | 'toolTip' | 'caption';
  readonly terminal: TerminalState;
  readonly collector: TextCollector;
  readonly priority: string | null;
  readonly disabled: boolean;
  readonly controlSupported: boolean;
  hasNestedElement: boolean;
}

interface ElementFrame {
  pathPushed: boolean;
  previousScope: OccurrenceScope | null;
  previousSomContainer: SomContainer | null;
  terminal: TerminalState | null;
  enteredNamedExclGroup: boolean;
  assistFor: TerminalState | null;
  captionFor: TerminalState | null;
  captionValueFor: TerminalState | null;
  uiFor: TerminalState | null;
  capture: CaptureState | null;
  occurrenceAffectsSom: boolean;
  allowsFormChildren: boolean;
  enteredIgnoredBranch: boolean;
  inVariablesBranch: boolean;
  enteredConditionalParticipation: boolean;
  previousAccessRestricted: boolean | null;
  staticChoiceRole: StaticChoiceRole | null;
  staticChoiceCapture: StaticChoiceCaptureState | null;
  enteredStaticChoiceGroup: StaticChoiceGroupState | null;
  enteredStaticChoiceField: StaticChoiceFieldState | null;
}

class XfaUnavailableError extends Error {
  readonly reason: XfaSemanticsUnavailableReason;

  constructor(reason: XfaSemanticsUnavailableReason) {
    super(reason);
    this.reason = reason;
  }
}

function unavailable(
  reason: XfaSemanticsUnavailableReason,
): XfaSemanticsResult {
  return {
    status: 'unavailable',
    reason,
    byExactSomName: new Map(),
    humanOnlyExactSomNames: new Set(),
    readOnlyExactSomNames: new Set(),
    candidateCount: 0,
    duplicateCount: 0,
  };
}

function exactTemplatePacket(document: PDFDocument): PDFRawStream {
  const acroForm = document.catalog.AcroForm();
  if (!acroForm) throw new XfaUnavailableError('acroform_missing');

  const xfaEntry = document.context.lookup(acroForm.get(PDFName.of('XFA')));
  if (!xfaEntry) throw new XfaUnavailableError('xfa_missing');
  if (!(xfaEntry instanceof PDFArray)) {
    throw new XfaUnavailableError('xfa_not_packet_array');
  }
  if (xfaEntry.size() % 2 !== 0) {
    throw new XfaUnavailableError('xfa_packet_array_malformed');
  }

  let template: PDFRawStream | null = null;
  for (let index = 0; index < xfaEntry.size(); index += 2) {
    const packetName = xfaEntry.lookup(index);
    const packetStream = xfaEntry.lookup(index + 1);
    if (
      !(
        packetName instanceof PDFString || packetName instanceof PDFHexString
      ) ||
      !(packetStream instanceof PDFRawStream)
    ) {
      throw new XfaUnavailableError('xfa_packet_array_malformed');
    }
    if (packetName.decodeText() !== 'template') continue;
    if (template) {
      throw new XfaUnavailableError('template_packet_duplicate');
    }
    template = packetStream;
  }

  if (!template) throw new XfaUnavailableError('template_packet_missing');
  return template;
}

interface HuffmanTable {
  readonly entries: Int32Array;
  readonly maxBits: number;
}

const CODE_LENGTH_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);
const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
]);
const DISTANCE_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577,
]);
const DISTANCE_EXTRA_BITS = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
]);

function reverseBits(value: number, width: number): number {
  let reversed = 0;
  for (let index = 0; index < width; index += 1) {
    reversed = (reversed << 1) | ((value >>> index) & 1);
  }
  return reversed;
}

function huffmanTable(
  lengths: Uint8Array,
  allowSingleBitIncomplete: boolean,
): HuffmanTable {
  let maxBits = 0;
  for (const length of lengths) maxBits = Math.max(maxBits, length);
  if (maxBits === 0 || maxBits > 15) throw new Error('Invalid Huffman tree');

  const counts = new Uint16Array(maxBits + 1);
  for (const length of lengths) {
    if (length > 0) counts[length] += 1;
  }
  let remainingCodes = 1;
  for (let width = 1; width <= maxBits; width += 1) {
    remainingCodes = remainingCodes * 2 - counts[width];
    if (remainingCodes < 0) throw new Error('Oversubscribed Huffman tree');
  }
  if (remainingCodes > 0 && !(allowSingleBitIncomplete && maxBits === 1)) {
    throw new Error('Undersubscribed Huffman tree');
  }

  const nextCode = new Uint16Array(maxBits + 1);
  let code = 0;
  for (let width = 1; width <= maxBits; width += 1) {
    code = (code + counts[width - 1]) << 1;
    nextCode[width] = code;
  }

  const entries = new Int32Array(1 << maxBits);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const width = lengths[symbol];
    if (width === 0) continue;
    const reversed = reverseBits(nextCode[width], width);
    nextCode[width] += 1;
    for (let index = reversed; index < entries.length; index += 1 << width) {
      entries[index] = (width << 16) | (symbol + 1);
    }
  }
  return { entries, maxBits };
}

function fixedLiteralLengthTable(): HuffmanTable {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280);
  return huffmanTable(lengths, true);
}

const FIXED_LITERAL_LENGTH_TABLE = fixedLiteralLengthTable();
const FIXED_DISTANCE_TABLE = huffmanTable(new Uint8Array(32).fill(5), true);

export class BoundedZlibDecodeLimitError extends Error {}

class BoundedFlateDecoder {
  readonly input: Uint8Array;
  readonly maxOutputBytes: number;
  output: Uint8Array;
  inputOffset = 0;
  outputLength = 0;
  bitBuffer = 0;
  bitCount = 0;

  constructor(input: Uint8Array, maxOutputBytes: number) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error('Invalid FlateDecode output limit');
    }
    this.input = input;
    this.maxOutputBytes = maxOutputBytes;
    this.output = new Uint8Array(
      Math.min(maxOutputBytes, Math.max(1_024, input.byteLength * 2)),
    );
    const compressionMethod = this.readInputByte();
    const flags = this.readInputByte();
    if (
      (compressionMethod & 0x0f) !== 8 ||
      compressionMethod >>> 4 > 7 ||
      ((compressionMethod << 8) | flags) % 31 !== 0 ||
      (flags & 0x20) !== 0
    ) {
      throw new Error('Invalid zlib header');
    }
  }

  decode(): Uint8Array {
    let finalBlock = false;
    while (!finalBlock) {
      finalBlock = this.readBits(1) === 1;
      const blockType = this.readBits(2);
      if (blockType === 0) {
        this.decodeStoredBlock();
      } else if (blockType === 1) {
        this.decodeHuffmanBlock(
          FIXED_LITERAL_LENGTH_TABLE,
          FIXED_DISTANCE_TABLE,
        );
      } else if (blockType === 2) {
        const [literalLengthTable, distanceTable] = this.readDynamicTables();
        this.decodeHuffmanBlock(literalLengthTable, distanceTable);
      } else {
        throw new Error('Invalid DEFLATE block type');
      }
    }
    this.verifyAdler32();
    return this.output.subarray(0, this.outputLength);
  }

  private readInputByte(): number {
    const value = this.input[this.inputOffset];
    if (value === undefined) throw new Error('Truncated FlateDecode stream');
    this.inputOffset += 1;
    return value;
  }

  private readBits(width: number): number {
    while (this.bitCount < width) {
      this.bitBuffer |= this.readInputByte() << this.bitCount;
      this.bitCount += 8;
    }
    const mask = (1 << width) - 1;
    const value = this.bitBuffer & mask;
    this.bitBuffer >>>= width;
    this.bitCount -= width;
    return value;
  }

  private readSymbol(table: HuffmanTable): number {
    while (this.bitCount < table.maxBits) {
      this.bitBuffer |= this.readInputByte() << this.bitCount;
      this.bitCount += 8;
    }
    const entry = table.entries[this.bitBuffer & ((1 << table.maxBits) - 1)];
    if (entry === 0) throw new Error('Invalid Huffman code');
    const width = entry >>> 16;
    this.bitBuffer >>>= width;
    this.bitCount -= width;
    return (entry & 0xffff) - 1;
  }

  private alignToByte(): void {
    const discardedBits = this.bitCount % 8;
    this.bitBuffer >>>= discardedBits;
    this.bitCount -= discardedBits;
  }

  private readAlignedByte(): number {
    if (this.bitCount >= 8) {
      const value = this.bitBuffer & 0xff;
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;
      return value;
    }
    return this.readInputByte();
  }

  private decodeStoredBlock(): void {
    this.alignToByte();
    const length = this.readAlignedByte() | (this.readAlignedByte() << 8);
    const complement = this.readAlignedByte() | (this.readAlignedByte() << 8);
    if ((length ^ 0xffff) !== complement) {
      throw new Error('Invalid stored DEFLATE block length');
    }
    this.ensureOutputCapacity(length);
    const end = this.outputLength + length;
    while (this.outputLength < end) {
      this.output[this.outputLength] = this.readAlignedByte();
      this.outputLength += 1;
    }
  }

  private readDynamicTables(): readonly [HuffmanTable, HuffmanTable | null] {
    const literalLengthCount = this.readBits(5) + 257;
    const distanceCount = this.readBits(5) + 1;
    const codeLengthCount = this.readBits(4) + 4;
    if (literalLengthCount > 286) {
      throw new Error('Invalid literal/length code count');
    }

    const codeLengthLengths = new Uint8Array(19);
    for (let index = 0; index < codeLengthCount; index += 1) {
      codeLengthLengths[CODE_LENGTH_ORDER[index]] = this.readBits(3);
    }
    const codeLengthTable = huffmanTable(codeLengthLengths, false);
    const lengths = new Uint8Array(literalLengthCount + distanceCount);
    let index = 0;
    while (index < lengths.length) {
      const symbol = this.readSymbol(codeLengthTable);
      if (symbol <= 15) {
        lengths[index] = symbol;
        index += 1;
        continue;
      }

      let repeatedLength = 0;
      let repeatCount = 0;
      if (symbol === 16) {
        if (index === 0) throw new Error('Invalid repeated code length');
        repeatedLength = lengths[index - 1];
        repeatCount = this.readBits(2) + 3;
      } else if (symbol === 17) {
        repeatCount = this.readBits(3) + 3;
      } else if (symbol === 18) {
        repeatCount = this.readBits(7) + 11;
      } else {
        throw new Error('Invalid code length symbol');
      }
      if (index + repeatCount > lengths.length) {
        throw new Error('Repeated code length exceeds table');
      }
      lengths.fill(repeatedLength, index, index + repeatCount);
      index += repeatCount;
    }

    const literalLengths = lengths.subarray(0, literalLengthCount);
    if (literalLengths[256] === 0) {
      throw new Error('Missing end-of-block Huffman code');
    }
    const distanceLengths = lengths.subarray(literalLengthCount);
    const distanceTable =
      distanceLengths.length === 1 && distanceLengths[0] === 0
        ? null
        : huffmanTable(distanceLengths, true);
    return [huffmanTable(literalLengths, true), distanceTable];
  }

  private decodeHuffmanBlock(
    literalLengthTable: HuffmanTable,
    distanceTable: HuffmanTable | null,
  ): void {
    while (true) {
      const symbol = this.readSymbol(literalLengthTable);
      if (symbol < 256) {
        this.ensureOutputCapacity(1);
        this.output[this.outputLength] = symbol;
        this.outputLength += 1;
        continue;
      }
      if (symbol === 256) return;
      if (symbol < 257 || symbol > 285) {
        throw new Error('Invalid length symbol');
      }
      if (distanceTable === null) {
        throw new Error('Length symbol without a distance tree');
      }

      const lengthIndex = symbol - 257;
      const length =
        LENGTH_BASE[lengthIndex] +
        this.readBits(LENGTH_EXTRA_BITS[lengthIndex]);
      const distanceSymbol = this.readSymbol(distanceTable);
      if (distanceSymbol > 29) throw new Error('Invalid distance symbol');
      const distance =
        DISTANCE_BASE[distanceSymbol] +
        this.readBits(DISTANCE_EXTRA_BITS[distanceSymbol]);
      if (distance > this.outputLength || distance > 32_768) {
        throw new Error('Invalid DEFLATE distance');
      }
      this.ensureOutputCapacity(length);
      const end = this.outputLength + length;
      while (this.outputLength < end) {
        this.output[this.outputLength] =
          this.output[this.outputLength - distance];
        this.outputLength += 1;
      }
    }
  }

  private ensureOutputCapacity(additionalBytes: number): void {
    const required = this.outputLength + additionalBytes;
    if (!Number.isSafeInteger(required) || required > this.maxOutputBytes) {
      throw new BoundedZlibDecodeLimitError(
        'Decoded Flate stream exceeds output limit',
      );
    }
    if (required <= this.output.byteLength) return;

    const nextCapacity = Math.min(
      this.maxOutputBytes,
      Math.max(required, this.output.byteLength * 2),
    );
    const output = new Uint8Array(nextCapacity);
    output.set(this.output.subarray(0, this.outputLength));
    this.output = output;
  }

  private verifyAdler32(): void {
    this.alignToByte();
    const bufferedBytes = this.bitCount / 8;
    const checksumOffset = this.inputOffset - bufferedBytes;
    if (checksumOffset + 4 !== this.input.length) {
      throw new Error('Invalid zlib trailer');
    }
    const expected =
      ((this.input[checksumOffset] << 24) |
        (this.input[checksumOffset + 1] << 16) |
        (this.input[checksumOffset + 2] << 8) |
        this.input[checksumOffset + 3]) >>>
      0;
    let a = 1;
    let b = 0;
    for (const byte of this.output.subarray(0, this.outputLength)) {
      a = (a + byte) % 65_521;
      b = (b + a) % 65_521;
    }
    if (((b << 16) | a) >>> 0 !== expected) {
      throw new Error('Invalid Adler-32 checksum');
    }
  }
}

export function decodeBoundedZlib(
  input: Uint8Array,
  maxOutputBytes: number,
): Uint8Array {
  return new BoundedFlateDecoder(input, maxOutputBytes).decode();
}

function templateBytes(stream: PDFRawStream): Uint8Array {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const decodeParameters = stream.dict.lookup(PDFName.of('DecodeParms'));
  if (decodeParameters) {
    throw new XfaUnavailableError('template_packet_filter_unsupported');
  }

  if (!filter) {
    if (stream.contents.byteLength > MAX_TEMPLATE_BYTES) {
      throw new XfaUnavailableError('template_packet_too_large');
    }
    return stream.contents;
  }

  const singleFilter =
    filter instanceof PDFName
      ? filter
      : filter instanceof PDFArray && filter.size() === 1
        ? filter.lookup(0)
        : null;
  if (
    !(singleFilter instanceof PDFName) ||
    singleFilter !== PDFName.of('FlateDecode')
  ) {
    throw new XfaUnavailableError('template_packet_filter_unsupported');
  }
  if (stream.contents.byteLength > MAX_COMPRESSED_TEMPLATE_BYTES) {
    throw new XfaUnavailableError('template_packet_compressed_too_large');
  }
  try {
    return decodeBoundedZlib(stream.contents, MAX_TEMPLATE_BYTES);
  } catch (error) {
    if (error instanceof BoundedZlibDecodeLimitError) {
      throw new XfaUnavailableError('template_packet_too_large');
    }
    throw error;
  }
}

function decodeTemplate(stream: PDFRawStream): string {
  let bytes: Uint8Array;
  try {
    bytes = templateBytes(stream);
  } catch (error) {
    if (error instanceof XfaUnavailableError) throw error;
    throw new XfaUnavailableError('template_packet_decode_failed');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new XfaUnavailableError('template_invalid_utf8');
  }
}

function attribute(tag: SaxesTagNS, local: string): string | null {
  for (const value of Object.values(tag.attributes)) {
    if (value.local === local && value.uri === '') return value.value;
  }
  return null;
}

function nextOccurrence(scope: OccurrenceScope, name: string): number {
  const occurrence = scope.counts.get(name) ?? 0;
  scope.counts.set(name, occurrence + 1);
  return occurrence;
}

function escapeSomSegmentName(name: string): string {
  return name.replaceAll('.', '\\.');
}

function somName(tag: SaxesTagNS): string | null {
  const name = attribute(tag, 'name');
  if (name !== null && !XML_NAME_WITHOUT_COLON.test(name)) {
    throw new XfaUnavailableError('template_invalid_som_name');
  }
  return name;
}

function occurrenceNeedsExpansion(tag: SaxesTagNS): boolean {
  for (const local of ['initial', 'min', 'max']) {
    const value = attribute(tag, local);
    if (value === null) continue;
    if (!/^\d+$/u.test(value) || Number(value) !== 1) return true;
  }
  return false;
}

function accessRestrictsMutation(tag: SaxesTagNS): boolean {
  const access = attribute(tag, 'access');
  if (access === null || access === 'open') return false;
  if (
    access === 'protected' ||
    access === 'readOnly' ||
    access === 'nonInteractive'
  ) {
    return true;
  }
  throw new XfaUnavailableError('template_structure_unsupported');
}

function effectiveSpeak(terminal: TerminalState): string | null {
  if (terminal.speakDisabled || !terminal.speakControlSupported) return null;
  switch (terminal.speakPriority) {
    case null:
    case 'custom':
      return terminal.customSpeak ?? terminal.toolTip ?? terminal.caption;
    case 'caption':
      return terminal.caption ?? terminal.customSpeak ?? terminal.toolTip;
    case 'name':
      return null;
    case 'toolTip':
      return terminal.toolTip ?? terminal.customSpeak ?? terminal.caption;
    default:
      return null;
  }
}

function effectiveCaption(terminal: TerminalState): string | null {
  return terminal.speakPriority === 'name' ||
    (terminal.speakPriority !== null &&
      terminal.speakPriority !== 'custom' &&
      terminal.speakPriority !== 'caption' &&
      terminal.speakPriority !== 'toolTip')
    ? null
    : terminal.caption;
}

function discoverySpeak(terminal: TerminalState): string | null {
  const value = terminal.customSpeak;
  return terminal.speakDisabled &&
    terminal.speakControlSupported &&
    (terminal.speakPriority === null || terminal.speakPriority === 'custom') &&
    value !== null &&
    value.length <= MAX_DISCOVERY_SPEAK_TEXT &&
    /[\p{L}\p{N}]/u.test(value)
    ? value
    : null;
}

function createCollector(limit: number): TextCollector {
  return { value: '', pendingSpace: false, overflowed: false, limit };
}

function appendText(collector: TextCollector, text: string): void {
  if (collector.overflowed || text.length === 0) return;

  const matches = text.matchAll(/\S+/gu);
  let previousEnd = 0;
  let sawToken = false;
  for (const match of matches) {
    const token = match[0];
    const index = match.index;
    const needsSpace =
      collector.value.length > 0 &&
      (collector.pendingSpace || index > previousEnd);
    if (
      collector.value.length + token.length + (needsSpace ? 1 : 0) >
      collector.limit
    ) {
      collector.overflowed = true;
      return;
    }
    if (needsSpace) collector.value += ' ';
    collector.value += token;
    previousEnd = index + token.length;
    collector.pendingSpace = false;
    sawToken = true;
  }

  if (sawToken) {
    collector.pendingSpace = previousEnd < text.length;
  } else if (collector.value.length > 0) {
    collector.pendingSpace = true;
  }
}

function createRawCollector(limit: number): RawTextCollector {
  return { value: '', overflowed: false, limit };
}

function appendRawText(collector: RawTextCollector, text: string): void {
  if (collector.overflowed || text.length === 0) return;
  if (collector.value.length + text.length > collector.limit) {
    collector.overflowed = true;
    return;
  }
  collector.value += text;
}

function createStaticChoiceField(
  group: StaticChoiceGroupState,
): StaticChoiceFieldState {
  group.directFieldCount += 1;
  if (group.directFieldCount > MAX_STATIC_CHOICES_PER_GROUP) {
    group.valid = false;
  }
  return {
    group,
    uiCount: 0,
    checkButtonCount: 0,
    captionCount: 0,
    captionValueCount: 0,
    captionTextCount: 0,
    itemsCount: 0,
    itemScalarCount: 0,
    label: null,
    value: null,
    valid: true,
  };
}

function invalidateStaticChoiceField(field: StaticChoiceFieldState): void {
  field.valid = false;
  field.group.valid = false;
}

function staticChoiceParticipationIsUnconditional(tag: SaxesTagNS): boolean {
  const presence = attribute(tag, 'presence');
  const relevant = attribute(tag, 'relevant');
  return (
    (presence === null || presence === 'visible') &&
    (relevant === null || relevant.length === 0)
  );
}

function staticChoiceItemsAreStatic(tag: SaxesTagNS): boolean {
  const reference = attribute(tag, 'ref');
  const save = attribute(tag, 'save');
  return (
    staticChoiceParticipationIsUnconditional(tag) &&
    (reference === null || reference.length === 0) &&
    (save === null || save === '1')
  );
}

function staticChoiceLabelKey(label: string): string {
  return label.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function allowedStaticChoiceLabel(label: string): boolean {
  return !/\p{C}/u.test(label) && /[\p{L}\p{N}\p{P}\p{S}]/u.test(label);
}

function finishStaticChoiceField(field: StaticChoiceFieldState): void {
  const { label, value } = field;
  if (
    !field.group.valid ||
    !field.valid ||
    field.uiCount !== 1 ||
    field.checkButtonCount !== 1 ||
    field.captionCount !== 1 ||
    field.captionValueCount !== 1 ||
    field.captionTextCount !== 1 ||
    field.itemsCount !== 1 ||
    field.itemScalarCount !== 1 ||
    label === null ||
    value === null ||
    !allowedStaticChoiceLabel(label) ||
    value.trim().length === 0 ||
    field.group.choices.some(
      (choice) =>
        choice.value === value ||
        staticChoiceLabelKey(choice.label) === staticChoiceLabelKey(label),
    )
  ) {
    field.group.valid = false;
    return;
  }

  const characterCount = label.length + value.length;
  if (
    field.group.characterCount + characterCount >
    MAX_STATIC_CHOICE_GROUP_CHARACTERS
  ) {
    field.group.valid = false;
    return;
  }
  field.group.characterCount += characterCount;
  field.group.choices.push({ value, label });
}

function enterStaticChoiceElement(
  tag: SaxesTagNS,
  isTemplateElement: boolean,
  parent: ElementFrame | undefined,
  group: StaticChoiceGroupState,
  activeField: StaticChoiceFieldState | undefined,
  frame: ElementFrame,
  fieldStack: StaticChoiceFieldState[],
  captureStack: StaticChoiceCaptureState[],
): void {
  const invalidate = (): void => {
    frame.staticChoiceRole = 'invalid';
    if (activeField) invalidateStaticChoiceField(activeField);
    else group.valid = false;
  };

  if (!isTemplateElement) {
    invalidate();
    return;
  }

  const parentRole = parent?.staticChoiceRole;
  if (parentRole === 'group') {
    if (tag.local === 'field') {
      const field = createStaticChoiceField(group);
      if (!staticChoiceParticipationIsUnconditional(tag)) {
        invalidateStaticChoiceField(field);
      }
      frame.staticChoiceRole = 'field';
      frame.enteredStaticChoiceField = field;
      fieldStack.push(field);
    } else if (tag.local === 'traversal') {
      frame.staticChoiceRole = 'traversal';
    } else {
      invalidate();
    }
    return;
  }

  if (!activeField) {
    if (parentRole === 'traversal' && tag.local === 'traverse') {
      frame.staticChoiceRole = 'leaf';
    } else invalidate();
    return;
  }

  if (parentRole === 'field') {
    if (tag.local === 'ui') {
      activeField.uiCount += 1;
      if (activeField.uiCount !== 1) invalidateStaticChoiceField(activeField);
      frame.staticChoiceRole = 'ui';
    } else if (tag.local === 'caption') {
      activeField.captionCount += 1;
      if (
        activeField.captionCount !== 1 ||
        !staticChoiceParticipationIsUnconditional(tag)
      ) {
        invalidateStaticChoiceField(activeField);
      }
      frame.staticChoiceRole = 'caption';
    } else if (tag.local === 'items') {
      activeField.itemsCount += 1;
      if (activeField.itemsCount !== 1 || !staticChoiceItemsAreStatic(tag)) {
        invalidateStaticChoiceField(activeField);
      }
      frame.staticChoiceRole = 'items';
    } else if (tag.local === 'assist') {
      frame.staticChoiceRole = 'assist';
    } else if (
      tag.local === 'font' ||
      tag.local === 'margin' ||
      tag.local === 'para'
    ) {
      frame.staticChoiceRole = 'leaf';
    } else {
      invalidate();
    }
    return;
  }

  if (parentRole === 'ui') {
    if (tag.local !== 'checkButton') {
      invalidate();
      return;
    }
    activeField.checkButtonCount += 1;
    if (activeField.checkButtonCount !== 1) {
      invalidateStaticChoiceField(activeField);
    }
    frame.staticChoiceRole = 'checkButton';
    return;
  }

  if (parentRole === 'checkButton') {
    if (tag.local === 'border') {
      frame.staticChoiceRole = 'checkButtonBorder';
    } else invalidate();
    return;
  }

  if (parentRole === 'checkButtonBorder') {
    if (tag.local === 'edge' || tag.local === 'fill') {
      frame.staticChoiceRole = 'leaf';
    } else invalidate();
    return;
  }

  if (parentRole === 'caption') {
    if (tag.local === 'value') {
      activeField.captionValueCount += 1;
      if (activeField.captionValueCount !== 1) {
        invalidateStaticChoiceField(activeField);
      }
      frame.staticChoiceRole = 'captionValue';
    } else if (tag.local === 'font' || tag.local === 'para') {
      frame.staticChoiceRole = 'leaf';
    } else {
      invalidate();
    }
    return;
  }

  if (parentRole === 'captionValue') {
    if (tag.local !== 'text') {
      invalidate();
      return;
    }
    activeField.captionTextCount += 1;
    if (activeField.captionTextCount !== 1) {
      invalidateStaticChoiceField(activeField);
    }
    const capture: StaticChoiceCaptureState = {
      kind: 'label',
      field: activeField,
      collector: createCollector(MAX_CAPTION_TEXT),
      hasNestedElement: false,
    };
    frame.staticChoiceRole = 'captionText';
    frame.staticChoiceCapture = capture;
    captureStack.push(capture);
    return;
  }

  if (parentRole === 'items') {
    if (tag.local !== 'text' && tag.local !== 'integer') {
      invalidate();
      return;
    }
    activeField.itemScalarCount += 1;
    if (activeField.itemScalarCount !== 1) {
      invalidateStaticChoiceField(activeField);
    }
    const capture: StaticChoiceCaptureState = {
      kind: 'value',
      field: activeField,
      collector: createRawCollector(MAX_STATIC_CHOICE_VALUE_TEXT),
      hasNestedElement: false,
    };
    frame.staticChoiceRole = 'itemScalar';
    frame.staticChoiceCapture = capture;
    captureStack.push(capture);
    return;
  }

  if (parentRole === 'assist') {
    if (tag.local === 'speak' || tag.local === 'toolTip') {
      frame.staticChoiceRole = 'assistText';
    } else invalidate();
    return;
  }

  invalidate();
}

function parseTemplate(xml: string): XfaSemanticsResult {
  if (UNSAFE_XML_DECLARATION.test(xml)) {
    throw new XfaUnavailableError('template_unsafe_xml');
  }

  const byExactSomName = new Map<string, XfaFieldSemantics>();
  const humanOnlyExactSomNames = new Set<string>();
  const readOnlyExactSomNames = new Set<string>();
  const ambiguousSomNames = new Set<string>();
  const frames: ElementFrame[] = [];
  const path: string[] = [];
  const captureStack: CaptureState[] = [];
  const staticChoiceGroups: StaticChoiceGroupState[] = [];
  const staticChoiceFields: StaticChoiceFieldState[] = [];
  const staticChoiceCaptureStack: StaticChoiceCaptureState[] = [];
  let currentScope: OccurrenceScope = { counts: new Map() };
  let currentSomContainer: SomContainer = { subformCount: 0 };
  let templateNamespace: string | null = null;
  let namedExclGroupDepth = 0;
  const namedExclGroupTerminals: TerminalState[] = [];
  let ignoredBranchDepth = 0;
  let variablesDepth = 0;
  let conditionalParticipationDepth = 0;
  let accessRestricted = false;
  let nodeCount = 0;
  let candidateCount = 0;
  let generatedSomCharacterCount = 0;
  let discoverySpeakCharacterCount = 0;
  let staticChoiceCharacterCount = 0;
  let duplicateCount = 0;

  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new XfaUnavailableError('template_unsafe_xml');
  });
  parser.on('error', () => {
    throw new XfaUnavailableError('template_malformed_xml');
  });
  parser.on('opentag', (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES) {
      throw new XfaUnavailableError('template_node_limit_exceeded');
    }
    if (frames.length + 1 > MAX_XML_DEPTH) {
      throw new XfaUnavailableError('template_depth_limit_exceeded');
    }

    if (templateNamespace === null) {
      if (tag.local !== 'template' || !XFA_TEMPLATE_NAMESPACES.has(tag.uri)) {
        throw new XfaUnavailableError('template_namespace_unsupported');
      }
      templateNamespace = tag.uri;
    }

    const parent = frames.at(-1);
    const activeCapture = captureStack.at(-1);
    if (activeCapture) activeCapture.hasNestedElement = true;
    const activeStaticChoiceCapture = staticChoiceCaptureStack.at(-1);
    if (activeStaticChoiceCapture) {
      activeStaticChoiceCapture.hasNestedElement = true;
    }
    const isTemplateElement = tag.uri === templateNamespace;
    if (
      isTemplateElement &&
      (attribute(tag, 'use') !== null || attribute(tag, 'usehref') !== null)
    ) {
      throw new XfaUnavailableError('template_structure_unsupported');
    }
    const insideNamedExclGroup = namedExclGroupDepth > 0;
    const insideIgnoredBranch = ignoredBranchDepth > 0;
    const insideVariablesBranch = variablesDepth > 0;
    const frame: ElementFrame = {
      pathPushed: false,
      previousScope: null,
      previousSomContainer: null,
      terminal: null,
      enteredNamedExclGroup: false,
      assistFor: null,
      captionFor: null,
      captionValueFor: null,
      uiFor: null,
      capture: null,
      occurrenceAffectsSom: false,
      allowsFormChildren: false,
      enteredIgnoredBranch: false,
      inVariablesBranch: false,
      enteredConditionalParticipation: false,
      previousAccessRestricted: null,
      staticChoiceRole: null,
      staticChoiceCapture: null,
      enteredStaticChoiceGroup: null,
      enteredStaticChoiceField: null,
    };

    const parentAllowsFormChildren = parent?.allowsFormChildren === true;
    const isRootTemplate =
      frames.length === 0 && isTemplateElement && tag.local === 'template';
    const isFormNode =
      tag.local === 'subform' ||
      tag.local === 'field' ||
      tag.local === 'exclGroup';
    const isFormSibling =
      isFormNode ||
      tag.local === 'area' ||
      tag.local === 'variables' ||
      tag.local === 'proto' ||
      tag.local === 'pageSet' ||
      tag.local === 'pageArea' ||
      tag.local === 'draw' ||
      tag.local === 'exObject' ||
      tag.local === 'event' ||
      tag.local === 'subformSet';
    const isSupportedProperty =
      (tag.local === 'assist' && parent?.terminal != null) ||
      (tag.local === 'caption' && parent?.terminal != null) ||
      (tag.local === 'ui' && parent?.terminal != null) ||
      ((tag.local === 'speak' || tag.local === 'toolTip') &&
        parent?.assistFor != null) ||
      (tag.local === 'signature' && parent?.uiFor != null) ||
      (tag.local === 'value' && parent?.captionFor != null) ||
      (tag.local === 'text' && parent?.captionValueFor != null) ||
      (tag.local === 'occur' && parent?.occurrenceAffectsSom === true);
    const isSupportedStructure =
      isRootTemplate ||
      (isTemplateElement &&
        ((parentAllowsFormChildren && isFormSibling) || isSupportedProperty));

    if (
      isTemplateElement &&
      parentAllowsFormChildren &&
      !insideIgnoredBranch &&
      !insideVariablesBranch &&
      !isFormSibling &&
      !isSupportedProperty &&
      attribute(tag, 'name') !== null
    ) {
      throw new XfaUnavailableError('template_structure_unsupported');
    }

    if (
      !insideIgnoredBranch &&
      !insideVariablesBranch &&
      !isSupportedStructure
    ) {
      ignoredBranchDepth += 1;
      frame.enteredIgnoredBranch = true;
    }
    if (isRootTemplate) frame.allowsFormChildren = true;

    if (
      isTemplateElement &&
      !insideIgnoredBranch &&
      !insideVariablesBranch &&
      !frame.enteredIgnoredBranch &&
      tag.local === 'subformSet'
    ) {
      throw new XfaUnavailableError('template_structure_unsupported');
    }

    if (insideVariablesBranch) {
      if (isTemplateElement && variablesDepth === 1) {
        const variableName = somName(tag);
        if (variableName !== null) {
          nextOccurrence(currentScope, variableName);
        }
      }
      variablesDepth += 1;
      frame.inVariablesBranch = true;
    } else if (
      isTemplateElement &&
      !insideIgnoredBranch &&
      !frame.enteredIgnoredBranch &&
      tag.local === 'variables'
    ) {
      variablesDepth = 1;
      frame.inVariablesBranch = true;
    } else if (
      isTemplateElement &&
      !insideIgnoredBranch &&
      !frame.enteredIgnoredBranch &&
      (tag.local === 'proto' ||
        tag.local === 'pageSet' ||
        tag.local === 'pageArea' ||
        tag.local === 'draw' ||
        tag.local === 'exObject' ||
        tag.local === 'event')
    ) {
      if (
        tag.local !== 'proto' &&
        !insideNamedExclGroup &&
        parentAllowsFormChildren
      ) {
        const ignoredName = somName(tag);
        if (ignoredName !== null) nextOccurrence(currentScope, ignoredName);
      }
      ignoredBranchDepth += 1;
      frame.enteredIgnoredBranch = true;
    }

    const isSemanticElement =
      isTemplateElement &&
      !insideIgnoredBranch &&
      !insideVariablesBranch &&
      !frame.enteredIgnoredBranch &&
      tag.local !== 'template';
    if (isSemanticElement && !staticChoiceParticipationIsUnconditional(tag)) {
      conditionalParticipationDepth += 1;
      frame.enteredConditionalParticipation = true;
    }
    const isAccessControlledFormNode =
      isSemanticElement &&
      (tag.local === 'subform' ||
        tag.local === 'field' ||
        tag.local === 'exclGroup');
    const accessRestrictedHere =
      isAccessControlledFormNode && accessRestrictsMutation(tag);
    if (accessRestrictedHere && insideNamedExclGroup) {
      const group = namedExclGroupTerminals.at(-1);
      if (!group) {
        throw new XfaUnavailableError('template_structure_unsupported');
      }
      group.readOnly = true;
    }
    if (accessRestrictedHere && !accessRestricted) {
      frame.previousAccessRestricted = accessRestricted;
      accessRestricted = true;
    }
    const canHaveSomName =
      isSemanticElement &&
      (tag.local === 'subform' ||
        tag.local === 'field' ||
        tag.local === 'exclGroup');
    const name = canHaveSomName ? somName(tag) : null;
    const named = name !== null;

    if (
      isSemanticElement &&
      tag.local === 'occur' &&
      parent?.occurrenceAffectsSom &&
      occurrenceNeedsExpansion(tag)
    ) {
      throw new XfaUnavailableError('template_occurrence_unsupported');
    }

    if (isSemanticElement && tag.local === 'subform' && !insideNamedExclGroup) {
      frame.allowsFormChildren = true;
      const classOccurrence = currentSomContainer.subformCount;
      currentSomContainer.subformCount += 1;
      frame.previousSomContainer = currentSomContainer;
      currentSomContainer = { subformCount: 0 };
      if (named) {
        const occurrence = nextOccurrence(currentScope, name);
        path.push(`${escapeSomSegmentName(name)}[${occurrence}]`);
        frame.previousScope = currentScope;
        currentScope = { counts: new Map() };
      } else {
        path.push(`#subform[${classOccurrence}]`);
      }
      frame.pathPushed = true;
      frame.occurrenceAffectsSom = true;
    }

    if (isSemanticElement && tag.local === 'area' && !insideNamedExclGroup) {
      frame.allowsFormChildren = true;
    }

    if (
      isSemanticElement &&
      tag.local === 'exclGroup' &&
      !insideNamedExclGroup
    ) {
      frame.allowsFormChildren = true;
      frame.occurrenceAffectsSom = true;
    }

    if (
      isSemanticElement &&
      insideNamedExclGroup &&
      (tag.local === 'subform' ||
        tag.local === 'area' ||
        tag.local === 'exclGroup')
    ) {
      frame.allowsFormChildren = true;
    }

    if (
      isSemanticElement &&
      named &&
      !insideNamedExclGroup &&
      (tag.local === 'field' || tag.local === 'exclGroup')
    ) {
      if (candidateCount >= MAX_SOM_CANDIDATES) {
        throw new XfaUnavailableError('template_semantic_budget_exceeded');
      }
      const occurrence = nextOccurrence(currentScope, name);
      const terminalSegment = `${escapeSomSegmentName(name)}[${occurrence}]`;
      const somNameLength = path.reduce(
        (length, segment) => length + segment.length + 1,
        terminalSegment.length,
      );
      if (
        generatedSomCharacterCount + somNameLength >
        MAX_GENERATED_SOM_CHARACTERS
      ) {
        throw new XfaUnavailableError('template_semantic_budget_exceeded');
      }
      generatedSomCharacterCount += somNameLength;
      candidateCount += 1;
      frame.terminal = {
        somName: [...path, terminalSegment].join('.'),
        customSpeak: null,
        speakPriority: null,
        speakDisabled: false,
        speakControlSupported: true,
        toolTip: null,
        caption: null,
        speakCaptured: false,
        toolTipCaptured: false,
        captionCaptured: false,
        humanOnly: false,
        readOnly: accessRestricted,
        staticChoices: null,
      };
      frame.occurrenceAffectsSom = true;
    }

    if (isSemanticElement && tag.local === 'exclGroup' && named) {
      if (!frame.terminal) {
        throw new XfaUnavailableError('template_structure_unsupported');
      }
      frame.enteredNamedExclGroup = true;
      namedExclGroupDepth += 1;
      namedExclGroupTerminals.push(frame.terminal);
      const staticChoiceGroup: StaticChoiceGroupState = {
        terminal: frame.terminal,
        choices: [],
        directFieldCount: 0,
        characterCount: 0,
        valid: conditionalParticipationDepth === 0,
      };
      frame.staticChoiceRole = 'group';
      frame.enteredStaticChoiceGroup = staticChoiceGroup;
      staticChoiceGroups.push(staticChoiceGroup);
    }

    const activeStaticChoiceGroup = staticChoiceGroups.at(-1);
    if (activeStaticChoiceGroup && frame.enteredStaticChoiceGroup === null) {
      enterStaticChoiceElement(
        tag,
        isTemplateElement,
        parent,
        activeStaticChoiceGroup,
        staticChoiceFields.at(-1),
        frame,
        staticChoiceFields,
        staticChoiceCaptureStack,
      );
    }

    if (isSemanticElement && tag.local === 'ui' && parent?.terminal) {
      frame.uiFor = parent.terminal;
    } else if (
      isSemanticElement &&
      tag.local === 'signature' &&
      parent?.uiFor
    ) {
      parent.uiFor.humanOnly = true;
    } else if (
      isSemanticElement &&
      tag.local === 'assist' &&
      parent?.terminal
    ) {
      frame.assistFor = parent.terminal;
    } else if (
      isSemanticElement &&
      tag.local === 'caption' &&
      parent?.terminal
    ) {
      frame.captionFor = parent.terminal;
    } else if (
      isSemanticElement &&
      (tag.local === 'speak' || tag.local === 'toolTip') &&
      parent?.assistFor
    ) {
      const disable = tag.local === 'speak' ? attribute(tag, 'disable') : null;
      const priority =
        tag.local === 'speak' ? attribute(tag, 'priority') : null;
      frame.capture = {
        kind: tag.local,
        terminal: parent.assistFor,
        collector: createCollector(MAX_SPEAK_TEXT),
        priority,
        disabled: disable === '1',
        controlSupported:
          tag.local !== 'speak' ||
          ((disable === null || disable === '0' || disable === '1') &&
            (priority === null ||
              priority === 'custom' ||
              priority === 'caption' ||
              priority === 'name' ||
              priority === 'toolTip')),
        hasNestedElement: false,
      };
      captureStack.push(frame.capture);
    } else if (
      isSemanticElement &&
      tag.local === 'value' &&
      parent?.captionFor
    ) {
      frame.captionValueFor = parent.captionFor;
    } else if (
      isSemanticElement &&
      tag.local === 'text' &&
      parent?.captionValueFor
    ) {
      frame.capture = {
        kind: 'caption',
        terminal: parent.captionValueFor,
        collector: createCollector(MAX_CAPTION_TEXT),
        priority: null,
        disabled: false,
        controlSupported: true,
        hasNestedElement: false,
      };
      captureStack.push(frame.capture);
    }

    frames.push(frame);
  });
  const collectText = (text: string): void => {
    const capture = captureStack.at(-1);
    if (capture && frames.at(-1)?.capture === capture) {
      appendText(capture.collector, text);
    }
    const frame = frames.at(-1);
    const staticChoiceCapture = staticChoiceCaptureStack.at(-1);
    const capturesStaticChoice =
      staticChoiceCapture && frame?.staticChoiceCapture === staticChoiceCapture;
    if (capturesStaticChoice) {
      if (staticChoiceCapture.kind === 'label') {
        appendText(staticChoiceCapture.collector, text);
      } else {
        appendRawText(staticChoiceCapture.collector, text);
      }
    } else if (
      staticChoiceGroups.length > 0 &&
      frame?.staticChoiceRole !== 'assistText' &&
      text.trim().length > 0
    ) {
      const field = staticChoiceFields.at(-1);
      if (field) invalidateStaticChoiceField(field);
      else staticChoiceGroups.at(-1)!.valid = false;
    }
  };
  parser.on('text', collectText);
  parser.on('cdata', collectText);
  parser.on('closetag', () => {
    const frame = frames.pop();
    if (!frame) {
      throw new XfaUnavailableError('template_malformed_xml');
    }

    if (frame.capture) {
      const capture = captureStack.pop();
      if (capture !== frame.capture) {
        throw new XfaUnavailableError('template_malformed_xml');
      }
      const text =
        capture.collector.overflowed || capture.hasNestedElement
          ? null
          : capture.collector.value || null;
      if (capture.kind === 'speak') {
        if (!capture.terminal.speakCaptured) {
          capture.terminal.speakCaptured = true;
          capture.terminal.customSpeak = text;
          capture.terminal.speakPriority = capture.priority;
          capture.terminal.speakDisabled = capture.disabled;
          capture.terminal.speakControlSupported = capture.controlSupported;
        }
      } else if (capture.kind === 'toolTip') {
        if (!capture.terminal.toolTipCaptured) {
          capture.terminal.toolTipCaptured = true;
          capture.terminal.toolTip = text;
        }
      } else if (!capture.terminal.captionCaptured) {
        capture.terminal.captionCaptured = true;
        capture.terminal.caption = text;
      }
    }

    if (frame.staticChoiceCapture) {
      const capture = staticChoiceCaptureStack.pop();
      if (capture !== frame.staticChoiceCapture) {
        throw new XfaUnavailableError('template_malformed_xml');
      }
      if (capture.collector.overflowed || capture.hasNestedElement) {
        invalidateStaticChoiceField(capture.field);
      } else if (capture.kind === 'label') {
        capture.field.label = capture.collector.value || null;
      } else {
        capture.field.value = capture.collector.value;
      }
    }

    if (frame.enteredStaticChoiceField) {
      if (staticChoiceFields.pop() !== frame.enteredStaticChoiceField) {
        throw new XfaUnavailableError('template_malformed_xml');
      }
      finishStaticChoiceField(frame.enteredStaticChoiceField);
    }

    if (frame.enteredStaticChoiceGroup) {
      const group = staticChoiceGroups.pop();
      if (group !== frame.enteredStaticChoiceGroup) {
        throw new XfaUnavailableError('template_malformed_xml');
      }
      if (
        group.valid &&
        group.directFieldCount > 0 &&
        group.choices.length === group.directFieldCount &&
        staticChoiceCharacterCount + group.characterCount <=
          MAX_STATIC_CHOICE_CHARACTERS
      ) {
        group.terminal.staticChoices = group.choices.map((choice) => ({
          ...choice,
        }));
        staticChoiceCharacterCount += group.characterCount;
      }
    }

    if (frame.terminal) {
      const discoveryOnlySpeak = discoverySpeak(frame.terminal);
      if (discoveryOnlySpeak !== null) {
        discoverySpeakCharacterCount += discoveryOnlySpeak.length;
        if (discoverySpeakCharacterCount > MAX_DISCOVERY_SPEAK_CHARACTERS) {
          throw new XfaUnavailableError('template_semantic_budget_exceeded');
        }
      }
      const semantics: XfaFieldSemantics = {
        speak: effectiveSpeak(frame.terminal),
        caption: effectiveCaption(frame.terminal),
        ...(discoveryOnlySpeak === null
          ? {}
          : { discoverySpeak: discoveryOnlySpeak }),
        ...(frame.terminal.staticChoices === null
          ? {}
          : { staticChoices: frame.terminal.staticChoices }),
      };
      if (frame.terminal.humanOnly) {
        humanOnlyExactSomNames.add(frame.terminal.somName);
      }
      if (frame.terminal.readOnly) {
        readOnlyExactSomNames.add(frame.terminal.somName);
      }
      if (ambiguousSomNames.has(frame.terminal.somName)) {
        duplicateCount += 1;
      } else if (byExactSomName.has(frame.terminal.somName)) {
        byExactSomName.delete(frame.terminal.somName);
        ambiguousSomNames.add(frame.terminal.somName);
        duplicateCount += 1;
      } else {
        byExactSomName.set(frame.terminal.somName, semantics);
      }
    }

    if (frame.enteredNamedExclGroup) {
      if (namedExclGroupTerminals.pop() !== frame.terminal) {
        throw new XfaUnavailableError('template_malformed_xml');
      }
      namedExclGroupDepth -= 1;
    }
    if (frame.inVariablesBranch) variablesDepth -= 1;
    if (frame.enteredIgnoredBranch) ignoredBranchDepth -= 1;
    if (frame.enteredConditionalParticipation) {
      conditionalParticipationDepth -= 1;
    }
    if (frame.pathPushed) path.pop();
    if (frame.previousScope) currentScope = frame.previousScope;
    if (frame.previousSomContainer) {
      currentSomContainer = frame.previousSomContainer;
    }
    if (frame.previousAccessRestricted !== null) {
      accessRestricted = frame.previousAccessRestricted;
    }
  });

  parser.write(xml).close();
  return {
    status: 'available',
    reason: null,
    byExactSomName,
    humanOnlyExactSomNames,
    readOnlyExactSomNames,
    candidateCount,
    duplicateCount,
  };
}

export function extractXfaSemantics(document: PDFDocument): XfaSemanticsResult {
  try {
    const template = exactTemplatePacket(document);
    return parseTemplate(decodeTemplate(template));
  } catch (error) {
    return unavailable(
      error instanceof XfaUnavailableError
        ? error.reason
        : 'template_processing_failed',
    );
  }
}
