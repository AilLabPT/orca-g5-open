// @vitest-environment happy-dom

import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { installBodyOverlayAttributes } from '@/lib/overlay-interaction/body-overlay-attributes'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'
import { Toaster } from './sonner'

vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/store/index', () => {
  const state = { settings: { theme: 'light' } }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  return { useAppStore }
})

let disposeOverlays: () => void
let root: Root
let container: HTMLDivElement

function Scene({ dialogOpen }: { dialogOpen: boolean }): React.JSX.Element {
  return (
    <>
      <Toaster />
      <Dialog open={dialogOpen}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Opened by the user</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  )
}

// One frame (deferred nudge creation, Sonner dismiss) then zero-delay tasks (Sonner delivery).
const settle = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => setTimeout(resolve, 0), 0)))
const raised = (): boolean => document.querySelector('[data-toasts-raised]') !== null
const toastWith = (text: string): Element | undefined =>
  [...document.querySelectorAll('[data-sonner-toast]')].find((element) =>
    element.textContent?.includes(text)
  )

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  disposeOverlays = installBodyOverlayAttributes()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Scene dialogOpen={false} />)
    await settle()
  })
})

afterEach(async () => {
  await act(async () => {
    toast.dismiss()
    await settle()
    root.unmount()
  })
  container.remove()
  disposeOverlays()
})

it('keeps a toast published just before a dialog opens behind that dialog', async () => {
  await act(async () => {
    toast.info('Published before the dialog')
    // The dialog's portal connects before Sonner delivers the toast a task later.
    flushSync(() => root.render(<Scene dialogOpen />))
    await settle()
  })
  expect(document.body.hasAttribute('data-modal-overlay-open')).toBe(true)
  expect(toastWith('Published before the dialog')).toBeDefined()
  expect(raised()).toBe(false)
})

it('keeps an already shown toast in place behind a dialog', async () => {
  await act(async () => {
    toast.info('Shown before the dialog')
    await settle()
  })
  const shown = toastWith('Shown before the dialog')
  expect(shown).toBeDefined()
  await act(async () => {
    root.render(<Scene dialogOpen />)
    await settle()
  })
  expect(raised()).toBe(false)
  expect(toastWith('Shown before the dialog')).toBe(shown)
})

it('still raises a toast that the open dialog itself shows', async () => {
  await act(async () => {
    root.render(<Scene dialogOpen />)
    await settle()
  })
  await act(async () => {
    toast.error('Raised by the dialog')
    await settle()
  })
  expect(toastWith('Raised by the dialog')).toBeDefined()
  expect(raised()).toBe(true)
})
