'use client';

import {
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileCheck2,
  FileText,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
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
import {
  approveDraftFromUi,
  createFormState,
  exportApprovedPdfFromUi,
  getEffectiveFieldValue,
  getReleaseGate,
  stageFieldUpdates,
  validateDraft,
  type FieldUpdate,
  type FormFieldDefinition,
  type FormFieldValue,
  type FormState,
  type StateError,
} from '@/lib/form-state';
import type {
  ApplyResult,
  PdfFieldDescriptor,
  PdfInspection,
} from '@/lib/pdf-engine';
import {
  registerFormProofWebMcpTools,
  type FormProofAdapterFailure,
  type FormProofWebMcpAdapter,
  type FormProofWebMcpRegistration,
  type VersionBoundInput,
} from '@/lib/webmcp';

const DEMO_URL = '/demo-form.pdf';
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const HUMAN_ONLY_MARKER = /\[\s*HUMAN[_ -]?ONLY\s*\]/gi;

type ToolState =
  | { status: 'registering'; count: 0; message: string }
  | { status: 'ready'; count: number; message: string }
  | { status: 'unsupported'; count: 0; message: string }
  | { status: 'error'; count: 0; message: string };

interface LoadedDocument {
  fileName: string;
  sourceUrl: string;
  inspection: PdfInspection;
}

interface ReviewBinding {
  sourceHash: string;
  planHash: string;
  stateVersion: number;
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

function cleanLabel(field: PdfFieldDescriptor): string {
  const tooltip = field.tooltip?.replace(HUMAN_ONLY_MARKER, '').trim();
  if (!tooltip) return field.name;
  return tooltip.split(/\s+[–—-]\s+/u)[0]?.trim() || field.name;
}

function toStateType(field: PdfFieldDescriptor): FormFieldDefinition['type'] {
  if (field.type === 'option_list') return 'option-list';
  if (field.type === 'unsupported') return 'text';
  return field.type;
}

function toFieldDefinition(field: PdfFieldDescriptor): FormFieldDefinition {
  return {
    name: field.name,
    label: cleanLabel(field),
    type: toStateType(field),
    required: field.required,
    readOnly: field.readOnly || field.type === 'unsupported',
    humanOnly: field.humanOnly || field.type === 'unsupported',
    ...(field.type === 'dropdown' || field.type === 'option_list'
      ? { multiSelect: field.multiSelect }
      : {}),
    ...(field.options.length > 0 ? { options: [...field.options] } : {}),
    ...(field.maxLength === null ? {} : { maxLength: field.maxLength }),
    sourceValue: Array.isArray(field.current)
      ? [...field.current]
      : field.current,
  };
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
  if (input.expectedStateVersion !== state.stateVersion) {
    return adapterFailure(
      state,
      'stale_state',
      'The fill plan changed. Refresh form context before continuing.',
    );
  }
  if (input.expectedSourceHash !== state.source.sourceHash) {
    return adapterFailure(
      state,
      'source_mismatch',
      'The active PDF is not the document referenced by this request.',
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

function waitForVisibleCommit(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function outputFileName(sourceName: string): string {
  const stem = sourceName.replace(/\.pdf$/iu, '') || 'form';
  return `${stem}-formproof.pdf`;
}

export function FormProofWorkbench() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<FormState | null>(null);
  const inspectionRef = useRef<PdfInspection | null>(null);
  const sourceBytesRef = useRef<Uint8Array | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const outputUrlRef = useRef<string | null>(null);
  const reviewLockRef = useRef(false);
  const reviewBindingRef = useRef<ReviewBinding | null>(null);
  const pendingPlanMutationsRef = useRef(0);
  const loadingRef = useRef(true);
  const exportingRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const [formState, setFormState] = useState<FormState | null>(null);
  const [documentState, setDocumentState] = useState<LoadedDocument | null>(
    null,
  );
  const [outputResult, setOutputResult] = useState<ApplyResult | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmedFields, setConfirmedFields] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolState, setToolState] = useState<ToolState>({
    status: 'registering',
    count: 0,
    message: 'Registering WebMCP tools',
  });

  const commitState = useCallback((next: FormState) => {
    const binding = reviewBindingRef.current;
    if (
      reviewLockRef.current &&
      (!binding ||
        binding.sourceHash !== next.source.sourceHash ||
        binding.planHash !== next.planHash ||
        binding.stateVersion !== next.stateVersion)
    ) {
      reviewLockRef.current = false;
      reviewBindingRef.current = null;
      setReviewOpen(false);
      setConfirmedFields(new Set());
    }
    stateRef.current = next;
    setFormState(next);
  }, []);

  const closeReview = useCallback(() => {
    if (exportingRef.current) return;
    reviewLockRef.current = false;
    reviewBindingRef.current = null;
    setReviewOpen(false);
    setConfirmedFields(new Set());
  }, []);

  const openReview = useCallback(() => {
    const current = stateRef.current;
    if (
      pendingPlanMutationsRef.current > 0 ||
      loadingRef.current ||
      exportingRef.current
    ) {
      setError('Wait for the current form update to finish before review.');
      return false;
    }
    if (!current || Object.keys(current.draft).length === 0) {
      setError('Stage at least one field before starting review.');
      return false;
    }
    const validation = validateDraft(current);
    if (!validation.canApprove) {
      setError('Resolve the required-field blockers before review.');
      return false;
    }
    reviewLockRef.current = true;
    reviewBindingRef.current = {
      sourceHash: current.source.sourceHash,
      planHash: current.planHash,
      stateVersion: current.stateVersion,
    };
    setConfirmedFields(new Set());
    setError(null);
    setReviewOpen(true);
    return true;
  }, []);

  const resetOutput = useCallback(() => {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    outputUrlRef.current = null;
    setOutputUrl(null);
    setOutputResult(null);
    setShowOutput(false);
  }, []);

  const beginLoad = useCallback(() => {
    const generation = ++loadGenerationRef.current;
    loadingRef.current = true;
    reviewLockRef.current = false;
    reviewBindingRef.current = null;
    setLoading(true);
    setReviewOpen(false);
    setConfirmedFields(new Set());
    setError(null);
    setNotice(null);
    return generation;
  }, []);

  const loadSource = useCallback(
    async (fileName: string, bytes: Uint8Array, generation: number) => {
      try {
        if (bytes.byteLength > MAX_PDF_BYTES) {
          throw new Error(
            'Choose a PDF smaller than 15 MB for this browser demo.',
          );
        }

        const { inspectPdf } = await import('@/lib/pdf-engine');
        const inspection = await inspectPdf(bytes);
        const nextState = await createFormState(
          {
            fileName,
            sourceHash: inspection.sourceHash,
            byteLength: bytes.byteLength,
            pageCount: inspection.pageCount,
            loadedAt: new Date().toISOString(),
          },
          inspection.fields.map(toFieldDefinition),
        );

        if (!mountedRef.current || generation !== loadGenerationRef.current)
          return;
        const sourceUrl = URL.createObjectURL(
          new Blob([copyArrayBuffer(bytes)], { type: 'application/pdf' }),
        );
        if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
        sourceUrlRef.current = sourceUrl;
        sourceBytesRef.current = Uint8Array.from(bytes);
        inspectionRef.current = inspection;
        commitState(nextState);
        setDocumentState({ fileName, sourceUrl, inspection });
        resetOutput();
        reviewLockRef.current = false;
        reviewBindingRef.current = null;
        setReviewOpen(false);
        setConfirmedFields(new Set());
        setNotice(
          `${inspection.fieldCount} fields and ${inspection.widgetCount} widgets inspected locally.`,
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
    if (exportingRef.current) return;
    const generation = beginLoad();
    try {
      const response = await fetch(DEMO_URL);
      if (!response.ok)
        throw new Error('The built-in demo PDF could not be loaded.');
      await loadSource(
        'residential-support-intake.pdf',
        new Uint8Array(await response.arrayBuffer()),
        generation,
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

    const adapter: FormProofWebMcpAdapter = {
      getFormContext(input) {
        const current = stateRef.current;
        const inspection = inspectionRef.current;
        if (!current || !inspection) {
          return adapterFailure(
            null,
            'no_active_document',
            'Load a PDF before inspecting fields.',
          );
        }

        let offset = 0;
        if (input.cursor !== undefined) {
          const match = /^field:(\d+)$/u.exec(input.cursor);
          if (!match) {
            return adapterFailure(
              current,
              'invalid_input',
              'The field cursor is invalid.',
            );
          }
          offset = Number(match[1]);
          if (
            !Number.isSafeInteger(offset) ||
            offset > inspection.fields.length
          ) {
            return adapterFailure(
              current,
              'invalid_input',
              'The field cursor is out of range.',
            );
          }
        }

        const fields = inspection.fields
          .slice(offset, offset + input.limit)
          .map((field) => {
            const definition = current.fields[field.name];
            const staged = current.draft[field.name] ?? null;
            return {
              name: field.name,
              label: definition?.label ?? field.name,
              type: field.type,
              required: field.required,
              readOnly: field.readOnly,
              humanOnly: field.humanOnly,
              currentValue: field.current,
              stagedValue: staged?.value ?? null,
              options: field.options,
              choices: field.choices,
              multiSelect: field.multiSelect,
              maxLength: field.maxLength,
              page: field.page,
              rect: field.rect,
            };
          });
        const nextOffset = offset + fields.length;

        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          data: {
            document: {
              fileName: current.source.fileName,
              pageCount: current.source.pageCount,
              fieldCount: inspection.fieldCount,
              widgetCount: inspection.widgetCount,
            },
            binding: {
              stateVersion: current.stateVersion,
              sourceHash: current.source.sourceHash,
              planHash: current.planHash,
            },
            fields,
            validation: current.validation,
            approvalBoundary:
              'Only the visible human UI can approve or export.',
            pagination: {
              returned: fields.length,
              nextCursor:
                nextOffset < inspection.fields.length
                  ? `field:${nextOffset}`
                  : null,
            },
          },
        };
      },

      getFieldEvidence(input) {
        const current = stateRef.current;
        const inspection = inspectionRef.current;
        if (!current || !inspection) {
          return adapterFailure(
            null,
            'no_active_document',
            'Load a PDF before reading evidence.',
          );
        }
        const mismatch = bindingFailure(current, input);
        if (mismatch) return mismatch;

        const descriptors = new Map(
          inspection.fields.map((field) => [field.name, field]),
        );
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

        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          data: {
            fields: input.fieldNames.map((name) => {
              const definition = current.fields[name];
              const staged = current.draft[name] ?? null;
              const descriptor = descriptors.get(name);
              return {
                name,
                label: definition.label,
                sourceValue: definition.sourceValue,
                effectiveValue: getEffectiveFieldValue(current, name) ?? null,
                staged,
                page: descriptor?.page ?? null,
                rect: descriptor?.rect ?? null,
                tooltip: descriptor?.tooltip ?? null,
                constraints: {
                  type: definition.type,
                  required: definition.required,
                  readOnly: definition.readOnly,
                  humanOnly: definition.humanOnly,
                  maxLength: definition.maxLength ?? null,
                  options: definition.options ?? [],
                  multiSelect: definition.multiSelect ?? false,
                },
                untrustedPdfContent: true,
              };
            }),
          },
        };
      },

      stageFormValues(input, context) {
        pendingPlanMutationsRef.current += 1;
        return withMutationLock(async () => {
          if (context.signal.aborted)
            throw new DOMException('Aborted', 'AbortError');
          const current = stateRef.current;
          if (!current) {
            return adapterFailure(
              null,
              'no_active_document',
              'Load a PDF before staging values.',
            );
          }
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
              `${result.changedFields.length} proposed values staged. Nothing was written to the PDF.`,
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
          return adapterFailure(
            null,
            'no_active_document',
            'Load a PDF before validation.',
          );
        }
        const mismatch = bindingFailure(current, input);
        if (mismatch) return mismatch;
        const validation = validateDraft(current);
        return {
          ok: true,
          stateVersion: current.stateVersion,
          sourceHash: current.source.sourceHash,
          data: {
            valid:
              validation.canApprove && Object.keys(current.draft).length > 0,
            stagedFieldCount: Object.keys(current.draft).length,
            ...validation,
          },
        };
      },

      startFillReview(input) {
        const current = stateRef.current;
        if (!current) {
          return adapterFailure(
            null,
            'no_active_document',
            'Load a PDF before review.',
          );
        }
        const mismatch = bindingFailure(current, input);
        if (mismatch) return mismatch;
        if (
          Object.keys(current.draft).length === 0 ||
          !validateDraft(current).canApprove
        ) {
          return adapterFailure(
            current,
            'review_not_ready',
            'Stage a non-empty plan and resolve validation blockers first.',
          );
        }
        if (!openReview()) {
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
          data: {
            reviewOpened: true,
            planHash: current.planHash,
            humanActionRequired: true,
          },
        };
      },
    };

    void registerFormProofWebMcpTools(adapter, {
      awaitVisibleCommit: waitForVisibleCommit,
      onRegistrationError: () => {
        if (!cancelled) {
          setToolState({
            status: 'error',
            count: 0,
            message: 'WebMCP registration failed safely',
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
          message: `${registered.registeredTools.length} WebMCP tools ready`,
        });
      }
    });

    return () => {
      cancelled = true;
      registration?.cleanup();
    };
  }, [commitState, openReview, resetOutput]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    };
  }, []);

  const onFileChosen = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (exportingRef.current) {
        setError(
          'Wait for the verified export to finish before loading a PDF.',
        );
        return;
      }
      if (
        file.type !== 'application/pdf' &&
        !file.name.toLowerCase().endsWith('.pdf')
      ) {
        setError('Choose a PDF file.');
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

  const stageDemoPlan = async () => {
    const current = stateRef.current;
    if (!current || reviewLockRef.current) return;
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
    return [
      ...new Set([
        ...Object.keys(formState.draft),
        ...formState.validation.reviewFieldNames,
        ...Object.keys(formState.fields).filter((fieldName) => {
          const field = formState.fields[fieldName];
          return field.humanOnly || field.type === 'signature';
        }),
      ]),
    ].sort();
  }, [formState]);

  const allReviewFieldsConfirmed =
    reviewNames.length > 0 &&
    reviewNames.every((name) => confirmedFields.has(name));

  const approveAndExport = useCallback(async () => {
    if (exportingRef.current) return;
    const current = stateRef.current;
    const source = sourceBytesRef.current;
    const binding = reviewBindingRef.current;
    if (
      !current ||
      !source ||
      !binding ||
      !allReviewFieldsConfirmed ||
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
      return;
    }

    exportingRef.current = true;
    setExporting(true);
    setError(null);
    try {
      const approval = approveDraftFromUi(current, {
        expectedStateVersion: current.stateVersion,
        expectedSourceHash: current.source.sourceHash,
        expectedPlanHash: current.planHash,
        approvedBy: 'Local reviewer',
        confirmedFieldNames: reviewNames,
      });
      if (!approval.ok) {
        setError(approval.errors.map((item) => item.message).join(' '));
        return;
      }
      const exported = await exportApprovedPdfFromUi(approval.state, source);
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
      reviewLockRef.current = false;
      reviewBindingRef.current = null;
      commitState(exported.state);
      setShowOutput(true);
      setNotice(
        'Approved values were written to a fresh copy and reopened for verification.',
      );
      setReviewOpen(false);
      setConfirmedFields(new Set());
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : 'The approved PDF could not be exported.',
      );
    } finally {
      exportingRef.current = false;
      if (mountedRef.current) setExporting(false);
    }
  }, [allReviewFieldsConfirmed, commitState, reviewNames]);

  const downloadOutput = useCallback(() => {
    if (
      !outputUrl ||
      !documentState ||
      !formState ||
      !getReleaseGate(formState).open
    ) {
      return;
    }
    const link = window.document.createElement('a');
    link.href = outputUrl;
    link.download = outputFileName(documentState.fileName);
    link.click();
  }, [documentState, formState, outputUrl]);

  const draftEntries = formState ? Object.values(formState.draft) : [];
  const descriptorByName = useMemo(
    () =>
      new Map(
        documentState?.inspection.fields.map((field) => [field.name, field]) ??
          [],
      ),
    [documentState],
  );
  const releaseOpen = formState ? getReleaseGate(formState).open : false;
  const activePreviewUrl =
    showOutput && outputUrl ? outputUrl : documentState?.sourceUrl;
  const validation = formState ? validateDraft(formState) : null;

  const steps = [
    {
      label: 'Inspect form',
      detail: formState
        ? `${documentState?.inspection.fieldCount ?? 0} fields found`
        : 'Load a PDF',
      state: formState ? 'done' : 'active',
    },
    {
      label: 'Draft values',
      detail:
        draftEntries.length > 0
          ? `${draftEntries.length} values staged`
          : 'Waiting for agent',
      state: draftEntries.length > 0 ? 'done' : formState ? 'active' : 'idle',
    },
    {
      label: 'Review evidence',
      detail: formState?.approval ? 'Exact plan approved' : 'Human-only gate',
      state: formState?.approval
        ? 'done'
        : draftEntries.length > 0
          ? 'active'
          : 'idle',
    },
    {
      label: 'Verify & export',
      detail: releaseOpen ? 'Verified copy ready' : 'Locked',
      state: releaseOpen ? 'done' : formState?.approval ? 'active' : 'idle',
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
            <LockKeyhole aria-hidden="true" /> Stays in this browser
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
            <Sparkles aria-hidden="true" /> AcroForm safe mode
          </p>
          <h1 id="page-title">The agent drafts. You decide.</h1>
          <p>
            Fill real PDF forms with field-level evidence, a visible diff, and a
            human approval boundary the agent cannot cross.
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
          <Button
            variant="outline"
            size="lg"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload aria-hidden="true" /> Choose PDF
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

      <section
        id="workspace"
        className="workspace"
        aria-label="Form review workspace"
      >
        <aside className="flow-panel" aria-labelledby="flow-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Workflow</p>
              <h2 id="flow-title">One safe path</h2>
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
              <strong>Approval is not a tool</strong>
              <p>
                Only a click in this interface can approve the exact reviewed
                plan.
              </p>
            </div>
          </div>
        </aside>

        <article className="document-panel" aria-labelledby="document-title">
          <div className="document-toolbar">
            <div>
              <p className="section-kicker">
                {showOutput ? 'Verified output' : 'Untouched source'}
              </p>
              <h2 id="document-title">
                {documentState?.fileName ?? 'No PDF loaded'}
              </h2>
            </div>
            <div className="document-meta">
              {documentState && (
                <>
                  <span>{documentState.inspection.pageCount} pages</span>
                  <span>{documentState.inspection.fieldCount} fields</span>
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
                Verified output
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
              <div className="pdf-empty">
                <FileText aria-hidden="true" />
                <strong>
                  {loading
                    ? 'Inspecting the demo PDF…'
                    : 'Choose a fillable PDF'}
                </strong>
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
                  ? `${draftEntries.length} proposed changes`
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
                return (
                  <div className="draft-card" key={entry.fieldName}>
                    <div className="draft-card-heading">
                      <strong>{field?.label ?? entry.fieldName}</strong>
                      <Badge variant="outline">
                        {Math.round(entry.provenance.confidence * 100)}%
                      </Badge>
                    </div>
                    <div className="mini-diff">
                      <span>
                        {formatValue(
                          field?.sourceValue ?? null,
                          descriptor?.choices,
                        )}
                      </span>
                      <ArrowRight aria-hidden="true" />
                      <b>{formatValue(entry.value, descriptor?.choices)}</b>
                    </div>
                    <small>{entry.provenance.kind.replaceAll('_', ' ')}</small>
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
            <blockquote>
              “Inspect this form, stage my support details, and explain every
              source.”
            </blockquote>
          </div>

          {draftEntries.length === 0 ? (
            <Button
              className="w-full"
              size="lg"
              onClick={() => void stageDemoPlan()}
              disabled={!formState || loading}
            >
              Stage synthetic plan <ArrowRight aria-hidden="true" />
            </Button>
          ) : (
            <Button
              className="w-full"
              size="lg"
              onClick={openReview}
              disabled={!validation?.canApprove}
            >
              Review exact plan <ArrowRight aria-hidden="true" />
            </Button>
          )}
          <p className="button-note">
            {validation && validation.blockerCount > 0
              ? `${validation.blockerCount} validation blocker(s) remain.`
              : 'Approval and download exist only in this human interface.'}
          </p>

          {releaseOpen && formState?.approval && outputResult && (
            <div className="receipt-card">
              <div className="receipt-heading">
                <span>
                  <CheckCircle2 aria-hidden="true" />
                </span>
                <div>
                  <p className="section-kicker">Release gate open</p>
                  <strong>Verified export receipt</strong>
                </div>
              </div>
              <dl>
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
                  <dt>Verified</dt>
                  <dd>
                    {outputResult.verifiedFields.length} fields ·{' '}
                    {outputResult.widgetCount} widgets
                  </dd>
                </div>
              </dl>
              <Button className="w-full" onClick={downloadOutput}>
                <Download aria-hidden="true" /> Download verified copy
              </Button>
            </div>
          )}
        </aside>
      </section>

      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => (open ? openReview() : closeReview())}
      >
        <DialogContent className="review-dialog" showCloseButton={!exporting}>
          <DialogHeader>
            <p className="section-kicker">Human approval boundary</p>
            <DialogTitle>Review the exact plan</DialogTitle>
            <DialogDescription>
              Confirm every changed or human-only field. Approval is bound to
              this source hash, plan hash, and revision; any later change
              invalidates it.
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

          <div className="review-checklist">
            {reviewNames.map((fieldName) => {
              const field = formState?.fields[fieldName];
              const staged = formState?.draft[fieldName];
              const descriptor = descriptorByName.get(fieldName);
              const isHumanCompletion = !staged;
              const sourceIsBlank = isBlankValue(field?.sourceValue ?? null);
              const requiresHumanCompletion =
                formState?.validation.issues.some(
                  (issue) =>
                    issue.fieldName === fieldName &&
                    issue.code === 'human_completion_required',
                ) ?? false;
              return (
                <label className="review-check" key={fieldName}>
                  <input
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
                    disabled={exporting}
                  />
                  <div className="review-check-copy">
                    <span className="review-check-heading">
                      <strong>{field?.label ?? fieldName}</strong>
                      <Badge variant="outline">
                        {isHumanCompletion
                          ? requiresHumanCompletion
                            ? 'Complete after export'
                            : 'Preserved unchanged'
                          : staged.provenance.kind.replaceAll('_', ' ')}
                      </Badge>
                    </span>
                    {isHumanCompletion ? (
                      <span className="human-only-note">
                        {requiresHumanCompletion
                          ? 'FormProof will not fill this field. Complete it personally in a trusted PDF reader.'
                          : sourceIsBlank
                            ? 'FormProof will preserve this blank field. Complete it personally in a trusted PDF reader if needed.'
                            : 'FormProof will preserve the existing value and will not rewrite this field.'}
                      </span>
                    ) : (
                      <span className="full-diff">
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
                            {formatValue(staged.value, descriptor?.choices)}
                          </b>
                        </span>
                      </span>
                    )}
                    {staged?.provenance.rationale && (
                      <em>{staged.provenance.rationale}</em>
                    )}
                    {staged?.provenance.evidence && (
                      <div className="evidence-block">
                        <small>Evidence</small>
                        <ul className="evidence-list">
                          {staged.provenance.evidence.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          <div className="dialog-safety-note">
            <ShieldCheck aria-hidden="true" />
            <span>
              The original bytes stay unchanged. Export writes only this
              approved draft to a fresh copy, reopens it, and verifies values
              plus appearances.
            </span>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeReview}
              disabled={exporting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void approveAndExport()}
              disabled={!allReviewFieldsConfirmed || exporting}
            >
              {exporting ? (
                <>
                  <LoaderCircle className="spin" aria-hidden="true" />
                  Verifying fresh copy…
                </>
              ) : (
                <>
                  <FileCheck2 aria-hidden="true" />
                  Approve & create verified copy
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
