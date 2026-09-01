/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- the named validation scroll region must be keyboard focusable */
'use client';

import {
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileCheck2,
  FileJson,
  FileText,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  approveDraftFromUi,
  correctDraftFieldFromUi,
  createFormFieldDefinitionFromPdf,
  createFormState,
  discardDraftFields,
  exportApprovedDerivativePdfFromUi,
  exportApprovedPdfFromUi,
  exportFillPackageFromUi,
  getArtifactReviewFieldNames,
  getChoiceLabelReviewNotice,
  getReleaseGate,
  importFillPackageFromUi,
  MAX_FILL_PACKAGE_BYTES,
  stageFieldUpdates,
  validateDraft,
  type FieldUpdate,
  type FormFieldDefinition,
  type FormFieldValue,
  type FormState,
  type FillPackageResult,
  type StateError,
} from '@/lib/form-state';
import type {
  ApplyResult,
  PdfContentRiskReason,
  PdfContentRiskReasonCode,
  PdfExportStrategy,
  PdfInspection,
} from '@/lib/pdf-engine';
import {
  createFieldEvidenceToolData,
  createFormContextToolData,
  parseFieldChoiceCursor,
  parseFormContextCursor,
  registerFormProofWebMcpTools,
  type FormProofAdapterFailure,
  type FormProofWebMcpAdapter,
  type FormProofWebMcpRegistration,
  type VersionBoundInput,
} from '@/lib/webmcp';
import { formatCount } from '@/lib/utils';

const DEMO_URL = '/demo-form.pdf';
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const CONTENT_RISK_REASON_COPY = {
  javascript_present: {
    singular: 'JavaScript action',
    plural: 'JavaScript actions',
  },
  external_link_present: {
    singular: 'external link',
    plural: 'external links',
  },
  dangerous_or_unknown_action_present: {
    singular: 'dangerous or unrecognized action',
    plural: 'dangerous or unrecognized actions',
  },
  embedded_file_present: {
    singular: 'embedded file',
    plural: 'embedded files',
  },
  associated_file_present: {
    singular: 'associated file',
    plural: 'associated files',
  },
  file_attachment_present: {
    singular: 'file attachment annotation',
    plural: 'file attachment annotations',
  },
  rich_media_present: {
    singular: 'rich-media item',
    plural: 'rich-media items',
  },
  multimedia_present: {
    singular: 'multimedia item',
    plural: 'multimedia items',
  },
  unclassified_payload_entry: {
    singular: 'unclassified payload entry',
    plural: 'unclassified payload entries',
  },
} as const satisfies Record<
  PdfContentRiskReasonCode,
  { readonly singular: string; readonly plural: string }
>;

const GENERIC_CONTENT_RISK_COPY = 'unvalidated active or embedded content';

type ToolState =
  | { status: 'registering'; count: 0; message: string }
  | { status: 'ready'; count: number; message: string }
  | { status: 'unsupported'; count: 0; message: string }
  | { status: 'error'; count: 0; message: string };

interface LoadedDocument {
  fileName: string;
  kind: 'demo' | 'upload';
  sourceUrl: string | null;
  inspection: PdfInspection;
}

interface ReviewBinding {
  documentSessionId: string;
  sourceHash: string;
  planHash: string;
  stateVersion: number;
}

interface VisibleCommitWaiter {
  readonly targetRevision: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly timeoutId: number;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

type PdfInspectionWorkerResponse =
  | { ok: true; inspection: PdfInspection }
  | { ok: false; code: string; message: string };

type OpenReviewResult = 'opened' | 'already_open' | 'dismissed' | 'blocked';

function reviewBindingsMatch(
  left: ReviewBinding | null,
  right: ReviewBinding,
): boolean {
  return (
    left !== null &&
    left.documentSessionId === right.documentSessionId &&
    left.sourceHash === right.sourceHash &&
    left.planHash === right.planHash &&
    left.stateVersion === right.stateVersion
  );
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function claimedBasisLabel(kind: string): string {
  return `Agent claims: ${kind.replaceAll('_', ' ')}`;
}

function formatValue(
  value: FormFieldValue,
  choices: readonly { value: string; label: string }[] = [],
): string {
  const labels = new Map(choices.map((choice) => [choice.value, choice.label]));
  if (value === null || value === '') return 'Blank';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return labels.get(value) ?? value;
  return value.length > 0
    ? value.map((item) => labels.get(item) ?? item).join(', ')
    : 'Blank';
}

function formatFieldLocation(
  field: PdfInspection['fields'][number] | undefined,
): string {
  const page = field?.page == null ? 'page unavailable' : `page ${field.page}`;
  if (field?.rect == null) return `${page}; rectangle unavailable`;
  const { x, y, width, height } = field.rect;
  return `${page}; rectangle x ${x.toFixed(1)}, y ${y.toFixed(1)}, width ${width.toFixed(1)}, height ${height.toFixed(1)} PDF points`;
}

function isBlankValue(value: FormFieldValue): boolean {
  return (
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function adapterFailure(
  state: FormState | null,
  code: string,
  message: string,
  details?: unknown,
): FormProofAdapterFailure {
  return {
    ok: false,
    stateVersion: state?.stateVersion ?? null,
    sourceHash: state?.source.sourceHash ?? null,
    documentSessionId: state?.documentSessionId ?? null,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function bindingFailure(
  state: FormState,
  input: VersionBoundInput,
): FormProofAdapterFailure | null {
  if (input.expectedDocumentSessionId !== state.documentSessionId) {
    return adapterFailure(
      state,
      'document_session_mismatch',
      'This request belongs to a different PDF load session. Refresh form context before continuing.',
    );
  }
  if (input.expectedSourceHash !== state.source.sourceHash) {
    return adapterFailure(
      state,
      'source_mismatch',
      'The active PDF is not the document referenced by this request.',
    );
  }
  if (input.expectedStateVersion !== state.stateVersion) {
    return adapterFailure(
      state,
      'stale_state',
      'The fill plan changed. Refresh form context before continuing.',
    );
  }
  return null;
}

function stateErrorFailure(
  state: FormState,
  errors: readonly StateError[],
): FormProofAdapterFailure {
  const first = errors[0];
  return adapterFailure(
    state,
    first?.code ?? 'internal_error',
    first?.message ?? 'The operation could not be completed.',
    errors.map(({ code, fieldName }) => ({
      code,
      ...(fieldName === undefined ? {} : { fieldName }),
    })),
  );
}

function pdfOutputFileName(
  sourceName: string,
  strategy: ApplyResult['exportStrategy'],
): string {
  const stem = sourceName.replace(/\.pdf$/iu, '') || 'form';
  return strategy === 'filled_pdf'
    ? `${stem}-formproof-filled.pdf`
    : `${stem}-formproof-plain-derivative.pdf`;
}

function fillPackageFileName(sourceName: string): string {
  const stem = sourceName.replace(/\.pdf$/iu, '') || 'form';
  return `${stem}-formproof-fill-package.json`;
}

function describeContentRiskReason(reason: PdfContentRiskReason): string {
  const copy = CONTENT_RISK_REASON_COPY[reason.code];
  return formatCount(reason.count, copy.singular, copy.plural);
}

function describeContentRiskReasons(
  reasons: readonly PdfContentRiskReason[],
): string {
  const descriptions = reasons.map(describeContentRiskReason);
  return descriptions.length > 0
    ? descriptions.join(', ')
    : GENERIC_CONTENT_RISK_COPY;
}

function protectionOutcome(inspection: PdfInspection): {
  title: string;
  detail: string;
} {
  const { protection } = inspection;
  if (protection.exportStrategies.includes('filled_pdf')) {
    return {
      title: 'Filled PDF permitted by document policy',
      detail:
        'This is a standard AcroForm. An approved plan can be written to a fresh PDF and reopened to verify field values and confirm that normal appearance streams are present. Visual rendering is not independently checked.',
    };
  }
  if (protection.exportStrategies.includes('confirmed_plain_derivative_pdf')) {
    return {
      title: 'Plain derivative permitted after confirmation',
      detail:
        'The source has Reader Extensions usage rights. A person may choose a plain derivative that removes those rights; the original remains unchanged.',
    };
  }
  if (protection.exportStrategies.includes('fill_package')) {
    return {
      title: 'Original-untouched fill package',
      detail: protection.evidence.xfaPresent
        ? protection.protectionType === 'none'
          ? 'The source contains XFA. FormProof will not rewrite it; the UI can export reviewed field data, coordinates, provenance, and limitations as JSON.'
          : 'The source contains XFA and the protection shown below. FormProof will not rewrite it; the UI can export reviewed field data, coordinates, provenance, and limitations as JSON.'
        : 'The source PDF will not be rewritten. The UI can export reviewed field data, coordinates, provenance, and limitations as JSON.',
    };
  }
  return {
    title: 'Inspection only',
    detail:
      'No artifact export is available because the protection is unknown or no addressable fallback fields were found.',
  };
}

function initialExportStrategy(
  inspection: PdfInspection,
): PdfExportStrategy | null {
  const strategies = inspection.protection.exportStrategies;
  if (strategies.includes('filled_pdf')) return 'filled_pdf';
  if (strategies.includes('fill_package')) return 'fill_package';
  return null;
}

function describeActiveContent(
  activeContent: PdfInspection['activeContent'],
): string {
  const markers = [
    [
      activeContent.javascriptActionCount,
      'JavaScript action',
      'JavaScript actions',
    ],
    [
      activeContent.additionalActionDictionaryCount,
      'additional-action dictionary',
      'additional-action dictionaries',
    ],
    [activeContent.openActionCount, 'OpenAction', 'OpenActions'],
    [activeContent.externalActionCount, 'external action', 'external actions'],
    [
      activeContent.highRiskActionCount,
      'blocked high-risk action',
      'blocked high-risk actions',
    ],
    [
      activeContent.otherActionCount,
      'other native action',
      'other native actions',
    ],
  ] as const;
  return markers
    .filter(([count]) => count > 0)
    .map(([count, singular, plural]) => formatCount(count, singular, plural))
    .join(', ');
}

function exportStrategyCopy(strategy: PdfExportStrategy): {
  title: string;
  detail: string;
} {
  switch (strategy) {
    case 'filled_pdf':
      return {
        title: 'Filled PDF',
        detail:
          'Write the reviewed values to a new PDF, then reopen it to verify field values and confirm that normal appearance streams are present. Visual rendering is not independently checked. The original stays unchanged.',
      };
    case 'confirmed_plain_derivative_pdf':
      return {
        title: 'Confirmed plain derivative',
        detail:
          'Remove the recognized Reader Extensions usage-rights entry and create a new ordinary PDF. This does not preserve that rights signature.',
      };
    case 'fill_package':
      return {
        title: 'Original-untouched fill package',
        detail:
          'Export reviewed values, field names, coordinates, provenance, and limitations as JSON. No PDF bytes are rewritten.',
      };
  }
}

interface HumanCorrectionEditorProps {
  field: Readonly<FormFieldDefinition>;
  choices: readonly { value: string; label: string }[];
  multiline: boolean;
  initialValue: FormFieldValue;
  disabled: boolean;
  onCancel: () => void;
  onSave: (value: FormFieldValue) => void;
}

function HumanCorrectionEditor({
  field,
  choices,
  multiline,
  initialValue,
  disabled,
  onCancel,
  onSave,
}: HumanCorrectionEditorProps) {
  const [value, setValue] = useState<FormFieldValue>(() =>
    Array.isArray(initialValue) ? [...initialValue] : initialValue,
  );
  const labels = new Map(choices.map((choice) => [choice.value, choice.label]));
  const inputId = 'human-correction-value';
  const allowsMultiple =
    (field.type === 'dropdown' || field.type === 'option-list') &&
    (field.multiSelect ?? field.type === 'option-list');

  return (
    <div className="grid gap-2 rounded-lg border border-emerald-200 bg-white p-3">
      <label className="text-xs font-medium" htmlFor={inputId}>
        Corrected value
      </label>
      {field.type === 'text' && multiline ? (
        <Textarea
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength}
          rows={4}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
        />
      ) : field.type === 'text' ? (
        <Input
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
        />
      ) : field.type === 'checkbox' ? (
        <NativeSelect
          id={inputId}
          className="w-full"
          value={value === true ? 'true' : 'false'}
          onChange={(event) => setValue(event.target.value === 'true')}
          disabled={disabled}
        >
          <NativeSelectOption value="true">Yes</NativeSelectOption>
          <NativeSelectOption value="false">No</NativeSelectOption>
        </NativeSelect>
      ) : allowsMultiple ? (
        <>
          <select
            id={inputId}
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-24 w-full rounded-lg border bg-transparent p-2 text-sm outline-none focus-visible:ring-3"
            multiple
            value={Array.isArray(value) ? [...value] : []}
            onChange={(event) =>
              setValue(
                Array.from(event.target.selectedOptions, ({ value }) => value),
              )
            }
            disabled={disabled}
          >
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {labels.get(option) ?? option}
              </option>
            ))}
          </select>
          <Button
            type="button"
            className="justify-self-start"
            variant="ghost"
            size="xs"
            onClick={() => setValue([])}
            disabled={disabled}
          >
            Clear selection
          </Button>
        </>
      ) : (
        <NativeSelect
          id={inputId}
          className="w-full"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) =>
            setValue(event.target.value === '' ? null : event.target.value)
          }
          disabled={disabled}
        >
          <NativeSelectOption value="">Blank</NativeSelectOption>
          {(field.options ?? []).map((option) => (
            <NativeSelectOption key={option} value={option}>
              {labels.get(option) ?? option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <p className="text-muted-foreground text-[10px] leading-relaxed">
        Saving makes this a session-scoped human correction. Agent tools cannot
        replace it unless you later remove the correction in this UI.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="xs"
          onClick={() => onSave(value)}
          disabled={disabled}
        >
          Save human correction
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onCancel}
          disabled={disabled}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function FormProofWorkbench() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fillPackageInputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<FormState | null>(null);
  const inspectionRef = useRef<PdfInspection | null>(null);
  const sourceBytesRef = useRef<Uint8Array | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const outputUrlRef = useRef<string | null>(null);
  const fillPackageUrlRef = useRef<string | null>(null);
  const reviewLockRef = useRef(false);
  const reviewBindingRef = useRef<ReviewBinding | null>(null);
  const dismissedReviewBindingRef = useRef<ReviewBinding | null>(null);
  const reviewMutationRef = useRef(false);
  const pendingPlanMutationsRef = useRef(0);
  const loadingRef = useRef(true);
  const exportingRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const pdfInspectionWorkerRef = useRef<Worker | null>(null);
  const pdfInspectionAbortRef = useRef<AbortController | null>(null);
  const agentDataConsentSessionRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const uiRevisionRef = useRef(0);
  const visibleUiRevisionRef = useRef(0);
  const visibleCommitWaitersRef = useRef(new Set<VisibleCommitWaiter>());

  const [formState, setFormState] = useState<FormState | null>(null);
  const [documentState, setDocumentState] = useState<LoadedDocument | null>(
    null,
  );
  const [outputResult, setOutputResult] = useState<ApplyResult | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [fillPackageResult, setFillPackageResult] =
    useState<FillPackageResult | null>(null);
  const [fillPackageUrl, setFillPackageUrl] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmedFields, setConfirmedFields] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeContentAcknowledged, setActiveContentAcknowledged] =
    useState(false);
  const [protectionLossAcknowledged, setProtectionLossAcknowledged] =
    useState(false);
  const [selectedExportStrategy, setSelectedExportStrategy] =
    useState<PdfExportStrategy | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [reviewMutating, setReviewMutating] = useState(false);
  const [discardAllArmed, setDiscardAllArmed] = useState(false);
  const [correctionFieldName, setCorrectionFieldName] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolState, setToolState] = useState<ToolState>({
    status: 'registering',
    count: 0,
    message: 'Registering WebMCP tools',
  });
  const [agentDataAccessGranted, setAgentDataAccessGranted] = useState(false);

  useLayoutEffect(() => {
    visibleUiRevisionRef.current = uiRevisionRef.current;
    for (const waiter of visibleCommitWaitersRef.current) {
      if (waiter.targetRevision > visibleUiRevisionRef.current) continue;
      visibleCommitWaitersRef.current.delete(waiter);
      window.clearTimeout(waiter.timeoutId);
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve();
    }
  });

  const waitForVisibleCommit = useCallback(
    (signal: AbortSignal): Promise<void> => {
      const targetRevision = uiRevisionRef.current;
      if (visibleUiRevisionRef.current >= targetRevision) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const finish = (reason: unknown) => {
          const waiter = Array.from(visibleCommitWaitersRef.current).find(
            (candidate) => candidate.resolve === resolve,
          );
          if (!waiter) return;
          visibleCommitWaitersRef.current.delete(waiter);
          window.clearTimeout(waiter.timeoutId);
          signal.removeEventListener('abort', waiter.abort);
          reject(reason);
        };
        const abort = () => finish(new DOMException('Aborted', 'AbortError'));
        const timeoutId = window.setTimeout(
          () => finish(new Error('ui_commit_unconfirmed')),
          1_000,
        );
        const waiter: VisibleCommitWaiter = {
          targetRevision,
          resolve,
          reject,
          timeoutId,
          signal,
          abort,
        };
        visibleCommitWaitersRef.current.add(waiter);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    [],
  );

  const commitState = useCallback((next: FormState) => {
    const binding = reviewBindingRef.current;
    if (
      reviewLockRef.current &&
      (!binding ||
        binding.documentSessionId !== next.documentSessionId ||
        binding.sourceHash !== next.source.sourceHash ||
        binding.planHash !== next.planHash ||
        binding.stateVersion !== next.stateVersion)
    ) {
      reviewLockRef.current = false;
      reviewBindingRef.current = null;
      setReviewOpen(false);
      setConfirmedFields(new Set());
      setActiveContentAcknowledged(false);
      setProtectionLossAcknowledged(false);
      setSelectedExportStrategy(null);
      setDiscardAllArmed(false);
      setCorrectionFieldName(null);
    }
    uiRevisionRef.current += 1;
    stateRef.current = next;
    setFormState(next);
  }, []);

  const closeReview = useCallback(() => {
    if (exportingRef.current || reviewMutationRef.current) return;
    if (reviewBindingRef.current) {
      dismissedReviewBindingRef.current = reviewBindingRef.current;
    }
    reviewLockRef.current = false;
    reviewBindingRef.current = null;
    setReviewOpen(false);
    setConfirmedFields(new Set());
    setActiveContentAcknowledged(false);
    setProtectionLossAcknowledged(false);
    setSelectedExportStrategy(null);
    setDiscardAllArmed(false);
    setCorrectionFieldName(null);
  }, []);

  const openReview = useCallback(
    (origin: 'agent' | 'human'): OpenReviewResult => {
      const current = stateRef.current;
      if (
        pendingPlanMutationsRef.current > 0 ||
        loadingRef.current ||
        exportingRef.current ||
        reviewMutationRef.current
      ) {
        setError('Wait for the current form update to finish before review.');
        return 'blocked';
      }
      const inspection = inspectionRef.current;
      if (!current || !inspection || Object.keys(current.draft).length === 0) {
        setError('Stage at least one field before starting review.');
        return 'blocked';
      }
      const preferredStrategy = initialExportStrategy(inspection);
      if (preferredStrategy === null) {
        setError(
          'This document is inspection-only because no artifact export strategy is available.',
        );
        return 'blocked';
      }
      const nextBinding: ReviewBinding = {
        documentSessionId: current.documentSessionId,
        sourceHash: current.source.sourceHash,
        planHash: current.planHash,
        stateVersion: current.stateVersion,
      };
      if (
        reviewLockRef.current &&
        reviewBindingsMatch(reviewBindingRef.current, nextBinding)
      ) {
        return 'already_open';
      }
      if (
        origin === 'agent' &&
        reviewBindingsMatch(dismissedReviewBindingRef.current, nextBinding)
      ) {
        setError(
          'You dismissed review for this exact plan. Only you can reopen it until the plan changes.',
        );
        return 'dismissed';
      }
      reviewLockRef.current = true;
      reviewBindingRef.current = nextBinding;
      setConfirmedFields(new Set());
      setActiveContentAcknowledged(false);
      setProtectionLossAcknowledged(false);
      setSelectedExportStrategy(null);
      setDiscardAllArmed(false);
      setCorrectionFieldName(null);
      setError(null);
      uiRevisionRef.current += 1;
      setReviewOpen(true);
      return 'opened';
    },
    [],
  );

  const resetOutput = useCallback(() => {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    if (fillPackageUrlRef.current)
      URL.revokeObjectURL(fillPackageUrlRef.current);
    outputUrlRef.current = null;
    fillPackageUrlRef.current = null;
    setOutputUrl(null);
    setOutputResult(null);
    setFillPackageUrl(null);
    setFillPackageResult(null);
    setShowOutput(false);
  }, []);

  const beginLoad = useCallback(() => {
    const generation = ++loadGenerationRef.current;
    pdfInspectionAbortRef.current?.abort();
    pdfInspectionAbortRef.current = null;
    pdfInspectionWorkerRef.current?.terminate();
    pdfInspectionWorkerRef.current = null;
    loadingRef.current = true;
    stateRef.current = null;
    inspectionRef.current = null;
    sourceBytesRef.current = null;
    agentDataConsentSessionRef.current = null;
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
    setFormState(null);
    setDocumentState(null);
    setAgentDataAccessGranted(false);
    resetOutput();
    reviewLockRef.current = false;
    reviewBindingRef.current = null;
    dismissedReviewBindingRef.current = null;
    setLoading(true);
    setReviewOpen(false);
    setConfirmedFields(new Set());
    setActiveContentAcknowledged(false);
    setProtectionLossAcknowledged(false);
    setSelectedExportStrategy(null);
    setDiscardAllArmed(false);
    setCorrectionFieldName(null);
    setError(null);
    setNotice(null);
    return generation;
  }, [resetOutput]);

  const loadSource = useCallback(
    async (
      fileName: string,
      bytes: Uint8Array,
      generation: number,
      kind: LoadedDocument['kind'],
    ) => {
      try {
        if (bytes.byteLength === 0) {
          throw new Error(
            'The selected file is empty. Choose a non-empty PDF.',
          );
        }
        if (bytes.byteLength > MAX_PDF_BYTES) {
          throw new Error(
            'Choose a PDF smaller than 15 MB for this browser demo.',
          );
        }

        const inspectionController = new AbortController();
        pdfInspectionAbortRef.current = inspectionController;
        const worker = new Worker(
          new URL('../lib/pdf-inspection-worker.ts', import.meta.url),
          { type: 'module', name: 'formproof-pdf-inspection' },
        );
        pdfInspectionWorkerRef.current = worker;
        const inspection = await new Promise<PdfInspection>(
          (resolve, reject) => {
            let settled = false;
            const timeout = { id: 0 };
            const finish = (
              result: { inspection: PdfInspection } | { error: Error },
            ) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout.id);
              worker.terminate();
              if (pdfInspectionWorkerRef.current === worker) {
                pdfInspectionWorkerRef.current = null;
              }
              if (pdfInspectionAbortRef.current === inspectionController) {
                pdfInspectionAbortRef.current = null;
              }
              if ('inspection' in result) resolve(result.inspection);
              else reject(result.error);
            };
            const abort = () =>
              finish({ error: new DOMException('Aborted', 'AbortError') });
            timeout.id = window.setTimeout(
              () =>
                finish({
                  error: new Error(
                    'PDF inspection exceeded the 15-second browser limit.',
                  ),
                }),
              15_000,
            );
            worker.onmessage = (
              event: MessageEvent<PdfInspectionWorkerResponse>,
            ) => {
              const response = event.data;
              finish(
                response.ok
                  ? { inspection: response.inspection }
                  : { error: new Error(response.message) },
              );
            };
            worker.onerror = () =>
              finish({ error: new Error('The PDF inspection worker failed.') });
            inspectionController.signal.addEventListener('abort', abort, {
              once: true,
            });
            const transferableBytes = copyArrayBuffer(bytes);
            worker.postMessage(transferableBytes, [transferableBytes]);
            if (inspectionController.signal.aborted) abort();
          },
        );
        const nextState = await createFormState(
          {
            fileName,
            sourceHash: inspection.sourceHash,
            byteLength: bytes.byteLength,
            pageCount: inspection.pageCount,
            loadedAt: new Date().toISOString(),
          },
          inspection.fields.map(createFormFieldDefinitionFromPdf),
        );

        if (!mountedRef.current || generation !== loadGenerationRef.current)
          return;
        const sourceUrl = inspection.contentRisk.blocksInteractivePreview
          ? null
          : URL.createObjectURL(
              new Blob([copyArrayBuffer(bytes)], { type: 'application/pdf' }),
            );
        if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
        sourceUrlRef.current = sourceUrl;
        sourceBytesRef.current = Uint8Array.from(bytes);
        inspectionRef.current = inspection;
        commitState(nextState);
        setDocumentState({ fileName, kind, sourceUrl, inspection });
        resetOutput();
        reviewLockRef.current = false;
        reviewBindingRef.current = null;
        setReviewOpen(false);
        setConfirmedFields(new Set());
        setActiveContentAcknowledged(false);
        setNotice(
          `${formatCount(inspection.fieldCount, 'field')} and ${formatCount(inspection.widgetCount, 'widget')} inspected locally.`,
        );
      } catch (caught) {
        if (!mountedRef.current || generation !== loadGenerationRef.current)
          return;
        const message =
          caught instanceof Error
            ? caught.message
            : 'The PDF could not be inspected.';
        setError(message);
      } finally {
        if (mountedRef.current && generation === loadGenerationRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [commitState, resetOutput],
  );

  const loadDemo = useCallback(async () => {
    if (exportingRef.current || reviewMutationRef.current) return;
    const generation = beginLoad();
    try {
      const response = await fetch(DEMO_URL);
      if (!response.ok)
        throw new Error('The built-in demo PDF could not be loaded.');
      await loadSource(
        'residential-support-intake.pdf',
        new Uint8Array(await response.arrayBuffer()),
        generation,
        'demo',
      );
    } catch (caught) {
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return;
      loadingRef.current = false;
      setLoading(false);
      setError(
        caught instanceof Error
          ? caught.message
          : 'The demo PDF could not be loaded.',
      );
    }
  }, [beginLoad, loadSource]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDemo(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDemo]);

  useEffect(() => {
    let cancelled = false;
    let registration: FormProofWebMcpRegistration | null = null;
    const registrationController = new AbortController();
    let mutationTail: Promise<void> = Promise.resolve();

    const withMutationLock = async <T,>(
      operation: () => Promise<T>,
    ): Promise<T> => {
      const previous = mutationTail;
      let release: () => void = () => undefined;
      mutationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };

    const inactiveDocumentFailure = (message: string) =>
      adapterFailure(
        null,
        loadingRef.current ? 'document_loading' : 'no_active_document',
        loadingRef.current
          ? 'A newly selected PDF is still being inspected.'
          : message,
      );

    const adapter: FormProofWebMcpAdapter = {
      getPdfProtection() {
        const current = stateRef.current;
        const inspection = inspectionRef.current;
        if (!current || !inspection) {
          return inactiveDocumentFailure(
            'Load a PDF before inspecting its protection.',
          );
        }
        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          documentSessionId: current.documentSessionId,
          data: {
            protectionType: inspection.protection.protectionType,
            allowedMutations: inspection.protection.allowedMutations,
            exportStrategies: inspection.protection.exportStrategies,
            signatureImpact: inspection.protection.signatureImpact,
            requiresHumanConfirmation:
              inspection.protection.requiresHumanConfirmation,
            protectionEvidence: inspection.protection.evidence,
            contentRisk: inspection.contentRisk,
            exportStrategySelection: 'human_ui_only',
            agentMaySelectExportStrategy: false,
          },
        };
      },

      getFormContext(input) {
        const current = stateRef.current;
        const inspection = inspectionRef.current;
        if (!current || !inspection) {
          return inactiveDocumentFailure(
            'Load a PDF before inspecting fields.',
          );
        }
        if (agentDataConsentSessionRef.current !== current.documentSessionId) {
          return adapterFailure(
            current,
            'consent_required',
            'A person must explicitly allow field data sharing for this PDF load before the agent can inspect fields.',
          );
        }

        let offset = 0;
        if (input.cursor !== undefined) {
          const cursor = parseFormContextCursor(
            input.cursor,
            {
              documentSessionId: current.documentSessionId,
              sourceHash: current.source.sourceHash,
              stateVersion: current.stateVersion,
            },
            input,
          );
          if (!cursor.ok) {
            return adapterFailure(
              current,
              cursor.code,
              cursor.code === 'source_mismatch'
                ? 'The field cursor belongs to a different PDF.'
                : cursor.code === 'stale_state'
                  ? 'The field cursor expired because the form state changed. Refresh context from the first page.'
                  : 'The field cursor is invalid.',
            );
          }
          offset = cursor.offset;
        }

        const data = createFormContextToolData(
          current,
          inspection,
          offset,
          input.limit,
          input,
        );
        if (offset > data.pagination.total) {
          return adapterFailure(
            current,
            'invalid_input',
            'The field cursor is out of range.',
          );
        }

        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          documentSessionId: current.documentSessionId,
          data,
        };
      },

      getFieldEvidence(input) {
        const current = stateRef.current;
        const inspection = inspectionRef.current;
        if (!current || !inspection) {
          return inactiveDocumentFailure('Load a PDF before reading evidence.');
        }
        if (agentDataConsentSessionRef.current !== current.documentSessionId) {
          return adapterFailure(
            current,
            'consent_required',
            'Field data sharing is off for this PDF load.',
          );
        }
        const mismatch = bindingFailure(current, input);
        if (mismatch) return mismatch;

        const unknown = input.fieldNames.filter(
          (name) => !Object.hasOwn(current.fields, name),
        );
        if (unknown.length > 0) {
          return adapterFailure(
            current,
            'unknown_field',
            'At least one field does not exist.',
            { fieldNames: unknown },
          );
        }

        let choiceOffset = 0;
        if (input.choiceCursor !== undefined) {
          const cursor = parseFieldChoiceCursor(
            input.choiceCursor,
            current.documentSessionId,
            current.source.sourceHash,
            input.fieldNames[0],
          );
          if (!cursor.ok) {
            return adapterFailure(
              current,
              cursor.code,
              cursor.code === 'source_mismatch'
                ? 'The choice cursor belongs to a different PDF.'
                : 'The choice cursor does not match the requested field.',
            );
          }
          const descriptor = inspection.fields.find(
            ({ name }) => name === input.fieldNames[0],
          );
          if (cursor.offset > (descriptor?.choices.length ?? 0)) {
            return adapterFailure(
              current,
              'invalid_input',
              'The choice cursor is outside this field.',
            );
          }
          choiceOffset = cursor.offset;
        }

        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          documentSessionId: current.documentSessionId,
          data: createFieldEvidenceToolData(
            current,
            inspection,
            input.fieldNames,
            choiceOffset,
          ),
        };
      },

      stageFormValues(input, context) {
        pendingPlanMutationsRef.current += 1;
        return withMutationLock(async () => {
          if (context.signal.aborted)
            throw new DOMException('Aborted', 'AbortError');
          const current = stateRef.current;
          if (!current) {
            return inactiveDocumentFailure('Load a PDF before staging values.');
          }
          if (
            agentDataConsentSessionRef.current !== current.documentSessionId
          ) {
            return adapterFailure(
              current,
              'consent_required',
              'Field data sharing is off for this PDF load.',
            );
          }
          const mismatch = bindingFailure(current, input);
          if (mismatch) return mismatch;
          if (reviewLockRef.current) {
            return adapterFailure(
              current,
              'human_action_required',
              'A person is reviewing the exact plan. Close review before changing it.',
            );
          }

          const result = await stageFieldUpdates(current, {
            expectedStateVersion: input.expectedStateVersion,
            expectedSourceHash: input.expectedSourceHash,
            actor: 'agent',
            updates: input.updates.map((update) => ({
              fieldName: update.fieldName,
              value: update.value,
              provenance: {
                kind: update.provenance.kind,
                confidence: update.provenance.confidence,
                ...(update.provenance.evidence === undefined
                  ? {}
                  : { evidence: update.provenance.evidence }),
                ...(update.provenance.rationale === undefined
                  ? {}
                  : { rationale: update.provenance.rationale }),
              },
            })),
          });
          if (context.signal.aborted)
            throw new DOMException('Aborted', 'AbortError');
          const latest = stateRef.current;
          if (reviewLockRef.current) {
            return adapterFailure(
              latest ?? current,
              'human_action_required',
              'A person started reviewing the exact plan before this update completed.',
            );
          }
          if (loadingRef.current || latest !== current) {
            return adapterFailure(
              latest ?? current,
              'stale_state',
              'The active form changed before this update could commit.',
            );
          }
          if (!result.ok) return stateErrorFailure(current, result.errors);

          commitState(result.state);
          if (result.changedFields.length > 0) {
            setNotice(
              `${formatCount(result.changedFields.length, 'proposed value')} staged. Nothing was written to the PDF.`,
            );
            resetOutput();
          } else {
            setNotice(
              'The submitted values already match the current plan. Any existing verification remains valid.',
            );
          }
          setError(null);
          return {
            ok: true as const,
            stateVersion: result.state.stateVersion,
            sourceHash: result.state.source.sourceHash,
            documentSessionId: result.state.documentSessionId,
            data: {
              changedFields: result.changedFields,
              planHash: result.state.planHash,
              validation: result.state.validation,
              pdfModified: false,
            },
          };
        }).finally(() => {
          pendingPlanMutationsRef.current -= 1;
        });
      },

      validateFillPlan(input) {
        const current = stateRef.current;
        if (!current) {
          return inactiveDocumentFailure('Load a PDF before validation.');
        }
        if (agentDataConsentSessionRef.current !== current.documentSessionId) {
          return adapterFailure(
            current,
            'consent_required',
            'Field data sharing is off for this PDF load.',
          );
        }
        const mismatch = bindingFailure(current, input);
        if (mismatch) return mismatch;
        const validation = validateDraft(current);
        const inspection = inspectionRef.current;
        const reviewArtifacts = inspection?.protection.exportStrategies ?? [];
        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          documentSessionId: current.documentSessionId,
          data: {
            readyForReview:
              Object.keys(current.draft).length > 0 &&
              reviewArtifacts.length > 0,
            reviewArtifacts,
            exportStrategySelection: 'human_ui_only',
            stagedFieldCount: Object.keys(current.draft).length,
            ...validation,
          },
        };
      },

      startFillReview(input) {
        const current = stateRef.current;
        if (!current) {
          return inactiveDocumentFailure('Load a PDF before review.');
        }
        if (agentDataConsentSessionRef.current !== current.documentSessionId) {
          return adapterFailure(
            current,
            'consent_required',
            'Field data sharing is off for this PDF load.',
          );
        }
        const mismatch = bindingFailure(current, input);
        if (mismatch) return mismatch;
        const reviewArtifacts =
          inspectionRef.current?.protection.exportStrategies ?? [];
        if (reviewArtifacts.length === 0) {
          return adapterFailure(
            current,
            'review_not_ready',
            'This document has no available artifact strategy.',
          );
        }
        if (Object.keys(current.draft).length === 0) {
          return adapterFailure(
            current,
            'review_not_ready',
            'Stage a non-empty plan before review.',
          );
        }
        const openResult = openReview('agent');
        if (openResult === 'dismissed') {
          return adapterFailure(
            current,
            'human_action_required',
            'A person dismissed review for this exact plan. Only the review UI can reopen it until the plan changes.',
          );
        }
        if (openResult === 'blocked') {
          return adapterFailure(
            current,
            'review_not_ready',
            'Wait for pending form updates before opening human review.',
          );
        }
        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          documentSessionId: current.documentSessionId,
          data: {
            reviewOpened:
              openResult === 'opened' || openResult === 'already_open',
            reviewStatePreserved: openResult === 'already_open',
            planHash: current.planHash,
            humanActionRequired: true,
            reviewArtifacts,
            exportStrategySelection: 'human_ui_only',
          },
        };
      },
    };

    void registerFormProofWebMcpTools(adapter, {
      signal: registrationController.signal,
      awaitVisibleCommit: waitForVisibleCommit,
      onRegistrationError: () => {
        if (!cancelled) {
          setToolState({
            status: 'error',
            count: 0,
            message: 'WebMCP registration failed; agent tools are unavailable',
          });
        }
      },
    }).then((registered) => {
      registration = registered;
      if (cancelled) {
        registered.cleanup();
        return;
      }
      if (registered.error) {
        setToolState({
          status: 'error',
          count: 0,
          message: registered.error.message,
        });
      } else if (!registered.supported) {
        setToolState({
          status: 'unsupported',
          count: 0,
          message: 'This browser does not expose WebMCP',
        });
      } else {
        setToolState({
          status: 'ready',
          count: registered.registeredTools.length,
          message: `${formatCount(registered.registeredTools.length, 'WebMCP tool')} ready`,
        });
      }
    });

    return () => {
      cancelled = true;
      registrationController.abort();
      registration?.cleanup();
    };
  }, [commitState, openReview, resetOutput, waitForVisibleCommit]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      pdfInspectionAbortRef.current?.abort();
      pdfInspectionWorkerRef.current?.terminate();
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
      if (fillPackageUrlRef.current)
        URL.revokeObjectURL(fillPackageUrlRef.current);
    };
  }, []);

  const onFileChosen = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (exportingRef.current || reviewMutationRef.current) {
        setError(
          'Wait for the current review update or verified export to finish before loading a PDF.',
        );
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        setError('Choose a PDF smaller than 15 MB for this browser demo.');
        return;
      }
      const generation = beginLoad();
      try {
        await loadSource(
          file.name,
          new Uint8Array(await file.arrayBuffer()),
          generation,
          'upload',
        );
      } catch (caught) {
        if (!mountedRef.current || generation !== loadGenerationRef.current)
          return;
        loadingRef.current = false;
        setLoading(false);
        setError(
          caught instanceof Error
            ? caught.message
            : 'The PDF could not be read.',
        );
      }
    },
    [beginLoad, loadSource],
  );

  const onFillPackageChosen = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const current = stateRef.current;
      const source = sourceBytesRef.current;
      const inspection = inspectionRef.current;
      if (!current || !source || !inspection) {
        setError('Load the matching source PDF before opening a fill package.');
        return;
      }
      if (
        loadingRef.current ||
        exportingRef.current ||
        reviewMutationRef.current ||
        reviewLockRef.current ||
        pendingPlanMutationsRef.current > 0
      ) {
        setError(
          'Wait for the current form update or review to finish before opening a fill package.',
        );
        return;
      }
      if (Object.keys(current.draft).length > 0) {
        setError(
          'Discard the current staged plan before opening a fill package. FormProof never merges packages into an existing draft.',
        );
        return;
      }
      if (
        file.type !== 'application/json' &&
        !file.name.toLowerCase().endsWith('.json')
      ) {
        setError('Choose a FormProof fill package JSON file.');
        return;
      }
      if (file.size > MAX_FILL_PACKAGE_BYTES) {
        setError('Choose a fill package no larger than 4 MB.');
        return;
      }

      const generation = loadGenerationRef.current;
      reviewMutationRef.current = true;
      pendingPlanMutationsRef.current += 1;
      setReviewMutating(true);
      setError(null);
      try {
        const result = await importFillPackageFromUi(
          current,
          source,
          new Uint8Array(await file.arrayBuffer()),
          inspection,
        );
        if (
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          stateRef.current !== current ||
          sourceBytesRef.current !== source ||
          reviewLockRef.current ||
          loadingRef.current
        ) {
          return;
        }
        if (!result.ok) {
          setError(result.errors.map((item) => item.message).join(' '));
          return;
        }

        commitState(result.state);
        resetOutput();
        setConfirmedFields(new Set());
        setActiveContentAcknowledged(false);
        setProtectionLossAcknowledged(false);
        setSelectedExportStrategy(null);
        setCorrectionFieldName(null);
        setNotice(
          `${formatCount(result.receipt.importedFieldNames.length, 'proposal')} restored from the matching fill package. The exact PDF and recorded plan hash matched; that proves consistency, not who created the package. Review every imported value before choosing an artifact.`,
        );
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'The fill package could not be opened.',
        );
      } finally {
        pendingPlanMutationsRef.current -= 1;
        reviewMutationRef.current = false;
        if (mountedRef.current) setReviewMutating(false);
      }
    },
    [commitState, resetOutput],
  );

  const stageDemoPlan = async () => {
    const current = stateRef.current;
    if (!current || reviewLockRef.current) return;
    if (documentState?.kind !== 'demo') {
      setError(
        'The synthetic plan only matches the built-in demo PDF. Use a WebMCP agent to stage values in your PDF.',
      );
      return;
    }
    pendingPlanMutationsRef.current += 1;

    try {
      const candidates: Record<string, FormFieldValue> = {
        'frm.q7f1': 'Avery Chen',
        'frm.p0x4': 'avery@example.test',
        'frm.m2k9': 'Email',
        'frm.c8v3': true,
        'frm.r4d6': 'rent',
        'frm.l9n5': ['Rent assistance', 'Utilities'],
        'frm.t3w8':
          'Temporary rent support requested while a new work schedule begins.',
      };
      const evidenceByField: Record<string, readonly string[]> = {
        'frm.q7f1': ['Synthetic request · applicant name: Avery Chen'],
        'frm.p0x4': ['Synthetic request · email: avery@example.test'],
        'frm.m2k9': ['Synthetic request · preferred contact: Email'],
        'frm.c8v3': ['Synthetic request · consent explicitly granted'],
        'frm.r4d6': ['Synthetic request · current housing: rent'],
        'frm.l9n5': [
          'Synthetic request · programs: Rent assistance and Utilities',
        ],
        'frm.t3w8': [
          'Synthetic request · temporary rent support while a new work schedule begins',
        ],
      };
      const updates: FieldUpdate[] = Object.entries(candidates)
        .filter(([fieldName]) => {
          const field = current.fields[fieldName];
          return (
            field &&
            !field.readOnly &&
            !field.humanOnly &&
            field.type !== 'signature'
          );
        })
        .map(([fieldName, value]) => ({
          fieldName,
          value,
          provenance:
            fieldName === 'frm.t3w8'
              ? {
                  kind: 'agent_inference',
                  confidence: 0.74,
                  evidence: evidenceByField[fieldName],
                  rationale:
                    'Drafted from the synthetic demo request for explicit human review.',
                }
              : {
                  kind: 'user_instruction',
                  confidence: 0.99,
                  evidence: evidenceByField[fieldName],
                },
        }));
      if (updates.length !== Object.keys(candidates).length) {
        setError(
          'The built-in demo fields no longer match the synthetic plan. Reload the demo before continuing.',
        );
        return;
      }
      const result = await stageFieldUpdates(current, {
        expectedStateVersion: current.stateVersion,
        expectedSourceHash: current.source.sourceHash,
        actor: 'agent',
        updates,
      });
      if (
        stateRef.current !== current ||
        reviewLockRef.current ||
        loadingRef.current
      ) {
        setError(
          'The active form changed before the synthetic plan could commit.',
        );
        return;
      }
      if (!result.ok) {
        setError(result.errors.map((item) => item.message).join(' '));
        return;
      }
      commitState(result.state);
      resetOutput();
      setError(null);
      setNotice(
        'Synthetic agent plan staged. The source PDF is still untouched.',
      );
    } finally {
      pendingPlanMutationsRef.current -= 1;
    }
  };

  const reviewNames = useMemo(() => {
    if (!formState) return [];
    return getArtifactReviewFieldNames(formState);
  }, [formState]);

  const activeContent = documentState?.inspection.activeContent;
  const activeContentDescription = activeContent
    ? describeActiveContent(activeContent)
    : '';
  const contentRiskReasons =
    documentState?.inspection.contentRisk.reasons ?? [];
  const contentRiskReasonDescriptions = contentRiskReasons.map(
    describeContentRiskReason,
  );
  const contentRiskDescription = describeContentRiskReasons(contentRiskReasons);
  const fillPackageAvailable =
    documentState?.inspection.protection.exportStrategies.includes(
      'fill_package',
    ) ?? false;
  const selectedCreatesPdf =
    selectedExportStrategy === 'filled_pdf' ||
    selectedExportStrategy === 'confirmed_plain_derivative_pdf';
  const requiresActiveContentAcknowledgment =
    selectedCreatesPdf && activeContentDescription.length > 0;
  const hasBlockedPdfContent =
    documentState?.inspection.contentRisk.blocksPdfExport ?? false;
  const requiresProtectionLossAcknowledgment =
    selectedExportStrategy === 'confirmed_plain_derivative_pdf';

  const allReviewFieldsConfirmed =
    reviewNames.length > 0 &&
    reviewNames.every((name) => confirmedFields.has(name)) &&
    (!requiresActiveContentAcknowledgment || activeContentAcknowledged) &&
    (!requiresProtectionLossAcknowledgment || protectionLossAcknowledged);

  const correctProposal = useCallback(
    async (fieldName: string, value: FormFieldValue) => {
      if (exportingRef.current || reviewMutationRef.current) return;
      const current = stateRef.current;
      const binding = reviewBindingRef.current;
      if (
        !current ||
        !binding ||
        !reviewLockRef.current ||
        binding.documentSessionId !== current.documentSessionId ||
        binding.sourceHash !== current.source.sourceHash ||
        binding.planHash !== current.planHash ||
        binding.stateVersion !== current.stateVersion
      ) {
        setError(
          'The fill plan changed. Reopen review before correcting a proposal.',
        );
        return;
      }

      reviewMutationRef.current = true;
      pendingPlanMutationsRef.current += 1;
      setReviewMutating(true);
      setError(null);
      try {
        const result = await correctDraftFieldFromUi(current, {
          expectedStateVersion: current.stateVersion,
          expectedSourceHash: current.source.sourceHash,
          expectedPlanHash: current.planHash,
          fieldName,
          value,
        });
        if (
          !mountedRef.current ||
          stateRef.current !== current ||
          !reviewLockRef.current ||
          reviewBindingRef.current !== binding ||
          loadingRef.current
        ) {
          return;
        }
        if (!result.ok) {
          setError(result.errors.map((item) => item.message).join(' '));
          return;
        }

        const fieldLabel = current.fields[fieldName]?.label ?? fieldName;
        commitState(result.state);
        resetOutput();
        setNotice(
          `${fieldLabel} was corrected by you and is locked against agent changes for this loaded document session. The plan changed, review closed, and every confirmation was cleared. The source PDF remains untouched.`,
        );
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'The staged proposal could not be corrected.',
        );
      } finally {
        pendingPlanMutationsRef.current -= 1;
        reviewMutationRef.current = false;
        if (mountedRef.current) setReviewMutating(false);
      }
    },
    [commitState, resetOutput],
  );

  const rejectProposals = useCallback(
    async (
      fieldNames: readonly string[],
      intent: 'reject' | 'unlock' | 'discard_all' = 'reject',
    ) => {
      if (exportingRef.current || reviewMutationRef.current) return;
      const current = stateRef.current;
      const binding = reviewBindingRef.current;
      if (
        !current ||
        !binding ||
        !reviewLockRef.current ||
        fieldNames.length === 0 ||
        binding.documentSessionId !== current.documentSessionId ||
        binding.sourceHash !== current.source.sourceHash ||
        binding.planHash !== current.planHash ||
        binding.stateVersion !== current.stateVersion
      ) {
        setError(
          'The fill plan changed. Reopen review before rejecting a proposal.',
        );
        return;
      }
      if (
        intent === 'unlock' &&
        fieldNames.some(
          (fieldName) =>
            current.draft[fieldName]?.actor !== 'human' ||
            (current.importedProposalFieldNames ?? []).includes(fieldName),
        )
      ) {
        setError('Only a human correction can be unlocked in this UI.');
        return;
      }

      reviewMutationRef.current = true;
      pendingPlanMutationsRef.current += 1;
      setReviewMutating(true);
      setError(null);
      try {
        const result = await discardDraftFields(current, {
          expectedStateVersion: current.stateVersion,
          expectedSourceHash: current.source.sourceHash,
          fieldNames,
        });
        if (
          !mountedRef.current ||
          stateRef.current !== current ||
          !reviewLockRef.current ||
          reviewBindingRef.current !== binding ||
          loadingRef.current
        ) {
          return;
        }
        if (!result.ok) {
          setError(result.errors.map((item) => item.message).join(' '));
          return;
        }

        const discardedAll =
          fieldNames.length === Object.keys(current.draft).length;
        const fieldLabel =
          current.fields[fieldNames[0]]?.label ?? fieldNames[0];
        commitState(result.state);
        resetOutput();
        setNotice(
          `${intent === 'unlock' ? `${fieldLabel} human correction removed; its original PDF value is restored and the agent may propose it again.` : discardedAll || intent === 'discard_all' ? `All ${formatCount(fieldNames.length, 'staged value')} discarded.` : `${fieldLabel} proposal rejected.`} The plan changed, so review closed and every confirmation was cleared.`,
        );
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'The staged proposal could not be rejected.',
        );
      } finally {
        pendingPlanMutationsRef.current -= 1;
        reviewMutationRef.current = false;
        if (mountedRef.current) setReviewMutating(false);
      }
    },
    [commitState, resetOutput],
  );

  const completeReview = useCallback(async () => {
    if (exportingRef.current || reviewMutationRef.current) return;
    if (correctionFieldName !== null) {
      setError('Save or cancel the open field correction before approval.');
      return;
    }
    const current = stateRef.current;
    const source = sourceBytesRef.current;
    const inspection = inspectionRef.current;
    const binding = reviewBindingRef.current;
    if (
      !current ||
      !source ||
      !inspection ||
      !binding ||
      selectedExportStrategy === null ||
      !allReviewFieldsConfirmed ||
      binding.documentSessionId !== current.documentSessionId ||
      binding.sourceHash !== current.source.sourceHash ||
      binding.planHash !== current.planHash ||
      binding.stateVersion !== current.stateVersion
    ) {
      setError(
        'The fill plan changed. Reopen review and confirm the new plan.',
      );
      reviewLockRef.current = false;
      reviewBindingRef.current = null;
      setReviewOpen(false);
      setConfirmedFields(new Set());
      setActiveContentAcknowledged(false);
      setProtectionLossAcknowledged(false);
      setSelectedExportStrategy(null);
      setCorrectionFieldName(null);
      return;
    }

    exportingRef.current = true;
    setExporting(true);
    setError(null);
    try {
      if (selectedExportStrategy === 'fill_package') {
        const packaged = await exportFillPackageFromUi(current, source, {
          confirmedFieldNames: reviewNames,
        });
        if (!packaged.ok) {
          setError(packaged.errors.map((item) => item.message).join(' '));
          return;
        }
        if (
          !mountedRef.current ||
          stateRef.current !== current ||
          !reviewLockRef.current ||
          reviewBindingRef.current !== binding ||
          loadingRef.current
        ) {
          return;
        }
        const nextUrl = URL.createObjectURL(
          new Blob([copyArrayBuffer(packaged.result.bytes)], {
            type: 'application/json',
          }),
        );
        if (fillPackageUrlRef.current)
          URL.revokeObjectURL(fillPackageUrlRef.current);
        fillPackageUrlRef.current = nextUrl;
        setFillPackageUrl(nextUrl);
        setFillPackageResult(packaged.result);
        if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
        outputUrlRef.current = null;
        setOutputUrl(null);
        setOutputResult(null);
        setShowOutput(false);
        setNotice(
          'Reviewed field data was exported as an original-untouched fill package. No PDF bytes were rewritten.',
        );
      } else {
        if (!validateDraft(current).canApprove) {
          setError(
            fillPackageAvailable
              ? 'Resolve required-field blockers before creating a PDF artifact. An incomplete original-untouched fill package can still be reviewed.'
              : 'Resolve required-field blockers before creating a PDF artifact.',
          );
          return;
        }
        const approval = approveDraftFromUi(current, {
          expectedStateVersion: current.stateVersion,
          expectedSourceHash: current.source.sourceHash,
          expectedPlanHash: current.planHash,
          approvedBy: 'UI reviewer',
          confirmedFieldNames: reviewNames,
        });
        if (!approval.ok) {
          setError(approval.errors.map((item) => item.message).join(' '));
          return;
        }
        const exported =
          selectedExportStrategy === 'confirmed_plain_derivative_pdf'
            ? await exportApprovedDerivativePdfFromUi(approval.state, source, {
                humanConfirmedProtectionLoss: protectionLossAcknowledged,
              })
            : await exportApprovedPdfFromUi(approval.state, source);
        if (!exported.ok) {
          setError(exported.errors.map((item) => item.message).join(' '));
          return;
        }
        if (
          !mountedRef.current ||
          stateRef.current !== current ||
          !reviewLockRef.current ||
          reviewBindingRef.current !== binding ||
          loadingRef.current
        ) {
          return;
        }

        const nextUrl = URL.createObjectURL(
          new Blob([copyArrayBuffer(exported.result.bytes)], {
            type: 'application/pdf',
          }),
        );
        if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
        outputUrlRef.current = nextUrl;
        setOutputUrl(nextUrl);
        setOutputResult(exported.result);
        if (fillPackageUrlRef.current)
          URL.revokeObjectURL(fillPackageUrlRef.current);
        fillPackageUrlRef.current = null;
        setFillPackageUrl(null);
        setFillPackageResult(null);
        commitState(exported.state);
        setShowOutput(true);
        setNotice(
          exported.result.exportStrategy === 'filled_pdf'
            ? 'Approved staged values were written to a filled PDF and reopened: field values matched and normal appearance streams were present. Visual rendering was not independently checked.'
            : 'A confirmed plain derivative was created, its Reader Extensions usage rights were removed, field values matched after reopening, and normal appearance streams were present. Visual rendering was not independently checked.',
        );
      }
      reviewLockRef.current = false;
      reviewBindingRef.current = null;
      setReviewOpen(false);
      setConfirmedFields(new Set());
      setActiveContentAcknowledged(false);
      setProtectionLossAcknowledged(false);
      setSelectedExportStrategy(null);
      setCorrectionFieldName(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : 'The reviewed artifact could not be exported.',
      );
    } finally {
      exportingRef.current = false;
      if (mountedRef.current) setExporting(false);
    }
  }, [
    allReviewFieldsConfirmed,
    commitState,
    correctionFieldName,
    fillPackageAvailable,
    protectionLossAcknowledged,
    reviewNames,
    selectedExportStrategy,
  ]);

  const downloadOutput = useCallback(() => {
    if (
      !outputUrl ||
      !documentState ||
      !formState ||
      !outputResult ||
      !getReleaseGate(formState).open
    ) {
      return;
    }
    const link = window.document.createElement('a');
    link.href = outputUrl;
    link.download = pdfOutputFileName(
      documentState.fileName,
      outputResult.exportStrategy,
    );
    link.click();
  }, [documentState, formState, outputResult, outputUrl]);

  const downloadFillPackage = useCallback(() => {
    if (!fillPackageUrl || !fillPackageResult || !documentState) return;
    const link = window.document.createElement('a');
    link.href = fillPackageUrl;
    link.download = fillPackageFileName(documentState.fileName);
    link.click();
  }, [documentState, fillPackageResult, fillPackageUrl]);

  const draftEntries = formState ? Object.values(formState.draft) : [];
  const importedProposalSet = useMemo(
    () => new Set(formState?.importedProposalFieldNames ?? []),
    [formState?.importedProposalFieldNames],
  );
  const importedProposalNames = [...importedProposalSet];
  const descriptorByName = useMemo(
    () =>
      new Map(
        documentState?.inspection.fields.map((field) => [field.name, field]) ??
          [],
      ),
    [documentState],
  );
  const releaseOpen = formState ? getReleaseGate(formState).open : false;
  const artifactReady = releaseOpen || fillPackageResult !== null;
  const protectionPresentation = documentState
    ? protectionOutcome(documentState.inspection)
    : null;
  const activePreviewUrl =
    showOutput && outputUrl ? outputUrl : documentState?.sourceUrl;
  const validation = formState ? validateDraft(formState) : null;
  const validationErrors =
    validation?.issues.filter(({ severity }) => severity === 'error') ?? [];
  const allValidationErrorsAreRequiredMissing =
    validationErrors.length > 0 &&
    validationErrors.every(({ code }) => code === 'required_missing');
  const validationBlockerItems = validationErrors.map((issue) => {
    if (allValidationErrorsAreRequiredMissing) {
      const label = formState?.fields[issue.fieldName]?.label.trim();
      if (label && label !== issue.fieldName) return label;
    }
    return issue.message.replaceAll(issue.fieldName, 'Unnamed PDF field');
  });
  const validationBlockerTitle = allValidationErrorsAreRequiredMissing
    ? `${formatCount(validationErrors.length, 'PDF-required field')} ${validationErrors.length === 1 ? 'is' : 'are'} still blank`
    : `${formatCount(validationErrors.length, 'PDF validation blocker')} ${validationErrors.length === 1 ? 'remains' : 'remain'}`;
  const hasPdfProducingStrategy =
    documentState?.inspection.protection.exportStrategies.some(
      (strategy) =>
        strategy === 'filled_pdf' ||
        strategy === 'confirmed_plain_derivative_pdf',
    ) ?? false;
  const validationBlockerGuidance = [
    hasPdfProducingStrategy
      ? allValidationErrorsAreRequiredMissing
        ? 'PDF artifacts cannot be exported until these fields are completed.'
        : 'PDF artifacts cannot be exported until these blockers are resolved.'
      : '',
    fillPackageAvailable
      ? draftEntries.length > 0
        ? 'An incomplete original-untouched fill package can still be reviewed.'
        : allValidationErrorsAreRequiredMissing
          ? 'Stage values before reviewing an original-untouched fill package; it will remain incomplete while these fields are blank.'
          : 'Stage values before reviewing an original-untouched fill package; it will remain incomplete while these blockers remain.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const showValidationBlockerSummary =
    (documentState?.inspection.protection.exportStrategies.length ?? 0) > 0 &&
    !hasBlockedPdfContent &&
    validationErrors.length > 0;
  const pendingHumanCompletionNames = formState
    ? [
        ...new Set(
          formState.validation.issues
            .filter(({ code }) => code === 'human_completion_required')
            .map(({ fieldName }) => fieldName),
        ),
      ]
    : [];

  const steps = [
    {
      label: 'Inspect form',
      detail: formState
        ? `${formatCount(documentState?.inspection.fieldCount ?? 0, 'field')} found`
        : 'Load a PDF',
      state: formState ? 'done' : 'active',
    },
    {
      label: 'Draft values',
      detail:
        draftEntries.length > 0
          ? `${formatCount(draftEntries.length, 'value')} staged`
          : 'Waiting for agent',
      state: draftEntries.length > 0 ? 'done' : formState ? 'active' : 'idle',
    },
    {
      label: 'Review evidence',
      detail: fillPackageResult
        ? 'Field package reviewed'
        : formState?.approval
          ? 'Exact plan approved'
          : 'UI review gate',
      state:
        fillPackageResult || formState?.approval
          ? 'done'
          : draftEntries.length > 0
            ? 'active'
            : 'idle',
    },
    {
      label: 'Verify & export',
      detail: outputResult
        ? 'PDF values verified; appearance streams present'
        : fillPackageResult
          ? 'JSON round-trip verified'
          : 'Locked',
      state: artifactReady ? 'done' : formState?.approval ? 'active' : 'idle',
    },
  ] as const;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#workspace" aria-label="FormProof home">
          <span className="brand-mark">
            <FileCheck2 aria-hidden="true" />
          </span>
          <span>FormProof</span>
        </a>
        <div className="topbar-status">
          <span className="privacy-note">
            <LockKeyhole aria-hidden="true" /> PDF bytes stay in this browser
          </span>
          <Badge
            variant="outline"
            className={`tool-badge tool-${toolState.status}`}
            title={toolState.message}
          >
            <span className="status-dot" /> {toolState.message}
          </Badge>
        </div>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">
            <Sparkles aria-hidden="true" /> Evidence-bound PDF form review
          </p>
          <h1 id="page-title">The agent drafts. You decide.</h1>
          <p>
            PDF protection metadata is available to WebMCP. Field names and
            values stay private until you enable sharing for the current PDF
            load. Approval and export stay outside its tool surface.
          </p>
        </div>
        <div className="intro-actions">
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => void onFileChosen(event)}
          />
          <input
            ref={fillPackageInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void onFillPackageChosen(event)}
          />
          <Button
            variant="outline"
            size="lg"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload aria-hidden="true" /> Choose PDF
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={() => fillPackageInputRef.current?.click()}
            disabled={
              !formState ||
              loading ||
              exporting ||
              reviewMutating ||
              draftEntries.length > 0
            }
          >
            <FileJson aria-hidden="true" /> Open fill package
          </Button>
          <Button size="lg" onClick={() => void loadDemo()} disabled={loading}>
            {loading ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            Reload demo
          </Button>
        </div>
      </section>

      <section className="notice-bar" aria-label="Agent data access">
        <LockKeyhole aria-hidden="true" />
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={agentDataAccessGranted}
            disabled={!formState || loading}
            onChange={(event) => {
              const current = stateRef.current;
              const granted = event.target.checked && current !== null;
              agentDataConsentSessionRef.current = granted
                ? current.documentSessionId
                : null;
              setAgentDataAccessGranted(granted);
            }}
          />
          <span>
            <strong>Share this PDF&apos;s field data with the agent</strong>
            <br />
            Off by default and reset on every load. When enabled, WebMCP may
            return field names, existing values, choices, and staged proposals
            for this document session. Approval and export are not WebMCP tools;
            browser automation outside that tool boundary could still operate
            the visible UI.
          </span>
        </label>
      </section>

      {(notice || error) && (
        <div
          className={`notice-bar ${error ? 'notice-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ? (
            <ShieldCheck aria-hidden="true" />
          ) : (
            <CheckCircle2 aria-hidden="true" />
          )}
          <span>{error ?? notice}</span>
        </div>
      )}

      {importedProposalNames.length > 0 && (
        <output className="notice-bar">
          <ShieldCheck aria-hidden="true" />
          <span>
            <strong>Imported proposals are untrusted.</strong> The package
            matched this exact PDF and reproduced its recorded plan hash. That
            checks consistency, not creator identity. Review all{' '}
            {formatCount(importedProposalNames.length, 'imported value')} before
            export.
          </span>
        </output>
      )}

      <section
        id="workspace"
        className="workspace"
        aria-label="Form review workspace"
      >
        <aside className="flow-panel" aria-labelledby="flow-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Workflow</p>
              <h2 id="flow-title">One bounded path</h2>
            </div>
            <span className="revision">v{formState?.stateVersion ?? 0}</span>
          </div>
          <ol className="flow-list">
            {steps.map((step, index) => (
              <li key={step.label} className={`flow-step ${step.state}`}>
                <span className="step-index">
                  {step.state === 'done' ? (
                    <Check aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
              </li>
            ))}
          </ol>
          <div className="safety-card">
            <ShieldCheck aria-hidden="true" />
            <div>
              <strong>Approval is not a WebMCP tool</strong>
              <p>
                Agent tools can inspect, stage, validate, and open review.
                Approval and export stay in this interface.
              </p>
              {formState && (
                <p>
                  Whole-form completeness is not assessed; structural checks use
                  PDF required flags only.
                  {requiresActiveContentAcknowledgment
                    ? ` Detected markers: ${activeContentDescription}. Categories can overlap.`
                    : ''}
                </p>
              )}
            </div>
          </div>
          {documentState && protectionPresentation && (
            <div className="safety-card">
              <Fingerprint aria-hidden="true" />
              <div>
                <strong>{protectionPresentation.title}</strong>
                <p>{protectionPresentation.detail}</p>
                {hasBlockedPdfContent && (
                  <p>
                    <b>Content restrictions:</b> PDF protection and content risk
                    are evaluated separately. Interactive preview and PDF
                    rewriting are blocked because FormProof detected{' '}
                    {contentRiskDescription}. Counts are detector findings;
                    categories can overlap.
                  </p>
                )}
                <p>
                  Protection type:{' '}
                  <b>{documentState.inspection.protection.protectionType}</b>
                  <br />
                  Allowed mutations:{' '}
                  {documentState.inspection.protection.allowedMutations.join(
                    ', ',
                  ) || 'none'}
                  <br />
                  Export strategies:{' '}
                  {documentState.inspection.protection.exportStrategies.join(
                    ', ',
                  ) || 'none'}
                  <br />
                  Signature impact:{' '}
                  {documentState.inspection.protection.signatureImpact}
                  <br />
                  Human confirmation:{' '}
                  {documentState.inspection.protection.requiresHumanConfirmation
                    ? 'required for the plain derivative'
                    : 'not required by the protection policy'}
                </p>
                <p>
                  Evidence:{' '}
                  {documentState.inspection.protection.evidence.usageRightsKeys
                    .length > 0
                    ? `${documentState.inspection.protection.evidence.usageRightsKeys.join('/')} usage rights; `
                    : ''}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .signatureDictionaryCount,
                    'recognized signature dictionary',
                    'recognized signature dictionaries',
                  )}
                  {' ('}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .usageRightsSignatureCount,
                    'UR/UR3 signature dictionary',
                    'UR/UR3 signature dictionaries',
                  )}
                  {', '}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .documentSignatureCount,
                    'signed-field document signature',
                  )}
                  {', '}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .unclassifiedSignatureDictionaryCount,
                    'unclassified signature dictionary',
                    'unclassified signature dictionaries',
                  )}
                  {', '}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .unreachableSignatureDictionaryCount,
                    'unreachable signature dictionary',
                    'unreachable signature dictionaries',
                  )}
                  {'); '}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .byteRangeEntryCount,
                    'ByteRange entry',
                    'ByteRange entries',
                  )}{' '}
                  (
                  {formatCount(
                    documentState.inspection.protection.evidence.byteRanges
                      .length,
                    'parsed entry',
                    'parsed entries',
                  )}
                  {', '}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .malformedByteRangeCount,
                    'malformed entry',
                    'malformed entries',
                  )}
                  {'; whole-file coverage '}
                  {documentState.inspection.protection.evidence
                    .byteRangesCoverWholeFile === null
                    ? 'not applicable'
                    : documentState.inspection.protection.evidence
                          .byteRangesCoverWholeFile
                      ? 'yes'
                      : 'no'}
                  {'); '}DocMDP{' '}
                  {!documentState.inspection.protection.evidence.docMdpPresent
                    ? documentState.inspection.protection.evidence
                        .unknownStructures.length > 0
                      ? 'not established; unknown protection remains'
                      : 'absent'
                    : documentState.inspection.protection.evidence
                          .docMdpPermission === null
                      ? 'present; permission unrecognized'
                      : `present; P=${documentState.inspection.protection.evidence.docMdpPermission}`}
                  {'; '}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .signatureFieldCount,
                    'signature field',
                  )}
                  {' ('}
                  {formatCount(
                    documentState.inspection.protection.evidence
                      .signedSignatureFieldCount,
                    'signed signature field',
                  )}
                  {'); XFA '}
                  {documentState.inspection.protection.evidence.xfaPresent
                    ? 'present'
                    : 'absent'}
                  .
                </p>
                {documentState.inspection.protection.evidence.unknownStructures
                  .length > 0 && (
                  <p>
                    Unrecognized protection evidence:{' '}
                    {documentState.inspection.protection.evidence.unknownStructures.join(
                      ', ',
                    )}
                    . No export strategy is available.
                  </p>
                )}
                {documentState.inspection.protection.evidence.adbeExtension && (
                  <p>
                    ADBE developer extension declaration:{' '}
                    {documentState.inspection.protection.evidence.adbeExtension
                      .baseVersion ?? 'base version unspecified'}
                    , level{' '}
                    {documentState.inspection.protection.evidence.adbeExtension
                      .extensionLevel ?? 'unspecified'}
                    . This declaration is not itself a usage right or a
                    signature.
                  </p>
                )}
                <p>
                  Browser CMS integrity:{' '}
                  {documentState.inspection.protection.evidence.cmsIntegrity.replaceAll(
                    '_',
                    ' ',
                  )}
                  ; signer trust:{' '}
                  {documentState.inspection.protection.evidence.signerTrust.replaceAll(
                    '_',
                    ' ',
                  )}
                  .
                </p>
              </div>
            </div>
          )}
        </aside>

        <article className="document-panel" aria-labelledby="document-title">
          <div className="document-toolbar">
            <div>
              <p className="section-kicker">
                {showOutput && outputResult
                  ? exportStrategyCopy(outputResult.exportStrategy).title
                  : 'Untouched source'}
              </p>
              <h2 id="document-title">
                {documentState?.fileName ?? 'No PDF loaded'}
              </h2>
            </div>
            <div className="document-meta">
              {documentState && (
                <>
                  <span>
                    {formatCount(documentState.inspection.pageCount, 'page')}
                  </span>
                  <span>
                    {formatCount(documentState.inspection.fieldCount, 'field')}
                  </span>
                  <span className="hash">
                    <Fingerprint aria-hidden="true" />{' '}
                    {shortHash(documentState.inspection.sourceHash)}
                  </span>
                </>
              )}
            </div>
          </div>
          {outputUrl && (
            <div className="preview-switch" aria-label="PDF preview version">
              <button
                type="button"
                className={!showOutput ? 'selected' : ''}
                onClick={() => setShowOutput(false)}
              >
                Source
              </button>
              <button
                type="button"
                className={showOutput ? 'selected' : ''}
                onClick={() => setShowOutput(true)}
              >
                {outputResult
                  ? exportStrategyCopy(outputResult.exportStrategy).title
                  : 'PDF result'}
              </button>
            </div>
          )}
          <div className="paper-frame pdf-frame">
            {activePreviewUrl ? (
              <object
                className="pdf-object"
                data={activePreviewUrl}
                type="application/pdf"
                aria-label="Active PDF preview"
              >
                <p>
                  PDF preview unavailable.{' '}
                  <a href={activePreviewUrl}>Open the document</a>.
                </p>
              </object>
            ) : (
              <div className="pdf-empty" aria-live="polite">
                <FileText aria-hidden="true" />
                <strong>
                  {loading
                    ? 'Inspecting the demo PDF…'
                    : documentState?.inspection.contentRisk
                          .blocksInteractivePreview
                      ? 'Interactive preview disabled for this PDF'
                      : 'Choose a fillable PDF'}
                </strong>
                {documentState?.inspection.contentRisk
                  .blocksInteractivePreview && (
                  <div className="content-risk-explanation">
                    <p>
                      Interactive preview and PDF rewriting are blocked because
                      FormProof detected:
                    </p>
                    {contentRiskReasonDescriptions.length > 0 ? (
                      <ul
                        className="content-risk-list"
                        aria-label="Reasons PDF preview and rewriting are blocked"
                      >
                        {contentRiskReasons.map((reason) => (
                          <li key={reason.code}>
                            {describeContentRiskReason(reason)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>{GENERIC_CONTENT_RISK_COPY}.</p>
                    )}
                    <p>
                      Counts are detector findings; categories can overlap. The
                      original remains untouched.
                      {fillPackageAvailable
                        ? ' Document policy permits an original-untouched fill package after values are staged and a person reviews them.'
                        : ' No artifact export is available under the current document policy.'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </article>

        <aside className="review-panel" aria-labelledby="review-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Review queue</p>
              <h2 id="review-title">
                {draftEntries.length > 0
                  ? formatCount(draftEntries.length, 'proposed change')
                  : 'No draft yet'}
              </h2>
            </div>
            <span className="queue-count">{draftEntries.length}</span>
          </div>

          {draftEntries.length === 0 ? (
            <div className="empty-review">
              <span>
                <FileText aria-hidden="true" />
              </span>
              <h3>Ask the agent to inspect this form</h3>
              <p>
                It can propose a bounded batch of values, but nothing is written
                to the PDF yet.
              </p>
            </div>
          ) : (
            <div className="draft-list" aria-label="Staged field changes">
              {draftEntries.map((entry) => {
                const field = formState?.fields[entry.fieldName];
                const descriptor = descriptorByName.get(entry.fieldName);
                const isMultiline = descriptor?.multiline === true;
                const importedProposal = importedProposalSet.has(
                  entry.fieldName,
                );
                const requiresIdentityReview =
                  (entry.identityReviewReasons?.length ?? 0) > 0;
                const choiceLabelReviewNotice = getChoiceLabelReviewNotice(
                  descriptor?.choices ?? [],
                );
                return (
                  <div className="draft-card" key={entry.fieldName}>
                    <div className="draft-card-heading">
                      <strong>{field?.label ?? entry.fieldName}</strong>
                      <Badge variant="outline">
                        {importedProposal
                          ? 'Imported · review required'
                          : entry.actor === 'human'
                            ? 'Human locked'
                            : requiresIdentityReview
                              ? 'Verify field identity'
                              : `${Math.round(entry.provenance.confidence * 100)}%`}
                      </Badge>
                    </div>
                    <div
                      className={`mini-diff${isMultiline ? ' is-multiline' : ''}`}
                    >
                      <span>
                        {formatValue(
                          field?.sourceValue ?? null,
                          descriptor?.choices,
                        )}
                      </span>
                      <ArrowRight aria-hidden="true" />
                      <b>{formatValue(entry.value, descriptor?.choices)}</b>
                    </div>
                    <small>
                      {importedProposal
                        ? 'untrusted package proposal · creator not verified'
                        : entry.actor === 'human'
                          ? 'human correction · agent locked for this session'
                          : claimedBasisLabel(entry.provenance.kind)}
                    </small>
                    {requiresIdentityReview && (
                      <small className="human-only-note">
                        A non-authoritative discovery hint can recall this
                        candidate, but it is not a label or evidence. Verify the
                        field in the untouched original PDF at{' '}
                        {formatFieldLocation(descriptor)} before export.
                      </small>
                    )}
                    {choiceLabelReviewNotice && (
                      <small className="human-only-note">
                        {choiceLabelReviewNotice}
                      </small>
                    )}
                    {entry.provenance.evidence && (
                      <ul className="evidence-list compact-evidence">
                        {entry.provenance.evidence.slice(0, 2).map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="prompt-card">
            <p className="section-kicker">Try with an agent</p>
            {toolState.status === 'ready' ? (
              <blockquote>
                “Inspect this form, stage my support details, and explain every
                source.”
              </blockquote>
            ) : (
              <p>
                This browser can inspect PDFs locally, but agent staging needs a
                WebMCP host. The built-in synthetic demo still shows the review
                and export path.
              </p>
            )}
          </div>

          {draftEntries.length === 0 ? (
            documentState?.kind === 'demo' ? (
              <Button
                className="w-full"
                size="lg"
                onClick={() => void stageDemoPlan()}
                disabled={!formState || loading}
              >
                Stage synthetic demo plan <ArrowRight aria-hidden="true" />
              </Button>
            ) : (
              <Button
                className="w-full"
                size="lg"
                variant="outline"
                onClick={() => void loadDemo()}
                disabled={loading}
              >
                Load built-in demo <RefreshCw aria-hidden="true" />
              </Button>
            )
          ) : (
            <Button
              className="w-full"
              size="lg"
              onClick={() => openReview('human')}
              disabled={
                !documentState ||
                documentState.inspection.protection.exportStrategies.length ===
                  0
              }
            >
              Review exact plan <ArrowRight aria-hidden="true" />
            </Button>
          )}
          {showValidationBlockerSummary ? (
            <section
              className="validation-blocker-summary"
              aria-labelledby="validation-blocker-title"
            >
              <output aria-live="polite">
                <h3 id="validation-blocker-title">{validationBlockerTitle}</h3>
              </output>
              <section
                className="validation-blocker-list-scroll"
                aria-label="Fields blocking PDF validation"
                tabIndex={0}
              >
                <ul className="validation-blocker-list">
                  {validationBlockerItems.map((item, index) => (
                    <li
                      key={`${validationErrors[index]?.fieldName ?? 'unknown'}:${validationErrors[index]?.code ?? 'unknown'}:${index}`}
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
              <p>{validationBlockerGuidance}</p>
            </section>
          ) : (
            <p className="button-note">
              {documentState &&
              documentState.inspection.protection.exportStrategies.length === 0
                ? documentState.inspection.protection.protectionType ===
                  'unknown'
                  ? 'Unknown protection remains inspection-only; no artifact export is offered.'
                  : 'No artifact export is available because this PDF has no agent-writable addressable fields.'
                : hasBlockedPdfContent
                  ? `PDF rewriting is blocked because FormProof detected ${contentRiskDescription}.${fillPackageAvailable ? ' Document policy permits an original-untouched fill package after values are staged and a person reviews them.' : ''}`
                  : 'A person chooses the artifact here; WebMCP cannot select or export it.'}
            </p>
          )}

          {releaseOpen && formState?.approval && outputResult && (
            <div className="receipt-card">
              <div className="receipt-heading">
                <span>
                  <CheckCircle2 aria-hidden="true" />
                </span>
                <div>
                  <p className="section-kicker">Staged values verified</p>
                  <strong>
                    {outputResult.exportStrategy === 'filled_pdf'
                      ? 'Filled PDF receipt'
                      : 'Confirmed derivative receipt'}
                  </strong>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Artifact</dt>
                  <dd>
                    {exportStrategyCopy(outputResult.exportStrategy).title}
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{shortHash(formState.source.sourceHash)}</dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>
                    {shortHash(formState.planHash.replace(/^sha256:/u, ''))}
                  </dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{shortHash(outputResult.outputHash)}</dd>
                </div>
                <div>
                  <dt>Staged fields</dt>
                  <dd>
                    {formatCount(
                      outputResult.verifiedFields.length,
                      'field value',
                    )}{' '}
                    verified; normal appearance streams present
                  </dd>
                </div>
                <div>
                  <dt>Form structure</dt>
                  <dd>
                    {formatCount(outputResult.fieldCount, 'total field')} ·{' '}
                    {formatCount(outputResult.widgetCount, 'total widget')}
                  </dd>
                </div>
                <div>
                  <dt>Signature impact</dt>
                  <dd>{outputResult.sourceProtection.signatureImpact}</dd>
                </div>
                <div>
                  <dt>Completeness</dt>
                  <dd>Not assessed beyond PDF required flags</dd>
                </div>
                <div>
                  <dt>Still required</dt>
                  <dd>
                    {pendingHumanCompletionNames.length > 0
                      ? pendingHumanCompletionNames
                          .map((name) => formState.fields[name]?.label ?? name)
                          .join(', ')
                      : 'No required human-only fields'}
                  </dd>
                </div>
              </dl>
              <Button className="w-full" onClick={downloadOutput}>
                <Download aria-hidden="true" />{' '}
                {pendingHumanCompletionNames.length > 0
                  ? 'Download PDF for completion'
                  : outputResult.exportStrategy === 'filled_pdf'
                    ? 'Download filled PDF'
                    : 'Download confirmed derivative'}
              </Button>
            </div>
          )}

          {fillPackageResult && formState && (
            <div className="receipt-card">
              <div className="receipt-heading">
                <span>
                  <FileJson aria-hidden="true" />
                </span>
                <div>
                  <p className="section-kicker">Original PDF not modified</p>
                  <strong>Fill package receipt</strong>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Artifact</dt>
                  <dd>Original-untouched fill package</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    {shortHash(fillPackageResult.manifest.source.sourceHash)}
                  </dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>
                    {shortHash(
                      fillPackageResult.manifest.plan.planHash.replace(
                        /^sha256:/u,
                        '',
                      ),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{shortHash(fillPackageResult.outputHash)}</dd>
                </div>
                <div>
                  <dt>Staged fields</dt>
                  <dd>
                    {formatCount(
                      fillPackageResult.manifest.plan.stagedFields.length,
                      'reviewed field value',
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Original PDF modified</dt>
                  <dd>No</dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>JSON round-trip and source/plan binding verified</dd>
                </div>
                <div>
                  <dt>PDF field appearances</dt>
                  <dd>Not applicable; this artifact does not fill a PDF</dd>
                </div>
              </dl>
              <Button className="w-full" onClick={downloadFillPackage}>
                <Download aria-hidden="true" /> Download fill package (JSON)
              </Button>
            </div>
          )}
        </aside>
      </section>

      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => (open ? openReview('human') : closeReview())}
      >
        <DialogContent
          className="review-dialog"
          showCloseButton={!exporting && !reviewMutating}
        >
          <DialogHeader>
            <p className="section-kicker">UI approval and export gate</p>
            <DialogTitle>Review the exact plan</DialogTitle>
            <DialogDescription>
              Confirm, correct, or reject every proposed change, then confirm
              any human-only field and verify every field found through a
              non-authoritative discovery fallback. Approval is bound to this
              source hash, plan hash, and revision; any later change invalidates
              it.
            </DialogDescription>
          </DialogHeader>

          <div className="binding-strip">
            <span>
              Source <b>{shortHash(formState?.source.sourceHash)}</b>
            </span>
            <span>
              Plan{' '}
              <b>{shortHash(formState?.planHash.replace(/^sha256:/u, ''))}</b>
            </span>
            <span>
              Revision <b>v{formState?.stateVersion ?? 0}</b>
            </span>
          </div>

          <div className="review-dialog-body">
            {importedProposalNames.length > 0 && (
              <div className="dialog-safety-note">
                <FileJson aria-hidden="true" />
                <span>
                  This plan contains{' '}
                  {formatCount(
                    importedProposalNames.length,
                    'untrusted package proposal',
                  )}
                  . The exact source and recorded plan matched, but creator
                  identity was not verified. Confirm each value as if it were a
                  new external suggestion.
                </span>
              </div>
            )}

            <div>
              <p className="section-kicker">Choose the artifact yourself</p>
              <p className="button-note">
                WebMCP reports the permitted strategies but cannot select one or
                trigger export.
              </p>
            </div>
            <div className="review-checklist" aria-label="Artifact choice">
              {documentState?.inspection.protection.exportStrategies.map(
                (strategy) => {
                  const copy = exportStrategyCopy(strategy);
                  const createsPdf = strategy !== 'fill_package';
                  const unavailable =
                    createsPdf &&
                    (!validation?.canApprove || hasBlockedPdfContent);
                  const strategyId = `export-strategy-${strategy}`;
                  return (
                    <div className="review-check" key={strategy}>
                      <input
                        id={strategyId}
                        name="export-strategy"
                        type="radio"
                        checked={selectedExportStrategy === strategy}
                        onChange={() => {
                          setSelectedExportStrategy(strategy);
                          setActiveContentAcknowledged(false);
                          setProtectionLossAcknowledged(false);
                        }}
                        disabled={exporting || reviewMutating || unavailable}
                      />
                      <div className="review-check-copy">
                        <span className="review-check-heading">
                          <label htmlFor={strategyId}>
                            <strong>{copy.title}</strong>
                          </label>
                          <Badge variant="outline">
                            {strategy === 'confirmed_plain_derivative_pdf'
                              ? 'Explicit confirmation'
                              : strategy === 'fill_package'
                                ? 'No PDF rewrite'
                                : 'PDF output'}
                          </Badge>
                        </span>
                        <span className="human-only-note">
                          {copy.detail}
                          {unavailable
                            ? ' This PDF option is unavailable until its validation or native-action blockers are resolved.'
                            : ''}
                        </span>
                      </div>
                    </div>
                  );
                },
              )}
            </div>

            <div className="review-checklist">
              {reviewNames.map((fieldName, index) => {
                const field = formState?.fields[fieldName];
                const staged = formState?.draft[fieldName];
                const descriptor = descriptorByName.get(fieldName);
                const isMultiline = descriptor?.multiline === true;
                const choiceLabelReviewNotice = getChoiceLabelReviewNotice(
                  descriptor?.choices ?? [],
                );
                const checkboxId = `review-field-${index}`;
                const isHumanCompletion = !staged;
                const importedProposal = importedProposalSet.has(fieldName);
                const isHumanPinned =
                  staged?.actor === 'human' && !importedProposal;
                const requiresIdentityReview =
                  (staged?.identityReviewReasons?.length ?? 0) > 0;
                const canCorrect =
                  (staged?.actor === 'agent' || importedProposal) &&
                  field !== undefined &&
                  !field.readOnly &&
                  !field.humanOnly &&
                  field.type !== 'signature';
                const sourceIsBlank = isBlankValue(field?.sourceValue ?? null);
                const requiresHumanCompletion =
                  formState?.validation.issues.some(
                    (issue) =>
                      issue.fieldName === fieldName &&
                      issue.code === 'human_completion_required',
                  ) ?? false;
                const isRequiredMissing =
                  formState?.validation.issues.some(
                    (issue) =>
                      issue.fieldName === fieldName &&
                      issue.code === 'required_missing',
                  ) ?? false;
                return (
                  <div className="review-check" key={fieldName}>
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={confirmedFields.has(fieldName)}
                      onChange={(event) => {
                        setConfirmedFields((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(fieldName);
                          else next.delete(fieldName);
                          return next;
                        });
                      }}
                      disabled={exporting || reviewMutating}
                    />
                    <div className="review-check-copy">
                      <span className="review-check-heading">
                        <label htmlFor={checkboxId}>
                          <strong>
                            {requiresIdentityReview
                              ? `Verify field identity — ${field?.label ?? fieldName}`
                              : (field?.label ?? fieldName)}
                          </strong>
                        </label>
                        <Badge variant="outline">
                          {importedProposal
                            ? 'Imported · review required'
                            : isHumanPinned
                              ? 'Human correction · agent locked'
                              : requiresIdentityReview
                                ? 'Identity check required'
                                : isRequiredMissing
                                  ? 'Required field is blank'
                                  : isHumanCompletion
                                    ? requiresHumanCompletion
                                      ? 'Complete after export'
                                      : 'Preserved unchanged'
                                    : staged
                                      ? claimedBasisLabel(
                                          staged.provenance.kind,
                                        )
                                      : 'Agent proposal'}
                        </Badge>
                      </span>
                      {isHumanCompletion ? (
                        <span className="human-only-note">
                          {isRequiredMissing
                            ? fillPackageAvailable
                              ? 'This PDF marks the field as required and it is still blank. If you choose a fill package, confirm that it remains incomplete and complete the field manually.'
                              : 'This PDF marks the field as required and it is still blank. A PDF artifact cannot be exported until the field is completed.'
                            : requiresHumanCompletion
                              ? 'FormProof will not fill this field. Complete it personally in a trusted PDF reader.'
                              : sourceIsBlank
                                ? 'FormProof will preserve this blank field. Complete it personally in a trusted PDF reader if needed.'
                                : 'FormProof will preserve the existing value and will not rewrite this field.'}
                        </span>
                      ) : (
                        <span
                          className={`full-diff${isMultiline ? ' is-multiline' : ''}`}
                        >
                          <span>
                            <small>Before</small>
                            {formatValue(
                              field?.sourceValue ?? null,
                              descriptor?.choices,
                            )}
                          </span>
                          <ArrowRight aria-hidden="true" />
                          <span>
                            <small>After</small>
                            <b>
                              {formatValue(
                                staged?.value ?? null,
                                descriptor?.choices,
                              )}
                            </b>
                          </span>
                        </span>
                      )}
                      {requiresIdentityReview && (
                        <span className="human-only-note">
                          This candidate can be recalled by a non-authoritative
                          discovery hint. That hint is not the field label and
                          is not evidence. Open the untouched original PDF and
                          verify the displayed field at{' '}
                          {formatFieldLocation(descriptor)}
                          before checking this box.
                        </span>
                      )}
                      {choiceLabelReviewNotice && (
                        <span className="human-only-note">
                          {choiceLabelReviewNotice}
                        </span>
                      )}
                      {!isHumanCompletion && isRequiredMissing && (
                        <span className="human-only-note">
                          {fillPackageAvailable
                            ? 'This staged value leaves a PDF-required field blank. A fill package can be reviewed only as incomplete; complete the field manually.'
                            : 'This staged value leaves a PDF-required field blank. A PDF artifact cannot be exported until the field is completed.'}
                        </span>
                      )}
                      {staged?.provenance.rationale && (
                        <em>{staged.provenance.rationale}</em>
                      )}
                      {staged?.provenance.evidence && (
                        <div className="evidence-block">
                          <small>Evidence</small>
                          <ul className="evidence-list">
                            {staged.provenance.evidence
                              .slice(0, 5)
                              .map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                          </ul>
                          {staged.provenance.evidence.length > 5 && (
                            <small>
                              {formatCount(
                                staged.provenance.evidence.length - 5,
                                'additional evidence item',
                              )}{' '}
                              {staged.provenance.evidence.length - 5 === 1
                                ? 'was'
                                : 'were'}{' '}
                              omitted from this view.
                            </small>
                          )}
                        </div>
                      )}
                      {correctionFieldName === fieldName &&
                      canCorrect &&
                      staged &&
                      field ? (
                        <HumanCorrectionEditor
                          field={field}
                          choices={descriptor?.choices ?? []}
                          multiline={isMultiline}
                          initialValue={staged.value}
                          disabled={exporting || reviewMutating}
                          onCancel={() => setCorrectionFieldName(null)}
                          onSave={(value) =>
                            void correctProposal(fieldName, value)
                          }
                        />
                      ) : isHumanPinned ? (
                        <Button
                          type="button"
                          className="self-start"
                          variant="destructive"
                          size="xs"
                          onClick={() =>
                            void rejectProposals([fieldName], 'unlock')
                          }
                          disabled={exporting || reviewMutating}
                        >
                          Remove correction &amp; let agent suggest
                        </Button>
                      ) : staged ? (
                        <div className="flex flex-wrap gap-2">
                          {canCorrect && (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() => {
                                setCorrectionFieldName(fieldName);
                                setConfirmedFields((current) => {
                                  const next = new Set(current);
                                  next.delete(fieldName);
                                  return next;
                                });
                              }}
                              disabled={exporting || reviewMutating}
                            >
                              <Pencil aria-hidden="true" /> Correct value
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            onClick={() => void rejectProposals([fieldName])}
                            disabled={exporting || reviewMutating}
                          >
                            Reject proposal
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {requiresActiveContentAcknowledgment && (
                <div className="review-check">
                  <input
                    id="review-active-content"
                    type="checkbox"
                    checked={activeContentAcknowledged}
                    onChange={(event) =>
                      setActiveContentAcknowledged(event.target.checked)
                    }
                    disabled={exporting || reviewMutating}
                  />
                  <div className="review-check-copy">
                    <span className="review-check-heading">
                      <label htmlFor="review-active-content">
                        <strong>Unvalidated PDF behaviors</strong>
                      </label>
                      <Badge variant="outline">Source risk</Badge>
                    </span>
                    <span className="human-only-note">
                      Detected markers: {activeContentDescription}. Categories
                      can overlap. FormProof preserves these behaviors but does
                      not execute or validate them; the exported copy may run
                      them in another PDF reader. Continue only if you trust the
                      source.
                    </span>
                  </div>
                </div>
              )}
              {requiresProtectionLossAcknowledgment && (
                <div className="review-check">
                  <input
                    id="review-protection-loss"
                    type="checkbox"
                    checked={protectionLossAcknowledged}
                    onChange={(event) =>
                      setProtectionLossAcknowledged(event.target.checked)
                    }
                    disabled={exporting || reviewMutating}
                  />
                  <div className="review-check-copy">
                    <span className="review-check-heading">
                      <label htmlFor="review-protection-loss">
                        <strong>
                          Reader Extensions rights will be removed
                        </strong>
                      </label>
                      <Badge variant="outline">Required confirmation</Badge>
                    </span>
                    <span className="human-only-note">
                      I understand this creates an ordinary derivative PDF,
                      removes the recognized UR/UR3 rights entry, its signature
                      dictionary, and its declared CMS container. CMS integrity
                      and signer trust were not verified here; the original PDF
                      stays unchanged.
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="dialog-safety-note">
              {selectedExportStrategy === 'fill_package' ? (
                <FileJson aria-hidden="true" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              <span>
                {selectedExportStrategy === 'filled_pdf'
                  ? 'Filled PDF: the original bytes stay unchanged. A new PDF is reopened, its staged values are verified, and normal appearance streams are confirmed present. Visual rendering is not independently checked. Human-only fields remain untouched.'
                  : selectedExportStrategy === 'confirmed_plain_derivative_pdf'
                    ? 'Confirmed derivative: the original stays unchanged, but the new PDF intentionally loses its recognized Reader Extensions rights. No signature-preservation claim is made.'
                    : 'Original-untouched fill package: no PDF bytes are written. The JSON package is round-trip checked and bound to this source and plan; it is not a completed PDF form.'}
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const fieldNames = Object.keys(formState?.draft ?? {});
                if (discardAllArmed) {
                  void rejectProposals(fieldNames, 'discard_all');
                } else {
                  setDiscardAllArmed(true);
                }
              }}
              disabled={
                exporting ||
                reviewMutating ||
                Object.keys(formState?.draft ?? {}).length === 0
              }
            >
              <Trash2 aria-hidden="true" />{' '}
              {discardAllArmed
                ? `Confirm discard ${formatCount(Object.keys(formState?.draft ?? {}).length, 'staged value')}`
                : 'Discard all staged values'}
            </Button>
            <Button
              variant="outline"
              onClick={closeReview}
              disabled={exporting || reviewMutating}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void completeReview()}
              disabled={
                !allReviewFieldsConfirmed ||
                exporting ||
                reviewMutating ||
                correctionFieldName !== null ||
                selectedExportStrategy === null ||
                (selectedCreatesPdf &&
                  (!validation?.canApprove || hasBlockedPdfContent))
              }
            >
              {exporting ? (
                <>
                  <LoaderCircle className="spin" aria-hidden="true" />
                  Creating reviewed artifact…
                </>
              ) : (
                <>
                  {selectedExportStrategy === 'fill_package' ? (
                    <FileJson aria-hidden="true" />
                  ) : (
                    <FileCheck2 aria-hidden="true" />
                  )}
                  {selectedExportStrategy === 'filled_pdf'
                    ? 'Approve & create filled PDF'
                    : selectedExportStrategy ===
                        'confirmed_plain_derivative_pdf'
                      ? 'Confirm & create plain derivative'
                      : 'Create original-untouched fill package'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
