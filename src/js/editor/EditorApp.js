/**
 * EditorApp.js — preset source-code editor popup
 *
 * Butterchurn presets: each top-level key becomes a tab.
 * Shadertoy presets: single GLSL editor tab.
 *
 * Incoming:  { type: 'editor-load', presetName, content, language, group }
 * Outgoing:  { type: 'editor-ready' }
 */

import { basicSetup }  from 'codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView }  from '@codemirror/view'
import { oneDark }     from '@codemirror/theme-one-dark'
import { json }        from '@codemirror/lang-json'
import { cpp }         from '@codemirror/lang-cpp'

const ch = new BroadcastChannel('visualizer-editor')

// ── DOM refs ──────────────────────────────────────────────────────────────
let _tabbarEl = null
let _bodyEl   = null
let _applyEl   = null
let _copyEl    = null
let _pasteEl   = null
let _revertEl  = null
let _lastLoad  = null   // last editor-load payload for Revert

// All live CodeMirror views (destroyed on reload)
let _views = []

// ── Apply state ──────────────────────────────────────────────────────────────
let _currentPreset   = null   // full parsed preset object (butterchurn)
let _currentLanguage = 'json' // 'json' | 'glsl'

// ── Tab definitions (curated order) ──────────────────────────────────────
const TAB_DEFS = [
  { key: 'baseVals',      label: 'Base Vals',  type: 'json-obj' },
  { key: 'init_eqs_str',  label: 'Init EQs',   type: 'eq'       },
  { key: 'frame_eqs_str', label: 'Frame EQs',  type: 'eq'       },
  { key: 'pixel_eqs_str', label: 'Pixel EQs',  type: 'eq'       },
  { key: 'warp',          label: 'Warp',        type: 'glsl'     },
  { key: 'comp',          label: 'Comp',        type: 'glsl'     },
  { key: 'shapes',        label: 'Shapes',      type: 'items'    },
  { key: 'waves',         label: 'Waves',       type: 'items'    },
]

// ── Helpers ───────────────────────────────────────────────────────────────

// Format semicolon-separated expressions one-per-line
function _fmtEqs(str) {
  return str
    .replace(/\n/g, ' ')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s + ';\n')
    .join('')
}

// Strip the `shader_body { }` wrapper for display, preserving the exact
// head (everything up to and including the newline after `{`) and tail
// (the closing `\n }`) so Apply/Copy can reconstruct byte-for-byte.
function _stripShaderBodyEx(glsl) {
  // Capture: head = preamble + " shader_body { \n"; body; tail = "\n }"
  const m = glsl.match(/^([\s\S]*?[ \t]*shader_body[^\n]*\n)([\s\S]*?)(\n[ \t]*\})\s*$/)
  if (!m) return { displayed: glsl, hadWrapper: false, head: '', tail: '' }
  return { displayed: m[2], hadWrapper: true, head: m[1], tail: m[3] }
}

// ── CodeMirror factories ──────────────────────────────────────────────────

const _baseExts = [oneDark]

function _langExt(type) {
  if (type === 'glsl')     return cpp()
  if (type === 'json-obj') return json()
  return EditorView.lineWrapping   // eq / text
}

// A self-scrolling editor that fills its parent
function _makeFillView(parent, content, type) {
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        ..._baseExts,
        basicSetup,
        _langExt(type),
        EditorView.theme({
          '&':            { height: '100%' },
          '.cm-scroller': { overflow: 'auto', height: '100%' },
        }),
      ],
    }),
    parent,
  })
  _views.push(view)
  return view
}

// An auto-height editor (outer container scrolls)
function _makeFlowView(parent, content, type) {
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        ..._baseExts,
        basicSetup,
        _langExt(type),
        EditorView.theme({
          '&':            { height: 'auto' },
          '.cm-scroller': { overflow: 'visible' },
        }),
      ],
    }),
    parent,
  })
  _views.push(view)
  return view
}

// ── Tab panel builders ────────────────────────────────────────────────────

function _buildSinglePanel(el, content, type) {
  el.classList.add('panel-fill')
  return _makeFillView(el, content, type)
}

// Shapes / waves: stacked sub-sections for each enabled item
function _buildItemsPanel(el, items, key) {
  el.classList.add('panel-scroll')
  const itemLabel = key === 'shapes' ? 'Shape' : 'Wave'
  const EQ_FIELDS = [
    { key: 'init_eqs_str',  label: 'Init EQs'  },
    { key: 'frame_eqs_str', label: 'Frame EQs' },
    { key: 'pixel_eqs_str', label: 'Pixel EQs' },
  ]

  // Only include enabled items
  const enabled = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item?.baseVals?.enabled !== 0)

  if (!enabled.length) {
    const msg = document.createElement('div')
    msg.className = 'panel-empty'
    msg.textContent = `No enabled ${itemLabel.toLowerCase()}s`
    el.appendChild(msg)
    return
  }

  for (const { item, i } of enabled) {
    const section = document.createElement('div')
    section.className = 'sub-section'

    const hdr = document.createElement('div')
    hdr.className = 'sub-section-hdr'
    hdr.textContent = `${itemLabel} ${i + 1}`
    section.appendChild(hdr)

    // baseVals
    if (item.baseVals && Object.keys(item.baseVals).length > 1) {
      _appendSubEditor(section, 'Base Vals', JSON.stringify(item.baseVals, null, 2), 'json-obj')
    }

    // eq strings
    for (const f of EQ_FIELDS) {
      if (typeof item[f.key] === 'string' && item[f.key].trim()) {
        _appendSubEditor(section, f.label, _fmtEqs(item[f.key]), 'eq')
      }
    }

    el.appendChild(section)
  }
}

function _appendSubEditor(parent, label, content, type) {
  const wrap = document.createElement('div')
  wrap.className = 'sub-editor'

  const lbl = document.createElement('div')
  lbl.className = 'sub-editor-label'
  lbl.textContent = label
  wrap.appendChild(lbl)

  const mount = document.createElement('div')
  wrap.appendChild(mount)
  _makeFlowView(mount, content, type)

  parent.appendChild(wrap)
}

// ── Tab bar ───────────────────────────────────────────────────────────────

let _activeKey = null
const _panels   = new Map()   // key → panel element
const _tabViews = new Map()   // key → primary EditorView (for requestMeasure / Apply)
const _tabMeta  = new Map()   // key → { type, hadWrapper?, preamble? } for Apply

function _activateTab(key) {
  if (_activeKey === key) return
  _activeKey = key

  _tabbarEl.querySelectorAll('.ed-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === key)
  })

  for (const [k, el] of _panels) {
    const isActive = k === key
    el.classList.toggle('active', isActive)
  }

  // After making active, let CodeMirror re-measure in case it was hidden
  const panel = _panels.get(key)
  if (panel) {
    requestAnimationFrame(() => {
      _views.forEach(v => {
        if (panel.contains(v.dom)) v.requestMeasure()
      })
    })
  }
}

function _buildTabUI(tabs) {
  // Only remove tab buttons — #ed-apply must survive the rebuild
  _tabbarEl.querySelectorAll('.ed-tab').forEach(el => el.remove())
  _bodyEl.innerHTML = ''
  _panels.clear()
  _tabMeta.clear()
  _tabViews.clear()

  for (const tab of tabs) {
    // Tab button — insert before #ed-apply so tabs appear to the left of it
    const btn = document.createElement('button')
    btn.className    = 'ed-tab'
    btn.dataset.key  = tab.key
    btn.textContent  = tab.label
    btn.addEventListener('click', () => _activateTab(tab.key))
    // Insert before #ed-copy so tabs stay left of the action buttons
    _tabbarEl.insertBefore(btn, _copyEl)

    // Panel
    const panel = document.createElement('div')
    panel.className  = 'ed-panel'
    _bodyEl.appendChild(panel)
    _panels.set(tab.key, panel)

    // Populate panel (and record metadata for Apply reconstruction)
    if (tab.type === 'glsl') {
      const { displayed, hadWrapper, head, tail } = _stripShaderBodyEx(tab.value)
      _tabMeta.set(tab.key, { type: 'glsl', hadWrapper, head, tail })
      _tabViews.set(tab.key, _buildSinglePanel(panel, displayed, tab.type))
    } else if (tab.type === 'eq') {
      _tabMeta.set(tab.key, { type: 'eq' })
      _tabViews.set(tab.key, _buildSinglePanel(panel, _fmtEqs(tab.value), tab.type))
    } else if (tab.type === 'json-obj') {
      _tabMeta.set(tab.key, { type: 'json-obj' })
      _tabViews.set(tab.key, _buildSinglePanel(panel, JSON.stringify(tab.value, null, 2), tab.type))
    } else if (tab.type === 'items') {
      _tabMeta.set(tab.key, { type: 'items' })
      _buildItemsPanel(panel, tab.value, tab.key)
    }
  }

  // Activate first tab
  if (tabs.length) _activateTab(tabs[0].key)
}

// ── Load ──────────────────────────────────────────────────────────────────

function _load({ presetName = '', content = '', language = 'json', group = '' } = {}) {
  document.title = `\u270e ${presetName}`

  // Remove placeholder (belt + suspenders)
  document.getElementById('ed-empty')?.remove()

  // Apply/Revert buttons only make sense for butterchurn (JSON) presets
  if (_applyEl)  _applyEl.style.display  = language === 'json' ? '' : 'none'
  if (_revertEl) _revertEl.style.display = language === 'json' ? '' : 'none'

  // Destroy all previous views
  _views.forEach(v => v.destroy())
  _views = []
  _activeKey = null
  _panels.clear()
  _currentPreset   = null
  _currentLanguage = language

  if (language === 'json') {
    // ── Butterchurn ───────────────────────────────────────────────────────
    let parsed
    try { parsed = JSON.parse(content) } catch {
      // Malformed — show raw in a single editor
      _tabbarEl.innerHTML = ''
      _bodyEl.innerHTML = ''
      const panel = document.createElement('div')
      panel.className = 'ed-panel'
      _bodyEl.appendChild(panel)
      _buildSinglePanel(panel, content, 'json-obj')
      _panels.set('__raw', panel)
      _activateTab('__raw')
      return
    }

    _currentPreset = parsed
    const tabs = TAB_DEFS
      .filter(({ key, type }) => {
        const val = parsed[key]
        if (val === undefined || val === null) return false
        if (typeof val === 'string' && !val.trim()) return false
        if (Array.isArray(val) && !val.some(item => item?.baseVals?.enabled !== 0)) return false
        return true
      })
      .map(def => ({ ...def, value: parsed[def.key] }))

    _buildTabUI(tabs)
  } else {
    // ── Shadertoy GLSL ────────────────────────────────────────────────────
    _buildTabUI([{ key: 'glsl', label: 'Shader', type: 'glsl', value: content }])
  }
}

// ── Apply (reconstruct edited preset → push to visualizer) ─────────────────────

function _reconstructPreset() {
  if (!_currentPreset || _currentLanguage !== 'json') return null
  // Deep-clone so we never mutate the stored original
  const preset = JSON.parse(JSON.stringify(_currentPreset))

  for (const [key] of _panels) {
    const meta = _tabMeta.get(key)
    const view = _tabViews.get(key)
    if (!meta || !view) continue  // items panels have no primary view

    const content = view.state.doc.toString()

    if (meta.type === 'json-obj') {
      try { preset[key] = JSON.parse(content) }
      catch (e) { console.warn(`[Apply] JSON parse error in "${key}":`, e); return null }
    } else if (meta.type === 'eq') {
      preset[key] = content.split('\n').map(s => s.trim().replace(/\s*;\s*$/, '')).filter(Boolean).map(s => s + ';').join('')
    } else if (meta.type === 'glsl') {
      if (!meta.hadWrapper) {
        preset[key] = content
      } else {
        // Re-wrap using the exact original head/tail to preserve whitespace
        preset[key] = meta.head + content + meta.tail
      }
    }
    // items: skip — structural complexity; original shape preserved
  }

  return preset
}

function _applyPreset() {
  const preset = _reconstructPreset()
  if (!preset) {
    console.warn('[Apply] Could not reconstruct preset')
    return
  }
  ch.postMessage({ type: 'editor-apply-preset', preset })
  console.log('[Apply] Preset sent to visualizer')
}

// ── Init ──────────────────────────────────────────────────────────────────────────

function init() {
  _tabbarEl = document.getElementById('ed-tabbar')
  _bodyEl   = document.getElementById('ed-body')
  _applyEl  = document.getElementById('ed-apply')
  _copyEl   = document.getElementById('ed-copy')
  _pasteEl  = document.getElementById('ed-paste')
  _revertEl = document.getElementById('ed-revert')

  _applyEl?.addEventListener('click', _applyPreset)
  _revertEl?.addEventListener('click', () => { if (_lastLoad) _load(_lastLoad) })

  _pasteEl?.addEventListener('click', () => {
    navigator.clipboard.readText().then(text => {
      const base = _lastLoad || {}
      _load({ ...base, type: 'editor-load', content: text, language: 'json',
              presetName: base.presetName ? `${base.presetName} (pasted)` : '(pasted)' })
    }).catch(err => console.error('[Paste] Clipboard read failed:', err))
  })

  _copyEl?.addEventListener('click', () => {
    const preset = _reconstructPreset()
    if (!preset) { console.warn('[Copy] Could not reconstruct preset'); return }
    const text = JSON.stringify(preset)
    navigator.clipboard.writeText(text).then(() => {
      _copyEl.classList.add('copied')
      _copyEl.textContent = 'Copied'
      setTimeout(() => { _copyEl.classList.remove('copied'); _copyEl.textContent = 'Copy' }, 1500)
    }).catch(err => console.error('[Copy] Clipboard write failed:', err))
  })

  // Listen for content AFTER DOM is fully ready
  ch.addEventListener('message', (e) => {
    if (e.data?.type === 'editor-load') { _lastLoad = e.data; _load(e.data) }
  })

  // Signal readiness — App.js will deliver any buffered content
  ch.postMessage({ type: 'editor-ready' })
}

document.addEventListener('DOMContentLoaded', init)
