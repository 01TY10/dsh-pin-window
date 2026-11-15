/**
 * Host half of the Windows title-bar pin: authenticated local routes that read
 * and change the desktop window's native always-on-top state.
 *
 * Maximizing suspends the pin (the user's intent is remembered) and restoring
 * the window re-applies it. Disabling the plugin clears the native state.
 */

import { createWin32Controller } from './win32.js'

export const name = 'dsh-pin-window'
export const inject = ['webServer', 'connection']

const STATE_PATH = '/dsh-pin-window/state'
const PIN_PATH = '/dsh-pin-window/pin'
const UNPIN_PATH = '/dsh-pin-window/unpin'

/** JSON response with live facts; never cache a window state. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Refuse a method the route does not own. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * @param ctx - Cordis Host context with webServer and connection.
 */
export function apply(ctx) {
  if (process.platform !== 'win32') return
  const connection = ctx.connection ?? ctx.get?.('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return

  const controller = createWin32Controller()
  /** User intent; undefined until the first read adopts the actual state. */
  let wanted
  let warned = false

  const warn = (message, error) => {
    if (warned) return
    warned = true
    console.warn(`desktop-pin: ${message}:`, error?.message ?? error)
  }

  /** Apply the maximize-suspend and user-intent rules, then report the truth. */
  const readState = async () => {
    let current
    try {
      current = await controller.read()
    } catch (error) {
      warn('the desktop window is unavailable', error)
      return { available: false, pinned: false, maximized: false }
    }
    if (!current.available) return { available: false, pinned: false, maximized: false }

    if (wanted === undefined) wanted = current.pinned
    try {
      if (current.maximized) {
        if (current.pinned) {
          await controller.setPinned(false)
          current.pinned = false
        }
      } else if (wanted && !current.pinned) {
        await controller.setPinned(true)
        current.pinned = true
      } else if (!wanted && current.pinned) {
        await controller.setPinned(false)
        current.pinned = false
      }
    } catch (error) {
      warn('cannot update the always-on-top state', error)
      // Report what Windows actually holds and stop retrying until the next gesture.
      try {
        const actual = await controller.read()
        if (!actual.available) return { available: false, pinned: false, maximized: false }
        current.pinned = actual.pinned
        current.maximized = actual.maximized
        wanted = actual.pinned
      } catch {
        return { available: false, pinned: false, maximized: false }
      }
    }
    return { available: true, pinned: current.pinned, maximized: current.maximized, wanted: wanted === true }
  }

  /** True when the connection trust fence already answered the request. */
  const rejected = (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, await readState())
    },
  }), `dsh-pin-window: GET ${STATE_PATH}`)

  /** Shared pin/unpin body: explicit verbs, no request body. */
  const mutation = (pin) => async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, 'POST')
      return
    }
    const current = await readState()
    if (!current.available) {
      sendJson(res, 503, { ...current, error: 'unavailable' })
      return
    }
    if (pin && current.maximized) {
      sendJson(res, 409, { ...current, error: 'maximized' })
      return
    }
    try {
      if (pin) {
        await controller.setPinned(true)
        wanted = true
      } else {
        wanted = false
        if (current.pinned) await controller.setPinned(false)
      }
    } catch (error) {
      warn('the requested pin change failed', error)
      sendJson(res, 500, {
        available: current.available,
        pinned: current.pinned,
        maximized: current.maximized,
        wanted: wanted === true,
        error: 'win32',
      })
      return
    }
    sendJson(res, 200, await readState())
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PIN_PATH,
    handler: mutation(true),
  }), `dsh-pin-window: POST ${PIN_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UNPIN_PATH,
    handler: mutation(false),
  }), `dsh-pin-window: POST ${UNPIN_PATH}`)

  ctx.effect(() => () => {
    // The native state outlives plugin disposal; never leave the window pinned
    // without the button that explains and clears it.
    if (wanted === true) void controller.setPinned(false).catch(() => {})
  }, 'dsh-pin-window: clear the native pin')
}
