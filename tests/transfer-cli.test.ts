/**
 * End-to-end tests for the CLI transfer commands.
 *
 * These drive the REAL `main()` with a real `DSH_HOME` and a real auth
 * directory, because the failure mode this feature has is not a wrong return
 * value — it is a command that reports success while writing files nothing
 * reads, or reading a settings document that is not there. Only the assembled
 * command can show that.
 *
 * `process.env.DSH_HOME` and `WORKBUDDY_AUTH_FILE` are set per test and restored
 * afterwards: the CLI resolves both at call time, so a leaked value would make a
 * later test read the developer's own machine.
 */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/bin.ts'
import { BUNDLE_FORMAT, BUNDLE_VERSION, readPendingSettings, writeSettingsSnapshot } from '../src/transfer.ts'

/** A desktop-shaped auth document. */
function authDocument(index: number): string {
  const now = Date.now()
  return JSON.stringify({
    auth: {
      accessToken: `access-token-${index}-${'a'.repeat(40)}`,
      refreshToken: `refresh-token-${index}-${'b'.repeat(40)}`,
      expiresAt: now + 3_600_000,
      refreshExpiresAt: now + 30 * 24 * 3_600_000,
      lastRefreshTime: now - 60_000,
      domain: '',
    },
    account: {
      uin: `1000000000${index}`,
      uid: `uid-${index}-${'0'.repeat(24)}`,
      nickname: `Account${index}`,
    },
  })
}

let home = ''
let authDir = ''
let workDir = ''
const savedEnv: Record<string, string | undefined> = {}

/**
 * Point every directory the pool probes at a throwaway location.
 *
 * `WORKBUDDY_AUTH_FILE` is ADDITIVE in `candidateAuthDirs` — it names a
 * directory to scan in addition to the platform defaults — so setting it alone
 * would leave the real desktop auth directory in the scan list and these tests
 * would import whatever accounts the developer happens to be signed in with.
 * The platform variables are what move the defaults themselves.
 */
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wbx-cli-home-'))
  authDir = await mkdtemp(join(tmpdir(), 'wbx-cli-auth-'))
  workDir = await mkdtemp(join(tmpdir(), 'wbx-cli-work-'))
  for (const key of [
    'DSH_HOME', 'WORKBUDDY_AUTH_FILE', 'WORKBUDDY_APP_EXECUTABLE',
    'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE',
  ]) {
    savedEnv[key] = process.env[key]
  }
  process.env['DSH_HOME'] = home
  process.env['WORKBUDDY_AUTH_FILE'] = join(authDir, 'workbuddy-desktop.info')
  // Empty platform defaults, so the only accounts in play are the fake ones.
  process.env['LOCALAPPDATA'] = join(home, 'local')
  process.env['APPDATA'] = join(home, 'roaming')
  process.env['XDG_CONFIG_HOME'] = join(home, 'config')
  // Point the desktop-app probe at nothing, so a scan never spawns a real
  // WorkBuddy binary on the machine running the tests.
  process.env['WORKBUDDY_APP_EXECUTABLE'] = join(authDir, 'does-not-exist.exe')
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

/** Run a CLI command, capturing stdout and stderr. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    out.push(parts.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    err.push(parts.map(String).join(' '))
  })
  const code = await main(args)
  log.mockRestore()
  error.mockRestore()
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** Sign `count` accounts in, as the desktop app would. */
async function signIn(count: number): Promise<void> {
  await mkdir(authDir, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const name = index === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.r.${index}.uuid.info`
    await writeFile(join(authDir, name), authDocument(index), 'utf8')
  }
}

describe('CLI export', () => {
  it('writes a bundle carrying every account and the settings mirror', async () => {
    await signIn(3)
    await writeSettingsSnapshot({ distribution: 'balanced', creditReserves: { a: 5 } }, join(home, '.workbuddy-xdpool'))
    const target = join(workDir, 'bundle.json')

    const result = await run(['export', target])
    expect(result.code).toBe(0)
    expect(result.out).toContain('Exported 3 account(s)')
    // The warning about plaintext is part of the command's contract, not a nicety:
    // the file is every account's tokens.
    expect(result.out).toContain('tokens in the clear')

    const bundle = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    expect(bundle['format']).toBe(BUNDLE_FORMAT)
    expect(bundle['version']).toBe(BUNDLE_VERSION)
    expect(bundle['accounts']).toHaveLength(3)
    expect(bundle['settings']).toMatchObject({ distribution: 'balanced' })
  })

  it('refuses to overwrite an existing file without --force', async () => {
    await signIn(1)
    const target = join(workDir, 'bundle.json')
    await writeFile(target, 'previous', 'utf8')

    const refused = await run(['export', target])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('--force')
    expect(await readFile(target, 'utf8')).toBe('previous')

    const forced = await run(['export', target, '--force'])
    expect(forced.code).toBe(0)
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ format: BUNDLE_FORMAT })
  })

  it('fails with a real reason when there is no account to export', async () => {
    // No auth directory at all: an empty bundle would be worse than an error,
    // because the user would carry it to the other machine and import nothing.
    const result = await run(['export', join(workDir, 'empty.json')])
    expect(result.code).toBe(1)
    expect(result.err).toContain('nothing to export')
    expect(existsSync(join(workDir, 'empty.json'))).toBe(false)
  })

  it('exports settings without credentials under --settings-only', async () => {
    await writeSettingsSnapshot({ distribution: 'round-robin' }, join(home, '.workbuddy-xdpool'))
    const target = join(workDir, 'settings.json')
    const result = await run(['export', target, '--settings-only'])
    expect(result.code).toBe(0)
    const bundle = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    expect(bundle['accounts']).toEqual([])
    expect(bundle['settings']).toMatchObject({ distribution: 'round-robin' })
  })

  it('rejects --accounts-only together with --settings-only', async () => {
    const result = await run(['export', join(workDir, 'x.json'), '--accounts-only', '--settings-only'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('mutually exclusive')
  })
})

describe('CLI transfer', () => {
  it('imports a bundle written by export, and stages its settings', async () => {
    await signIn(2)
    await writeSettingsSnapshot({ distribution: 'balanced' }, join(home, '.workbuddy-xdpool'))
    const target = join(workDir, 'bundle.json')
    expect((await run(['export', target])).code).toBe(0)

    // A second machine: a different DSH_HOME with no desktop sign-in at all.
    const otherHome = await mkdtemp(join(tmpdir(), 'wbx-cli-home2-'))
    process.env['DSH_HOME'] = otherHome
    process.env['WORKBUDDY_AUTH_FILE'] = join(await mkdtemp(join(tmpdir(), 'wbx-cli-empty-')), 'nope.info')

    const result = await run(['transfer', target])
    expect(result.code).toBe(0)
    expect(result.out).toContain('Imported 2 account(s)')

    const written = (await readdir(join(otherHome, '.workbuddy-xdpool'))).filter(name => name.endsWith('.info'))
    expect(written).toHaveLength(2)

    // The settings half is staged for the host, not applied by the CLI: this
    // process has no settings service.
    const pending = await readPendingSettings(join(otherHome, '.workbuddy-xdpool'))
    expect(pending).toMatchObject({ distribution: 'balanced' })
  })

  it('discovers the imported accounts through the pool, with no desktop sign-in', async () => {
    // The end the user actually cares about: after `transfer`, the pool has the
    // accounts. Asserted through `accounts --json`, which runs a real scan.
    await signIn(2)
    const target = join(workDir, 'bundle.json')
    expect((await run(['export', target])).code).toBe(0)

    const otherHome = await mkdtemp(join(tmpdir(), 'wbx-cli-home3-'))
    process.env['DSH_HOME'] = otherHome
    process.env['WORKBUDDY_AUTH_FILE'] = join(await mkdtemp(join(tmpdir(), 'wbx-cli-empty2-')), 'nope.info')
    expect((await run(['transfer', target])).code).toBe(0)

    const listed = await run(['accounts', '--json'])
    const accounts = JSON.parse(listed.out) as { label: string }[]
    expect(accounts).toHaveLength(2)
    // The label is `nickname#<first 8 chars of the uid>`, so the two accounts
    // are distinguishable even though their nicknames differ only by a digit.
    expect(accounts.map(entry => entry.label).sort()).toEqual(['Account0#uid-0-00', 'Account1#uid-1-00'])
  })

  it('reports a refused bundle instead of importing nothing quietly', async () => {
    const target = join(workDir, 'not-a-bundle.json')
    await writeFile(target, JSON.stringify({ hello: 'world' }), 'utf8')
    const result = await run(['transfer', target])
    expect(result.code).toBe(1)
    expect(result.err).toContain('not a usable bundle')
  })

  it('reports a missing file with the path, not a stack trace', async () => {
    const result = await run(['transfer', join(workDir, 'absent.json')])
    expect(result.code).toBe(1)
    expect(result.err).toContain('Cannot read')
    expect(result.err).not.toContain('at Object')
  })

  it('answers --json with what it imported, for scripting', async () => {
    await signIn(1)
    const target = join(workDir, 'bundle.json')
    expect((await run(['export', target])).code).toBe(0)

    const otherHome = await mkdtemp(join(tmpdir(), 'wbx-cli-home4-'))
    process.env['DSH_HOME'] = otherHome
    process.env['WORKBUDDY_AUTH_FILE'] = join(await mkdtemp(join(tmpdir(), 'wbx-cli-empty3-')), 'nope.info')
    const result = await run(['transfer', target, '--json'])
    expect(result.code).toBe(0)
    const body = JSON.parse(result.out) as { ok: boolean; imported: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.imported).toHaveLength(1)
  })

  it('requires a file argument', async () => {
    const result = await run(['transfer'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('usage:')
  })
})

describe('CLI export and transfer round trip', () => {
  it('carries credentials that still parse on the receiving side', async () => {
    await signIn(2)
    const target = join(workDir, 'bundle.json')
    expect((await run(['export', target])).code).toBe(0)

    const otherHome = await mkdtemp(join(tmpdir(), 'wbx-cli-home5-'))
    process.env['DSH_HOME'] = otherHome
    process.env['WORKBUDDY_AUTH_FILE'] = join(await mkdtemp(join(tmpdir(), 'wbx-cli-empty4-')), 'nope.info')
    expect((await run(['transfer', target])).code).toBe(0)

    // The written files must be the documents themselves — plain tokens, no
    // `$wbEncrypted` envelope, which would only open on the source machine.
    const dir = join(otherHome, '.workbuddy-xdpool')
    for (const name of (await readdir(dir)).filter(entry => entry.endsWith('.info'))) {
      const text = await readFile(join(dir, name), 'utf8')
      expect(text).not.toContain('$wbEncrypted')
      const document = JSON.parse(text) as { auth: { accessToken: string } }
      expect(document.auth.accessToken).toContain('access-token-')
    }
  })
})
