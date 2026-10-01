/**
 * Account and settings transfer between machines.
 *
 * The pool discovers accounts by scanning the desktop app's own auth directory,
 * so a second machine starts empty even when the same WorkBuddy accounts are
 * signed in elsewhere — and WorkBuddy's desktop app holds ONE signed-in account
 * at a time, which makes rebuilding a five-account pool a matter of five
 * sign-outs and five QR scans. This module packages the already-discovered
 * accounts into one file so the second machine skips all of it.
 *
 * Two decisions shape the format:
 *
 *  - **Tokens are exported DECRYPTED.** From 5.6.0 the desktop app seals
 *    `accessToken` / `refreshToken` into a `$wbEncrypted` envelope whose key is
 *    a build-time constant of the installed app (see `at-rest.ts`). Copying the
 *    raw file would therefore produce a bundle that only opens on a machine
 *    running the exact same build, and silently reads as "not signed in" on any
 *    other. Writing the plain values instead means the receiving machine needs
 *    no at-rest key at all: `parseWorkBuddyAuth` accepts plain strings, which is
 *    the shape pre-5.6.0 builds write.
 *
 *  - **The bundle is plaintext.** That is the user's explicit choice. It means
 *    the file is equivalent to a password list: anyone who reads it holds every
 *    pooled account. Nothing here hides that — the CLI says so on export and the
 *    card warns before downloading.
 *
 * @module dsh-workbuddy-xdpool/transfer
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseWorkBuddyAuth, type WorkBuddyCredential } from './accounts.ts'
import { pluginDataDir } from './ignored.ts'

/**
 * Format marker, checked on import.
 *
 * A bundle is a file the user may hand-edit or confuse with something else, so
 * the first thing import does is confirm it is looking at one. Without this a
 * JSON file of the wrong shape imports as "zero accounts" and reports success.
 */
export const BUNDLE_FORMAT = 'dsh-workbuddy-xdpool-bundle'

/** Bundle schema version. Import accepts only versions it understands. */
export const BUNDLE_VERSION = 1

/** File-name prefix for credentials written by an import. */
export const IMPORTED_FILE_PREFIX = 'workbuddy-xdpool-'

/**
 * One account inside a bundle.
 *
 * `id` and `label` are for the report the user reads; the credential itself is
 * `document`, deliberately shaped like a desktop auth file so the same parser
 * reads it and there is no second credential format to keep in step.
 */
export interface TransferAccount {
  /** Pool account id, as `accounts --json` prints it. */
  id: string
  /** Human label, so an import report is readable without a rescan. */
  label: string
  /** Plain (decrypted) auth document, readable by {@link parseWorkBuddyAuth}. */
  document: Record<string, unknown>
}

/**
 * The plugin settings a bundle carries.
 *
 * Only keys the user chose to travel: the model selection, how requests spread,
 * which accounts are switched off, the credit floors, and the automation switch.
 * The earnings and usage ledgers are deliberately absent — they are this
 * machine's history, and importing yesterday's counters into a fresh install
 * would claim rewards and traffic that never happened there.
 */
export interface TransferSettings {
  distribution?: string
  disabledAccountIds?: string[]
  creditReserves?: Record<string, number>
  /**
   * The per-region model selections and the automation block are carried as
   * opaque values on purpose.
   *
   * Their real shapes live in the settings schema (`ModelSelectionConfig`,
   * `AutomationConfig`), and restating them here would mean a second copy of
   * each that has to be kept in step. The host writes what it holds and
   * {@link pickTransferSettings} narrows whatever arrives from a file, which is
   * the only place an untrusted value can enter.
   */
  modelSelectionCn?: unknown
  modelSelectionGlobal?: unknown
  automation?: unknown
}

/** A parsed, validated bundle. */
export interface TransferBundle {
  format: string
  version: number
  /** When the source machine wrote it, ISO. */
  exportedAt: string
  /** Machine the bundle came from, for the import report. */
  source?: { platform: string; host?: string }
  accounts: TransferAccount[]
  settings?: TransferSettings
}

/**
 * Rebuild a desktop-shaped auth document from a parsed credential.
 *
 * Field names and nesting match what the desktop app writes, because the
 * receiving side parses this with the same `parseWorkBuddyAuth` the pool uses.
 * A bespoke shape would need its own parser, and two parsers for one concept is
 * how the import path quietly stops agreeing with the discovery path.
 */
export function credentialToDocument(credential: WorkBuddyCredential): Record<string, unknown> {
  return {
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAtMs,
      ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: credential.refreshExpiresAtMs },
      ...credential.lastRefreshAtMs === undefined ? {} : { lastRefreshTime: credential.lastRefreshAtMs },
      domain: credential.domain,
    },
    account: {
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      ...credential.uin === undefined ? {} : { uin: credential.uin },
      ...credential.uid === undefined ? {} : { uid: credential.uid },
      ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
    },
  }
}

/** Assemble a bundle from live pool accounts and the saved settings. */
export function buildBundle(input: {
  accounts: readonly { id: string; label: string; credential: WorkBuddyCredential }[]
  settings?: TransferSettings
  now?: Date
}): TransferBundle {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    source: { platform: process.platform, ...process.env['COMPUTERNAME'] === undefined
      ? {}
      : { host: process.env['COMPUTERNAME'] as string } },
    accounts: input.accounts.map(account => ({
      id: account.id,
      label: account.label,
      document: credentialToDocument(account.credential),
    })),
    ...input.settings === undefined ? {} : { settings: input.settings },
  }
}

/** Pretty-print a bundle for writing to disk. */
export function serializeBundle(bundle: TransferBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

/** Outcome of reading a bundle: the parsed value, or why it was refused. */
export type BundleParseResult =
  | { ok: true; bundle: TransferBundle }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate an untrusted bundle.
 *
 * Every failure returns a REASON rather than an empty bundle: importing a file
 * that turns out to be something else must not read as "0 accounts imported,
 * done", which is indistinguishable from a successful import of an empty pool
 * and sends the user looking for the fault in the wrong place.
 */
export function parseBundle(text: string): BundleParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'not a JSON object' }
  if (parsed['format'] !== BUNDLE_FORMAT) {
    return { ok: false, error: `not a ${BUNDLE_FORMAT} file` }
  }
  const version = parsed['version']
  if (version !== BUNDLE_VERSION) {
    return {
      ok: false,
      error: typeof version === 'number'
        ? `bundle version ${version} is not supported by this build (expected ${BUNDLE_VERSION})`
        : 'bundle carries no version',
    }
  }
  const rawAccounts = parsed['accounts']
  if (!Array.isArray(rawAccounts)) return { ok: false, error: 'bundle carries no accounts array' }

  const accounts: TransferAccount[] = []
  for (const [index, entry] of rawAccounts.entries()) {
    if (!isPlainObject(entry)) return { ok: false, error: `account ${index + 1} is not an object` }
    const document = entry['document']
    if (!isPlainObject(document)) return { ok: false, error: `account ${index + 1} carries no credential document` }
    const id = typeof entry['id'] === 'string' ? entry['id'] : ''
    accounts.push({
      id,
      label: typeof entry['label'] === 'string' && entry['label'] !== '' ? entry['label'] : (id || `account ${index + 1}`),
      document,
    })
  }

  const settings = parsed['settings']
  if (settings !== undefined && !isPlainObject(settings)) {
    return { ok: false, error: 'settings block is not an object' }
  }

  return {
    ok: true,
    bundle: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: typeof parsed['exportedAt'] === 'string' ? parsed['exportedAt'] : '',
      ...isPlainObject(parsed['source'])
        ? { source: parsed['source'] as TransferBundle['source'] }
        : {},
      accounts,
      ...settings === undefined ? {} : { settings: settings as TransferSettings },
    },
  }
}

/** One account an import refused, with the reason, so the report can say why. */
export interface TransferSkip {
  label: string
  reason: string
}

/** What an import did, for the CLI report and the card's confirmation. */
export interface TransferApplyResult {
  /** Accounts written to disk and readable by the pool. */
  imported: { id: string; label: string; file: string }[]
  /** Accounts the bundle carried but that could not be used. */
  skipped: TransferSkip[]
  /** Settings keys the caller applied; empty when the bundle carried none. */
  settingsApplied: string[]
}

/**
 * Absolute path of one imported account's credential file.
 *
 * Named after the pool's own account id, so re-importing the same bundle
 * overwrites the same file instead of growing a new copy each time — and so a
 * re-import is also the way to refresh a token that has since expired.
 *
 * The `workbuddy-desktop.info` name is deliberately NOT reused: that name means
 * "the app's live sign-in" to `compareFreshness`, which ranks a live file above
 * every other credential. An imported copy claiming to be live would outrank the
 * real session on the machine that actually has one.
 */
export function importedCredentialPath(accountId: string, dir: string = pluginDataDir()): string {
  return join(dir, `${IMPORTED_FILE_PREFIX}${accountId}.info`)
}

/**
 * Write a bundle's accounts into the plugin's own data directory.
 *
 * The directory is scanned by the pool alongside the desktop app's (see
 * `candidateAuthDirs`), so a written file joins the rotation on the next scan
 * without touching the app's own files — discovery stays read-only with respect
 * to the desktop app, which is what keeps an import from disturbing the session
 * the user is actually signed in with.
 *
 * Each document is parsed BEFORE it is written. A document that cannot produce a
 * credential — a refresh window that already closed, a missing access token —
 * is reported as skipped rather than written, because a file the pool cannot
 * read is a permanent "credential file could not be read" warning on the card
 * with nothing the user can do about it.
 */
export async function writeBundleAccounts(
  bundle: TransferBundle,
  dir: string = pluginDataDir(),
): Promise<TransferApplyResult> {
  const imported: TransferApplyResult['imported'] = []
  const skipped: TransferSkip[] = []
  if (bundle.accounts.length > 0) await mkdir(dir, { recursive: true })

  for (const account of bundle.accounts) {
    const path = importedCredentialPath(account.id, dir)
    let credential: WorkBuddyCredential | undefined
    try {
      credential = parseWorkBuddyAuth(JSON.stringify(account.document), path)
    } catch (error: unknown) {
      skipped.push({ label: account.label, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (credential === undefined) {
      skipped.push({
        label: account.label,
        reason: 'no usable access token (the refresh window may already have closed)',
      })
      continue
    }
    // Atomic, like every other document this plugin owns: a crash part-way
    // through a multi-account import must not leave a truncated file that reads
    // as a corrupt credential.
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(account.document, null, 2)}\n`, 'utf8')
    await rename(temp, path)
    imported.push({ id: account.id, label: account.label, file: path })
  }

  return { imported, skipped, settingsApplied: [] }
}

/** File holding settings a CLI import could not apply, for the host to pick up. */
export const PENDING_SETTINGS_FILE_NAME = 'pending-settings.json'

/** Absolute path of the pending-settings handoff file. */
export function pendingSettingsPath(dir: string = pluginDataDir()): string {
  return join(dir, PENDING_SETTINGS_FILE_NAME)
}

/**
 * Hand a bundle's settings to the running host.
 *
 * The CLI has no settings service: on this host line the plugin's settings live
 * in the profile's patch document, which the host owns and writes. Writing that
 * YAML from a short-lived CLI process would mean re-implementing the host's own
 * merge rules against a file it may be rewriting at the same moment.
 *
 * So the CLI leaves the block here and the host applies it through the same
 * settings path every other write uses, on its next start. The alternative —
 * importing accounts and silently dropping the settings — leaves the user with
 * half a transfer and no way to tell that the other half never happened.
 */
export async function writePendingSettings(
  settings: TransferSettings,
  dir: string = pluginDataDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = pendingSettingsPath(dir)
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temp, path)
  return path
}

/** Read the pending-settings handoff, or undefined when there is none. */
export async function readPendingSettings(
  dir: string = pluginDataDir(),
): Promise<TransferSettings | undefined> {
  let text: string
  try {
    text = await readFile(pendingSettingsPath(dir), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed as TransferSettings : undefined
  } catch {
    return undefined
  }
}

/** Remove the pending-settings handoff once it has been applied. */
export async function clearPendingSettings(dir: string = pluginDataDir()): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(pendingSettingsPath(dir))
  } catch {
    // Already gone: the handoff is consumed exactly once, so a missing file is
    // the normal case on every start after the first.
  }
}

/**
 * The settings keys a bundle may carry, in the order the report lists them.
 *
 * A fixed list rather than "whatever the file holds": the block arrives from an
 * untrusted file, and copying unknown keys into the settings document would let
 * a hand-edited bundle write arbitrary fields into the user's config.
 */
export const TRANSFER_SETTING_KEYS = [
  'distribution',
  'disabledAccountIds',
  'creditReserves',
  'modelSelectionCn',
  'modelSelectionGlobal',
  'automation',
] as const satisfies readonly (keyof TransferSettings)[]

/**
 * Narrow an untrusted settings block to the keys this plugin owns.
 *
 * Each value is also type-checked against what its schema accepts, so a
 * malformed field is dropped here rather than reaching the settings service and
 * failing validation there — which would surface as "the namespace refused to
 * register" rather than as "this one field was ignored".
 */
export function pickTransferSettings(raw: TransferSettings | Record<string, unknown>): TransferSettings {
  const source = raw as Record<string, unknown>
  const out: TransferSettings = {}
  const distribution = source['distribution']
  if (distribution === 'priority' || distribution === 'round-robin' || distribution === 'balanced') {
    out.distribution = distribution
  }
  const disabled = source['disabledAccountIds']
  if (Array.isArray(disabled) && disabled.every(entry => typeof entry === 'string')) {
    out.disabledAccountIds = disabled as string[]
  }
  const reserves = source['creditReserves']
  if (isPlainObject(reserves)) {
    const kept: Record<string, number> = {}
    for (const [id, value] of Object.entries(reserves)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) kept[id] = Math.floor(value)
    }
    out.creditReserves = kept
  }
  for (const key of ['modelSelectionCn', 'modelSelectionGlobal'] as const) {
    const value = source[key]
    if (isPlainObject(value)) out[key] = value
  }
  const automation = source['automation']
  if (isPlainObject(automation)) out.automation = automation
  return out
}

/** Ensure a directory exists before writing into it (used by the CLI). */
export async function ensureDirFor(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

/** File holding the host's mirror of the transferable settings, for the CLI. */
export const SETTINGS_SNAPSHOT_FILE_NAME = 'settings-snapshot.json'

/** Absolute path of the settings mirror. */
export function settingsSnapshotPath(dir: string = pluginDataDir()): string {
  return join(dir, SETTINGS_SNAPSHOT_FILE_NAME)
}

/**
 * Mirror the transferable settings to a file the CLI can read.
 *
 * The CLI runs as its own process with no settings service, and the settings
 * themselves live in the profile's own document — a YAML file the host owns,
 * rewrites, and resolves through its own patch layering. Re-parsing that from
 * the CLI would mean re-implementing the host's merge rules against a file it
 * may be rewriting at the same moment, and getting it subtly wrong would export
 * settings that do not match what is running.
 *
 * So the host, which already holds the resolved values, writes them here on
 * every config apply. `export` then reads one small JSON file whose shape it
 * owns. A stale mirror is not a hazard: it is rewritten whenever the settings
 * change, which is exactly when its content would otherwise go out of date.
 */
export async function writeSettingsSnapshot(
  settings: TransferSettings,
  dir: string = pluginDataDir(),
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const path = settingsSnapshotPath(dir)
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** Read the host's settings mirror; undefined when the host never wrote one. */
export async function readSettingsSnapshot(
  dir: string = pluginDataDir(),
): Promise<TransferSettings | undefined> {
  let text: string
  try {
    text = await readFile(settingsSnapshotPath(dir), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? pickTransferSettings(parsed) : undefined
  } catch {
    return undefined
  }
}
