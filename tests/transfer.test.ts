/**
 * Machine-to-machine transfer: one bundle carrying every account and the
 * transferable settings.
 *
 * The format is the contract between two installs, so what these tests pin down
 * is that contract rather than the code that happens to implement it:
 *
 *  - a bundle written on one machine must parse into a credential that
 *    authenticates on the other, which is why the round trip goes through the
 *    REAL `parseWorkBuddyAuth` and the REAL pool rather than a stub;
 *  - credentials must leave DECRYPTED, because the desktop app's own files are
 *    sealed with a key derived from the installed build and a verbatim copy
 *    would only open on the machine that produced it;
 *  - an imported file must actually be discovered, which is the failure this
 *    feature exists to avoid — a bundle that writes files the pool never reads
 *    reports success while changing nothing.
 */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool, candidateAuthDirs, parseWorkBuddyAuth } from '../src/accounts.ts'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  IMPORTED_FILE_PREFIX,
  buildBundle,
  credentialToDocument,
  importedCredentialPath,
  parseBundle,
  pickTransferSettings,
  readPendingSettings,
  readSettingsSnapshot,
  serializeBundle,
  writeBundleAccounts,
  writePendingSettings,
  writeSettingsSnapshot,
} from '../src/transfer.ts'

/** A desktop-shaped auth document for one fake account. */
function authDocument(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now()
  return {
    auth: {
      accessToken: `access-token-${index}-${'a'.repeat(40)}`,
      refreshToken: `refresh-token-${index}-${'b'.repeat(40)}`,
      expiresAt: now + 3_600_000,
      refreshExpiresAt: now + 30 * 24 * 3_600_000,
      lastRefreshTime: now - 60_000,
      domain: '',
      ...overrides,
    },
    account: {
      uin: `1000000000${index}`,
      uid: `uid-${index}-${'0'.repeat(24)}`,
      nickname: `Account${index}`,
    },
  }
}

/** Write `count` accounts into a fresh directory, as the desktop app would. */
async function writeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-auth-'))
  for (let index = 0; index < count; index += 1) {
    const name = index === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.r.${index}.uuid.info`
    await writeFile(join(dir, name), JSON.stringify(authDocument(index)), 'utf8')
  }
  return dir
}

/** A bundle built from `count` real, parsed credentials. */
async function bundleWith(count: number, settings?: Record<string, unknown>) {
  const dir = await writeAuthDir(count)
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], logger: { warn() {} } })
  const accounts = await pool.scan()
  return buildBundle({
    accounts: accounts.map(account => ({
      id: account.id,
      label: account.label,
      credential: account.credential,
    })),
    ...settings === undefined ? {} : { settings: settings as never },
  })
}

describe('transfer bundle', () => {
  it('round-trips credentials through a file', async () => {
    const bundle = await bundleWith(3)
    const text = serializeBundle(bundle)

    const parsed = parseBundle(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.accounts).toHaveLength(3)

    // Every document must still produce a credential after the file round trip.
    for (const account of parsed.bundle.accounts) {
      const credential = parseWorkBuddyAuth(JSON.stringify(account.document), 'bundle')
      expect(credential, account.label).toBeDefined()
      expect(credential?.accessToken).toContain('access-token-')
      expect(credential?.nickname).toMatch(/^Account\d$/)
    }
  })

  it('carries the format marker and version', async () => {
    const bundle = await bundleWith(1)
    expect(bundle.format).toBe(BUNDLE_FORMAT)
    expect(bundle.version).toBe(BUNDLE_VERSION)
    expect(bundle.exportedAt).not.toBe('')
  })

  it('writes plain tokens, never the desktop app encrypted envelope', async () => {
    // The desktop app seals tokens as `{$wbEncrypted:1,envelope}` from 5.6.0, and
    // the key is a build-time constant of THAT install. A bundle carrying the
    // envelope would therefore only open on the machine that produced it.
    const bundle = await bundleWith(1)
    const text = serializeBundle(bundle)
    expect(text).not.toContain('$wbEncrypted')
    const auth = bundle.accounts[0]!.document['auth'] as Record<string, unknown>
    expect(typeof auth['accessToken']).toBe('string')
    expect(typeof auth['refreshToken']).toBe('string')
  })

  it('refuses a file that is not a bundle, with a reason', () => {
    const cases: [string, string][] = [
      ['not json at all', 'not valid JSON'],
      ['[]', 'not a JSON object'],
      ['{"hello":"world"}', 'not a'],
      [`{"format":"${BUNDLE_FORMAT}"}`, 'version'],
      [`{"format":"${BUNDLE_FORMAT}","version":99}`, 'not supported'],
      [`{"format":"${BUNDLE_FORMAT}","version":${BUNDLE_VERSION}}`, 'accounts'],
    ]
    for (const [text, expected] of cases) {
      const parsed = parseBundle(text)
      expect(parsed.ok, text).toBe(false)
      if (parsed.ok) continue
      expect(parsed.error).toContain(expected)
    }
  })

  it('refuses an account entry whose credential is not an object', () => {
    const parsed = parseBundle(JSON.stringify({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      accounts: [{ id: 'x', label: 'X', document: 'not-an-object' }],
    }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('credential document')
  })

  it('keeps an account whose refresh window has closed out of the pool', async () => {
    // A bundle is a point-in-time capture, so one of its accounts can easily be
    // stale. Writing it anyway would leave a file the pool can never read, which
    // the card then reports as an unreadable credential forever.
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-stale-'))
    const bundle = buildBundle({
      accounts: [{
        id: 'stale-account',
        label: 'Stale',
        credential: {
          accessToken: 'token',
          refreshToken: 'refresh',
          expiresAtMs: Date.now() - 1000,
          // Already past: the parser refuses the document outright.
          refreshExpiresAtMs: Date.now() - 60_000,
          domain: '',
          sourcePath: 'test',
        },
      }],
    })
    const result = await writeBundleAccounts(bundle, dir)
    expect(result.imported).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('refresh window')
    // And nothing was written, so the pool has no unreadable file to report.
    expect(await readdir(dir)).toHaveLength(0)
  })
})

describe('imported credentials join the pool', () => {
  it('discovers an imported account from the plugin data directory alone', async () => {
    // This is the whole point of the feature: a second machine has no desktop
    // sign-in at all, so the imported files are the ONLY source of accounts.
    const source = await writeAuthDir(2)
    const sourcePool = new WorkBuddyAccountPool({ authDirs: [source], logger: { warn() {} } })
    const accounts = await sourcePool.scan()
    const bundle = buildBundle({
      accounts: accounts.map(account => ({
        id: account.id,
        label: account.label,
        credential: account.credential,
      })),
    })

    const fresh = await mkdtemp(join(tmpdir(), 'wbx-transfer-fresh-'))
    const result = await writeBundleAccounts(bundle, fresh)
    expect(result.imported).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)

    // A pool that scans ONLY that directory — no desktop app present.
    const receiving = new WorkBuddyAccountPool({ authDirs: [fresh], logger: { warn() {} } })
    const discovered = await receiving.scan()
    expect(discovered).toHaveLength(2)
    expect(discovered.map(account => account.credential.accessToken).sort())
      .toEqual(accounts.map(account => account.credential.accessToken).sort())
  })

  it('includes the plugin data directory in the default scan', () => {
    const dirs = candidateAuthDirs({ DSH_HOME: 'C:\\dsh-home' } as NodeJS.ProcessEnv)
    expect(dirs.some(dir => dir.includes('.workbuddy-xdpool'))).toBe(true)
  })

  it('scans the desktop app directories BEFORE the plugin data directory', () => {
    // Order matters: `compareFreshness` ranks the live file first, and the
    // desktop app's own sign-in must win against an imported copy of the same
    // account — the copy is a capture, never the session in use.
    const dirs = candidateAuthDirs({ DSH_HOME: 'C:\\dsh-home' } as NodeJS.ProcessEnv)
    const pluginIndex = dirs.findIndex(dir => dir.includes('.workbuddy-xdpool'))
    expect(pluginIndex).toBe(dirs.length - 1)
  })

  it('names each imported file after the account id, so a re-import overwrites', async () => {
    const bundle = await bundleWith(1)
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-name-'))
    const first = await writeBundleAccounts(bundle, dir)
    const second = await writeBundleAccounts(bundle, dir)
    expect(first.imported[0]?.file).toBe(second.imported[0]?.file)
    expect(first.imported[0]?.file).toBe(importedCredentialPath(bundle.accounts[0]!.id, dir))
    expect((await readdir(dir)).filter(name => name.endsWith('.info'))).toHaveLength(1)
  })

  it('does not name an imported file as the desktop app live sign-in', async () => {
    // `compareFreshness` treats a file literally named `workbuddy-desktop.info`
    // as the app's live session and ranks it above everything else. An imported
    // copy carrying that name would outrank the real sign-in on a machine that
    // has one.
    const bundle = await bundleWith(1)
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-live-'))
    const result = await writeBundleAccounts(bundle, dir)
    const name = result.imported[0]!.file.split(/[\\/]/u).pop() ?? ''
    expect(name.startsWith(IMPORTED_FILE_PREFIX)).toBe(true)
    expect(name).not.toBe('workbuddy-desktop.info')
  })

  it('prefers the desktop app live sign-in over an imported copy of it', async () => {
    // The behavioural half of the naming rule above: with both present, the pool
    // must serve the token the app is actually using.
    const live = await writeAuthDir(1)
    const liveText = await readFile(join(live, 'workbuddy-desktop.info'), 'utf8')
    const liveCredential = parseWorkBuddyAuth(liveText, join(live, 'workbuddy-desktop.info'))
    expect(liveCredential).toBeDefined()

    const imported = buildBundle({
      accounts: [{
        id: 'same-account',
        label: 'Same',
        // A STALER token for the same identity: a re-import of an older bundle.
        credential: { ...liveCredential!, accessToken: 'stale-access-token', lastRefreshAtMs: 1 },
      }],
    })
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-prefer-'))
    await writeBundleAccounts(imported, dir)

    const pool = new WorkBuddyAccountPool({ authDirs: [live, dir], logger: { warn() {} } })
    const accounts = await pool.scan()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.credential.accessToken).toBe(liveCredential!.accessToken)
  })
})

describe('transfer settings', () => {
  it('narrows an untrusted block to the keys this plugin owns', () => {
    const picked = pickTransferSettings({
      distribution: 'balanced',
      disabledAccountIds: ['a', 'b'],
      creditReserves: { a: 100, b: 0, c: -5, d: 'nope' },
      modelSelectionCn: { enabledModelIds: ['hy3'] },
      automation: { enabled: true },
      // None of these may travel: they are not this plugin's to write.
      automationEarnings: { date: '2026-01-01' },
      modelUsage: { days: [] },
      authFile: 'C:\\evil',
      cooldownMs: 1,
    })
    expect(picked.distribution).toBe('balanced')
    expect(picked.disabledAccountIds).toEqual(['a', 'b'])
    // Non-positive and non-numeric reserves are dropped rather than stored.
    expect(picked.creditReserves).toEqual({ a: 100 })
    expect(picked.modelSelectionCn).toEqual({ enabledModelIds: ['hy3'] })
    expect(picked.automation).toEqual({ enabled: true })
    expect('automationEarnings' in picked).toBe(false)
    expect('modelUsage' in picked).toBe(false)
    expect('authFile' in picked).toBe(false)
    expect('cooldownMs' in picked).toBe(false)
  })

  it('drops a distribution value the schema would reject', () => {
    expect(pickTransferSettings({ distribution: 'random' }).distribution).toBeUndefined()
  })

  it('round-trips the settings mirror the host writes for the CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-mirror-'))
    const settings = {
      distribution: 'round-robin',
      disabledAccountIds: ['x'],
      creditReserves: { x: 42 },
      modelSelectionCn: { enabledModelIds: ['hy3'] },
    }
    await writeSettingsSnapshot(settings, dir)
    expect(await readSettingsSnapshot(dir)).toEqual(settings)
  })

  it('reads no settings mirror rather than throwing when none was written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-nomirror-'))
    expect(await readSettingsSnapshot(dir)).toBeUndefined()
  })

  it('stages and consumes the pending-settings handoff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-pending-'))
    expect(await readPendingSettings(dir)).toBeUndefined()
    await writePendingSettings({ distribution: 'balanced' }, dir)
    expect(await readPendingSettings(dir)).toEqual({ distribution: 'balanced' })
  })

  it('ignores a corrupt settings mirror instead of failing the export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbx-transfer-badmirror-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings-snapshot.json'), '{ not json', 'utf8')
    expect(await readSettingsSnapshot(dir)).toBeUndefined()
  })
})

describe('credentialToDocument', () => {
  it('omits absent optional fields rather than writing nulls', () => {
    const document = credentialToDocument({
      accessToken: 'a',
      refreshToken: '',
      expiresAtMs: 0,
      domain: '',
      sourcePath: 'test',
    })
    const account = document['account'] as Record<string, unknown>
    const auth = document['auth'] as Record<string, unknown>
    expect(account).toEqual({})
    expect('refreshExpiresAt' in auth).toBe(false)
    expect('lastRefreshTime' in auth).toBe(false)
    // And the result is still a readable credential: an empty refresh token is
    // legal (a session that cannot be renewed), unlike a missing access token.
    expect(parseWorkBuddyAuth(JSON.stringify(document), 'test')).toBeDefined()
  })

  it('preserves every identity field the pool keys accounts on', () => {
    // Realistic epoch-ms values, because `parseWorkBuddyAuth` reads anything at
    // or below 1e12 as SECONDS (the upstream sometimes sends seconds). A toy
    // value like `123` is therefore not a round-trip test of the ms fields.
    const refreshExpiresAtMs = Date.now() + 30 * 24 * 3_600_000
    const expiresAtMs = Date.now() + 3_600_000
    const lastRefreshAtMs = Date.now() - 60_000
    const document = credentialToDocument({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs,
      refreshExpiresAtMs,
      lastRefreshAtMs,
      nickname: '寒风',
      uin: '10001',
      uid: 'uid-1',
      enterpriseId: 'ent-1',
      domain: 'www.workbuddy.cn',
      sourcePath: 'test',
    })
    const parsed = parseWorkBuddyAuth(JSON.stringify(document), 'test')
    expect(parsed).toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs,
      refreshExpiresAtMs,
      lastRefreshAtMs,
      nickname: '寒风',
      uin: '10001',
      uid: 'uid-1',
      enterpriseId: 'ent-1',
      domain: 'www.workbuddy.cn',
    })
  })
})
