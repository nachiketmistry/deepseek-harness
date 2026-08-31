/**
 * The product claim, through the product: two people who sign in to the same
 * deployment do not see each other's chats.
 *
 * Everything here is the real thing. The server is `wrangler dev` over the
 * built Worker, the identity service is `apps/cf-auth`'s own `pnpm run dev`,
 * the tokens are the ones that service issues to the accounts its seed
 * created, and the isolation is read off the sidebar rather than out of
 * storage. The two accounts get separate browser contexts, so neither the
 * deployment's session cookie nor the identity service's can leak between
 * them the way they would in one profile.
 *
 * No model turn is involved: a chat exists, and is titled, from the message
 * the person sent, and the turn that follows it fails on a missing API key.
 * That failure is the deployment's, not this run's, and nothing here reads it.
 *
 * Start both servers first:
 *   pnpm --filter @deepseek-ai/dsh-cf-auth run dev    # :8788, then run seed
 *   pnpm --filter @deepseek-ai/dsh-cf-web  run dev    # :8790, needs run build
 */

import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const WEB_URL = process.env.DSH_CF_WEB_DEV_URL ?? 'http://localhost:8790'
const IDENTITY_URL = process.env.DSH_CF_AUTH_DEV_URL ?? 'http://localhost:8788'
const PASSWORD = process.env.DSH_CF_AUTH_DEV_PASSWORD ?? 'dev-password-not-a-secret'
const ALICE = 'alice@dev.invalid'
const BOB = 'bob@dev.invalid'

/**
 * What each account starts, and the workspace it starts it in. Both accounts
 * write, so neither absence assertion can pass on a sidebar that has not
 * finished loading: the account's own chat has to be there first.
 */
// Named per run: a Durable Object keeps what earlier runs wrote, so a fixed
// title would make every later run read one of several identical entries.
const RUN = String(process.pid)
const ALICE_CHAT = `alice's private notes ${RUN}`
const BOB_CHAT = `bob's private notes ${RUN}`
const ALICE_WORKSPACE = `alice-project-${RUN}`
const BOB_WORKSPACE = `bob-project-${RUN}`

/** Long enough for a Durable Object to boot the harness tree on a cold wake. */
const READY_TIMEOUT = 60_000

/** Whether both servers this run drives are up. */
async function serversUp(): Promise<boolean> {
  const reachable = async (url: string): Promise<boolean> => {
    try {
      await fetch(url)
      return true
    } catch {
      return false
    }
  }
  return (await reachable(WEB_URL)) && (await reachable(`${IDENTITY_URL}/api/auth/jwks`))
}

const live = await serversUp()
if (!live) {
  console.warn(`principal isolation e2e: ${WEB_URL} or ${IDENTITY_URL} is unreachable; skipping`)
}

/** The panels a profile that has not used this deployment before is shown, in the order they arrive. */
const FIRST_RUN_PANELS = ['Continue', 'Configure later'] as const

/**
 * Dismiss the first-run panels, and wait out the ones this profile is not
 * shown. They arrive after the sidebar renders and they overlay it, so a run
 * that reads the tree without clearing them first clicks into an overlay.
 * @param page - the signed-in page.
 */
async function dismissFirstRun(page: Page): Promise<void> {
  for (const label of FIRST_RUN_PANELS) {
    const button = page.getByRole('button', { name: label, exact: true }).first()
    try {
      await button.waitFor({ state: 'visible', timeout: 10_000 })
    } catch {
      // This profile was not shown that panel; nothing else raises here,
      // because the locator is resolved lazily and the wait is the only call.
      continue
    }
    await button.click()
    await button.waitFor({ state: 'hidden', timeout: READY_TIMEOUT })
  }
}

/** Sign one account in through the deployment's own sign-in page and wait for the GUI. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(WEB_URL, { waitUntil: 'load' })
  const form = page.locator('form#f')
  await form.waitFor({ timeout: READY_TIMEOUT })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await page.locator('#submit').click()
  await page.getByRole('tree', { name: 'Sessions' }).waitFor({ timeout: READY_TIMEOUT })
  await dismissFirstRun(page)
}

/** Give up both this deployment's session and the identity session behind it. */
async function signOut(page: Page): Promise<void> {
  await page.goto(`${WEB_URL}/__dsh/signout`, { waitUntil: 'load' })
  await page.locator('form#f').waitFor({ timeout: READY_TIMEOUT })
}

/**
 * Everything the sidebar names: workspaces and the chats inside them, read
 * once `present` is on screen. Waiting for the account's own entry first is
 * what makes the absences this run asserts mean something.
 * @param page - the signed-in page.
 * @param present - an entry this account must have, which the wait is for.
 * @returns every line the sidebar tree shows.
 */
async function sidebarEntries(page: Page, present: string): Promise<string[]> {
  const tree = page.getByRole('tree', { name: 'Sessions' })
  await tree.waitFor({ timeout: READY_TIMEOUT })
  await tree.getByText(present, { exact: true }).first().waitFor({ timeout: READY_TIMEOUT })
  return (await tree.getByRole('treeitem').allInnerTexts())
    .flatMap(text => text.split('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/** Add a workspace through the directory picker, as a person would. */
async function addWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add workspace' }).click()
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByRole('textbox').last().fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  // The picker enters the folder it created; opening it there is what makes it
  // the workspace, and the sandbox policy refuses the workspace root itself.
  await page.getByRole('button', { name: name, exact: true }).waitFor({ timeout: READY_TIMEOUT })
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByRole('tree', { name: 'Sessions' }).getByText(name, { exact: true })
    .first().waitFor({ timeout: READY_TIMEOUT })
}

/** Start one chat in the selected workspace by sending its first message. */
async function startChat(page: Page, message: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: /Describe what you want to build/u })
  await composer.waitFor({ timeout: READY_TIMEOUT })
  await composer.fill(message)
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.getByRole('tree', { name: 'Sessions' }).getByText(message, { exact: true })
    .first().waitFor({ timeout: READY_TIMEOUT })
}

describe.skipIf(!live)('two accounts on one deployment', () => {
  let browser: Browser
  let aliceContext: BrowserContext
  let bobContext: BrowserContext
  let alice: Page
  let bob: Page

  beforeAll(async () => {
    browser = await chromium.launch()
    aliceContext = await browser.newContext()
    bobContext = await browser.newContext()
    alice = await aliceContext.newPage()
    bob = await bobContext.newPage()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('refuses a browser that has signed in to nothing', async () => {
    const anonymous = await bobContext.request.get(WEB_URL, { headers: { accept: 'text/html' } })
    expect(anonymous.status()).toBe(401)
    // The refusal is still somewhere a person can sign in from.
    expect(await anonymous.text()).toContain(IDENTITY_URL)
  })

  it('gives alice a chat of her own', async () => {
    await signIn(alice, ALICE)
    await addWorkspace(alice, ALICE_WORKSPACE)
    await startChat(alice, ALICE_CHAT)
    expect(await sidebarEntries(alice, ALICE_CHAT)).toContain(ALICE_WORKSPACE)
  })

  it('shows bob his own chat and nothing of alice', async () => {
    await signIn(bob, BOB)
    await addWorkspace(bob, BOB_WORKSPACE)
    await startChat(bob, BOB_CHAT)
    const entries = await sidebarEntries(bob, BOB_CHAT)
    expect(entries).not.toContain(ALICE_CHAT)
    expect(entries).not.toContain(ALICE_WORKSPACE)
  })

  it('gives alice her chat back, and still none of bob, when she signs in again', async () => {
    await signOut(alice)
    // Signed out, the deployment is closed to this browser again.
    const closed = await aliceContext.request.get(WEB_URL, { headers: { accept: 'text/html' } })
    expect(closed.status()).toBe(401)

    await signIn(alice, ALICE)
    const entries = await sidebarEntries(alice, ALICE_CHAT)
    expect(entries).toContain(ALICE_WORKSPACE)
    expect(entries).not.toContain(BOB_CHAT)
    expect(entries).not.toContain(BOB_WORKSPACE)
  })
})
