import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_TOOLS = [
  'get_pdf_protection',
  'get_form_context',
  'get_field_evidence',
  'stage_form_values',
  'validate_fill_plan',
  'start_fill_review',
] as const;

interface CliOptions {
  url: string;
  outputDir: string;
  chromeChannel: string;
  timeoutMs: number;
}

interface ToolConfig {
  functionName: string;
}

interface ToolOutcome {
  success: boolean;
  result?: unknown;
  error?: string;
}

interface ToolRegistry {
  getCurrentTools(): ToolConfig[] | Promise<ToolConfig[]>;
  executeToolChecked(name: string, args?: object): Promise<ToolOutcome>;
}

interface BrowserPage {
  goto(
    url: string,
    options: { waitUntil: 'networkidle2'; timeout: number },
  ): Promise<unknown>;
  reload(options: {
    waitUntil: 'networkidle2';
    timeout: number;
  }): Promise<unknown>;
  evaluate<T>(callback: () => T): Promise<T>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  version(): Promise<string>;
  close(): Promise<void>;
}

interface BrowserModule {
  launchBrowser(channel?: string): Promise<BrowserInstance>;
  BrowserToolRegistry: new (page: BrowserPage) => ToolRegistry;
}

interface CheckResult {
  id: string;
  expected: unknown;
  actual: unknown;
  status: 'pass' | 'fail';
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    url: process.env.FORMPROOF_EVAL_URL ?? 'http://127.0.0.1:3000',
    outputDir: '.evals/browser-smoke',
    chromeChannel: process.env.FORMPROOF_CHROME_CHANNEL ?? 'chrome',
    timeoutMs: 30_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !['--url', '--output-dir', '--chrome-channel', '--timeout'].includes(
        name,
      ) ||
      value === undefined
    ) {
      throw new TypeError(`Unknown or incomplete argument: ${name}`);
    }
    index += 1;
    if (name === '--url') options.url = value;
    if (name === '--output-dir') options.outputDir = value;
    if (name === '--chrome-channel') options.chromeChannel = value;
    if (name === '--timeout') {
      const timeoutMs = Number(value);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError('--timeout must be a positive integer.');
      }
      options.timeoutMs = timeoutMs;
    }
  }

  const target = new URL(options.url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new TypeError('--url must use HTTP or HTTPS.');
  }
  return options;
}

function runProcess(
  command: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolveProcess({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseToolResponse(
  outcome: ToolOutcome,
  label: string,
): Record<string, unknown> {
  if (!outcome.success) {
    throw new Error(
      `${label} did not execute: ${outcome.error ?? 'unknown error'}`,
    );
  }
  let result = outcome.result;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result) as unknown;
    } catch {
      throw new TypeError(`${label} returned non-JSON text.`);
    }
  }
  if (!isRecord(result)) {
    throw new TypeError(`${label} did not return an object.`);
  }
  return result;
}

function recordCheck(
  checks: CheckResult[],
  id: string,
  expected: unknown,
  actual: unknown,
  passed: boolean,
): void {
  checks.push({ id, expected, actual, status: passed ? 'pass' : 'fail' });
}

async function waitForTools(
  registry: ToolRegistry,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let names: string[] = [];
  while (Date.now() < deadline) {
    names = (await registry.getCurrentTools()).map(
      ({ functionName }) => functionName,
    );
    if (EXPECTED_TOOLS.every((name) => names.includes(name))) return names;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return names;
}

async function waitForProtection(
  registry: ToolRegistry,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let response: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    response = parseToolResponse(
      await registry.executeToolChecked('get_pdf_protection', {}),
      'get_pdf_protection',
    );
    if (response.ok === true) return response;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `The demo PDF did not become available: ${JSON.stringify(response)}`,
  );
}

function consentCode(response: Record<string, unknown>): unknown {
  return isRecord(response.error) ? response.error.code : undefined;
}

function sameBinding(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    left.stateVersion === right.stateVersion &&
    left.sourceHash === right.sourceHash &&
    left.documentSessionId === right.documentSessionId
  );
}

async function runDetailedProbe(
  options: CliOptions,
  outputDir: string,
): Promise<{
  checks: CheckResult[];
  browserVersion: string | null;
  error?: string;
}> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('webmcp-evals/package.json');
  const modulePath = join(
    dirname(packagePath),
    'dist',
    'evaluator',
    'browser.js',
  );
  const browserModule = (await import(
    pathToFileURL(modulePath).href
  )) as unknown as BrowserModule;
  const checks: CheckResult[] = [];
  let browser: BrowserInstance | undefined;
  let page: BrowserPage | undefined;

  try {
    browser = await browserModule.launchBrowser(options.chromeChannel);
    page = await browser.newPage();
    await page.goto(options.url, {
      waitUntil: 'networkidle2',
      timeout: options.timeoutMs,
    });
    let registry = new browserModule.BrowserToolRegistry(page);
    const initialNames = await waitForTools(registry, options.timeoutMs);
    const sortedNames = [...initialNames].sort();
    const sortedExpected = [...EXPECTED_TOOLS].sort();
    recordCheck(
      checks,
      'tools.exact-registration',
      sortedExpected,
      sortedNames,
      JSON.stringify(sortedNames) === JSON.stringify(sortedExpected),
    );
    recordCheck(
      checks,
      'tools.no-duplicates',
      EXPECTED_TOOLS.length,
      new Set(initialNames).size,
      initialNames.length === new Set(initialNames).size,
    );

    const before = await waitForProtection(registry, options.timeoutMs);
    recordCheck(checks, 'consent.protection-readable', true, before.ok, true);
    recordCheck(
      checks,
      'session.initial-version',
      0,
      before.stateVersion,
      before.stateVersion === 0,
    );

    const context = parseToolResponse(
      await registry.executeToolChecked('get_form_context', {}),
      'get_form_context',
    );
    recordCheck(
      checks,
      'consent.field-read-denied',
      'CONSENT_REQUIRED',
      consentCode(context),
      context.ok === false && consentCode(context) === 'CONSENT_REQUIRED',
    );

    const stage = parseToolResponse(
      await registry.executeToolChecked('stage_form_values', {
        expectedDocumentSessionId: before.documentSessionId,
        expectedStateVersion: before.stateVersion,
        expectedSourceHash: before.sourceHash,
        updates: [
          {
            fieldName: 'frm.q7f1',
            value: 'Avery Chen',
            provenance: {
              kind: 'user_instruction',
              confidence: 1,
              evidence: ['Synthetic Browser smoke value.'],
            },
          },
        ],
      }),
      'stage_form_values',
    );
    recordCheck(
      checks,
      'consent.mutation-denied',
      'CONSENT_REQUIRED',
      consentCode(stage),
      stage.ok === false && consentCode(stage) === 'CONSENT_REQUIRED',
    );

    const after = await waitForProtection(registry, options.timeoutMs);
    recordCheck(
      checks,
      'state.failed-calls-are-stable',
      {
        stateVersion: before.stateVersion,
        sourceHash: before.sourceHash,
        documentSessionId: before.documentSessionId,
      },
      {
        stateVersion: after.stateVersion,
        sourceHash: after.sourceHash,
        documentSessionId: after.documentSessionId,
      },
      sameBinding(before, after),
    );

    const uiBeforeReload = await page.evaluate(() => ({
      revision:
        document.querySelector('.revision')?.textContent?.trim() ?? null,
      hasEmptyQueue: document.body.innerText.includes('No draft yet'),
      toolStatus:
        Array.from(document.querySelectorAll('*'))
          .map((element) => element.textContent?.trim())
          .find((text) => text === '6 WebMCP tools ready') ?? null,
    }));
    recordCheck(
      checks,
      'ui.failed-calls-are-inert',
      {
        revision: 'v0',
        hasEmptyQueue: true,
        toolStatus: '6 WebMCP tools ready',
      },
      uiBeforeReload,
      uiBeforeReload.revision === 'v0' &&
        uiBeforeReload.hasEmptyQueue &&
        uiBeforeReload.toolStatus === '6 WebMCP tools ready',
    );
    await page.screenshot({
      path: join(outputDir, 'page.png'),
      fullPage: true,
    });

    await page.reload({
      waitUntil: 'networkidle2',
      timeout: options.timeoutMs,
    });
    registry = new browserModule.BrowserToolRegistry(page);
    const reloadNames = await waitForTools(registry, options.timeoutMs);
    const reloadProtection = await waitForProtection(
      registry,
      options.timeoutMs,
    );
    recordCheck(
      checks,
      'reload.exact-registration',
      sortedExpected,
      [...reloadNames].sort(),
      JSON.stringify([...reloadNames].sort()) ===
        JSON.stringify(sortedExpected),
    );
    recordCheck(
      checks,
      'reload.session-reset',
      { stateVersion: 0, documentSessionIdChanged: true },
      {
        stateVersion: reloadProtection.stateVersion,
        documentSessionIdChanged:
          reloadProtection.documentSessionId !== before.documentSessionId,
      },
      reloadProtection.stateVersion === 0 &&
        reloadProtection.documentSessionId !== before.documentSessionId,
    );
    const reloadContext = parseToolResponse(
      await registry.executeToolChecked('get_form_context', {}),
      'get_form_context after reload',
    );
    recordCheck(
      checks,
      'reload.consent-reset',
      'CONSENT_REQUIRED',
      consentCode(reloadContext),
      reloadContext.ok === false &&
        consentCode(reloadContext) === 'CONSENT_REQUIRED',
    );

    return {
      checks,
      browserVersion: await browser.version(),
    };
  } catch (error) {
    return {
      checks,
      browserVersion: browser
        ? await browser.version().catch(() => null)
        : null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderHtml(
  report: Record<string, unknown>,
  checks: CheckResult[],
): string {
  const rows = checks
    .map(
      (check) =>
        `<tr><td>${escapeHtml(check.id)}</td><td>${escapeHtml(
          check.status.toUpperCase(),
        )}</td><td><code>${escapeHtml(JSON.stringify(check.expected))}</code></td><td><code>${escapeHtml(
          JSON.stringify(check.actual),
        )}</code></td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FormProof Browser smoke</title>
<style>body{font:14px system-ui;margin:32px;color:#17212b}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3d8;padding:8px;text-align:left;vertical-align:top}th{background:#eef3f4}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}.pass{color:#087b68}.fail{color:#b42318}</style></head>
<body><h1>FormProof Browser smoke</h1><p class="${report.status === 'pass' ? 'pass' : 'fail'}">Overall: ${escapeHtml(String(report.status).toUpperCase())}</p>
<p>Target: <code>${escapeHtml(report.targetUrl)}</code><br>Commit: <code>${escapeHtml(report.evaluatedCommit)}</code><br>Browser: <code>${escapeHtml(report.browserVersion)}</code></p>
<table><thead><tr><th>Check</th><th>Status</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Upstream webmcp-evals smoke</h2><pre>${escapeHtml(report.upstreamTranscript)}</pre></body></html>\n`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('webmcp-evals/package.json');
  const cliPath = join(dirname(packagePath), 'dist', 'bin', 'webmcp-evals.js');
  const evalPath = resolve(
    fileURLToPath(
      new URL('../evals/formproof-browser-smoke.json', import.meta.url),
    ),
  );
  const upstream = await runProcess(process.execPath, [
    cliPath,
    '--chrome-channel',
    options.chromeChannel,
    'smoke',
    '--url',
    options.url,
    '--evals',
    evalPath,
    '--timeout',
    String(options.timeoutMs),
    '--verbose',
  ]);
  await writeFile(
    join(outputDir, 'upstream.log'),
    `${upstream.stdout}${upstream.stderr}`,
    'utf8',
  );

  const probe = await runDetailedProbe(options, outputDir);
  const failedChecks = probe.checks.filter(({ status }) => status === 'fail');
  const passed =
    upstream.exitCode === 0 &&
    probe.error === undefined &&
    failedChecks.length === 0;
  const report = {
    schemaVersion: 1,
    suiteId: 'formproof-browser-smoke-v1',
    generatedAt: new Date().toISOString(),
    evaluatedCommit: process.env.GITHUB_SHA ?? 'local-unbound',
    targetUrl: options.url,
    chromeChannel: options.chromeChannel,
    browserVersion: probe.browserVersion,
    status: passed ? 'pass' : 'fail',
    upstreamExitCode: upstream.exitCode,
    upstreamTranscript: `${upstream.stdout}${upstream.stderr}`,
    probeError: probe.error ?? null,
    checks: probe.checks,
  };
  await writeFile(
    join(outputDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(outputDir, 'report.html'),
    renderHtml(report, probe.checks),
    'utf8',
  );
  if (!passed) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
