/**
 * Native smoke test for the pin plugin. Read-only by default; set
 * DSH_PIN_SMOKE_TOGGLE=1 while the window is restored to exercise the
 * topmost round trip. The test always leaves the window unpinned.
 */

import assert from 'node:assert/strict'
import { createWin32Controller, loadWin32Bindings } from '../win32.js'

const bindings = await loadWin32Bindings()
const proto = bindings.koffi.proto('int __stdcall DshPinSmokeEnum(void *hwnd, intptr lparam)')
let found = null
const callback = bindings.koffi.register((hwnd) => {
  if (bindings.getWindow(hwnd, 4) !== null) return 1
  if (bindings.isWindowVisible(hwnd) === 0) return 1
  const classBuffer = Buffer.alloc(512)
  bindings.getClassNameW(hwnd, classBuffer, 256)
  if (classBuffer.toString('utf16le').replace(/\0.*$/u, '') !== 'Chrome_WidgetWin_1') return 1
  const titleBuffer = Buffer.alloc(2048)
  bindings.getWindowTextW(hwnd, titleBuffer, 1024)
  const title = titleBuffer.toString('utf16le').replace(/\0.*$/u, '')
  if (!title.includes('DeepSeek Harness')) return 1
  const pidBuffer = Buffer.alloc(4)
  bindings.getWindowThreadProcessId(hwnd, pidBuffer)
  found = { hwnd, pid: pidBuffer.readUInt32LE(0), title }
  return 0
}, bindings.koffi.pointer(proto))
try {
  bindings.enumWindows(callback, 0)
} finally {
  bindings.koffi.unregister(callback)
}
assert.ok(found, 'no DeepSeek Harness main window found')
console.log(JSON.stringify({ discovered: { hwnd: String(found.hwnd), pid: found.pid, title: found.title } }, null, 2))

const controller = createWin32Controller({ ownerPid: found.pid })
const state = await controller.read()
assert.equal(state.available, true, 'controller did not resolve the main window')
console.log(JSON.stringify({ state }, null, 2))

// The write path is opt-in: a shell process confined by the DSH sandbox has a
// restricted token and receives ERROR_ACCESS_DENIED from SetWindowPos on the
// Electron window. The product verifies writes through the Host route instead.
if (process.env.DSH_PIN_SMOKE_TOGGLE === '1') {
  if (state.maximized) {
    console.log('toggle: skipped because the window is maximized')
  } else {
    try {
      await controller.setPinned(true)
      assert.equal((await controller.read()).pinned, true, 'pin did not stick')
      console.log('toggle: pinned -> verified')
    } finally {
      await controller.setPinned(false)
      assert.equal((await controller.read()).pinned, false, 'window was not restored to unpinned')
      console.log('toggle: unpinned -> restored')
    }
  }
}
