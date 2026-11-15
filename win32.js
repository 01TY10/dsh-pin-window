/**
 * Win32 window owner for the pin plugin: one Koffi binding table, main-window
 * discovery by parent process, and the always-on-top read/write primitives.
 *
 * The Desktop Host is spawned by the Electron main process, so the top-level
 * window that belongs to `process.ppid` is the application window. A window is
 * accepted only when it is an unowned, visible `Chrome_WidgetWin_*` whose title
 * carries the product name; the largest accepted window wins.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const GW_OWNER = 4
const GWL_EXSTYLE = -20
const WS_EX_TOPMOST = 0x00000008
const HWND_TOPMOST = -1
const HWND_NOTOPMOST = -2
/** SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE: change Z-order without touching geometry or focus. */
const SWP_FLAGS = 0x0013
const MAX_CLASS_CHARS = 256
const MAX_TITLE_CHARS = 512

let koffiPromise

/**
 * Load koffi from an anchor that can resolve the running installation. The
 * Desktop Host entry lives inside the runtime's node_modules, so the shipped
 * N-API build resolves there; DSH_INSTALL_DIR covers test processes launched
 * from the workspace. A bundle-local dependency remains the last resort for a
 * standalone install.
 * @returns the koffi API object.
 */
async function loadKoffi() {
  if (koffiPromise !== undefined) return koffiPromise
  const attempt = (async () => {
    const failures = []
    const entry = process.argv[1]
    if (typeof entry === 'string' && entry !== '') {
      try {
        const entryRequire = createRequire(entry)
        const module = entryRequire('koffi')
        return module.default ?? module
      } catch (error) {
        failures.push(error)
      }
    }
    const installDir = process.env.DSH_INSTALL_DIR
    if (installDir !== undefined && installDir !== '') {
      try {
        const dshRequire = createRequire(join(installDir, 'package.json'))
        const module = dshRequire('koffi')
        return module.default ?? module
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      const module = await import('koffi')
      return module.default ?? module
    } catch (error) {
      failures.push(error)
    }
    throw new Error('desktop-pin: koffi is unavailable', { cause: failures[0] })
  })()
  koffiPromise = attempt.catch((error) => {
    // Do not pin a failed native load for the life of this Host process.
    koffiPromise = undefined
    throw error
  })
  return koffiPromise
}

/**
 * Load user32 and expose the exact calls this plugin needs.
 * @returns Koffi plus the bound Win32 functions.
 */
export async function loadWin32Bindings() {
  if (process.platform !== 'win32') throw new Error('desktop-pin: Windows only')
  const koffi = await loadKoffi()
  const user32 = koffi.load('user32.dll')
  // Koffi registers proto type names globally for the loaded module. A unique
  // name per binding table keeps plugin reloads in the same Host process (and
  // window re-discovery) from colliding with an already-registered callback type.
  const protoSuffix = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const enumProcProto = koffi.proto(`int __stdcall DshPinEnumProc_${protoSuffix}(void *hwnd, intptr lparam)`)
  return {
    koffi,
    enumProcProto,
    enumWindows: user32.func('__stdcall', 'EnumWindows', 'int', ['void *', 'intptr']),
    getWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', 'uint32 *']),
    getClassNameW: user32.func('__stdcall', 'GetClassNameW', 'int', ['void *', 'str16', 'int']),
    getWindowTextW: user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'str16', 'int']),
    getWindowRect: user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', 'int32 *']),
    getWindow: user32.func('__stdcall', 'GetWindow', 'void *', ['void *', 'uint32']),
    isWindow: user32.func('__stdcall', 'IsWindow', 'int', ['void *']),
    isWindowVisible: user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *']),
    isZoomed: user32.func('__stdcall', 'IsZoomed', 'int', ['void *']),
    getWindowLongW: user32.func('__stdcall', 'GetWindowLongW', 'int32', ['void *', 'int32']),
    setWindowPos: user32.func('__stdcall', 'SetWindowPos', 'int', ['void *', 'intptr', 'int', 'int', 'int', 'int', 'uint32']),
  }
}

/** Read a NUL-terminated UTF-16 window string through a caller-provided getter. */
function readWindowText(bindings, hwnd, getter, maxChars) {
  const buffer = Buffer.alloc(maxChars * 2)
  const length = getter(hwnd, buffer, maxChars)
  return length > 0 ? buffer.toString('utf16le', 0, length * 2) : ''
}

/** Read the owning process id of a window. */
function readWindowPid(bindings, hwnd) {
  const buffer = Buffer.alloc(4)
  bindings.getWindowThreadProcessId(hwnd, buffer)
  return buffer.readUInt32LE(0)
}

/** Read a window rectangle, or null when the window vanished. */
function readWindowRect(bindings, hwnd) {
  const buffer = Buffer.alloc(16)
  if (bindings.getWindowRect(hwnd, buffer) === 0) return null
  return {
    left: buffer.readInt32LE(0),
    top: buffer.readInt32LE(4),
    right: buffer.readInt32LE(8),
    bottom: buffer.readInt32LE(12),
  }
}

/** Whether a class name belongs to the Chromium top-level window family. */
function isChromeClass(className) {
  return className.startsWith('Chrome_WidgetWin_')
}

/**
 * Enumerate unowned, visible top-level windows owned by `ownerPid`, score the
 * plausible application windows, and return the best candidate.
 * @param bindings - bound user32 functions.
 * @param ownerPid - Electron main process id.
 * @returns the selected window, or null when no application window is visible.
 */
export function resolveMainWindow(bindings, ownerPid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null
  const candidates = []
  let callback
  try {
    callback = bindings.koffi.register((hwnd) => {
      try {
        // Owned windows (dialogs, IME hosts) are not the application window.
        if (bindings.getWindow(hwnd, GW_OWNER) !== null) return 1
        if (bindings.isWindowVisible(hwnd) === 0) return 1
        if (readWindowPid(bindings, hwnd) !== ownerPid) return 1
        const className = readWindowText(bindings, hwnd, bindings.getClassNameW, MAX_CLASS_CHARS)
        if (!isChromeClass(className)) return 1
        const title = readWindowText(bindings, hwnd, bindings.getWindowTextW, MAX_TITLE_CHARS)
        if (title === '') return 1
        // A detached DevTools window lacks the product title; a session named
        // "DevTools ..." still carries the brand suffix and must not be skipped.
        if (title.startsWith('DevTools') && !title.includes('DeepSeek Harness')) return 1
        const rect = readWindowRect(bindings, hwnd)
        if (rect === null) return 1
        const area = Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
        let score = Math.min(area / 100_000, 100)
        if (className === 'Chrome_WidgetWin_1') score += 20
        if (title.includes('DeepSeek Harness')) score += 100
        candidates.push({ hwnd, pid: ownerPid, title, className, area, score })
      } catch {
        // A window can disappear during enumeration; it is simply not a candidate.
      }
      return 1
    }, bindings.koffi.pointer(bindings.enumProcProto))
    bindings.enumWindows(callback, 0)
  } finally {
    if (callback !== undefined) bindings.koffi.unregister(callback)
  }
  candidates.sort((left, right) => right.score - left.score)
  return candidates[0] ?? null
}

/**
 * Read the two Window facts the plugin exposes.
 * @param bindings - bound user32 functions.
 * @param hwnd - application window handle.
 * @returns whether the window is maximized and actually topmost.
 */
export function readWindowState(bindings, hwnd) {
  const exStyle = bindings.getWindowLongW(hwnd, GWL_EXSTYLE)
  return {
    maximized: bindings.isZoomed(hwnd) !== 0,
    pinned: (exStyle & WS_EX_TOPMOST) !== 0,
  }
}

/**
 * Change the window's always-on-top state and verify it took effect.
 * @param bindings - bound user32 functions.
 * @param hwnd - application window handle.
 * @param pinned - desired state.
 * @throws when Windows refuses the Z-order change or the state does not stick.
 */
export function applyPinned(bindings, hwnd, pinned) {
  const inserted = bindings.setWindowPos(
    hwnd,
    pinned ? HWND_TOPMOST : HWND_NOTOPMOST,
    0,
    0,
    0,
    0,
    SWP_FLAGS,
  )
  if (inserted === 0) throw new Error('desktop-pin: SetWindowPos failed')
  const actual = readWindowState(bindings, hwnd).pinned
  if (actual !== pinned) throw new Error('desktop-pin: the topmost state did not change')
}

/**
 * Stateful facade used by the Host half: lazy bindings, cached window, and
 * cache invalidation when the Electron window is recreated.
 * @param options.ownerPid - parent process id, normally process.ppid.
 */
export function createWin32Controller(options = {}) {
  const ownerPid = options.ownerPid ?? process.ppid
  let bindingsPromise
  let cachedHwnd = null

  const load = () => {
    bindingsPromise ??= loadWin32Bindings()
    return bindingsPromise
  }

  const stillMainWindow = (bindings, hwnd) => {
    if (bindings.isWindow(hwnd) === 0) return false
    if (bindings.getWindow(hwnd, GW_OWNER) !== null) return false
    if (readWindowPid(bindings, hwnd) !== ownerPid) return false
    const className = readWindowText(bindings, hwnd, bindings.getClassNameW, MAX_CLASS_CHARS)
    if (!isChromeClass(className)) return false
    const title = readWindowText(bindings, hwnd, bindings.getWindowTextW, MAX_TITLE_CHARS)
    return title === '' || title.includes('DeepSeek Harness')
  }

  const ensureWindow = async (bindings) => {
    if (cachedHwnd !== null && stillMainWindow(bindings, cachedHwnd)) return cachedHwnd
    cachedHwnd = null
    const found = resolveMainWindow(bindings, ownerPid)
    if (found !== null) cachedHwnd = found.hwnd
    return cachedHwnd
  }

  return {
    /**
     * @returns available plus the current maximized/topmost state.
     */
    async read() {
      if (process.platform !== 'win32') return { available: false, maximized: false, pinned: false }
      const bindings = await load()
      const hwnd = await ensureWindow(bindings)
      if (hwnd === null) return { available: false, maximized: false, pinned: false }
      return { available: true, ...readWindowState(bindings, hwnd) }
    },

    /**
     * @param pinned - desired always-on-top state.
     * @throws when no window exists or Windows refuses the change.
     */
    async setPinned(pinned) {
      if (process.platform !== 'win32') throw new Error('desktop-pin: Windows only')
      const bindings = await load()
      const hwnd = await ensureWindow(bindings)
      if (hwnd === null) throw new Error('desktop-pin: the desktop window was not found')
      applyPinned(bindings, hwnd, pinned)
    },

    /** Drop the cached handle without changing native state. */
    dispose() {
      cachedHwnd = null
    },
  }
}
