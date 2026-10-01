/**
 * Command-line diagnostics and account management.
 *
 *   dsh plugin --profile desktop exec dsh-workbuddy-xdpool <command>
 *
 * @module dsh-workbuddy-xdpool/bin
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultDesktopAuthDirs,
  parseWorkBuddyAuth,
  WORKBUDDY_LIVE_FILENAME,
  workbuddyAccountId,
} from './accounts.ts'
import { WORKBUDDY_APP_EXECUTABLE_ENV, workbuddyAppExecutableCandidates } from './at-rest.ts'
import { createCore } from './index.ts'
import { ignoreAccount, readIgnoredAccounts, unignoreAccount } from './ignored.ts'
import { formatRates, formatStatus } from './status.ts'
import {
  buildBundle,
  ensureDirFor,
  parseBundle,
  pickTransferSettings,
  readSettingsSnapshot,
  serializeBundle,
  writeBundleAccounts,
  writePendingSettings,
} from './transfer.ts'

/** Directory holding imported account snapshots. */
const ACCOUNT_DIR_NAME = '.workbuddy-xdpool'

/**
 * Assemble the runtime for a CLI command, with the ignore list applied.
 *
 * Every command goes through here rather than calling `createCore()` directly,
 * so a command can never accidentally act on an account the user has thrown out
 * — `checkin all` collecting a reward for a discarded account would be exactly
 * the kind of silent surprise the ignore feature exists to prevent.
 */
async function cliCore() {
  const core = createCore()
  const ignored = await readIgnoredAccounts()
  core.pool.applyIgnored(ignored.map(entry => entry.id))
  return core
}

/** Snapshot files are named by the md5 prefix of their key, so any key is safe. */
function snapshotPath(key: string, dir: string): string {
  return join(dir, `${createHash('md5').update(key).digest('hex').slice(0, 8)}.json`)
}

function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function accountDir(): string {
  return join(dshHome(), ACCOUNT_DIR_NAME)
}

function usage(): string {
  return [
    'dsh-workbuddy-xdpool — multi-account WorkBuddy provider for DeepSeek Harness',
    '',
    'Usage: dsh-workbuddy-xdpool <command> [options]',
    '',
    'Commands:',
    '  status              Account pool, credits, and shim state (add --credits, --json, --rates)',
    '  doctor              Diagnose discovery, cooldowns, and upstream reachability',
    '  accounts            List discovered accounts (add --json)',
    '  import <key>        Snapshot the current desktop login as <key> (add --force)',
    '  remove <key>        Delete one imported snapshot',
    '  export [file]       Write every account and setting to a bundle for another machine',
    '  transfer <file>     Import a bundle written by `export` on another machine',
    '  ignore <acct>       Drop an account from the pool for good (id or label)',
    '  unignore <acct>     Put an ignored account back into the pool',
    '  ignored             List the accounts dropped from the pool (add --json)',
    '  login               Guide for adding another account (desktop app is single-sign-in)',
    '  checkin [all|<acct>] Daily check-in: report status, or collect with `all` / a label',
    '  reset               Clear all rate-limit cooldowns immediately',
    '',
    'Options:',
    '  --json              Machine-readable output',
    '  --credits           Query remaining credits (read-only; does not consume)',
    '  --rates             Show per-model credit multipliers',
    '  --force             Overwrite an existing snapshot or bundle',
    '  --accounts-only     Export credentials without the settings block',
    '  --settings-only     Export settings without any credential',
  ].join('\n')
}

/** Live auth files, in probe order. */
function liveCandidates(): string[] {
  const fromEnv = process.env['WORKBUDDY_AUTH_FILE']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return [resolve(fromEnv.trim())]
  return defaultDesktopAuthDirs().map(dir => join(dir, WORKBUDDY_LIVE_FILENAME))
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function commandStatus(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const withCredits = args.includes('--credits')
  const withRates = args.includes('--rates')
  const core = await cliCore()
  const accounts = await core.pool.scan()

  const status = {
    ok: accounts.length > 0,
    accounts: accounts.map(account => {
      const now = Date.now()
      const modelCooling = Object.entries(account.modelCooldowns)
        .filter(([, until]) => until > now)
        .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }))
      return {
        id: account.id,
        label: account.label,
        domain: account.credential.domain,
        ...account.credential.expiresAtMs === 0
          ? {}
          : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
        cooling: account.cooldownUntilMs > now,
        ...modelCooling.length === 0 ? {} : { modelCooldowns: modelCooling },
        rateLimitHits: account.rateLimitHits,
        sourcePath: account.credential.sourcePath,
      }
    }),
    cooling: accounts.filter(account => account.cooldownUntilMs > Date.now()).length,
    models: core.catalogs.cn.current().map(model => ({ id: model.id, name: model.name, multiplier: model.multiplier })),
    shim: { running: false },
  }

  if (asJson) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    console.log(
      `WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling\n` +
        status.accounts
          .map(account => {
            const flag = account.cooling ? '⏸ ' : '▶ '
            const hits = account.rateLimitHits > 0 ? ` (hits ${account.rateLimitHits})` : ''
            const modelCooling = (account.modelCooldowns ?? [])
              .map(mc => `\n    model-cool: ${mc.modelId} until ${mc.until}`)
              .join('')
            return `${flag}${account.label}  [${account.domain || 'cn'}]${hits}\n    ${account.sourcePath}${modelCooling}`
          })
          .join('\n'),
    )
  }

  if (withRates) console.log(`\n${formatRates(status as never)}`)
  if (withCredits) {
    const first = accounts.find(account => account.cooldownUntilMs <= Date.now())
    if (first === undefined) {
      console.log('\nCredits: skipped (every account is cooling down)')
    } else {
      try {
        const credits = await core.client.fetchCredits(first.credential)
        console.log(`\nCredits for ${first.label}: ` + JSON.stringify(credits))
      } catch (error: unknown) {
        console.log(`\nCredits for ${first.label}: query failed — ${String(error).slice(0, 200)}`)
      }
    }
  }
  return status.ok ? 0 : 1
}

/**
 * Daily check-in from the terminal.
 *
 * `checkin` with no argument reports every account's status; `checkin all`
 * collects wherever a reward is still available, and `checkin <label>` targets
 * one account. A collection is never attempted twice for the same account on
 * the same day — the status is re-read first and an already-collected account
 * is reported as such.
 */
async function commandCheckin(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const target = args.find(arg => !arg.startsWith('--'))
  const core = await cliCore()
  const accounts = await core.pool.scan()
  if (accounts.length === 0) {
    console.error('No WorkBuddy account discovered. Sign in with the WorkBuddy desktop app first.')
    return 1
  }

  const wanted = target === undefined || target === 'all'
    ? core.pool.list()
    : core.pool.list().filter(account => account.label === target || account.id === target || account.id.startsWith(target))
  if (wanted.length === 0) {
    console.error(`No account matches "${target}". Run \`accounts\` to list labels.`)
    return 1
  }

  const rows: {
    label: string
    active: boolean
    alreadyCheckedIn: boolean
    streakDays: number
    claimed?: number
    error?: string
  }[] = []

  for (const account of wanted) {
    const row = { label: account.label, active: false, alreadyCheckedIn: false, streakDays: 0 } as typeof rows[number]
    try {
      const status = await core.client.fetchCheckinStatus(account.credential)
      row.active = status.active
      row.alreadyCheckedIn = status.todayCheckedIn
      row.streakDays = status.streakDays
      const shouldClaim = target !== undefined && status.active && !status.todayCheckedIn
      if (shouldClaim) {
        const claim = await core.client.claimDailyCheckin(account.credential)
        row.claimed = claim.credit
        row.streakDays = claim.streakDays
        row.alreadyCheckedIn = true
      }
    } catch (error: unknown) {
      row.error = String(error).slice(0, 200)
    }
    rows.push(row)
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return rows.every(row => row.error === undefined) ? 0 : 1
  }

  console.log('Daily check-in:')
  for (const row of rows) {
    if (row.error !== undefined) {
      console.log(`  ! ${row.label}: query failed — ${row.error}`)
      continue
    }
    if (!row.active) {
      console.log(`  – ${row.label}: no check-in activity`)
      continue
    }
    if (row.claimed !== undefined) {
      console.log(`  + ${row.label}: collected ${row.claimed} credit(s) (streak ${row.streakDays})`)
      continue
    }
    console.log(row.alreadyCheckedIn
      ? `  ✓ ${row.label}: already checked in today (streak ${row.streakDays})`
      : `  · ${row.label}: not checked in today — run \`checkin all\` to collect`)
  }
  if (target === undefined) console.log('\nAdd `all` (or an account label) to collect.')
  return rows.every(row => row.error === undefined) ? 0 : 1
}

async function commandDoctor(): Promise<number> {
  const lines: string[] = []
  let healthy = true

  lines.push(`dsh-workbuddy-xdpool doctor`)
  lines.push(`  platform : ${platform()}`)
  lines.push(`  dsh home : ${dshHome()}`)
  lines.push('')

  lines.push('Credential discovery:')
  for (const candidate of liveCandidates()) {
    const raw = await readJsonFile(candidate)
    // readJsonFile already parses; re-serialize so the parser sees text.
    const credential =
      raw === undefined ? undefined : parseWorkBuddyAuth(JSON.stringify(raw), candidate)
    lines.push(`  ${credential === undefined ? '✗' : '✓'} ${candidate}`)
  }

  const dirs = defaultDesktopAuthDirs()
  for (const dir of dirs) {
    const { readdir } = await import('node:fs/promises')
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      // A platform alternate that this machine does not use is not a fault.
      lines.push(`  - ${dir} (absent)`)
      continue
    }
    const snapshots = names.filter(name => name.startsWith('workbuddy-desktop.') && name.endsWith('.info'))
    lines.push(`  ✓ ${dir} → ${snapshots.length} snapshot(s)`)
  }

  lines.push('')
  const core = await cliCore()
  const accounts = await core.pool.scan()
  lines.push(`Accounts discovered: ${accounts.length}`)
  if (accounts.length === 0) {
    healthy = false
    lines.push('  ✗ none — sign in on the WorkBuddy desktop app, then run `import <key>`')
  }
  for (const account of accounts) {
    const state = account.cooldownUntilMs > Date.now() ? 'cooling' : 'ready'
    lines.push(`  ✓ ${account.label} (${state}, hits ${account.rateLimitHits})`)
  }

  lines.push('')
  lines.push(`Imported snapshots: ${accountDir()}`)
  const { readdir: readdir2 } = await import('node:fs/promises')
  let imported: string[] = []
  try {
    imported = (await readdir2(accountDir())).filter(name => name.endsWith('.json'))
  } catch {
    /* directory may not exist yet */
  }
  lines.push(imported.length === 0 ? '  (none)' : imported.map(name => `  ✓ ${name}`).join('\n'))

  // Desktop-app discovery. Printed verbatim, and that is the point: this is the
  // diagnostic for "the app is installed but the plugin cannot find it", and
  // the failure mode is usually a path that looks WRONG in a specific way — a
  // mojibake path from a non-UTF-8 console, a truncated one, or one pointing at
  // a directory that no longer exists. Showing the resolved strings (rather
  // than a count) is what makes those visible at a glance.
  lines.push('')
  lines.push('WorkBuddy desktop app:')
  const override = process.env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()
  if (override !== undefined && override !== '') {
    lines.push(`  env ${WORKBUDDY_APP_EXECUTABLE_ENV} = ${override}`)
  }
  let candidates: string[] = []
  try {
    candidates = workbuddyAppExecutableCandidates()
  } catch (error: unknown) {
    lines.push(`  ✗ candidate probe threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  let firstExisting: string | undefined
  for (const candidate of candidates) {
    const exists = existsSync(candidate)
    if (exists && firstExisting === undefined) firstExisting = candidate
    lines.push(`  ${exists ? '✓' : '·'} ${candidate}`)
  }
  lines.push(`  probed ${candidates.length} candidate path(s)`)
  if (firstExisting === undefined) {
    healthy = false
    lines.push(
      '  ✗ no WorkBuddy desktop executable found at any probed path.',
    )
    lines.push(
      '    If the app IS installed, set WORKBUDDY_APP_EXECUTABLE to its full .exe path',
    )
    lines.push(
      '    (or put that line in $DSH_HOME/.env) and restart DSH. A path shown above that',
    )
    lines.push(
      '    looks like mojibake (e.g. "???" for a Chinese folder) indicates the registry',
    )
    lines.push(
      '    value could not be decoded on this machine — please report it with the line.',
    )
  } else {
    lines.push(`  ✓ using ${firstExisting}`)
  }

  console.log(lines.join('\n'))
  return healthy ? 0 : 1
}

async function commandImport(args: string[]): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const key = positional[0]
  if (key === undefined) {
    console.error('usage: dsh-workbuddy-xdpool import <key> [--force]')
    return 2
  }
  const force = args.includes('--force')

  let source: string | undefined
  for (const candidate of liveCandidates()) {
    const raw = await readJsonFile(candidate)
    if (raw === undefined) continue
    if (parseWorkBuddyAuth(JSON.stringify(raw), candidate) !== undefined) {
      source = candidate
      break
    }
  }
  if (source === undefined) {
    console.error(
      'No signed-in WorkBuddy desktop session found. Sign in on the desktop app first\n' +
        `(looked in: ${liveCandidates().join(', ')})`,
    )
    return 1
  }

  const dir = accountDir()
  await mkdir(dir, { recursive: true })
  const target = snapshotPath(key, dir)

  const { access } = await import('node:fs/promises')
  let exists = false
  try {
    await access(target)
    exists = true
  } catch {
    /* not present */
  }
  if (exists && !force) {
    console.error(`Snapshot "${key}" already exists. Re-run with --force to overwrite.`)
    return 1
  }

  await copyFile(source, target)
  const text = await readFile(target, 'utf8')
  const credential = parseWorkBuddyAuth(text, target)
  const label =
    credential === undefined ? 'unknown' : (credential.nickname ?? 'WorkBuddy') + `#${workbuddyAccountId(credential).slice(0, 8)}`
  console.log(`Imported "${key}" → ${label}\n  saved: ${target}`)
  return 0
}

/**
 * Write every pooled account and the transferable settings to one bundle file.
 *
 * Credentials are written DECRYPTED. The desktop app seals its tokens with a key
 * derived from the installed build (5.6.0+, both platforms), so a verbatim copy
 * of its files would only open on a machine running that same build — and on any
 * other it would read as "not signed in" with no hint why. Plain values are the
 * shape pre-5.6.0 builds write and the shape `parseWorkBuddyAuth` accepts
 * everywhere, so the receiving machine needs no key of its own.
 *
 * Which also means the file IS the accounts: it is said out loud on every run
 * rather than left for the user to discover.
 */
async function commandExport(args: string[]): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const force = args.includes('--force')
  const accountsOnly = args.includes('--accounts-only')
  const settingsOnly = args.includes('--settings-only')
  if (accountsOnly && settingsOnly) {
    console.error('--accounts-only and --settings-only are mutually exclusive')
    return 2
  }

  const defaultName = `workbuddy-xdpool-${new Date().toISOString().slice(0, 10)}.json`
  const target = resolve(positional[0] ?? join(process.cwd(), defaultName))

  if (!force && existsSync(target)) {
    console.error(`"${target}" already exists. Re-run with --force to overwrite.`)
    return 1
  }

  const core = await cliCore()
  const accounts = settingsOnly ? [] : await core.pool.scan()
  if (!settingsOnly && accounts.length === 0) {
    console.error(
      'No WorkBuddy account discovered, so there is nothing to export.\n'
        + 'Sign in on the WorkBuddy desktop app first, then re-run.',
    )
    return 1
  }

  // The settings mirror is written by the host on every config apply. Absent
  // means the plugin has not run on this machine yet, which is reported rather
  // than silently exported as "no settings".
  const settings = accountsOnly ? undefined : await readSettingsSnapshot()
  if (!accountsOnly && settings === undefined) {
    console.log('Note: no settings mirror found (the plugin has not run here yet); exporting accounts only.')
  }

  const bundle = buildBundle({
    accounts: accounts.map(account => ({
      id: account.id,
      label: account.label,
      credential: account.credential,
    })),
    ...settings === undefined ? {} : { settings },
  })

  await ensureDirFor(target)
  await writeFile(target, serializeBundle(bundle), 'utf8')

  console.log(
    `Exported ${bundle.accounts.length} account(s)`
      + `${settings === undefined ? '' : ` and settings (${Object.keys(settings).join(', ')})`}\n`
      + `  saved: ${target}\n`
      + '\n'
      + '  This file holds every account\'s tokens in the clear — anyone who reads it\n'
      + '  holds those accounts. Move it directly to the other machine and delete it\n'
      + '  from anywhere it was copied through.',
  )
  return 0
}

/**
 * Import a bundle written by {@link commandExport} on another machine.
 *
 * Accounts land in the plugin's own data directory, which the pool scans
 * alongside the desktop app's. The app's files are never touched: the session
 * the user is actually signed in with must not be disturbed by an import.
 *
 * Settings are handed to the host through a small file rather than written here.
 * The settings document belongs to the host — it is layered, validated and
 * rewritten by it — and this process has no settings service, so a direct write
 * would race the host and could be reverted by its next save.
 */
async function commandTransfer(args: string[]): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const source = positional[0]
  if (source === undefined) {
    console.error('usage: dsh-workbuddy-xdpool transfer <file> [--json]')
    return 2
  }
  const asJson = args.includes('--json')

  let text: string
  try {
    text = await readFile(resolve(source), 'utf8')
  } catch (error: unknown) {
    console.error(`Cannot read "${source}": ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const parsed = parseBundle(text)
  if (!parsed.ok) {
    console.error(`"${source}" is not a usable bundle: ${parsed.error}`)
    return 1
  }
  const { bundle } = parsed

  const result = await writeBundleAccounts(bundle)
  const settings = bundle.settings === undefined ? undefined : pickTransferSettings(bundle.settings)
  const settingKeys = settings === undefined ? [] : Object.keys(settings)
  let pendingPath: string | undefined
  if (settings !== undefined && settingKeys.length > 0) {
    pendingPath = await writePendingSettings(settings)
  }

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      source: resolve(source),
      exportedAt: bundle.exportedAt,
      imported: result.imported.map(entry => ({ id: entry.id, label: entry.label })),
      skipped: result.skipped,
      settings: settingKeys,
    }, null, 2))
    return result.imported.length === 0 && result.skipped.length > 0 ? 1 : 0
  }

  console.log(`Imported ${result.imported.length} account(s) from ${resolve(source)}`)
  for (const entry of result.imported) console.log(`  + ${entry.label}`)
  for (const entry of result.skipped) console.log(`  ! ${entry.label}: ${entry.reason}`)

  if (pendingPath !== undefined) {
    console.log(
      `\nSettings carried by the bundle (${settingKeys.join(', ')}) were staged for the host.\n`
        + '  Restart DSH to apply them; they are written through the same settings path\n'
        + '  the card uses, so the model selection and automation survive the restart.',
    )
  }

  if (result.imported.length > 0) {
    console.log('\nRun `accounts` to confirm, or restart DSH to put them into rotation.')
  }
  return result.imported.length === 0 && result.skipped.length > 0 ? 1 : 0
}

async function commandRemove(args: string[]): Promise<number> {
  const key = args.filter(arg => !arg.startsWith('--'))[0]
  if (key === undefined) {
    console.error('usage: dsh-workbuddy-xdpool remove <key>')
    return 2
  }
  const target = snapshotPath(key, accountDir())
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(target)
    console.log(`Removed snapshot "${key}"`)
    return 0
  } catch {
    console.error(`No snapshot named "${key}"`)
    return 1
  }
}

/**
 * Throw one account out of the pool for good, or take it back.
 *
 * The target may be a full account id (as `accounts --json` prints it) or any
 * unambiguous fragment of the label, so the user does not have to copy a hash.
 * The id is what gets stored — a label can change when the account is renamed,
 * and an ignore list keyed by a mutable label would silently stop matching.
 */
async function commandIgnore(args: string[], ignored: boolean): Promise<number> {
  const verb = ignored ? 'ignore' : 'unignore'
  const target = args.filter(arg => !arg.startsWith('--'))[0]
  if (target === undefined) {
    console.error(`usage: dsh-workbuddy-xdpool ${verb} <account-id|label>`)
    return 2
  }

  const core = await cliCore()
  const accounts = await core.pool.scan()
  const current = await readIgnoredAccounts()

  if (!ignored) {
    // Restoring works off the IGNORE LIST, not the pool: an ignored account is
    // absent from `scan()` by definition, so looking it up there could never
    // find the one account the user wants back.
    const match = current.find(entry => entry.id === target)
      ?? current.find(entry => entry.label === target)
      ?? current.find(entry => entry.id.startsWith(target))
    if (match === undefined) {
      console.error(`No ignored account matches "${target}". Run \`ignored\` to list them.`)
      return 1
    }
    await unignoreAccount(match.id)
    console.log(`Restored ${match.label} (${match.id}). It rejoins the pool on the next scan.`)
    return 0
  }

  const matches = accounts.filter(account =>
    account.id === target
    || account.label === target
    || account.id.startsWith(target)
    || account.label.includes(target))
  if (matches.length === 0) {
    console.error(`No account matches "${target}". Run \`accounts\` to list them.`)
    return 1
  }
  if (matches.length > 1) {
    console.error(`"${target}" matches ${matches.length} accounts; use the full id:\n`
      + matches.map(account => `  ${account.id}  ${account.label}`).join('\n'))
    return 1
  }
  const account = matches[0]!
  await ignoreAccount({ id: account.id, label: account.label })
  console.log(
    `Ignored ${account.label} (${account.id}).\n`
    + '  Its credential is no longer read and it will not rejoin the pool, even if the\n'
    + '  desktop app signs it in again. Undo with: '
    + `dsh-workbuddy-xdpool unignore ${account.id}`,
  )
  return 0
}

/** List the accounts currently thrown out of the pool. */
async function commandIgnored(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const ignored = await readIgnoredAccounts()
  if (asJson) {
    console.log(JSON.stringify(ignored, null, 2))
    return 0
  }
  if (ignored.length === 0) {
    console.log('No accounts are ignored. Use `ignore <account-id|label>` to drop one.')
    return 0
  }
  console.log(ignored.map(entry => `⛔ ${entry.label}  (${entry.id})`).join('\n'))
  return 0
}

function commandLogin(): number {
  console.log(
    [
      'Adding another WorkBuddy account',
      '',
      'The WorkBuddy desktop app holds one signed-in account at a time, so each',
      'additional account is captured as a snapshot after you switch login:',
      '',
      '  1. Open the WorkBuddy desktop app and sign in (scan the QR code).',
      '  2. Run:  dsh plugin --profile desktop exec dsh-workbuddy-xdpool import <key>',
      '  3. Sign in with the next account in the desktop app.',
      '  4. Run the import command again with a different <key>.',
      '  5. Restart DSH Desktop; every imported account joins the rotation pool.',
      '',
      'Snapshots live in ' + accountDir() + ' and store the desktop app\'s tokens',
      'verbatim — protect that directory like a password.',
    ].join('\n'),
  )
  return 0
}

async function commandReset(): Promise<number> {
  const core = await cliCore()
  await core.pool.scan()
  core.pool.resetCooldowns()
  console.log('Cleared all rate-limit cooldowns.')
  return 0
}

async function commandAccounts(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const core = await cliCore()
  const accounts = await core.pool.scan()
  // Read the ignore list too. An ignored account is absent from `scan()` by
  // design, so without this line it would simply vanish from the output and the
  // user would have no way to tell "removed on purpose" from "not discovered".
  const ignored = await readIgnoredAccounts()
  if (asJson) {
    console.log(
      JSON.stringify(
        [
          ...accounts.map(account => ({
            id: account.id,
            label: account.label,
            cooling: account.cooldownUntilMs > Date.now(),
            rateLimitHits: account.rateLimitHits,
          })),
          ...ignored.map(entry => ({
            id: entry.id,
            label: entry.label,
            ignored: true,
            ignoredAt: entry.ignoredAt,
          })),
        ],
        null,
        2,
      ),
    )
  } else if (accounts.length === 0 && ignored.length === 0) {
    console.log('No imported accounts. Run `import <key>` after signing in on the desktop app.')
  } else {
    const lines = accounts.map(account => `${account.cooldownUntilMs > Date.now() ? '⏸' : '▶'} ${account.label}`)
    if (ignored.length > 0) {
      lines.push(...ignored.map(entry => `⛔ ${entry.label}  (removed; \`unignore ${entry.id}\` to restore)`))
    }
    console.log(lines.join('\n'))
  }
  return 0
}

/** Entry point; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(usage())
      return 0
    case 'status':
      return commandStatus(rest)
    case 'doctor':
      return commandDoctor()
    case 'accounts':
      return commandAccounts(rest)
    case 'import':
      return commandImport(rest)
    case 'export':
      return commandExport(rest)
    case 'transfer':
      return commandTransfer(rest)
    case 'remove':
      return commandRemove(rest)
    case 'ignore':
      return commandIgnore(rest, true)
    case 'unignore':
      return commandIgnore(rest, false)
    case 'ignored':
      return commandIgnored(rest)
    case 'login':
      return commandLogin()
    case 'logout':
      return commandRemove(['default', ...rest])
    case 'reset':
      return commandReset()
    case 'checkin':
      return commandCheckin(rest)
    default:
      console.error(`unknown command: ${command}\n\n${usage()}`)
      return 2
  }
}

/**
 * Run only when this module IS the process entry point.
 *
 * `package.json` declares `lib/bin.js` as the `dsh-workbuddy-xdpool` binary, so
 * the normal path is "node runs this file" and the guard is true. It exists so
 * the command table can also be IMPORTED — a test driving `main()` directly is
 * testing the real commands, whereas spawning a child process would test the
 * spawn — and without it the import would immediately execute a command with the
 * test runner's own argv and call `process.exit` on it.
 *
 * The comparison resolves symlinks on both sides because the binary is commonly
 * reached through one: this profile installs the plugin as a `link:` dependency,
 * and `process.argv[1]` then holds the real path while `import.meta.url` holds
 * the link.
 */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // Either path is unresolvable (a bundler-provided URL, a deleted file):
    // fall back to the raw comparison rather than silently skipping the command.
    return resolve(entry) === fileURLToPath(import.meta.url)
  }
}

if (isProcessEntryPoint()) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}

export { writeFile }
