/**
 * Client half of the desktop pin: one button in the Windows caption row,
 * left of the native minimize/maximize/close controls. The Host owns the
 * native state; this module only polls it, renders three states, and sends
 * explicit pin/unpin requests.
 */

window.__ModuleLoader__.load({
  id: 'dsh-pin-window',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'desktop-pin'
    const BASE = '/dsh-pin-window'
    const POLL_MS = 1000
    const RESIZE_DEBOUNCE_MS = 120
    const ERROR_FLASH_MS = 1500
    const PIN_PATH = 'M16 3H8a1 1 0 0 0 0 2h1v5.5L6.5 13a1 1 0 0 0 .7 1.7H11v5.8l.6 1.2.6-1.2v-5.8h3.8a1 1 0 0 0 .7-1.7L14 10.5V5h1a1 1 0 0 0 0-2z'

    const en = {
      pin: 'Pin on top',
      unpin: 'Unpin',
      maximized: 'Unavailable while maximized',
      paused: 'Maximized; pinning resumes when the window is restored',
      failed: 'Could not change the pin state',
    }
    const zh = {
      pin: '置顶',
      unpin: '取消置顶',
      maximized: '窗口最大化时不可用',
      paused: '窗口已最大化，恢复后自动置顶',
      failed: '置顶状态切换失败',
    }

    const CSS = `
.dsh-pin-window-anchor {
  position: fixed;
  top: 0;
  /* Windows 11 captions: three 46px logical buttons, each 40px tall. */
  --dsh-pin-window-caption-inset: 138px;
  right: var(--dsh-pin-window-caption-inset);
  /* Local to the overlay layer; frame-level stacking still owns global order. */
  z-index: 21;
  display: flex;
  width: 46px;
  height: var(--dsh-windows-titlebar-height, 40px);
  pointer-events: auto;
  -webkit-app-region: no-drag;
}
.dsh-pin-window-button {
  --dsh-pin-window-bg: var(--dsw-specific-sidebar-fill);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 0;
  background: var(--dsh-pin-window-bg);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dsh-pin-window-button:hover:not(:disabled) {
  /* Match the native caption cells: the entire 46x40 cell gets one neutral
     highlight, and the icon keeps its colour. */
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, var(--dsh-pin-window-bg));
}
.dsh-pin-window-button[data-pinned="true"] {
  --dsh-pin-window-bg: color-mix(in srgb, var(--dsw-static-deepseek-450) 16%, var(--dsw-specific-sidebar-fill));
  background: var(--dsh-pin-window-bg);
  color: var(--dsw-static-deepseek-500);
}
body[data-ds-dark-theme] .dsh-pin-window-button[data-pinned="true"] {
  color: var(--dsw-static-deepseek-400);
}
.dsh-pin-window-button:disabled,
.dsh-pin-window-button[data-pinned="true"]:disabled {
  /* The disabled cell keeps the native caption fill; the grey glyph and the
     disabled interaction carry the state instead of a darker block. */
  background: var(--dsw-specific-sidebar-fill);
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.dsh-pin-window-button[data-error="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-pin-window-button:focus-visible {
  outline: 2px solid var(--dsw-static-deepseek-450);
  outline-offset: -3px;
}
body[data-ds-dark-theme] .dsh-pin-window-button:focus-visible {
  outline-color: var(--dsw-static-deepseek-300);
}
.dsh-pin-window-button[aria-busy="true"] {
  opacity: 0.65;
}
.dsh-pin-window-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-pin-window-button {
    transition: none;
  }
}
@media (forced-colors: active) {
  .dsh-pin-window-button {
    outline: 1px solid ButtonText;
    outline-offset: -1px;
  }
  .dsh-pin-window-button:focus-visible {
    outline-color: Highlight;
  }
}
`

    /** The inline glyph; currentColor follows the three state colors. */
    function PinIcon() {
      return h('svg', {
        width: 20,
        height: 20,
        viewBox: '0 0 24 24',
        'aria-hidden': true,
        focusable: 'false',
      }, h('path', { fill: 'currentColor', d: PIN_PATH }))
    }

    /** The button only belongs to the Windows Electron main frame. */
    function isDesktopWindows() {
      if (typeof window === 'undefined' || !window.dshDesktop) return false
      return document.documentElement?.dataset?.platform === 'win32'
    }

    function PinButton(props) {
      const t = typeof props?.t === 'function'
        ? props.t
        : (key) => en[key] ?? key
      const [snapshot, setSnapshot] = React.useState({
        phase: 'loading',
        available: false,
        pinned: false,
        maximized: false,
        wanted: false,
      })
      const [pending, setPending] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [fullscreen, setFullscreen] = React.useState(
        typeof document !== 'undefined' && document.documentElement.hasAttribute('data-fullscreen'),
      )
      const desktop = React.useMemo(isDesktopWindows, [])
      const mountedRef = React.useRef(true)
      const failuresRef = React.useRef(0)
      const errorTimerRef = React.useRef(0)
      const pendingRef = React.useRef(false)
      const generationRef = React.useRef(0)

      React.useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      React.useEffect(() => {
        if (!desktop) return undefined
        const root = document.documentElement
        const update = () => { setFullscreen(root.hasAttribute('data-fullscreen')) }
        update()
        const observer = new MutationObserver(update)
        observer.observe(root, { attributes: true, attributeFilter: ['data-fullscreen'] })
        return () => observer.disconnect()
      }, [desktop])

      React.useEffect(() => {
        if (!desktop) return undefined
        let disposed = false
        let inFlight = false
        let interval = 0
        let resizeTimer = 0
        let controller

        const poll = async () => {
          if (disposed || inFlight) return
          if (document.visibilityState !== 'visible') return
          inFlight = true
          const generation = generationRef.current
          controller = new AbortController()
          const timeout = window.setTimeout(() => controller.abort(), 5000)
          try {
            const response = await fetch(`${BASE}/state`, {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              signal: controller.signal,
            })
            if (!response.ok) throw new Error(`state ${response.status}`)
            const next = await response.json()
            if (disposed) return
            if (generation !== generationRef.current || pendingRef.current) return
            if (!next || next.available !== true) {
              failuresRef.current += 1
              if (failuresRef.current >= 3) {
                setSnapshot({ phase: 'hidden', available: false, pinned: false, maximized: false, wanted: false })
              }
              return
            }
            failuresRef.current = 0
            setSnapshot({
              phase: 'ready',
              available: true,
              pinned: next.pinned === true,
              maximized: next.maximized === true,
              wanted: next.wanted === true,
            })
          } catch (error) {
            if (disposed || error?.name === 'AbortError') return
            if (generation !== generationRef.current || pendingRef.current) return
            failuresRef.current += 1
            if (failuresRef.current >= 3) {
              setSnapshot({ phase: 'hidden', available: false, pinned: false, maximized: false, wanted: false })
            }
          } finally {
            window.clearTimeout(timeout)
            inFlight = false
            controller = undefined
          }
        }
        const pollSoon = () => {
          if (disposed) return
          if (resizeTimer !== 0) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            resizeTimer = 0
            void poll()
          }, RESIZE_DEBOUNCE_MS)
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void poll()
        }
        interval = window.setInterval(() => { void poll() }, POLL_MS)
        window.addEventListener('resize', pollSoon)
        window.addEventListener('focus', onVisibility)
        document.addEventListener('visibilitychange', onVisibility)
        void poll()
        return () => {
          disposed = true
          if (interval !== 0) window.clearInterval(interval)
          if (resizeTimer !== 0) window.clearTimeout(resizeTimer)
          window.removeEventListener('resize', pollSoon)
          window.removeEventListener('focus', onVisibility)
          document.removeEventListener('visibilitychange', onVisibility)
          controller?.abort()
        }
      }, [desktop])

      const toggle = React.useCallback(async () => {
        if (pendingRef.current) return
        if (snapshot.phase !== 'ready' || !snapshot.available || snapshot.maximized) return
        generationRef.current += 1
        pendingRef.current = true
        setPending(true)
        setFailed(false)
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`${BASE}/${snapshot.pinned ? 'unpin' : 'pin'}`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          })
          let next = null
          try { next = await response.json() } catch { /* a failed request may have no JSON */ }
          if (!mountedRef.current) return
          if (response.status === 409 && next?.error === 'maximized') {
            setSnapshot((current) => ({
              ...current,
              pinned: false,
              maximized: true,
              wanted: next?.wanted === true || current.wanted,
            }))
            return
          }
          if (!response.ok || !next || next.available !== true) throw new Error('pin request failed')
          setSnapshot({
            phase: 'ready',
            available: true,
            pinned: next.pinned === true,
            maximized: next.maximized === true,
            wanted: next.wanted === true,
          })
        } catch {
          if (!mountedRef.current) return
          setFailed(true)
          if (errorTimerRef.current !== 0) window.clearTimeout(errorTimerRef.current)
          errorTimerRef.current = window.setTimeout(() => {
            errorTimerRef.current = 0
            setFailed(false)
          }, ERROR_FLASH_MS)
        } finally {
          window.clearTimeout(timeout)
          pendingRef.current = false
          if (mountedRef.current) setPending(false)
        }
      }, [pending, snapshot.phase, snapshot.available, snapshot.pinned, snapshot.maximized])

      React.useEffect(() => () => {
        if (errorTimerRef.current !== 0) window.clearTimeout(errorTimerRef.current)
      }, [])

      if (!desktop || fullscreen || snapshot.phase !== 'ready' || !snapshot.available) return null

      const actionLabel = snapshot.pinned ? t('unpin') : t('pin')
      const reason = snapshot.maximized
        ? (snapshot.wanted ? t('paused') : t('maximized'))
        : undefined
      // A disabled caption control has no hover tooltip or hover effect; keep
      // the explanation only in the visually hidden description for assistive
      // technology, not in a visible title bubble.
      const titleText = snapshot.maximized ? undefined : actionLabel

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('span', { key: 'anchor', className: 'dsh-pin-window-anchor', title: titleText },
          h('button', {
            type: 'button',
            className: 'dsh-pin-window-button',
            'data-pinned': snapshot.pinned ? 'true' : 'false',
            'data-error': failed ? 'true' : undefined,
            'aria-label': actionLabel,
            'aria-pressed': snapshot.pinned,
            'aria-busy': pending ? 'true' : undefined,
            'aria-describedby': reason ? 'dsh-pin-window-reason' : undefined,
            disabled: snapshot.maximized,
            title: titleText,
            onClick: () => { void toggle() },
          }, h(PinIcon, null)),
        ),
        h('span', {
          key: 'reason',
          id: 'dsh-pin-window-reason',
          className: 'dsh-pin-window-status',
        }, reason ?? ''),
        h('span', {
          key: 'status',
          className: 'dsh-pin-window-status',
          role: 'status',
          'aria-live': 'polite',
        }, failed ? t('failed') : ''),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-pin-window: dictionaries')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'desktop-pin',
          order: 100,
          locale: NS,
        }, PinButton))
      },
    }
  },
})
