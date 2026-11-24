'use strict'

// Hide loading status immediately when script starts
const statusEl = document.getElementById('status')
if (statusEl) statusEl.hidden = true

// Model onboarding lives in the conversation, not in a separate VS Code form.
// Keys only travel Webview -> extension -> DSH; results never echo them back.
const amo = {
  view: 'chat', provider: undefined, models: [], selected: [], operation: 0,
  busy: false, saved: false, requestId: 0, discoverTimer: undefined,
  hasCredential: false, connection: undefined, backToManage: false,
  presets: [
    { id: 'deepseek', name: 'DeepSeek', mark: 'D', baseURL: 'https://api.deepseek.com', api: 'openai-completions' },
    { id: 'openai', name: 'OpenAI', mark: 'O', baseURL: 'https://api.openai.com/v1', api: 'openai-completions' },
    { id: 'anthropic', name: 'Anthropic', mark: 'A', baseURL: 'https://api.anthropic.com', api: 'anthropic-messages' },
    { id: 'kimi-coding', name: 'Kimi', mark: 'K', baseURL: 'https://api.kimi.com/coding/v1', api: 'openai-completions' },
    { id: 'zai-coding-cn', name: 'GLM 智谱', mark: 'G', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions' },
    { id: 'google', name: 'Gemini', mark: 'G', baseURL: 'https://generativelanguage.googleapis.com/v1beta', api: 'openai-completions' },
    { id: 'qwen-token-plan-cn', name: 'Qwen 通义', mark: 'Q', baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
    { id: 'openrouter', name: 'OpenRouter', mark: 'OR', baseURL: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
    { id: 'moonshotai-cn', name: 'Moonshot', mark: 'M', baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
    { id: 'xai', name: 'xAI', mark: 'X', baseURL: 'https://api.x.ai/v1', api: 'openai-completions' },
    { id: 'groq', name: 'Groq', mark: 'G', baseURL: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
    { id: 'mistral', name: 'Mistral', mark: 'M', baseURL: 'https://api.mistral.ai', api: 'openai-completions' },
    { id: 'together', name: 'Together', mark: 'T', baseURL: 'https://api.together.ai/v1', api: 'openai-completions' },
    { id: 'fireworks', name: 'Fireworks', mark: 'F', baseURL: 'https://api.fireworks.ai/inference', api: 'openai-completions' },
    { id: 'baseten', name: 'Baseten', mark: 'B', baseURL: 'https://inference.baseten.co/v1', api: 'openai-completions' },
    { id: 'cerebras', name: 'Cerebras', mark: 'C', baseURL: 'https://api.cerebras.ai/v1', api: 'openai-completions' },
    { id: 'nvidia', name: 'NVIDIA', mark: 'N', baseURL: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions' },
    { id: 'minimax-cn', name: 'MiniMax', mark: 'M', baseURL: 'https://api.minimaxi.com/anthropic', api: 'anthropic-messages' },
    { id: 'huggingface', name: 'Hugging Face', mark: 'HF', baseURL: 'https://router.huggingface.co/v1', api: 'openai-completions' },
  ],
}
const amoById = id => document.getElementById(id)
function amoText(id, text) { amoById(id).textContent = text }
function amoRequest(type, params) {
  const requestId = ++amo.requestId
  vscode.postMessage({ type, requestId, params })
  return requestId
}
function amoDraft(includeModel = false) {
  const provider = amo.provider?.id === 'custom' ? amoById('amo-route').value.trim() : amo.provider?.id
  const key = amoById('amo-key').value.trim()
  const draft = {
    settingsNs: 'llm-pi-ai', provider, baseURL: amoById('amo-url').value.trim(),
    api: amoById('amo-protocol').value,
    ...key ? { apiKey: key } : {},
  }
  if (includeModel) {
    const selected = amo.models[amo.selected[0]]
    if (selected === undefined) return draft
    Object.assign(draft, {
        model: selected.id, modelName: amoById('amo-alias').value.trim() || selected.name,
      ...selected.contextWindow === undefined ? {} : { contextWindow: selected.contextWindow },
      ...selected.maxTokens === undefined ? {} : { maxTokens: selected.maxTokens },
      ...selected.inputModalities === undefined ? {} : { inputModalities: selected.inputModalities },
    })
  }
  return draft
}
function amoReady() {
  const draft = amoDraft(true)
  try { new URL(draft.baseURL) } catch { return false }
  return typeof draft.provider === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(draft.provider)
    && typeof draft.model === 'string' && draft.model.length > 0
}
function amoSetBusy(value) {
  amo.busy = value
  amoById('amo-test').disabled = value || !amoReady()
  amoById('amo-save').disabled = value || !amoReady()
  amoById('amo-rediscover').disabled = value
  amoText('amo-test', value ? '请稍候…' : '测试连接')
  amoText('amo-save', value ? '处理中…' : '保存并使用 →')
}
function amoError(text = '') {
  amoById('amo-form-error').hidden = !text
  amoText('amo-form-error', text)
}
function amoShow(view) {
  amo.view = view
  const chat = view === 'chat'
  if (!chat) empty.hidden = true
  amoById('model-onboarding').hidden = chat
  empty.hidden = !chat
  log.hidden = !chat
  // When onboarding is visible, hide the entire conversation shell to prevent overlap
  const conv = document.getElementById('conversation')
  if (conv) conv.hidden = !chat
  // Also hide the sticky prompt when showing onboarding
  const sticky = document.getElementById('sticky-prompt')
  if (sticky) {
    sticky.hidden = !chat
    if (!chat) hideStickyPrompt()
  }
  amoById('amo-provider-view').hidden = view !== 'providers'
  amoById('amo-config-view').hidden = view !== 'config'
  amoById('amo-manage-view').hidden = view !== 'manage'
  amoById('amo-config-footer').hidden = view !== 'config'
  amoById('bottom').hidden = view === 'config'
  amoById('model-menu').hidden = true
  // Remove any orphaned submenus appended to <body> by a previous open
  document.querySelectorAll('body > .amo-model-submenu').forEach(el => el.remove())
  if (!chat) { const c = document.getElementById('conversation'); if (c) c.scrollTop = 0 }
  applyTrustState()
}
function amoReset(preserveKey = false) {
  ++amo.operation
  clearTimeout(amo.discoverTimer)
  amo.models = []
  amo.selected = []
  amoSetBusy(false)
  amoError()
  amoById('amo-test-result').hidden = true
  amoById('amo-model-area').hidden = true
  amoText('amo-discovery', '填写后将自动获取可用模型')
  if (!preserveKey) amoById('amo-key').value = ''
}
function amoOpenProvider(preset, edit = false) {
  ++amo.operation
  clearTimeout(amo.discoverTimer)
  if (!edit && !amo.backToManage) amo.backToManage = amo.view === 'manage'
  amo.provider = preset
  amo.editing = edit
  amoText('amo-config-heading', `连接 ${preset.name}`)
  amoText('amo-selected-name', preset.name)
  amoText('amo-selected-mark', preset.mark)
  amoText('amo-selected-kind', preset.id === 'custom' ? '中转站、企业网关或其他厂商' : '内置服务商 · 地址与协议已预填')
  const custom = preset.id === 'custom'
  amoById('amo-custom-name-field').hidden = !custom
  amoById('amo-route-field').hidden = !custom
  amoById('amo-url-field').hidden = !custom
  if (!edit) {
    amoById('amo-url').value = preset.baseURL ?? ''
    amoById('amo-advanced-url').value = preset.baseURL ?? ''
    amoById('amo-protocol').value = preset.api ?? 'openai-completions'
    amoById('amo-route').value = custom ? 'custom-api' : preset.id
    amoById('amo-custom-name').value = custom ? '我的模型服务' : preset.name
    amoById('amo-route').disabled = false
  }
  if (preset.id === 'custom') {
    amo.hasCredential = false
    amoById('amo-key').placeholder = '粘贴服务商提供的 API Key；无密钥端点可留空'
    amoById('amo-key').disabled = false
  } else if (!edit) {
    amo.hasCredential = false
    amoById('amo-key').placeholder = '粘贴服务商提供的 API Key'
    amoById('amo-key').disabled = false
  } else {
    amoById('amo-key').disabled = false
  }
  amoReset(edit)
  amoShow('config')
  if (preset.id !== 'custom' && !edit) amoScheduleDiscovery()
}
function amoRenderProviders() {
  const query = amoById('amo-provider-search').value.trim().toLowerCase()
  const matches = amo.presets.filter(preset => `${preset.name} ${preset.id}`.toLowerCase().includes(query))
  const grid = amoById('amo-provider-grid')
  grid.replaceChildren()
  for (const preset of matches) {
    // DeepSeek presets match any DSH built-in deepseek-family provider
    const DEEPSEEK_FAMILY = ['deepseek', 'deepseek-account', 'deepseek-official']
    const existing = preset.id === 'deepseek'
      ? modelGroups.find(group => DEEPSEEK_FAMILY.includes(group.provider))
      : modelGroups.find(group => group.provider === preset.id)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'amo-provider'
    button.dataset.provider = preset.id
    const mark = document.createElement('span')
    mark.className = 'amo-provider-mark'
    mark.textContent = preset.mark
    const name = document.createElement('span')
    name.textContent = preset.name
    button.append(mark, name)
    if (existing) {
      button.style.opacity = '0.6'
      button.title = '已配置，点击进入编辑'
      const badge = document.createElement('small')
      badge.textContent = '已配置'
      badge.style.cssText = 'margin-left:auto;font-size:10px;color:var(--vscode-charts-green)'
      button.appendChild(badge)
    }
    button.addEventListener('click', () => {
      if (existing) {
        // Edit mode: load existing config
        amoOpenProvider(preset, true)
        amoRequest('providerConfig', { settingsNs: 'llm-pi-ai', provider: preset.id })
        amo.configRequest = amo.requestId
      } else {
        amoOpenProvider(preset)
      }
    })
    grid.appendChild(button)
  }
  amoById('amo-provider-empty').hidden = matches.length > 0
}
function amoSelectModel(index) {
  if (index < 0 || index >= amo.models.length) return
  amo.selected = [index]
  const selected = amo.models[index]
  amoById('amo-alias').value = selected.name
  amoText('amo-model-id', selected.id)
  for (const [position, button] of [...amoById('amo-model-list').children].entries()) {
    button.classList.toggle('is-selected', position === index)
    button.setAttribute('aria-checked', String(position === index))
  }
  amoById('amo-test-result').hidden = true
  amoError()
  amoSetBusy(false)
}
function amoRenderModels() {
  const list = amoById('amo-model-list')
  list.replaceChildren()
  amoById('amo-model-area').hidden = amo.models.length === 0
  amo.models.forEach((model, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'amo-model-option'
    button.setAttribute('role', 'checkbox')
    button.setAttribute('aria-checked', String(amo.selected.includes(index)))
    const checkbox = document.createElement('span')
    checkbox.className = 'amo-checkbox'
    checkbox.textContent = amo.selected.includes(index) ? '☑' : '☐'
    const name = document.createElement('span')
    name.textContent = model.id
    name.title = model.id
    button.append(checkbox, name)
    if (model.contextWindow !== undefined) {
      const capacity = document.createElement('small')
      capacity.textContent = formatTokenCount(model.contextWindow)
      button.appendChild(capacity)
    }
    button.addEventListener('click', () => amoToggleModel(index))
    list.appendChild(button)
  })
  // Select first model by default if none selected
  if (amo.selected.length === 0 && amo.models.length > 0) {
    amo.selected = [0]
  }
  // Update UI for all models
  for (const [position, button] of [...list.children].entries()) {
    const selected = amo.selected.includes(position)
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-checked', String(selected))
    button.querySelector('.amo-checkbox').textContent = selected ? '☑' : '☐'
  }
  const firstSelected = amo.models[amo.selected[0]]
  if (firstSelected) {
    amoById('amo-alias').value = firstSelected.name
    amoText('amo-model-id', firstSelected.id)
  }
  amoById('amo-test-result').hidden = true
  amoError()
  amoSetBusy(false)
  amoText('amo-discovery', `已发现 ${amo.models.length} 个模型，已选择 ${amo.selected.length} 个`)
}

function amoToggleModel(index) {
  const pos = amo.selected.indexOf(index)
  if (pos >= 0) amo.selected.splice(pos, 1)
  else amo.selected.push(index)
  if (amo.selected.length === 0) amo.selected = [index] // Keep at least one selected
  const list = amoById('amo-model-list')
  for (const [position, button] of [...list.children].entries()) {
    const selected = amo.selected.includes(position)
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-checked', String(selected))
    button.querySelector('.amo-checkbox').textContent = selected ? '☑' : '☐'
  }
  const firstSelected = amo.models[amo.selected[0]]
  if (firstSelected) {
    amoById('amo-alias').value = firstSelected.name
    amoText('amo-model-id', firstSelected.id)
  }
  amoById('amo-test-result').hidden = true
  amoError()
  amoSetBusy(false)
  amoText('amo-discovery', `已发现 ${amo.models.length} 个模型，已选择 ${amo.selected.length} 个`)
}

function amoSelectAllModels() {
  if (amo.selected.length === amo.models.length) {
    amo.selected = []
  } else {
    amo.selected = amo.models.map((_, i) => i)
  }
  if (amo.selected.length === 0 && amo.models.length > 0) amo.selected = [0]
  const list = amoById('amo-model-list')
  for (const [position, button] of [...list.children].entries()) {
    const selected = amo.selected.includes(position)
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-checked', String(selected))
    button.querySelector('.amo-checkbox').textContent = selected ? '☑' : '☐'
  }
  const firstSelected = amo.models[amo.selected[0]]
  if (firstSelected) {
    amoById('amo-alias').value = firstSelected.name
    amoText('amo-model-id', firstSelected.id)
  }
  amoText('amo-discovery', `已发现 ${amo.models.length} 个模型，已选择 ${amo.selected.length} 个`)
}
function amoDiscover() {
  clearTimeout(amo.discoverTimer)
  const draft = amoDraft()
  if (!draft.provider || !draft.baseURL) {
    amoText('amo-discovery', '请先填写服务名称、API 地址和密钥')
    return
  }
  const operation = ++amo.operation
  const requestId = amoRequest('discoverModels', draft)
  amo.discoverRequest = requestId
  amoSetBusy(true)
  const loading = document.createElement('span')
  loading.textContent = '正在获取模型列表…'
  const spinner = document.createElement('span')
  spinner.className = 'amo-spinner'
  amoById('amo-discovery').replaceChildren(loading, spinner)
  amoError()
  void operation
}
function amoScheduleDiscovery() {
  clearTimeout(amo.discoverTimer)
  amo.operation++
  if (!amoById('amo-key').value.trim() || !amoById('amo-url').value.trim()) return
  amoText('amo-discovery', '已输入密钥，即将自动获取模型…')
  amo.discoverTimer = setTimeout(amoDiscover, 700)
}
function amoSave() {
  if (!amoReady() || amo.busy) return
  const draft = amoDraft(true)
  const selectedModels = amo.selected.map(index => ({
    ...amo.models[index],
    name: index === amo.selected[0] ? (amoById('amo-alias').value.trim() || amo.models[index].name || amo.models[index].id) : amo.models[index].name || amo.models[index].id,
    input: amo.models[index].inputModalities ?? ['text'],
  }))
  if (selectedModels.length === 0) return
  amoSetBusy(true)
  amoError()
  amoRequest('saveCustomProvider', {
    ...draft, displayName: amoById('amo-custom-name').value.trim() || amo.provider.name,
    models: selectedModels,
  })
  amo.saveRequest = amo.requestId
}
function amoRenderManage() {
  const list = amoById('amo-manage-list')
  list.replaceChildren()
  for (const group of modelGroups) {
    const row = document.createElement('div')
    row.className = 'amo-manage-row'
    const mark = document.createElement('span')
    mark.className = 'amo-provider-mark'
    mark.textContent = group.name.slice(0, 2).toUpperCase()
    const copy = document.createElement('span')
    const name = document.createElement('strong')
    name.textContent = group.name
    const status = document.createElement('small')
    status.textContent = `${group.models.length} 个模型 · 凭据由 DSH 私密保存`
    copy.append(name, status)
    const preset = amo.presets.find(item => item.id === group.provider)
    const edit = document.createElement('button')
    edit.className = 'amo-text-button'
    edit.textContent = '编辑'
    edit.addEventListener('click', () => {
      amoOpenProvider(preset ?? { id: group.provider, name: group.name, mark: group.name.slice(0, 1), api: 'openai-completions' }, true)
      amoText('amo-discovery', '正在读取已有配置，不会读取密钥…')
      amoRequest('providerConfig', { provider: group.provider })
      amo.configRequest = amo.requestId
    })
    row.append(mark, copy, edit)
    if (group.deletable !== false) {
      const remove = document.createElement('button')
      remove.className = 'amo-text-button'
      remove.textContent = '删除'
      remove.addEventListener('click', () => {
        // VS Code webview may block window.confirm, use direct delete with visual feedback
        if (remove.textContent === '确认删除？') {
          // Only delete the user-created custom provider. DSH built-ins
          // (deepseek-account / deepseek-official) are protected and cannot be deleted.
          const DEEPSEEK_FAMILY = ['deepseek', 'deepseek-account', 'deepseek-official']
          const toDelete = DEEPSEEK_FAMILY.includes(group.provider) ? ['deepseek'] : [group.provider]
          toDelete.forEach(id => amoRequest('deleteCustomProvider', { provider: id }))
          remove.disabled = true
          remove.textContent = '删除中…'
        } else {
          remove.textContent = '确认删除？'
          remove.style.color = 'var(--vscode-errorForeground)'
          // Reset after 3 seconds if not confirmed
          setTimeout(() => {
            if (remove.textContent === '确认删除？') {
              remove.textContent = '删除'
              remove.style.color = ''
            }
          }, 3000)
        }
      })
      row.appendChild(remove)
    }
    list.appendChild(row)
  }
}
// Format token counts for display: 1048576 → "1.0M", 262144 → "256K", 128000 → "128K"
function formatTokenCount(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

// Global state: only one submenu can be open at a time. Shared by the main
// composer picker and the model selector inside history editors.
let activeSubMenu = null
let activeProviderEntry = null
let subMenuCloseTimer = null
const scheduleSubMenuClose = () => {
  clearTimeout(subMenuCloseTimer)
  subMenuCloseTimer = setTimeout(() => {
    if (activeSubMenu) activeSubMenu.style.display = 'none'
    if (activeProviderEntry) activeProviderEntry.style.background = 'none'
    activeSubMenu = null
    activeProviderEntry = null
  }, 200)
}
const cancelSubMenuClose = () => clearTimeout(subMenuCloseTimer)
const openSubMenu = (providerEntry, subMenu) => {
  cancelSubMenuClose()
  // Close any previously open submenu immediately
  if (activeSubMenu && activeSubMenu !== subMenu) {
    activeSubMenu.style.display = 'none'
    if (activeProviderEntry) activeProviderEntry.style.background = 'none'
  }
  activeSubMenu = subMenu
  activeProviderEntry = providerEntry
  // Attach the submenu to <body> so it is not clipped by any parent overflow
  // and can use pure viewport coordinates.
  if (subMenu.parentElement !== document.body) document.body.appendChild(subMenu)
  subMenu.style.visibility = 'hidden'
  subMenu.style.display = 'block'
  const rect = providerEntry.getBoundingClientRect()
  const subWidth = subMenu.offsetWidth
  const subHeight = subMenu.offsetHeight
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  // Right edge of submenu = left edge of provider row - 4px gap (no overlap).
  let left = rect.left - subWidth - 4
  if (left < 0) left = Math.max(0, viewportWidth - subWidth - 4)
  // Align submenu top exactly with the provider row top.
  let top = rect.top
  if (top + subHeight > viewportHeight) top = Math.max(0, viewportHeight - subHeight - 4)
  subMenu.style.left = `${left}px`
  subMenu.style.top = `${top}px`
  subMenu.style.visibility = ''
  providerEntry.style.background = 'var(--vscode-list-hoverBackground)'
}
function closeAllModelMenus() {
  clearTimeout(subMenuCloseTimer)
  if (activeSubMenu) activeSubMenu.style.display = 'none'
  if (activeProviderEntry) activeProviderEntry.style.background = 'none'
  activeSubMenu = null
  activeProviderEntry = null
  document.querySelectorAll('body > .amo-model-submenu').forEach(el => el.remove())
}
// Render the two-level provider → model menu into any container.
// onSelect(provider, modelId) is called when a model entry is clicked.
function renderModelMenuEntries(container, onSelect) {
  container.replaceChildren()
  for (const group of modelGroups) {
    const providerEntry = document.createElement('div')
    providerEntry.className = 'amo-model-menu-provider'
    providerEntry.style.cssText = 'position:relative;padding:6px 8px;cursor:pointer;display:flex;justify-content:center;align-items:center;user-select:none;border-radius:4px'
    // Arrow on the left
    const arrow = document.createElement('span')
    arrow.textContent = '‹'
    arrow.style.cssText = 'opacity:0.5;margin-right:6px;font-size:11px;position:absolute;left:8px'
    providerEntry.appendChild(arrow)
    const nameSpan = document.createElement('span')
    nameSpan.textContent = group.name
    nameSpan.style.cssText = 'text-align:center'
    providerEntry.appendChild(nameSpan)
    const subMenu = document.createElement('div')
    subMenu.className = 'amo-model-submenu'
    subMenu.style.cssText = 'display:none;position:fixed;min-width:200px;padding:4px;border:1px solid var(--vscode-widget-border);border-radius:6px;background:var(--vscode-editorWidget-background);z-index:101;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    for (const option of group.models) {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.className = 'amo-model-menu-entry'
      entry.style.cssText = 'display:block;width:100%;text-align:left;padding:5px 8px;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;border-radius:3px;font-size:12px;white-space:nowrap'
      entry.textContent = option.name || option.id
      if (option.contextWindow !== undefined) {
        const capacity = document.createElement('small')
        capacity.style.cssText = 'opacity:0.6;margin-left:6px;font-size:11px'
        capacity.textContent = formatTokenCount(option.contextWindow)
        entry.appendChild(capacity)
      }
      entry.addEventListener('click', () => {
        onSelect(group.provider, option.id)
        closeAllModelMenus()
      })
      entry.addEventListener('mouseenter', () => { entry.style.background = 'var(--vscode-list-hoverBackground)' })
      entry.addEventListener('mouseleave', () => { entry.style.background = 'none' })
      subMenu.appendChild(entry)
    }
    providerEntry.addEventListener('mouseenter', () => openSubMenu(providerEntry, subMenu))
    providerEntry.addEventListener('mouseleave', scheduleSubMenuClose)
    subMenu.addEventListener('mouseenter', cancelSubMenuClose)
    subMenu.addEventListener('mouseleave', scheduleSubMenuClose)
    // Do NOT append subMenu to providerEntry: we append it to document.body on hover
    // so it escapes any parent overflow clipping and uses pure viewport coordinates.
    container.appendChild(providerEntry)
  }
}
function amoRenderMenu() {
  renderModelMenuEntries(amoById('amo-menu-models'), (provider, modelId) => {
    selectedRoute = { provider, model: modelId }
    model.dataset.value = JSON.stringify([provider, modelId])
    model.dispatchEvent(new Event('change'))
    amoById('model-menu').hidden = true
  })
}
function modelDisplayName(provider, modelId) {
  for (const group of modelGroups) {
    const found = group.models.find(item => item.id === modelId && group.provider === provider)
    if (found) return found.name || found.id
  }
  return modelId
}
function amoOnboarding(available) {
  const changed = amo.hasModels !== available
  amo.hasModels = available
  if (available) {
    input.disabled = !trusted
    input.placeholder = '描述任务；@ 引用文件，Enter 发送，Shift+Enter 换行'
    // Only switch to chat if we're on providers or manage view, not on config view
    if (changed && (amo.view === 'providers' || amo.view === 'manage')) amoShow('chat')
  } else {
    input.value = ''
    input.disabled = true
    input.placeholder = '配置模型后，描述你的编码任务'
    if (amo.view === 'chat' || amo.view === 'manage') {
      amoRenderProviders()
      amoShow('providers')
    }
  }
}

function amoReturnToProviders() {
  const manage = amo.backToManage && amo.hasModels
  amo.backToManage = false
  if (manage) { amoRenderManage(); amoShow('manage') }
  else { amoRenderProviders(); amoShow('providers') }
}
for (const id of ['amo-custom-provider', 'amo-manage-add', 'amo-menu-add']) {
  amoById(id).addEventListener('click', () => {
    amo.backToManage = amo.hasModels && (id !== 'amo-custom-provider' ? amo.view === 'manage' : amo.backToManage)
    if (id === 'amo-custom-provider') amoOpenProvider({ id: 'custom', name: '自定义 API', mark: '＋', api: 'openai-completions' })
    else { amoRenderProviders(); amoShow('providers') }
  })
}
for (const id of ['amo-back', 'amo-change-provider']) amoById(id).addEventListener('click', amoReturnToProviders)
amoById('amo-provider-search').addEventListener('input', amoRenderProviders)
amoById('amo-show-key').addEventListener('click', () => {
  const key = amoById('amo-key')
  key.type = key.type === 'password' ? 'text' : 'password'
  amoText('amo-show-key', key.type === 'password' ? '显示' : '隐藏')
  amoById('amo-show-key').setAttribute('aria-label', key.type === 'password' ? '显示密钥' : '隐藏密钥')
})
for (const id of ['amo-key', 'amo-url', 'amo-route', 'amo-protocol', 'amo-advanced-url']) {
  amoById(id).addEventListener(id === 'amo-protocol' ? 'change' : 'input', () => {
    if (id === 'amo-advanced-url') amoById('amo-url').value = amoById(id).value
    if (id === 'amo-url') amoById('amo-advanced-url').value = amoById(id).value
    amoScheduleDiscovery()
  })
}
for (const id of ['amo-discover', 'amo-rediscover']) amoById(id).addEventListener('click', amoDiscover)
amoById('amo-select-all').addEventListener('click', amoSelectAllModels)
amoById('amo-alias').addEventListener('input', () => amoSetBusy(false))
amoById('amo-add-manual').addEventListener('click', () => {
  const id = amoById('amo-manual-id').value.trim()
  if (!id) { amoError('请输入服务商接受的真实模型 ID。'); return }
  const existing = amo.models.findIndex(model => model.id === id)
  if (existing < 0) amo.models.push({ id, name: id, inputModalities: ['text'] })
  amo.selected = [existing < 0 ? amo.models.length - 1 : existing]
  amoRenderModels()
  amoById('amo-manual-id').value = ''
  amoError()
})
amoById('amo-test').addEventListener('click', () => {
  if (!amoReady()) { amoError('请先填写 API 地址、API Key 并选择模型。'); return }
  amoSetBusy(true)
  amoById('amo-test-result').hidden = true
  amoError()
  amoRequest('testModel', amoDraft(true))
  amo.testRequest = amo.requestId
})
amoById('amo-save').addEventListener('click', amoSave)
amoById('amo-manage-back').addEventListener('click', () => amoShow('chat'))
amoById('amo-provider-back').addEventListener('click', () => amoShow('chat'))
amoById('amo-menu-manage').addEventListener('click', () => { amoRenderManage(); amoShow('manage') })
function amoModelMenuClick(event) {
  if (!model.disabled) {
    event.preventDefault()
    const menu = amoById('model-menu')
    const wasHidden = menu.hidden
    if (wasHidden) {
      // Clean up any stale submenus from a previous open before re-rendering
      document.querySelectorAll('body > .amo-model-submenu').forEach(el => el.remove())
    }
    amoRenderMenu()
    menu.hidden = !wasHidden
  }
}

function handleAmoMessage(message) {
  if (message.type === 'providerConfigResult') {
    if (message.requestId !== amo.configRequest || !amo.editing) return true
    if (message.error) { amoError(message.error); return true }
    const result = message.result
    if (result.models.length === 0) {
      const selected = modelGroups.find(group => group.provider === result.provider)?.models.find(item => item.id === currentRoute.model)
      if (selected !== undefined) result.models = [selected]
    }
    amo.provider = { ...amo.provider, id: result.provider, name: result.displayName, baseURL: result.baseURL, api: result.api }
    amoById('amo-route').value = result.provider
    amoById('amo-route').disabled = true
    amoById('amo-custom-name').value = result.displayName
    amoById('amo-url').value = result.baseURL ?? ''
    amoById('amo-advanced-url').value = result.baseURL ?? ''
    amoById('amo-protocol').value = result.api ?? 'openai-completions'
    amoById('amo-key').placeholder = result.hasCredential ? '已保存密钥；留空保持不变' : '粘贴服务商提供的 API Key'
    amo.hasCredential = result.hasCredential
    amo.models = result.models
    amo.selected = [Math.max(0, result.models.findIndex(item => item.id === currentRoute.model))]
    amoRenderModels()
    return true
  }
  if (message.type === 'discoverModelsResult') {
    if (message.requestId !== amo.discoverRequest || amo.view !== 'config') return true
    amoSetBusy(false)
    if (message.error) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'amo-text-button'
      retry.id = 'amo-discover'
      retry.textContent = '获取模型'
      retry.addEventListener('click', amoDiscover)
      amoById('amo-discovery').replaceChildren(document.createTextNode('自动获取失败，可重试或手动添加模型'), retry)
      amoError(message.error)
      return true
    }
    amo.models = message.models
    amo.selected = []
    amoRenderModels()
    return true
  }
  if (message.type === 'testModelResult') {
    if (message.requestId !== amo.testRequest || amo.view !== 'config') return true
    amoSetBusy(false)
    const result = amoById('amo-test-result')
    result.hidden = false
    result.className = message.error ? 'error' : 'success'
    result.textContent = message.error ? `连接失败：${message.error}` : `连接成功 · ${message.result.model} · ${message.result.durationMs} ms`
    return true
  }
  if (message.type === 'saveCustomProviderResult') {
    if (message.requestId !== amo.saveRequest) return true
    amoSetBusy(false)
    if (message.error) {
      amoError(`保存失败：${message.error}${message.error.includes('模型服务已保存') ? '。' : '。已输入的密钥仍保留，可直接重试。'}`)
      return true
    }
    amo.saved = true
    amoById('amo-key').value = ''
    amoShow('chat')
    amoById('ready-notice').hidden = false
    amoText('ready-notice', '模型已连接，可以开始编码')
    setTimeout(() => { amoById('ready-notice').hidden = true }, 5000)
    return true
  }
  if (message.type === 'deleteCustomProviderResult') {
    if (message.error) {
      reportError(`模型服务删除失败：${message.error}`)
      // Reset all delete buttons that may be stuck in "删除中…" state
      document.querySelectorAll('.amo-text-button').forEach(btn => {
        if (btn.textContent === '删除中…') {
          btn.textContent = '删除'
          btn.disabled = false
          btn.style.color = ''
        }
      })
      return true
    }
    vscode.postMessage({ type: 'modelCatalog' })
    amoRenderManage()
    return true
  }
  return false
}


// Global error handler to catch script execution failures
window.addEventListener('error', (event) => {
  const status = document.getElementById('status')
  if (status) {
    status.textContent = `脚本错误: ${event.message} (${event.filename}:${event.lineno})`
    status.style.color = 'red'
  }
  console.error('[AMO-FATAL]', event.error)
})

const vscode = acquireVsCodeApi()
const log = document.getElementById('log')
const conversation = document.getElementById('conversation')
const stickyPrompt = document.getElementById('sticky-prompt')
const stickyPromptText = stickyPrompt.querySelector('.user-collapsed')
const stickyPromptToggle = stickyPrompt.querySelector('.prompt-toggle')
const status = document.getElementById('status')
const input = document.getElementById('input')
const inputEditor = document.getElementById('input-editor')
const inputHighlight = document.getElementById('input-highlight')
const send = document.getElementById('send')
const model = document.getElementById('model')
const modelStatus = document.getElementById('model-status')

// Debug: log DOM element existence to console for troubleshooting
console.log('[AMO-DEBUG] DOM elements:', {
  log: !!log,
  model: !!model,
  modelStatus: !!modelStatus,
  modelMenu: !!document.getElementById('model-menu'),
  amoPanel: !!document.getElementById('amo-panel'),
  amoMenuAdd: !!document.getElementById('amo-menu-add'),
  amoMenuManage: !!document.getElementById('amo-menu-manage'),
})
const sessionSelect = document.getElementById('session-select')
const sessionMenu = document.getElementById('session-menu')
const sessionStatus = document.getElementById('session-status')
const refreshSessions = document.getElementById('refresh-sessions')
const empty = document.getElementById('empty')
const sendButton = document.getElementById('send')
let current
let sessions = []
const deletingSessions = new Set()
let activeSessionId = ''
let pendingSessionId = ''
let currentRoute = { provider: 'deepseek-account', model: 'deepseek-flash' }
let editorContext
const contextPreview = document.getElementById('context-preview')
let modelGroups = []
let selectedRoute
let modelSelectionVersion = 0
const toolCards = new Map()
const filePicker = document.getElementById('file-picker')
let workspaceFileList = []
let allWorkspaceFileList = []
let filteredFiles = []
let fileReferences = []
let fileTrigger
let fileActiveIndex = 0
let fileListRequested = false
let running = false
let streamFrame
let streamText = ''
let streamNode
let streamContent
/** Number of leading characters of the current assistant bubble already
 * rendered to static Markdown nodes; the remainder stays as live plain text. */
let streamRenderedLength = 0
let reasoningFrame
let reasoningText = ''
let reasoningNode
let reasoningCard
let reasoningBody
let followOutput = true
let stickyPromptElement
let stickyFrame
let editingUser
const userMessages = new Map()

// ── Image attachments ──────────────────────────────────────────────────────
/** @type {Array<{ type: 'image', data: string, mimeType: string, name?: string, previewUrl: string }>} */
let pendingImages = []
const IMAGE_MAX_SIZE = 5 * 1024 * 1024 // 5 MB base64 limit per image

function addImageAttachment(file) {
  if (pendingImages.length >= 5) {
    reportError('最多同时发送 5 张图片')
    return
  }
  // Support direct base64 injection (from VS Code explorer drops)
  if (typeof file.data === 'string' && typeof file.type === 'string' && file.type.startsWith('image/')) {
    const previewUrl = `data:${file.type};base64,${file.data}`
    pendingImages.push({
      type: 'image',
      data: file.data,
      mimeType: file.type,
      name: file.name,
      previewUrl,
    })
    renderImageChips()
    updateSendButton()
    return
  }
  if (file.size > IMAGE_MAX_SIZE) {
    reportError(`图片 "${file.name}" 超过 5MB 限制`)
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result
    const base64 = dataUrl.split(',')[1]
    if (!base64) { reportError(`图片 "${file.name}" 读取失败`); return }
    pendingImages.push({
      type: 'image',
      data: base64,
      mimeType: file.type || 'image/png',
      name: file.name,
      previewUrl: dataUrl,
    })
    renderImageChips()
    updateSendButton()
  }
  reader.onerror = () => reportError(`图片 "${file.name}" 读取失败`)
  reader.readAsDataURL(file)
}

function removeImageAttachment(index) {
  pendingImages.splice(index, 1)
  renderImageChips()
  updateSendButton()
}

function renderImageChips() {
  const container = document.getElementById('image-chips')
  if (!container) return
  container.innerHTML = ''
  if (pendingImages.length === 0) { container.hidden = true; return }
  container.hidden = false
  pendingImages.forEach((img, i) => {
    const chip = document.createElement('div')
    chip.className = 'image-chip'
    chip.style.cssText = 'position:relative;display:inline-block;margin:2px 4px 2px 0;border:1px solid var(--vscode-widget-border);border-radius:6px;overflow:hidden;max-width:80px;max-height:60px;'
    const thumb = document.createElement('img')
    thumb.src = img.previewUrl
    thumb.alt = img.name || 'image'
    thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
    chip.appendChild(thumb)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.title = '移除图片'
    remove.style.cssText = 'position:absolute;top:0;right:0;width:16px;height:16px;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;line-height:16px;text-align:center;cursor:pointer;border-radius:0 0 0 4px;padding:0;'
    remove.addEventListener('click', (e) => { e.stopPropagation(); removeImageAttachment(i) })
    chip.appendChild(remove)
    container.appendChild(chip)
  })
}

function clearImageAttachments() {
  pendingImages = []
  renderImageChips()
}

function extractImagesFromClipboard(items) {
  const images = []
  for (const item of items) {
    if (item.type.startsWith('image/')) images.push(item)
  }
  return images
}

// ── End image attachments ───────────────────────────────────────────────────

function updateInputHighlight() {
  const text = input.value
  const fragment = document.createDocumentFragment()
  // Only complete, selected workspace references are links; an unfinished @query stays plain text.
  const pattern = fileReferences.length === 0 ? undefined : new RegExp(fileReferences
    .map(reference => reference.path).sort((left, right) => right.length - left.length)
    .map(path => `@${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s)`).join('|'), 'g')
  let offset = 0
  if (pattern) for (const match of text.matchAll(pattern)) {
    fragment.appendChild(document.createTextNode(text.slice(offset, match.index)))
    const mention = document.createElement('span')
    mention.className = 'file-mention'
    mention.textContent = match[0]
    fragment.appendChild(mention)
    offset = match.index + match[0].length
  }
  fragment.appendChild(document.createTextNode(text.slice(offset)))
  inputHighlight.replaceChildren(fragment)
  inputHighlight.scrollTop = input.scrollTop
  inputHighlight.scrollLeft = input.scrollLeft
  inputEditor.style.height = `${input.offsetHeight}px`
}

function fileSearch() {
  if (fileTrigger === undefined) return
  const query = input.value.slice(fileTrigger + 1, input.selectionStart)
  if (/\s/.test(query) || input.selectionStart <= fileTrigger) { closeFilePicker(); return }
  const normalized = query.toLowerCase()
  filteredFiles = workspaceFileList.filter(file => {
    if (normalized.length === 0) return true
    const name = file.path.split('/').pop().toLowerCase()
    // Prefer filename initials, then fall back to matching the full workspace path.
    return name.startsWith(normalized) || file.path.toLowerCase().includes(normalized)
  })
    .sort((left, right) => {
      const leftName = left.path.split('/').pop().toLowerCase()
      const rightName = right.path.split('/').pop().toLowerCase()
      return Number(rightName.startsWith(normalized)) - Number(leftName.startsWith(normalized))
        || leftName.localeCompare(rightName) || left.path.localeCompare(right.path)
    }).slice(0, 50)
  fileActiveIndex = Math.min(fileActiveIndex, Math.max(0, filteredFiles.length - 1))
  filePicker.replaceChildren()
  if (filteredFiles.length === 0) {
    const emptyResult = document.createElement('div')
    emptyResult.id = 'file-empty'
    emptyResult.textContent = workspaceFileList.length === 0 ? '正在读取工作区文件…' : '没有匹配的文件'
    filePicker.appendChild(emptyResult)
  }
  filteredFiles.forEach((file, index) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'file-option' + (index === fileActiveIndex ? ' active' : '')
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(index === fileActiveIndex))
    const slash = file.path.lastIndexOf('/')
    const name = document.createElement('span')
    name.className = 'file-name'
    name.textContent = file.path.slice(slash + 1)
    const path = document.createElement('span')
    path.className = 'file-path'
    path.textContent = slash < 0 ? file.path : file.path.slice(0, slash)
    option.append(name, path)
    option.addEventListener('mousedown', event => { event.preventDefault(); chooseFile(index) })
    filePicker.appendChild(option)
  })
  filePicker.hidden = false
}

function closeFilePicker() {
  filePicker.hidden = true
  fileTrigger = undefined
  fileActiveIndex = 0
}

function updateFileSearch() {
  const cursor = input.selectionStart
  const before = input.value.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at < 0 || at > 0 && /[\w@./-]/.test(before[at - 1])) { closeFilePicker(); return }
  fileTrigger = at
  if (!fileListRequested) { fileListRequested = true; vscode.postMessage({ type: 'fileList' }) }
  fileSearch()
}

function chooseFile(index) {
  const file = filteredFiles[index]
  if (!file || fileTrigger === undefined) return
  const cursor = input.selectionStart
  input.value = `${input.value.slice(0, fileTrigger)}@${file.path} ${input.value.slice(cursor)}`
  if (!fileReferences.some(reference => reference.uri === file.uri)) fileReferences.push(file)
  const position = fileTrigger + file.path.length + 2
  input.setSelectionRange(position, position)
  closeFilePicker()
  updateInputHighlight()
  input.focus()
}

function renderModels(preserveSelection = true) {
  // model is now a <button>, not a <select>
  const route = selectedRoute ?? currentRoute
  model.dataset.value = JSON.stringify([route.provider, route.model])
  // Find display name for the current route
  let displayName = route.model
  for (const group of modelGroups) {
    const found = group.models.find(m => m.id === route.model && group.provider === route.provider)
    if (found) { displayName = found.name === found.id ? found.id : `${found.name}`; break }
  }
  model.textContent = displayName
  model.title = `${route.provider}/${route.model}`
}

function closeSessionMenu() {
  sessionMenu.hidden = true
  sessionSelect.setAttribute('aria-expanded', 'false')
}

function selectSession(sessionId) {
  flushStream()
  closeSessionMenu()
  if (!sessionId || sessionId === activeSessionId) return
  pendingSessionId = sessionId
  activeSessionId = sessionId
  renderSessions()
  sessionStatus.textContent = '正在恢复…'
  vscode.postMessage({ type: 'sessionSelect', sessionId })
}

function renderSessions() {
  const active = sessions.find(session => session.id === activeSessionId)
  sessionSelect.textContent = active?.title ?? '新会话'
  sessionSelect.title = active === undefined ? '切换当前工作区的历史会话' : `${active.title}\n${active.id}\n${active.cwd}`
  sessionMenu.replaceChildren()
  if (sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'session-empty'
    empty.textContent = '暂无历史会话'
    sessionMenu.appendChild(empty)
  }
  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = 'session-row'
    const option = document.createElement('button')
    option.className = 'session-option'
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(session.id === activeSessionId))
    option.setAttribute('aria-label', session.title)
    option.title = `${session.id}\n${session.cwd}`
    const title = document.createElement('span')
    title.className = 'session-title'
    title.textContent = session.title
    const time = document.createElement('span')
    time.className = 'session-time'
    time.textContent = new Date(session.updatedAt).toLocaleDateString()
    option.append(title, time)
    option.addEventListener('click', () => selectSession(session.id))
    const rename = document.createElement('button')
    rename.className = 'session-rename'
    rename.title = `重命名会话：${session.title}`
    rename.setAttribute('aria-label', `重命名会话：${session.title}`)
    rename.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
    rename.addEventListener('click', event => {
      event.stopPropagation()
      const current = sessions.find(item => item.id === session.id)
      const oldTitle = current?.title ?? session.title
      // Replace the title span with an inline input; prompt() is blocked in sandboxed webviews.
      const input = document.createElement('input')
      input.type = 'text'
      input.value = oldTitle
      input.className = 'session-rename-input'
      input.style.cssText = 'flex:1;min-width:0;padding:2px 4px;border:1px solid var(--vscode-focusBorder);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:inherit;'
      title.replaceWith(input)
      input.focus()
      input.select()
      const commit = () => {
        const trimmed = input.value.trim()
        if (trimmed.length > 0 && trimmed !== oldTitle) {
          if (current !== undefined) current.title = trimmed
          vscode.postMessage({ type: 'renameSession', sessionId: session.id, title: trimmed })
        }
        renderSessions()
      }
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') renderSessions()
      })
      input.addEventListener('blur', commit)
    })
    const exportButton = document.createElement('button')
    exportButton.className = 'session-export'
    exportButton.title = `导出会话为 Markdown：${session.title}`
    exportButton.setAttribute('aria-label', `导出会话：${session.title}`)
    exportButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>'
    exportButton.addEventListener('click', event => {
      event.stopPropagation()
      vscode.postMessage({ type: 'exportSession', sessionId: session.id })
    })
    const remove = document.createElement('button')
    remove.className = 'session-delete'
    remove.title = `删除会话：${session.title}`
    remove.setAttribute('aria-label', `删除会话：${session.title}`)
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg>'
    remove.addEventListener('click', event => {
      event.stopPropagation()
      if (deletingSessions.has(session.id)) return
      // Optimistic UI: disk and checkpoint cleanup never disable the picker.
      deletingSessions.add(session.id)
      sessions = sessions.filter(item => item.id !== session.id)
      if (activeSessionId === session.id) activeSessionId = ''
      renderSessions()
      sessionStatus.textContent = `${sessions.length} 个会话`
      vscode.postMessage({ type: 'sessionDelete', sessionId: session.id, session })
    })
    row.append(option, rename, exportButton, remove)
    sessionMenu.appendChild(row)
  }
  sessionStatus.textContent = pendingSessionId ? '正在恢复…' : activeSessionId ? '已恢复' : ''
}

function editHistory(message, element, inStickyPrompt = false) {
  console.log('[Webview] editHistory called, running:', running, 'seq:', element.dataset.userSeq, 'hasMessage:', !!message)
  if (running) return
  const seq = Number(element.dataset.userSeq)
  if (Number.isNaN(seq)) { console.log('[Webview] editHistory: seq is NaN'); return }
  const currentMessage = userMessages.get(seq) ?? element.historyMessage ?? message
  if (editingUser) editingUser.cancel()
  const target = inStickyPrompt ? stickyPrompt : element
  const previous = [...target.childNodes]
  if (inStickyPrompt) {
    stickyPrompt.classList.remove('expanded')
    stickyPromptText.textContent = ''
    stickyPromptToggle.setAttribute('aria-expanded', 'false')
  } else hideStickyPrompt()
  stickyPromptElement = element
  const editor = document.createElement('div')
  editor.className = 'history-edit'
  editor.addEventListener('click', event => {
    // Close the history model menu when clicking elsewhere inside the editor
    const menu = editor.querySelector('.history-model-menu')
    if (menu && !menu.hidden && !menu.contains(event.target) && event.target !== routeSelect) {
      menu.hidden = true
      closeAllModelMenus()
    }
    event.stopPropagation()
  })
  const textarea = document.createElement('textarea')
  textarea.value = currentMessage.text
  textarea.setAttribute('aria-label', '编辑历史消息并恢复代码重发')
  const actions = document.createElement('div')
  actions.className = 'actions'
  const hint = document.createElement('span')
  hint.className = 'history-hint'
  hint.textContent = typeof currentMessage.checkpointId === 'string'
    ? '回到此条消息之前：回滚后续代码与对话'
    : '仅回滚后续对话；此旧消息没有代码快照'

  // Show attached images in the edit form so the user knows they will be resent
  const editImages = document.createElement('div')
  editImages.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;'
  const currentImages = currentMessage.images || []
  if (currentImages.length > 0) {
    for (const img of currentImages) {
      const imgEl = document.createElement('img')
      imgEl.src = `data:${img.mimeType};base64,${img.data}`
      imgEl.alt = img.name || 'image'
      imgEl.style.cssText = 'max-width:80px;max-height:60px;border-radius:4px;object-fit:cover;'
      editImages.appendChild(imgEl)
    }
  }
  // History model picker: same two-level flyout as the composer model button.
  const routePicker = document.createElement('div')
  routePicker.className = 'history-model-picker'
  routePicker.style.cssText = 'position:relative;display:inline-block'
  const routeSelect = document.createElement('button')
  routeSelect.type = 'button'
  routeSelect.className = 'route-select history-model'
  routeSelect.title = '选择本次历史重发使用的模型'
  routeSelect.setAttribute('aria-label', '历史重发模型')
  let historyRoute = { provider: currentRoute.provider, model: currentRoute.model }
  const syncHistoryRouteLabel = () => {
    routeSelect.textContent = modelDisplayName(historyRoute.provider, historyRoute.model)
    routeSelect.title = `${historyRoute.provider}/${historyRoute.model}`
  }
  syncHistoryRouteLabel()
  const historyMenu = document.createElement('div')
  historyMenu.className = 'history-model-menu'
  historyMenu.hidden = true
  historyMenu.style.cssText = 'position:absolute;bottom:calc(100% + 4px);left:0;min-width:160px;max-width:240px;padding:5px;border:1px solid var(--vscode-widget-border);border-radius:7px;background:var(--vscode-editorWidget-background);z-index:100;box-shadow:0 -2px 8px rgba(0,0,0,0.15)'
  routePicker.append(routeSelect, historyMenu)
  routeSelect.addEventListener('click', event => {
    event.stopPropagation()
    if (historyMenu.hidden) {
      if (modelGroups.length === 0) refreshModelCatalog()
      renderModelMenuEntries(historyMenu, (provider, modelId) => {
        historyRoute = { provider, model: modelId }
        syncHistoryRouteLabel()
        historyMenu.hidden = true
      })
      historyMenu.hidden = false
    } else {
      historyMenu.hidden = true
      closeAllModelMenus()
    }
  })
  routeSelect.addEventListener('mousedown', event => event.stopPropagation())
  historyMenu.addEventListener('click', event => {
    // Clicks inside the menu (but not on model entries) keep the menu open;
    // model entry clicks close it via their own handler.
    event.stopPropagation()
  })
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'history-send'
  submit.title = typeof currentMessage.checkpointId === 'string' ? '回滚代码与对话并重新发送' : '仅回滚对话并重新发送'
  submit.setAttribute('aria-label', submit.title)
  submit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'cancel'
  cancel.title = '取消编辑'
  cancel.setAttribute('aria-label', '取消编辑')
  cancel.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>'
  actions.append(hint, routePicker, cancel, submit)
  editor.append(textarea, editImages, actions)
  target.replaceChildren(editor)
  if (inStickyPrompt) {
    target.classList.add('visible', 'editing')
    target.classList.remove('expanded')
    target.style.top = '6px'
  }
  const close = event => {
    event?.stopPropagation()
    editingUser = undefined
    closeAllModelMenus()
    if (inStickyPrompt) hideStickyPrompt()
    target.replaceChildren(...previous)
    bindHistory(userMessages.get(seq) ?? currentMessage, element)
    scheduleStickyPrompt()
  }
  editingUser = { cancel: close, element, inStickyPrompt }
  cancel.addEventListener('click', close)
  submit.addEventListener('click', event => {
    event.stopPropagation()
    if ((!textarea.value.trim() && (!currentMessage.images || currentMessage.images.length === 0)) || running) return
    const latest = userMessages.get(seq) ?? currentMessage
    const attachments = latest.images?.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType, name: img.name })) ?? []
    vscode.postMessage({ type: 'resend', sessionId: activeSessionId || undefined, seq, text: textarea.value.trim(), references: [], attachments, hasCheckpoint: typeof latest.checkpointId === 'string', route: { ...historyRoute } })
    close()
    busy(true)
  })
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit.click() }
  })
  textarea.focus()
}

function bindHistory(message, element) {
  if (element.historyClickBound) return
  const seq = typeof message.seq === 'number' ? message.seq : -1
  userMessages.set(seq, message)
  element.historyMessage = message
  element.tabIndex = 0
  element.dataset.userSeq = seq
  element.classList.toggle('history-pending', seq < 0)
  element.title = '历史消息；右上角铅笔可编辑'
  element.historyClickBound = true
  element.addEventListener('click', () => editHistory(element.historyMessage ?? message, element))
  element.addEventListener('keydown', event => {
    if (event.target !== element || event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    editHistory(element.historyMessage ?? message, element)
  })
}

function updateHistoryBinding(element, message) {
  const oldSeq = Number(element.dataset.userSeq)
  userMessages.delete(oldSeq)
  element.historyMessage = message
  if (typeof message.seq === 'number') {
    element.dataset.userSeq = message.seq
    userMessages.set(message.seq, message)
    element.classList.remove('history-pending')
  }
  element.title = '历史消息；右上角铅笔可编辑'
}

function hideStickyPrompt() {
  stickyPromptElement = undefined
  stickyPrompt.classList.remove('visible', 'expanded', 'editing')
  stickyPrompt.removeAttribute('tabindex')
  stickyPrompt.removeAttribute('role')
  stickyPromptText.textContent = ''
  stickyPromptToggle.setAttribute('aria-expanded', 'false')
  stickyPromptToggle.title = '展开当前问题'
  stickyPromptToggle.setAttribute('aria-label', '展开当前问题')
}

stickyPrompt.addEventListener('click', event => {
  if (event.target.closest('button') || !stickyPromptElement || stickyPrompt.classList.contains('editing')) return
  editHistory(stickyPromptElement.historyMessage, stickyPromptElement, true)
})
stickyPrompt.addEventListener('keydown', event => {
  if (event.target !== stickyPrompt || event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  if (stickyPromptElement) editHistory(stickyPromptElement.historyMessage, stickyPromptElement, true)
})

stickyPromptToggle.addEventListener('click', () => {
  const expanded = stickyPrompt.classList.toggle('expanded')
  if (expanded) stickyPrompt.style.top = '6px'
  else scheduleStickyPrompt()
  stickyPromptToggle.setAttribute('aria-expanded', String(expanded))
  stickyPromptToggle.title = expanded ? '收起当前问题' : '展开当前问题'
  stickyPromptToggle.setAttribute('aria-label', stickyPromptToggle.title)
})

function updateStickyPrompt() {
  stickyFrame = undefined
  // Never show the sticky prompt while an onboarding view is active.
  if (amo.view !== 'chat') { hideStickyPrompt(); return }
  const prompts = [...log.querySelectorAll('.user')]
  const viewport = conversation.getBoundingClientRect()
  const active = prompts.findLast(element => element.getBoundingClientRect().top <= viewport.top + 1)
  const height = active?.getBoundingClientRect().height ?? 0
  if (stickyPromptElement !== active) {
    hideStickyPrompt()
    stickyPromptElement = active
  } else if (active && active.getBoundingClientRect().top >= viewport.top - 1) {
    hideStickyPrompt()
    return
  }
  if (!active) return
  if (editingUser?.inStickyPrompt && active === editingUser.element) {
    stickyPrompt.style.top = '6px'
    return
  }
  if (active === editingUser?.element) return
  const next = prompts[prompts.indexOf(active) + 1]
  if (next && !stickyPrompt.classList.contains('expanded')) {
    const nextTop = next.getBoundingClientRect().top
    stickyPrompt.style.top = `${Math.max(0, Math.min(6, nextTop - viewport.top - height))}px`
  } else stickyPrompt.style.top = '6px'
  stickyPromptText.textContent = active.historyMessage?.text ?? active.textContent
  stickyPrompt.classList.add('visible')
  stickyPrompt.tabIndex = 0
  stickyPrompt.setAttribute('role', 'button')
  stickyPrompt.title = '点击编辑当前问题；可重新选择模型并回滚重发'
}

function scheduleStickyPrompt() {
  if (stickyFrame === undefined) stickyFrame = requestAnimationFrame(updateStickyPrompt)
}

function scrollToLatest() {
  // The conversation owns scrolling; scrolling a tall message into view only
  // reveals its top once the content extends beyond the viewport.
  conversation.scrollTop = conversation.scrollHeight
  scheduleStickyPrompt()
  updateScrollToBottomButton()
}

const scrollToBottomBtn = document.getElementById('scroll-to-bottom')

function updateScrollToBottomButton() {
  if (!scrollToBottomBtn) return
  scrollToBottomBtn.hidden = followOutput
}

if (scrollToBottomBtn) {
  scrollToBottomBtn.addEventListener('click', () => {
    followOutput = true
    scrollToLatest()
  })
}

conversation.addEventListener('scroll', () => {
  followOutput = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48
  scheduleStickyPrompt()
  updateScrollToBottomButton()
}, { passive: true })

/** Find the longest prefix of `text` that is safe to render as Markdown while
 * more tokens are still streaming. Safe boundaries: a closed fenced code block
 * (``` … ``` followed by a line break) or a blank-line paragraph break outside
 * any fence. The unclosed tail stays as plain text so half-typed syntax
 * (**, ```lang, |table) never re-parses mid-token. */
function findRenderSafeBoundary(text) {
  let boundary = 0
  let inFence = false
  let fenceMarker = ''
  const length = text.length
  let i = 0
  while (i < length) {
    const lineEnd = text.indexOf('\n', i)
    const end = lineEnd === -1 ? length : lineEnd
    const line = text.slice(i, end)
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[1] }
      else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false
        // A closed fence is a hard safe boundary: render up to and including
        // the closing fence line so the code block renders at once.
        boundary = lineEnd === -1 ? end : end + 1
      }
    } else if (!inFence && /^\s*$/.test(line) && lineEnd !== -1) {
      // Blank line outside a fence closes the preceding paragraph/list block.
      boundary = end + 1
    }
    if (lineEnd === -1) break
    i = lineEnd + 1
  }
  return boundary
}

/** Progressively render the completed prefix of a streaming assistant bubble.
 * Settled nodes are appended once and never rebuilt; only the trailing plain
 * text node keeps growing. This incremental strategy (the same idea as
 * Cursor/DSH's markdown stream renderer) formats output live without the
 * repaint flicker of re-parsing the whole reply on every delta. */
function renderStreamProgress(element) {
  const textContainer = element.querySelector('.assistant-text')
  if (!textContainer) return
  const full = textContainer.dataset.originalText ?? ''
  if (full.length <= streamRenderedLength) return
  const boundary = findRenderSafeBoundary(full)
  if (boundary <= streamRenderedLength) return
  const chunk = full.slice(streamRenderedLength, boundary)
  streamRenderedLength += boundary
  const holder = document.createElement('div')
  holder.className = 'assistant-content markdown-body stream-settled'
  holder.innerHTML = renderMarkdownToHtml(chunk)
  bindRenderedContentEvents(holder)
  autoApplyStyleToElement(holder)
  const tailText = full.slice(streamRenderedLength)
  if (streamContent && streamContent.parentNode === textContainer) {
    // Keep the live tail as the last node so subsequent deltas append after it.
    textContainer.insertBefore(holder, streamContent)
    streamContent.data = tailText
  } else {
    textContainer.appendChild(holder)
    streamContent = document.createTextNode(tailText)
    textContainer.appendChild(streamContent)
  }
}

/** Render markdown images, HTML img tags, and HTML code block previews safely in assistant messages. */
function renderAssistantContent(element) {
  // Find the text container inside the assistant message element
  const textContainer = element.querySelector('.assistant-text')
  if (!textContainer) {
    console.log('[Webview] renderAssistantContent: no .assistant-text found, classes:', element.className)
    return
  }

  // Get the original markdown text from data attribute, or from textContent if not yet rendered
  let originalText = textContainer.dataset.originalText
  if (originalText === undefined) {
    originalText = textContainer.textContent
    textContainer.dataset.originalText = originalText
  }

  if (!originalText) {
    console.log('[Webview] renderAssistantContent: empty originalText')
    return
  }

  // Check if content needs markdown rendering
  const hasMarkdown = /^#{1,6}\s|\*\*[^*]+\*\*|\*[^*]+\*|^\s*[-*+]\s|^\s*\d+\.\s|```|\[.+\]\(.+\)|^\s*>/m.test(originalText)
  const hasHtmlCodeBlock = /```html\s*\n[\s\S]*?```/.test(originalText)
  const hasMarkdownImages = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.test(originalText)
  const hasRawImages = /<img[^>]+src=["'][^"']+["'][^>]*>/i.test(originalText)

  console.log('[Webview] renderAssistantContent: text len:', originalText.length, 'hasMarkdown:', hasMarkdown)

  if (!hasMarkdown && !hasHtmlCodeBlock && !hasMarkdownImages && !hasRawImages) return

  // Create rendered content
  const rendered = renderMarkdownToHtml(originalText)

  // If incremental streaming already settled some blocks, only render the
  // un-rendered tail and merge with the settled prefix; settled nodes are kept.
  const settled = textContainer.querySelectorAll('.stream-settled')
  if (settled.length > 0 && streamRenderedLength > 0 && streamRenderedLength < originalText.length) {
    const tail = originalText.slice(streamRenderedLength)
    if (tail.trim()) {
      const tailRendered = renderMarkdownToHtml(tail)
      const last = settled[settled.length - 1]
      const tailNode = document.createElement('div')
      tailNode.className = 'assistant-content markdown-body stream-settled'
      tailNode.innerHTML = tailRendered
      bindRenderedContentEvents(tailNode)
      autoApplyStyleToElement(tailNode)
      last.after(tailNode)
    }
    // Remove the leftover plain-text tail node.
    const tailText = [...textContainer.childNodes].find(n => n.nodeType === 3)
    if (tailText) tailText.remove()
    textContainer.classList.add('assistant-content', 'markdown-body')
    autoApplyStyleToElement(textContainer)
    return
  }

  // Replace text container content with rendered HTML
  textContainer.innerHTML = rendered
  textContainer.classList.add('assistant-content', 'markdown-body')
  // classList.add does not fire the MutationObserver child-list hook, so apply
  // the current style settings to the freshly promoted markdown body directly.
  autoApplyStyleToElement(textContainer)

  // Bind interactive elements
  bindRenderedContentEvents(textContainer)
}

/** Render markdown text to HTML string */
// Match an inline-code token against the workspace file index. Accepts either
// an exact workspace-relative path ("src/agent.ts") or a bare filename
// ("agent.ts") when exactly one indexed file has that basename.
function resolveWorkspaceFilePath(code) {
  if (typeof code !== 'string' || code.length === 0 || code.length > 200) return undefined
  if (/\s/.test(code) || code.includes('*') || code.includes('..')) return undefined
  const normalized = code.replace(/^\.\//, '').replace(/\\/g, '/')
  if (!/\.[A-Za-z0-9]{1,12}$/.test(normalized)) return undefined
  // Use the full index (including images and other binaries) so generated
  // artifacts like `sunset.png` are clickable too.
  const list = allWorkspaceFileList.length > 0 ? allWorkspaceFileList : workspaceFileList
  if (!Array.isArray(list) || list.length === 0) return undefined
  const byPath = list.find(file => file.path === normalized)
  if (byPath !== undefined) return byPath.path
  const base = normalized.split('/').pop()
  const byName = list.filter(file => file.path.split('/').pop() === base)
  return byName.length === 1 ? byName[0].path : undefined
}

// ── Lightweight syntax highlighter ─────────────────────────────────────────
// Tokenizes common languages with regex and emits <span class="tk-*"> tokens.
// Colors are mapped to VS Code theme variables in extension.ts so the code
// matches the user's active theme without bundling a heavy tokenizer.

const HL_LANGS = {
  javascript: 'js', typescript: 'js', jsx: 'js', tsx: 'js', js: 'js', ts: 'js', mjs: 'js', cjs: 'js',
  python: 'py', py: 'py',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  markdown: 'md', md: 'md',
  css: 'css', scss: 'css',
  html: 'html', xml: 'html',
  sql: 'sql',
  go: 'go', rust: 'rust', rs: 'rust',
  java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', cs: 'cs', csharp: 'cs',
  ruby: 'rb', rb: 'rb',
  php: 'php',
  dockerfile: 'docker', docker: 'docker',
  diff: 'diff'
}

const HL_KEYWORDS = {
  js: 'const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|delete|typeof|instanceof|in|of|class|extends|super|this|null|undefined|true|false|try|catch|finally|throw|async|await|yield|static|get|set|import|export|from|as|void',
  py: 'def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|print|self|cls',
  sh: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|cd|ls|pwd|export|local|readonly|source|alias|unalias|set|unset|shift|trap|eval|exec|sudo|grep|sed|awk|cat|head|tail|find|xargs|chmod|chown|mkdir|rm|cp|mv|touch|ln|tar|gzip|curl|wget|git|npm|npx|node|python|pip|apt|yum|brew|xdg-open|open|serve|http-server|kill|killall|ps|top|htop|df|du|free|uname|whoami|which|whereis|locate|date|cal|sleep|yes|true|false|test|env|printenv|hostname|ping|netstat|ss|ssh|scp|rsync|rsync|screen|tmux|vim|nano|emacs|code|cursor',
  json: 'true|false|null',
  yaml: 'true|false|null|yes|no|on|off',
  sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|AND|OR|NOT|NULL|IN|EXISTS|BETWEEN|LIKE|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MAX|MIN',
  go: 'package|import|func|return|if|else|for|range|switch|case|default|break|continue|go|defer|chan|select|struct|interface|map|var|const|type|nil|true|false|make|new|append|len|cap|copy|delete|panic|recover|print|println|string|int|int64|float64|bool|byte|rune|error',
  rust: 'fn|let|mut|const|static|struct|enum|impl|trait|type|where|for|loop|while|if|else|match|return|break|continue|move|ref|pub|use|mod|crate|extern|unsafe|async|await|dyn|box|self|Self|super|true|false|Some|None|Ok|Err|Vec|String|i32|i64|u32|u64|f32|f64|bool|str|char',
  java: 'public|private|protected|static|final|abstract|class|interface|extends|implements|package|import|void|int|long|double|float|boolean|char|byte|short|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|this|super|null|true|false|instanceof|synchronized|volatile|transient|native|enum|assert',
  c: 'int|char|float|double|void|short|long|signed|unsigned|struct|union|enum|typedef|static|extern|const|volatile|register|auto|return|if|else|for|while|do|switch|case|default|break|continue|goto|sizeof|NULL|true|false',
  cpp: 'int|char|float|double|void|short|long|signed|unsigned|struct|union|enum|typedef|static|extern|const|volatile|register|auto|return|if|else|for|while|do|switch|case|default|break|continue|goto|sizeof|nullptr|true|false|class|public|private|protected|virtual|override|final|template|typename|namespace|using|new|delete|this|try|catch|throw|noexcept|constexpr|decltype|auto',
  cs: 'public|private|protected|internal|static|readonly|const|class|interface|struct|enum|delegate|event|namespace|using|void|int|long|double|float|bool|char|byte|string|object|var|new|return|if|else|for|foreach|while|do|switch|case|default|break|continue|try|catch|finally|throw|this|base|null|true|false|is|as|typeof|sizeof|get|set|partial|virtual|override|abstract|sealed|async|await|yield|where|in|out|ref|params',
  rb: 'def|class|module|end|if|elsif|else|unless|case|when|while|until|for|do|begin|rescue|ensure|raise|return|yield|block_given|lambda|proc|attr_accessor|attr_reader|attr_writer|require|include|extend|self|nil|true|false|super|private|protected|public|puts|print',
  php: 'function|class|public|private|protected|static|abstract|final|extends|implements|interface|namespace|use|new|return|if|else|elseif|for|foreach|while|do|switch|case|default|break|continue|try|catch|finally|throw|echo|print|var|const|null|true|false|self|parent|static|global|require|include|require_once|include_once|trait|yield|async|await',
  docker: 'FROM|RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|EXPOSE|ENV|ARG|VOLUME|USER|LABEL|HEALTHCHECK|SHELL|STOPSIGNAL|ONBUILD'
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Heuristic CSS class for inline `code` spans — commands / URLs / paths / flags. */
function inlineCodeClass(code) {
  if (typeof code !== 'string' || code.length === 0 || code.length > 200) return ''
  // URLs
  if (/^https?:\/\//.test(code)) return 'inline-url'
  // Absolute or home-relative paths
  if (/^(\/|~\/|\.\/|[A-Za-z]:[\\\/])/.test(code) && /[\/\\]/.test(code)) return 'inline-path'
  // Options / flags
  if (/^--?[a-zA-Z][\w-]*$/.test(code)) return 'inline-flag'
  // Keyboard shortcuts (Ctrl+C, Cmd+V, Shift+Enter, Alt+Tab, F5)
  if (/^(Ctrl|Cmd|Alt|Shift|Meta|Super|Fn|F\d{1,2})(\+[\w\d]+)*$/i.test(code)) return 'inline-kbd'
  // Common shell command at start (curl, git, python3, npm, …)
  if (/^(curl|wget|git|npm|npx|node|python\d?|pip\d?|bash|sh|zsh|fish|cd|ls|cat|echo|grep|find|chmod|chown|sudo|apt|yum|brew|docker|kubectl|make|cargo|go|rustc|java|javac|ruby|php|composer|pip3|python3|tar|zip|unzip|gzip|ssh|scp|rsync|vim|nano|emacs|code|cursor|xdg-open|open|test|\[|\[\[)\b/.test(code)) return 'inline-cmd'
  return ''
}

function highlightCode(code, lang) {
  const langKey = HL_LANGS[(lang ?? '').toLowerCase()] ?? 'plain'
  if (langKey === 'plain') return escapeHtml(code)

  // Build patterns in precedence order. Each pattern is applied to the
  // *original* source, collecting non-overlapping token spans. The first
  // pattern that matches at a position wins; later patterns skip occupied
  // ranges. This avoids nested-replacement bugs.
  const patterns = []
  // Comments (highest priority)
  if (langKey === 'sh' || langKey === 'yaml' || langKey === 'docker' || langKey === 'py' || langKey === 'rb') {
    patterns.push({ re: /#[^\n]*/g, cls: 'tk-comment' })
  } else if (langKey === 'html' || langKey === 'md') {
    patterns.push({ re: /<!--[\s\S]*?-->/g, cls: 'tk-comment' })
  } else if (langKey === 'sql') {
    patterns.push({ re: /--[^\n]*/g, cls: 'tk-comment' })
  } else {
    patterns.push({ re: /\/\/[^\n]*/g, cls: 'tk-comment' })
    patterns.push({ re: /\/\*[\s\S]*?\*\//g, cls: 'tk-comment' })
  }
  // Strings
  patterns.push({ re: /'(?:[^'\\\n]|\\.)*'?/g, cls: 'tk-string' })
  patterns.push({ re: /"(?:[^"\\\n]|\\.)*"?/g, cls: 'tk-string' })
  if (langKey === 'js' || langKey === 'sh') {
    patterns.push({ re: /`(?:[^`\\]|\\.)*`?/g, cls: 'tk-string' })
  }
  // URLs (all languages)
  patterns.push({ re: /https?:\/\/[^\s"'()<>\]]+/g, cls: 'tk-url' })
  // Numbers
  patterns.push({ re: /\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, cls: 'tk-number' })
  // Keywords
  const kws = HL_KEYWORDS[langKey]
  if (kws) {
    // For bash/sh, allow keywords to carry digit suffixes (python3, pip3, node16).
    // For other languages use strict \b word boundary.
    if (langKey === 'sh') {
      patterns.push({ re: new RegExp(`\\b(?:${kws})\\d*\\b`, 'g'), cls: 'tk-keyword' })
    } else {
      patterns.push({ re: new RegExp(`\\b(?:${kws})\\b`, 'g'), cls: 'tk-keyword' })
    }
  }
  // Shell/bash-specific: options (--foo, -x), file paths
  if (langKey === 'sh') {
    patterns.push({ re: /(^|\s)(--?[a-zA-Z][\w-]*)/g, cls: 'tk-attr', captureIdx: 2 })
    // Absolute paths, ~ home paths, ./ relative, and bare paths with / like foo/bar/baz.py
    patterns.push({ re: /(^|\s|["'=])(\/[^\s"']+|~\/[^\s"']*|\.\/[^\s"']+|(?:[\w.-]+\/)+[\w.-]+)/g, cls: 'tk-path', captureIdx: 2 })
  }
  // Function calls
  patterns.push({ re: /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/g, cls: 'tk-fn' })
  // Diff markers
  if (langKey === 'diff') {
    patterns.push({ re: /^\+[^\n]*/gm, cls: 'tk-add' })
    patterns.push({ re: /^-[^\n]*/gm, cls: 'tk-del' })
    patterns.push({ re: /^@@[^\n]*/gm, cls: 'tk-keyword' })
  }

  // Collect tokens from each pattern, then resolve overlaps by priority
  const tokens = [] // {start, end, cls}
  for (let priority = 0; priority < patterns.length; priority++) {
    const { re, cls, captureIdx } = patterns[priority]
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      // If the pattern has a capture group, only tokenize that range.
      // Otherwise tokenize the whole match.
      if (captureIdx !== undefined && m[captureIdx] !== undefined) {
        const captured = m[captureIdx]
        const offset = m.index + m[0].indexOf(captured)
        tokens.push({ start: offset, end: offset + captured.length, cls, priority })
      } else {
        tokens.push({ start: m.index, end: m.index + m[0].length, cls, priority })
      }
    }
  }
  // Sort by start, then by priority (lower = higher precedence)
  tokens.sort((a, b) => a.start - b.start || a.priority - b.priority)

  // Walk source, emit spans skipping overlaps
  const out = []
  let cursor = 0
  for (const tok of tokens) {
    if (tok.start < cursor) continue // overlapped
    if (tok.start > cursor) out.push(escapeHtml(code.slice(cursor, tok.start)))
    out.push(`<span class="${tok.cls}">${escapeHtml(code.slice(tok.start, tok.end))}</span>`)
    cursor = tok.end
  }
  if (cursor < code.length) out.push(escapeHtml(code.slice(cursor)))
  return out.join('')
}

function renderMarkdownToHtml(text) {
  // Escape HTML first
  let html = text  .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Store tables to protect them
  const tables = []
  html = html.replace(/^\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.*\|\s*\n?)+)/gm, (match, header, body) => {
    const id = tables.length
    const headers = header.split('|').map(cell => cell.trim()).filter(cell => cell)
    const rows = body.trim().split('\n').map(line => line.split('|').map(cell => cell.trim()).filter(cell => cell))
    tables.push({ headers, rows })
    // The trailing \n? in the pattern swallows the newline after the last table
    // row; restore one so a heading immediately after the table stays at a line
    // start and still matches the ^#{1,6} header rules below.
    return `\x00TABLE${id}\x00\n`
  })

  // Store code blocks to protect them from other transformations
  // Match both ```lang\ncode``` and ```lang code``` (single-line) forms.
  // Un-escape HTML entities so highlightCode can tokenize the original code
  // (it re-escapes per token) — prevents double-escaping like &amp;amp;.
  const unescapeHtml = (s) => s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  const codeBlocks = []
  html = html.replace(/```(\w*)[ \t]*\n?([\s\S]*?)```/g, (match, lang, code) => {
    const id = codeBlocks.length
    codeBlocks.push({ lang: lang ?? '', code: unescapeHtml(code.trim()) })
    return `\x00CODE${id}\x00`
  })

  // Store inline code
  const inlineCodes = []
  html = html.replace(/`([^`\n]+)`/g, (match, code) => {
    const id = inlineCodes.length
    inlineCodes.push(code)
    return `\x00INLINE${id}\x00`
  })

  // Render markdown elements
  // Headers
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')

  // Bold and italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  html = html.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')

  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  // Blockquotes
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>')

  // Unordered lists
  html = html.replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')

  // Ordered lists
  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    if (match.includes('<ul>')) return match
    return '<ol>' + match + '</ol>'
  })

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, text, href, title) => {
    const safeTitle = title ? ` title="${title}"` : ''
    return `<a href="${href}"${safeTitle} target="_blank" rel="noopener">${text}</a>`
  })

  // Autolink bare URLs (GFM autolink literals, mirrors Cursor/DSH behavior).
  // Convert http(s)://... that is NOT already inside an <a href="...">,
  // a <code> element, or an HTML attribute into a clickable link.
  // We use a placeholder strategy: first mask existing <a> and <code> elements,
  // autolink the remaining text, then restore the masked elements.
  const autolinkProtected = []
  html = html.replace(/(<a\s[^>]*>[\s\S]*?<\/a>|<code[^>]*>[\s\S]*?<\/code>)/gi, (m) => {
    autolinkProtected.push(m)
    return `\x00AUTOPROT${autolinkProtected.length - 1}\x00`
  })
  // Bare URL pattern: starts with http(s)://, ends at whitespace, CJK punctuation, or common trailing punctuation
  // Per GFM: trailing punctuation like . , ; : ! ? ' " ) ] } is excluded from the URL.
  html = html.replace(/https?:\/\/[^\s<>"'`()[\]{}]*[^\s<>"'`()[\]{},.!?;:'"）』】」，。！？；：]/g, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener" class="autolink">${url}</a>`
  })
  html = html.replace(/\x00AUTOPROT(\d+)\x00/g, (_, i) => autolinkProtected[parseInt(i, 10)])

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>')
  html = html.replace(/^\*\*\*$/gm, '<hr>')

  // Restore tables
  html = html.replace(/\x00TABLE(\d+)\x00/g, (match, id) => {
    const table = tables[parseInt(id)]
    let tableHtml = '<div class="table-wrapper" style="margin:12px 0;overflow-x:auto;"><table style="border-collapse:collapse;width:100%;font-size:12.5px;">'
    // Header
    tableHtml += '<thead><tr>'
    for (const header of table.headers) {
      tableHtml += `<th style="padding:8px 12px;text-align:left;border-bottom:2px solid var(--vscode-widget-border);font-weight:600;background:var(--vscode-editorWidget-background);">${header}</th>`
    }
    tableHtml += '</tr></thead>'
    // Body
    tableHtml += '<tbody>'
    for (const row of table.rows) {
      tableHtml += '<tr>'
      for (const cell of row) {
        tableHtml += `<td style="padding:8px 12px;border-bottom:1px solid var(--vscode-widget-border);">${cell}</td>`
      }
      tableHtml += '</tr>'
    }
    tableHtml += '</tbody></table></div>'
    return tableHtml
  })

  // Restore inline code
  html = html.replace(/\x00INLINE(\d+)\x00/g, (match, id) => {
    const code = inlineCodes[parseInt(id)]
    const baseStyle = 'padding:2px 6px;border-radius:4px;font-size:0.92em;font-family:var(--vscode-editor-font-family);'
    // Inline code that names a file present in the workspace becomes a link
    // which opens that file in the editor on click.
    const filePath = resolveWorkspaceFilePath(code)
    if (filePath !== undefined) {
      return `<code class="file-ref" data-file-path="${filePath.replace(/"/g, '&quot;')}" title="点击打开 ${filePath.replace(/"/g, '&quot;')}" style="${baseStyle}background:var(--vscode-textCodeBlock-background);color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;">${code}</code>`
    }
    // Heuristic inline-code colorization (mirrors Cursor's reader-friendly
    // styling for commands / URLs / paths / flags / keyboard shortcuts).
    const inlineClass = inlineCodeClass(code)
    const colorStyle = inlineClass ? `class="${inlineClass}"` : ''
    return `<code ${colorStyle} style="${baseStyle}background:var(--vscode-textCodeBlock-background);">${code}</code>`
  })

  // Restore code blocks
  html = html.replace(/\x00CODE(\d+)\x00/g, (match, id) => {
    const block = codeBlocks[parseInt(id)]
    const escapedCode = block.code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    if (block.lang === 'html') {
      const rawCode = block.code
      const previewId = 'html-preview-' + Math.random().toString(36).slice(2, 9)
      return `<div class="html-code-block" style="margin:12px 0;border:1px solid var(--vscode-widget-border);border-radius:8px;overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-widget-border);">
          <span style="font-size:11px;font-weight:500;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.5px;">HTML</span>
          <button type="button" class="html-preview-btn" data-preview-id="${previewId}" style="padding:4px 10px;border:none;border-radius:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:11px;cursor:pointer;">预览</button>
        </div>
        <pre style="margin:0;padding:12px;background:var(--vscode-textCodeBlock-background);overflow-x:auto;font-size:12.5px;line-height:1.5;"><code>${escapedCode}</code></pre>
        <script type="text/plain" id="${previewId}">${rawCode.replace(/</g, '\\u003c')}</script>
      </div>`
    }
    const langLabel = block.lang ? `<span style="font-size:10px;font-weight:500;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.5px;margin-right:8px;">${block.lang}</span>` : ''
    const copyBtn = `<button type="button" class="code-copy-btn" style="padding:3px 8px;border:none;border-radius:4px;background:transparent;color:var(--vscode-descriptionForeground);font-size:11px;cursor:pointer;opacity:0.7;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">复制</button>`
    // Lazy highlight: render plain text first with data-lang/data-code attributes.
    // An IntersectionObserver replaces <code> with the highlighted version when
    // the block scrolls into view (mirrors DSH's useViewportHighlighting), so
    // restoring long sessions doesn't pay the tokenize cost upfront.
    return `<div class="code-block-wrapper" style="margin:12px 0;border:1px solid var(--vscode-widget-border);border-radius:8px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-widget-border);">
        ${langLabel}
        ${copyBtn}
      </div>
      <pre class="code-hl" data-lang="${(block.lang ?? '').replace(/"/g, '&quot;')}" style="margin:0;padding:12px;background:var(--vscode-textCodeBlock-background);overflow-x:auto;font-size:12.5px;line-height:1.5;"><code>${escapedCode}</code></pre>
    </div>`
  })

  // Render markdown images
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, src, title) => {
    const safeAlt = alt.replace(/"/g, '&quot;')
    const safeTitle = title ? ` title="${title.replace(/"/g, '&quot;')}"` : ''
    if (src.startsWith('data:image/') || src.startsWith('http://') || src.startsWith('https://')) {
      return `<img src="${src}" alt="${safeAlt}"${safeTitle} class="chat-image" style="max-width:100%;max-height:300px;border-radius:6px;margin:4px 0;cursor:zoom-in;display:block;">`
    }
    return match
  })

  // Render raw HTML img tags
  html = html.replace(/&lt;img([^&gt]*)&gt;/gi, (match, attrs) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/)
    if (!srcMatch) return match
    const src = srcMatch[1]
    if (!src.startsWith('data:image/') && !src.startsWith('http://') && !src.startsWith('https://')) return match
    const altMatch = attrs.match(/alt=["']([^"']*)["']/)
    const alt = altMatch ? altMatch[1].replace(/"/g, '&quot;') : ''
    return `<img src="${src}" alt="${alt}" class="chat-image" style="max-width:100%;max-height:300px;border-radius:6px;margin:4px 0;cursor:zoom-in;display:block;">`
  })

  // Convert newlines to <br> for proper display (but not inside pre/li/blockquote)
  html = html.replace(/\n/g, '<br>')

  // Fix list items that got <br> inside
  html = html.replace(/<li>(.*?)<\/li>/g, (match, content) => {
    return '<li>' + content.replace(/<br>/g, '') + '</li>'
  })

  return html
}

/** Bind events to rendered content */
function bindRenderedContentEvents(container) {
  // Bind image zoom
  container.querySelectorAll('img.chat-image').forEach(img => {
    img.addEventListener('click', () => showImageZoom(img.src, img.alt))
  })

  // Workspace file references inside inline code open the file in the editor.
  container.querySelectorAll('code.file-ref').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation()
      const path = el.dataset.filePath
      if (typeof path === 'string' && path.length > 0) {
        vscode.postMessage({ type: 'openFile', path })
      }
    })
  })

  // External links: route through the extension so they open in the system
  // browser (webview <a target="_blank"> alone doesn't work in VS Code).
  container.querySelectorAll('a[href^="http://"], a[href^="https://"]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      vscode.postMessage({ type: 'openExternal', url: a.href })
    })
  })

  // Bind HTML preview buttons
  container.querySelectorAll('.html-preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const previewId = btn.dataset.previewId
      const script = document.getElementById(previewId)
      if (!script) return
      const rawHtml = script.textContent.replace(/\\u003c/g, '<')
      showHtmlPreview(rawHtml)
    })
  })

  // Bind code-block copy buttons. We read directly from the sibling <code>
  // element instead of a data attribute so large blocks aren't truncated.
  container.querySelectorAll('.code-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const wrapper = btn.closest('.code-block-wrapper')
      const code = wrapper?.querySelector('pre code')
      const text = code?.textContent ?? ''
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        const original = btn.textContent
        btn.textContent = '已复制'
        setTimeout(() => { btn.textContent = original }, 1200)
      } catch (err) {
        // Fallback for environments where navigator.clipboard is unavailable
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'
        document.body.appendChild(textarea)
        textarea.select()
        try { document.execCommand('copy') } catch {}
        textarea.remove()
        const original = btn.textContent
        btn.textContent = '已复制'
        setTimeout(() => { btn.textContent = original }, 1200)
      }
    })
  })

  // Lazy syntax highlighting: activate when a code block scrolls into view.
  // The block renders plain text upfront (fast session restore); when it
  // becomes visible we re-render <code> with highlightCode() spans.
  container.querySelectorAll('pre.code-hl[data-lang]').forEach(pre => {
    highlightViewport.observe(pre)
  })
}

// ── Viewport-activated syntax highlighting (mirrors DSH useViewportHighlighting) ──
// One IntersectionObserver shared across all assistant messages; each <pre>
// is observed once and unobserved after activation. This keeps long-session
// restore fast — plain text renders immediately; highlights apply on demand.
const highlightViewport = (() => {
  const activated = new WeakSet()
  let observer
  const getObserver = () => {
    if (observer !== undefined) return observer
    if (typeof IntersectionObserver === 'undefined') return null
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const pre = entry.target
        observer.unobserve(pre)
        activateHighlight(pre)
      }
    }, { rootMargin: '300px' }) // Pre-highlight 300px before entering view
    return observer
  }
  const activateHighlight = (pre) => {
    if (activated.has(pre)) return
    activated.add(pre)
    const code = pre.querySelector('code')
    if (!code) return
    const lang = pre.dataset.lang ?? ''
    const raw = code.textContent ?? ''
    if (!raw) return
    try {
      code.innerHTML = highlightCode(raw, lang)
    } catch (err) {
      console.warn('[Webview] highlightCode failed for lang', lang, err)
    }
  }
  return {
    observe(pre) {
      if (activated.has(pre)) return
      const obs = getObserver()
      if (obs === null) {
        // No IntersectionObserver — highlight immediately as fallback
        activateHighlight(pre)
        return
      }
      obs.observe(pre)
    }
  }
})()
/** Show a sandboxed HTML preview in a modal overlay. */
function showHtmlPreview(htmlCode) {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;'
  const modal = document.createElement('div')
  modal.style.cssText = 'width:90%;height:90%;background:var(--vscode-editor-background);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4);'
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-widget-border);'
  const title = document.createElement('span')
  title.textContent = 'HTML 预览'
  title.style.cssText = 'font-size:13px;font-weight:500;color:var(--vscode-foreground);'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.style.cssText = 'width:28px;height:28px;border:none;background:transparent;color:var(--vscode-foreground);font-size:18px;cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center;'
  close.addEventListener('click', () => overlay.remove())
  header.append(title, close)
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'flex:1;border:none;background:#fff;'
  iframe.sandbox = 'allow-scripts'
  // Write HTML into iframe srcdoc for sandboxing
  iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;}</style></head><body>${htmlCode}</body></html>`
  modal.append(header, iframe)
  overlay.appendChild(modal)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

/** Show a full-screen image zoom overlay. */
function showImageZoom(src, alt) {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;'
  const img = document.createElement('img')
  img.src = src
  img.alt = alt || 'zoomed image'
  img.style.cssText = 'max-width:95%;max-height:95%;object-fit:contain;'
  overlay.appendChild(img)
  overlay.addEventListener('click', () => overlay.remove())
  document.body.appendChild(overlay)
}

function append(kind, text, context, message) {
  const element = document.createElement('div')
  element.className = 'message ' + kind
  if (context) {
    const reference = document.createElement('button')
    reference.type = 'button'
    reference.className = 'context-ref'
    reference.textContent = context.label
    reference.title = `打开 ${context.path}:${context.line}`
    reference.addEventListener('click', () => vscode.postMessage({ type: 'openContext', reference: { uri: context.uri, line: context.line } }))
    element.appendChild(reference)
  }
  const content = document.createElement('span')
  content.textContent = text
  if (kind === 'user') content.className = 'user-collapsed'
  else if (kind === 'assistant') content.className = 'assistant-text'
  element.appendChild(content)
  // Don't render assistant content here - wait for stream completion or explicit render call
  // Render user-attached images in history
  if (kind === 'user' && message?.images?.length > 0) {
    const imgContainer = document.createElement('div')
    imgContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;'
    for (const img of message.images) {
      const imgEl = document.createElement('img')
      imgEl.src = `data:${img.mimeType};base64,${img.data}`
      imgEl.alt = img.name || 'image'
      imgEl.style.cssText = 'max-width:120px;max-height:90px;border-radius:6px;cursor:zoom-in;object-fit:cover;'
      imgEl.addEventListener('click', () => showImageZoom(imgEl.src, img.name))
      imgContainer.appendChild(imgEl)
    }
    element.appendChild(imgContainer)
  }
  if (kind === 'user') {
    const toggle = document.createElement('button')
    toggle.className = 'history-toggle'
    toggle.title = '编辑这条历史消息'
    toggle.setAttribute('aria-label', '编辑这条历史消息')
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 5 5 5M4 20l4-1 11-11-4-4L4 15v5Z"/></svg>'
    toggle.addEventListener('click', event => { event.stopPropagation(); editHistory(element.historyMessage ?? message, element) })
    element.appendChild(toggle)
    bindHistory(message, element)
  }
  log.appendChild(element)
  empty.hidden = true
  if (followOutput) scrollToLatest()
  updateScrollToBottomButton()
  return element
}

function flushStream() {
  if (streamFrame !== undefined) clearTimeout(streamFrame)
  streamFrame = undefined
  if (streamNode && streamText) {
    const textContainer = streamNode.querySelector('.assistant-text')
    if (textContainer) {
      textContainer.dataset.originalText = (textContainer.dataset.originalText ?? '') + streamText
      // Keep one stable tail text node; settled prefix blocks are rendered
      // incrementally and never rebuilt (no full-reply innerHTML reparse).
      streamContent ??= textContainer.lastChild?.nodeType === 3 ? textContainer.lastChild : document.createTextNode('')
      streamContent.data += streamText
      if (streamContent.parentNode !== textContainer) textContainer.appendChild(streamContent)
      // Render any newly completed Markdown prefix into settled nodes.
      renderStreamProgress(streamNode)
    } else {
      // A settled assistant event may already have rendered this bubble.
      // Settle it before starting a distinct streamed segment.
      renderAssistantContent(streamNode)
    }
    if (followOutput) scrollToLatest()
  }
  streamNode = undefined
  streamContent = undefined
  streamText = ''
}

function finishAssistantStream(element) {
  flushStream()
  if (!element) return
  element.classList.remove('streaming')
  renderAssistantContent(element)
  streamRenderedLength = 0
}

function flushReasoning() {
  if (reasoningFrame !== undefined) clearTimeout(reasoningFrame)
  reasoningFrame = undefined
  if (reasoningNode && reasoningText) {
    reasoningNode.textContent += reasoningText
    if (followOutput) scrollToLatest()
  }
  // Do NOT reset reasoningNode here — the same card accumulates the entire
  // turn's reasoning. The reference is cleared only on boundary events
  // (assistantBoundary / user / cleared).
  reasoningText = ''
}

// Style settings panel
const styleSettingsBtn = document.getElementById('style-settings')
const stylePanel = document.getElementById('style-panel')
const stylePanelClose = document.getElementById('style-panel-close')
const styleApply = document.getElementById('style-apply')
const styleReset = document.getElementById('style-reset')
const styleFontSize = document.getElementById('style-font-size')
const styleLineHeight = document.getElementById('style-line-height')
const styleCodeSize = document.getElementById('style-code-size')
const styleReasoningSize = document.getElementById('style-reasoning-size')
const styleFontFamily = document.getElementById('style-font-family')

// Load saved style settings from localStorage
function loadStyleSettings() {
  if (typeof localStorage === 'undefined') {
    return getDefaultStyleSettings()
  }
  const saved = localStorage.getItem('codingAgentStyleSettings')
  if (saved) {
    try {
      return JSON.parse(saved)
    } catch { /* ignore */ }
  }
  return getDefaultStyleSettings()
}

function getDefaultStyleSettings() {
  return {
    fontSize: '13.5',
    lineHeight: '1.7',
    codeSize: '12.5',
    reasoningSize: '12',
    fontFamily: ''
  }
}

// Store current style settings globally
let currentStyleSettings = getDefaultStyleSettings()

// Apply style settings to CSS
function applyStyleSettings(settings) {
  currentStyleSettings = settings
  const markdownBodies = document.querySelectorAll('.assistant .markdown-body, .assistant .assistant-text')
  const codeBlocks = document.querySelectorAll('.assistant .markdown-body code, .assistant .markdown-body pre')
  const reasoningBodies = document.querySelectorAll('.reasoning-body')

  markdownBodies.forEach(el => {
    el.style.fontSize = settings.fontSize + 'px'
    el.style.lineHeight = settings.lineHeight
    if (settings.fontFamily) {
      el.style.fontFamily = settings.fontFamily
    }
  })

  codeBlocks.forEach(el => {
    el.style.fontSize = settings.codeSize + 'px'
  })

  reasoningBodies.forEach(el => {
    el.style.fontSize = settings.reasoningSize + 'px'
  })
}

// Auto-apply style settings to newly added elements
function autoApplyStyleToElement(element) {
  if (!element || !element.style) return
  if (element.classList.contains('markdown-body') || element.classList.contains('assistant-text')) {
    element.style.fontSize = currentStyleSettings.fontSize + 'px'
    element.style.lineHeight = currentStyleSettings.lineHeight
    if (currentStyleSettings.fontFamily) {
      element.style.fontFamily = currentStyleSettings.fontFamily
    }
  }
  if (element.classList.contains('reasoning-body')) {
    element.style.fontSize = currentStyleSettings.reasoningSize + 'px'
  }
  // Check for code elements
  if (element.tagName === 'CODE' || element.tagName === 'PRE') {
    if (element.closest('.markdown-body')) {
      element.style.fontSize = currentStyleSettings.codeSize + 'px'
    }
  }
}

// Use MutationObserver to auto-apply styles to new elements
let styleObserver = null
if (typeof MutationObserver !== 'undefined' && typeof Node !== 'undefined') {
  styleObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          autoApplyStyleToElement(node)
          // Also check children
          const markdownBodies = node.querySelectorAll?.('.markdown-body, .assistant-text')
          const reasoningBodies = node.querySelectorAll?.('.reasoning-body')
          const codeElements = node.querySelectorAll?.('code, pre')
          markdownBodies?.forEach(autoApplyStyleToElement)
          reasoningBodies?.forEach(autoApplyStyleToElement)
          codeElements?.forEach(autoApplyStyleToElement)
        }
      })
    })
  })
}

// Start observing the log container
const logContainer = document.getElementById('log')
if (logContainer && styleObserver) {
  styleObserver.observe(logContainer, { childList: true, subtree: true })
}

// Save and apply settings
function saveAndApplySettings() {
  const settings = {
    fontSize: styleFontSize.value,
    lineHeight: styleLineHeight.value,
    codeSize: styleCodeSize.value,
    reasoningSize: styleReasoningSize.value,
    fontFamily: styleFontFamily.value.trim()
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('codingAgentStyleSettings', JSON.stringify(settings))
  }
  applyStyleSettings(settings)
  stylePanel.style.display = 'none'
  stylePanel.hidden = true
}

// Reset to defaults
function resetStyleSettings() {
  const defaults = getDefaultStyleSettings()
  styleFontSize.value = defaults.fontSize
  styleLineHeight.value = defaults.lineHeight
  styleCodeSize.value = defaults.codeSize
  styleReasoningSize.value = defaults.reasoningSize
  styleFontFamily.value = defaults.fontFamily
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('codingAgentStyleSettings', JSON.stringify(defaults))
  }
  applyStyleSettings(defaults)
}

// Initialize style settings
function initStyleSettings() {
  const settings = loadStyleSettings()
  currentStyleSettings = settings
  styleFontSize.value = settings.fontSize
  styleLineHeight.value = settings.lineHeight
  styleCodeSize.value = settings.codeSize
  styleReasoningSize.value = settings.reasoningSize
  styleFontFamily.value = settings.fontFamily
  applyStyleSettings(settings)
}

// Event listeners for style panel - use mousedown for more reliable detection
styleSettingsBtn.addEventListener('mousedown', (e) => {
  e.stopPropagation()
  e.preventDefault()
  console.log('[Style] Button mousedown, panel hidden:', stylePanel.hidden, 'display:', stylePanel.style.display)
  const isHidden = stylePanel.style.display === 'none' || stylePanel.hidden
  if (isHidden) {
    stylePanel.style.display = 'block'
    stylePanel.hidden = false
    console.log('[Style] Panel shown')
  } else {
    stylePanel.style.display = 'none'
    stylePanel.hidden = true
    console.log('[Style] Panel hidden')
  }
  styleSettingsBtn.setAttribute('aria-expanded', String(!isHidden))
})

stylePanelClose.addEventListener('click', () => {
  console.log('[Style] Close button clicked')
  stylePanel.style.display = 'none'
  stylePanel.hidden = true
  styleSettingsBtn.setAttribute('aria-expanded', 'false')
})

styleApply.addEventListener('click', () => {
  console.log('[Style] Apply clicked')
  saveAndApplySettings()
})
styleReset.addEventListener('click', () => {
  console.log('[Style] Reset clicked')
  resetStyleSettings()
})

// Close panel when clicking outside - use mousedown for consistency
document.addEventListener('mousedown', (e) => {
  const isVisible = stylePanel.style.display !== 'none' && !stylePanel.hidden
  if (isVisible && !stylePanel.contains(e.target) && e.target !== styleSettingsBtn) {
    console.log('[Style] Click outside, hiding panel')
    stylePanel.style.display = 'none'
    stylePanel.hidden = true
    styleSettingsBtn.setAttribute('aria-expanded', 'false')
  }
})

// Initialize on load
console.log('[Style] Initializing style settings, button:', styleSettingsBtn, 'panel:', stylePanel)
initStyleSettings()
console.log('[Style] Initialization complete')

let trusted = false
const trustWorkspace = document.getElementById('trust-workspace')
let trustRequestPending = false
let modelCatalogLoading = false
// Permission mode: custom menu with risk confirmation for full access
const permissionMode = document.getElementById('permissionMode')
const permissionMenu = document.getElementById('permission-menu')
let currentPermissionMode = 'workspace-write'

// Approval memory chip
const approvalMemoryBar = document.getElementById('approval-memory')
const approvalMemoryTools = document.getElementById('approval-memory-tools')
const approvalMemoryClear = document.getElementById('approval-memory-clear')

// The memory bar is only meaningful in modes that can raise approval prompts;
// under danger-full-access nothing is ever asked, so the bar hides even though
// the memory itself is preserved for when the user switches back.
let approvalMemoryList = []

function syncApprovalMemory(tools) {
  approvalMemoryList = tools ?? []
  refreshApprovalMemoryBar()
}

function refreshApprovalMemoryBar() {
  if (approvalMemoryList.length === 0 || currentPermissionMode === 'danger-full-access') {
    approvalMemoryBar.style.display = 'none'
    return
  }
  approvalMemoryBar.style.display = 'flex'
  approvalMemoryTools.textContent = approvalMemoryList.join('、')
}

approvalMemoryClear.addEventListener('click', () => {
  vscode.postMessage({ type: 'clearApprovalMemory', sessionId: activeSessionId || undefined })
})

// Approval card state
let pendingApproval = null // { requestId, tool, reason }

function showApprovalCard(requestId, tool, reason) {
  // Remove any existing card
  hideApprovalCard()
  const card = document.createElement('div')
  card.id = 'approval-card'
  card.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:12px;margin-bottom:8px;border:1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));border-radius:8px;background:var(--vscode-inputValidation-warningBackground, transparent)'

  const title = document.createElement('div')
  title.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500'
  const icon = document.createElement('span')
  icon.textContent = '⚡'
  const text = document.createElement('span')
  text.textContent = `需要权限：${tool}`
  title.append(icon, text)
  card.appendChild(title)

  if (reason) {
    const detail = document.createElement('div')
    detail.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5'
    detail.textContent = reason
    card.appendChild(detail)
  }

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:6px;justify-content:flex-end'

  const allowOnce = document.createElement('button')
  allowOnce.type = 'button'
  allowOnce.textContent = '允许一次'
  allowOnce.style.cssText = 'padding:5px 10px;border:none;border-radius:5px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-size:11px;cursor:pointer'
  allowOnce.addEventListener('click', () => {
    vscode.postMessage({ type: 'approvalResponse', requestId, outcome: 'allowed-once', sessionId: activeSessionId || undefined })
    hideApprovalCard()
  })

  const allowAlways = document.createElement('button')
  allowAlways.type = 'button'
  allowAlways.textContent = '始终允许此工具'
  allowAlways.title = '本会话不再询问此工具'
  allowAlways.style.cssText = 'padding:5px 10px;border:1px solid var(--vscode-button-secondaryBorder, var(--vscode-input-border));border-radius:5px;color:var(--vscode-button-secondaryForeground, var(--vscode-foreground));background:var(--vscode-button-secondaryBackground, transparent);font-size:11px;cursor:pointer'
  allowAlways.addEventListener('click', () => {
    vscode.postMessage({ type: 'allowToolForSession', tool, sessionId: activeSessionId || undefined })
    vscode.postMessage({ type: 'approvalResponse', requestId, outcome: 'allowed-once', sessionId: activeSessionId || undefined })
    hideApprovalCard()
  })

  const reject = document.createElement('button')
  reject.type = 'button'
  reject.textContent = '拒绝'
  reject.style.cssText = 'padding:5px 10px;border:none;border-radius:5px;color:var(--vscode-errorForeground);background:transparent;font-size:11px;cursor:pointer'
  reject.addEventListener('click', () => {
    vscode.postMessage({ type: 'approvalResponse', requestId, outcome: 'rejected', sessionId: activeSessionId || undefined })
    hideApprovalCard()
  })

  // Three buttons only (allow once / always allow / reject), matching Cursor's
  // approval card. Cancellation stays on Esc alone: a visible × next to 拒绝
  // reads as a duplicate cancel affordance and confuses which one to click.
  actions.append(allowOnce, allowAlways, reject)
  card.appendChild(actions)

  const hint = document.createElement('div')
  hint.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);text-align:right'
  hint.textContent = '「始终允许」仅本会话生效 · Esc = 取消'
  card.appendChild(hint)

  // Insert above the queue list, at the top of #bottom
  const bottom = document.getElementById('bottom')
  bottom.insertBefore(card, bottom.firstChild)
  pendingApproval = { requestId, card }

  // Esc key cancels
  const escHandler = event => {
    if (event.key === 'Escape' && pendingApproval?.requestId === requestId) {
      event.preventDefault()
      vscode.postMessage({ type: 'approvalResponse', requestId, outcome: 'cancelled', sessionId: activeSessionId || undefined })
      hideApprovalCard()
    }
  }
  document.addEventListener('keydown', escHandler)
  card._escHandler = escHandler
}

function hideApprovalCard() {
  if (pendingApproval?.card) {
    document.removeEventListener('keydown', pendingApproval.card._escHandler)
    pendingApproval.card.remove()
  }
  pendingApproval = null
}

function syncPermissionUI(mode) {
  currentPermissionMode = mode
  const labels = { 'read-only': '🔒 只读 · 写入审批', 'workspace-write': '📝 工作区可写', 'danger-full-access': '⚠️ 完全访问' }
  const tooltips = {
    'read-only': '沙箱: 只读 · 审批: 写入逐次询问',
    'workspace-write': '沙箱: 工作区内写入 · 审批: 越界时询问',
    'danger-full-access': '沙箱: 无限制 · 审批: 从不询问',
  }
  const descriptions = {
    'read-only': '当前：只读 — Agent 仅可读取文件，任何写入需逐次确认',
    'workspace-write': '当前：工作区可写 — 可直接修改工作区文件，越界写入需逐次确认',
    'danger-full-access': '当前：完全访问 — Agent 拥有全部权限，全程不询问',
  }
  permissionMode.textContent = labels[mode] ?? mode
  permissionMode.title = tooltips[mode] ?? mode
  permissionMode.classList.toggle('danger', mode === 'danger-full-access')
  document.querySelectorAll('#permission-menu .permission-option').forEach(opt => {
    opt.querySelector('.permission-check').style.visibility = opt.dataset.value === mode ? 'visible' : 'hidden'
  })
  const footer = document.querySelector('#permission-menu > div:last-child')
  if (footer) footer.textContent = descriptions[mode] ?? ''
  refreshApprovalMemoryBar()
}

permissionMode.addEventListener('click', () => {
  if (permissionMode.disabled) return
  permissionMenu.hidden = !permissionMenu.hidden
})

document.querySelectorAll('#permission-menu .permission-option').forEach(option => {
  option.addEventListener('click', () => {
    const value = option.dataset.value
    permissionMenu.hidden = true
    if (value === currentPermissionMode) return
    if (value === 'danger-full-access') {
      // Risk confirmation is handled by the extension via showWarningMessage
      vscode.postMessage({ type: 'permissionMode', value, sessionId: activeSessionId || undefined })
      return
    }
    vscode.postMessage({ type: 'permissionMode', value, sessionId: activeSessionId || undefined })
  })
  option.addEventListener('mouseenter', () => { option.style.background = 'var(--vscode-list-hoverBackground)' })
  option.addEventListener('mouseleave', () => { option.style.background = 'none' })
})

// Close permission menu when clicking outside
document.addEventListener('click', event => {
  if (!document.getElementById('permission-picker').contains(event.target)) {
    permissionMenu.hidden = true
  }
})

function applyTrustState() {
  model.disabled = running || !trusted
  permissionMode.disabled = running || !trusted
  sessionSelect.disabled = !trusted
  refreshSessions.disabled = !trusted
  document.getElementById('new').disabled = !trusted
  document.getElementById('diff-visible').disabled = !trusted
  document.getElementById('diff').disabled = !trusted
  document.getElementById('resume').disabled = !trusted
  document.getElementById('stop').disabled = !trusted
  input.disabled = !trusted || amo.hasModels === false
  input.placeholder = trusted
    ? (running ? '任务进行中…Enter 发送将排队执行；无文本点击按钮可停止' : '描述任务；@ 引用文件，Enter 发送，Shift+Enter 换行')
    : '信任工作区后才能发送任务'
  trustWorkspace.disabled = false
  trustWorkspace.textContent = trustRequestPending ? '等待工作区信任…' : '信任此工作区'
  document.getElementById('workspace-trust').hidden = trusted
  send.disabled = (!trusted && !running) || (amo.hasModels === false && !running)
}

function updateSendButton() {
  const hasText = input.value.trim().length > 0
  const hasImages = pendingImages.length > 0
  // Running with no text → red stop icon. Otherwise → normal send arrow.
  const stopping = running && !hasText && !hasImages
  sendButton.classList.toggle('stopping', stopping)
  sendButton.title = running
    ? (hasText || hasImages ? '排队发送（当前任务结束后执行）' : '停止本轮任务')
    : '发送（Enter）'
  sendButton.setAttribute('aria-label', sendButton.title)
}

function busy(value) {
  if (!value) flushStream()
  else { followOutput = true; scrollToLatest() }
  running = value
  applyTrustState()
  updateSendButton()
  // Settled content may have grown after the last delta (images, code blocks,
  // markdown). If the user was following output, re-scroll to the true bottom
  // once the DOM settles so the latest reply is fully visible.
  if (!value && followOutput) {
    requestAnimationFrame(() => {
      scrollToLatest()
      // One more pass after paint in case markdown rendering expanded nodes.
      setTimeout(() => { if (followOutput) scrollToLatest() }, 50)
    })
  }
}

function reportError(text) {
  append('error', text)
  busy(false)
}

// Submission echo state machine: each fresh send registers a local echo with
// an explicit lifecycle (pending → accepted → observed | failed). Stop-recovery
// consults this state instead of scraping DOM siblings, so historical messages
// can never be misclassified as unsent fresh prompts.
const submissions = new Map() // requestId → { status, text, element, isHistorical }
let submissionSeq = 0

function registerSubmission(text, element, isHistorical) {
  const requestId = `sub-${++submissionSeq}`
  submissions.set(requestId, { status: 'pending', text, element, isHistorical })
  return requestId
}

function retireSubmission(requestId, status) {
  const entry = submissions.get(requestId)
  if (entry === undefined) return undefined
  entry.status = status
  if (status === 'observed' || status === 'failed') submissions.delete(requestId)
  return entry
}

function findPendingSubmission(predicate) {
  for (const [requestId, entry] of submissions) {
    if (entry.status === 'pending' && predicate(entry)) return requestId
  }
  return undefined
}

// Retire the pending submission whose text matches one echoed user element,
// preferring an exact element identity and falling back to text equality.
function retireSubmissionForElement(element, status) {
  for (const [requestId, entry] of submissions) {
    if (entry.element === element) {
      retireSubmission(requestId, status)
      return entry
    }
  }
  const textSpan = element.querySelector('span.user-collapsed')
  const text = (textSpan?.textContent ?? element.textContent ?? '').trim()
  const match = findPendingSubmission(entry => entry.text.trim() === text)
  if (match !== undefined) {
    const entry = submissions.get(match)
    retireSubmission(match, status)
    return entry
  }
  return undefined
}

window.addEventListener('error', event => reportError(`Webview 错误: ${event.message}`))
window.addEventListener('message', event => {
  const message = event.data
  if (message.type === 'assistant' || message.type === 'assistantReasoning' || message.type === 'cleared' || message.type === 'user') {
    console.log(`[Webview] ${message.type}`, message.type === 'assistant' || message.type === 'assistantReasoning' ? `len=${message.text?.length ?? 0}` : message.type === 'user' ? `text="${(message.text ?? '').slice(0, 40)}"` : '')
  }
  if (handleAmoMessage(message)) return
  if (message.type === 'workspaceTrust') {
    trusted = message.trusted === true
    trustRequestPending = false
    if (!trusted) {
      closeSessionMenu()
      closeFilePicker()
      sessionStatus.textContent = '信任后可读取历史会话'
      modelStatus.textContent = '信任后可读取模型目录'
    }
    applyTrustState()
  }
  if (message.type === 'fileList') {
    workspaceFileList = message.files
    allWorkspaceFileList = Array.isArray(message.allFiles) && message.allFiles.length > 0 ? message.allFiles : message.files
    if (fileTrigger !== undefined) fileSearch()
  }
  if (message.type === 'status') {
    status.textContent = message.text
    status.className = message.status === 'error' ? 'error' : ''
  }
  if (message.type === 'busy') {
    busy(message.busy)
    if (!message.busy) {
      // Stop-recovery via the submission echo state machine: only a fresh send
      // that the Host never durably admitted (still pending) is restored into
      // the input box. Accepted or observed submissions stay in history —
      // the aborted turn's partial output remains as an interrupted message.
      for (const [requestId, entry] of submissions) {
        if (entry.status !== 'pending' || entry.isHistorical) continue
        console.log('[Webview] stop-recovery: restoring unadmitted submission', { requestId })
        entry.element?.remove()
        // Remove trailing empty elements created during the unadmitted turn.
        let after = entry.element?.nextElementSibling
        while (after) {
          const toRemove = after
          after = after.nextElementSibling
          toRemove.remove()
        }
        input.value = entry.text
        updateInputHighlight()
        updateSendButton()
        input.focus()
        retireSubmission(requestId, 'failed')
      }
      log.querySelectorAll('.user.history-pending').forEach(element => {
        const msg = element.historyMessage
        if (msg) updateHistoryBinding(element, msg)
      })
      // Streamed text keeps a stable DOM; render full Markdown once settled.
      log.querySelectorAll('.assistant').forEach(element => {
        element.classList.remove('streaming')
        renderAssistantContent(element)
      })
      // Close reasoning card when turn completes
      if (reasoningNode) {
        const card = reasoningNode.closest('.reasoning-card')
        if (card) card.open = false
      }
      flushReasoning()
      // DSH-style: when the Turn completes, close the current process group
      // (recompute its summary header) and ensure all groups are collapsed.
      if (currentProcessGroup) {
        closeCurrentProcessGroup()
      }
      log.querySelectorAll('.process-group[open]').forEach(card => {
        // Only auto-collapse settled groups (no live tools inside).
        if (!card.querySelector('.tool-group-item:not(.tool-done):not(.tool-error)')) {
          card.open = false
        }
      })
      // After replay/turn completes, verify all assistant elements are in DOM
      const assistants = log.querySelectorAll('.message.assistant')
      const tools = log.querySelectorAll('.tool-call')
      const reasoning = log.querySelectorAll('.reasoning-card')
      console.log(`[Webview] busy(false) DOM check: ${assistants.length} assistant, ${tools.length} tool, ${reasoning.length} reasoning, ${log.children.length} total children`)
      assistants.forEach((el, i) => {
        const text = el.querySelector('.assistant-text, .markdown-body')
        console.log(`[Webview]   assistant[${i}]: height=${el.offsetHeight}, text=${(text?.textContent ?? '').slice(0, 60)}`)
      })
    }
  }
  if (message.type === 'scrollToBottom') {
    // Force-scroll after a batch of messages has been appended. Retry a few
    // times with increasing delays to handle images/markdown that expand the
    // DOM asynchronously.
    followOutput = true
    const scroll = () => {
      conversation.scrollTop = conversation.scrollHeight
      updateScrollToBottomButton()
    }
    scroll()
    setTimeout(scroll, 0)
    setTimeout(scroll, 100)
    setTimeout(scroll, 300)
    setTimeout(scroll, 600)
  }
  if (message.type === 'cleared') {
    flushStream()
    flushReasoning()
    hideStickyPrompt()
    if (stickyFrame !== undefined) cancelAnimationFrame(stickyFrame)
    stickyFrame = undefined
    followOutput = true
    editingUser = undefined
    userMessages.clear()
    log.replaceChildren()
    toolCards.clear()
    closeCurrentProcessGroup('已停止')
    current = undefined
    reasoningNode = undefined
    reasoningCard = undefined
    reasoningBody = undefined
    empty.hidden = false
    queuedBubbles.clear()
    document.getElementById('queue-list').replaceChildren()
    console.log('[Webview] Log cleared, waiting for replay messages')
  }
  if (message.type === 'historyPrependOlder' && Array.isArray(message.messages)) {
    // Prepend older history messages before the current view without clearing.
    // Preserve scroll position so the user doesn't jump.
    const oldHeight = log.scrollHeight
    const oldScroll = conversation.scrollTop
    const fragment = document.createDocumentFragment()
    // Track a local process-group during prepend so reasoning + tools fold
    // into a card, mirroring the live render path. Reset whenever a reply or
    // user message closes the group.
    let prependGroup = undefined
    let prependGroupCounts = new Map()
    const closePrependGroup = () => {
      if (!prependGroup) return
      const ranked = [...prependGroupCounts.entries()].sort((a, b) => b[1] - a[1])
      const summarySpan = prependGroup.querySelector('.process-group-summary')
      if (summarySpan) {
        if (ranked.length === 0) summarySpan.textContent = '分析完成'
        else if (ranked.length === 1) summarySpan.textContent = `已${categoryLabels[ranked[0][0]] ?? '调用工具'}`
        else if (ranked.length === 2) summarySpan.textContent = `已${categoryLabels[ranked[0][0]] ?? '调用工具'}并${categoryLabels[ranked[1][0]] ?? '调用工具'}`
        else summarySpan.textContent = `已${categoryLabels[ranked[0][0]] ?? '调用工具'}、${categoryLabels[ranked[1][0]] ?? '调用工具'}、${categoryLabels[ranked[2][0]] ?? '调用工具'}等`
      }
      const stateEl = prependGroup.querySelector('.tool-state')
      if (stateEl) stateEl.textContent = '完成'
      prependGroup = undefined
      prependGroupCounts = new Map()
    }
    const ensurePrependGroup = () => {
      if (prependGroup) return prependGroup
      const card = document.createElement('details')
      card.className = 'tool-call tool-group process-group'
      card.open = false // history is settled; collapse by default
      const summary = document.createElement('summary')
      const summaryText = document.createElement('span')
      summaryText.className = 'process-group-summary'
      summaryText.textContent = '工作过程'
      const stateEl = document.createElement('span')
      stateEl.className = 'tool-state'
      stateEl.textContent = '运行中'
      summary.append(summaryText, stateEl)
      card.appendChild(summary)
      const list = document.createElement('div')
      list.className = 'tool-group-list'
      card.appendChild(list)
      prependGroup = card
      fragment.appendChild(card) // Attach the group card immediately so order is preserved
      return card
    }
      for (const entry of message.messages) {
        if (entry.type === 'user') {
          closePrependGroup()
          const el = document.createElement('div')
          el.className = 'message user'
          el.textContent = entry.text
          if (entry.seq !== undefined) { el.dataset.userSeq = entry.seq; userMessages.set(entry.seq, entry) }
          // Older history messages must be editable just like recent ones:
          // bindHistory wires click/keyboard editing, and the toggle button
          // provides the visible affordance. Without this, messages loaded
          // via historyPrependOlder (turns older than RECENT_TURNS) are dead.
          const toggle = document.createElement('button')
          toggle.className = 'history-toggle'
          toggle.title = '编辑这条历史消息'
          toggle.setAttribute('aria-label', '编辑这条历史消息')
          toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 5 5 5M4 20l4-1 11-11-4-4L4 15v5Z"/></svg>'
          toggle.addEventListener('click', event => { event.stopPropagation(); editHistory(el.historyMessage ?? entry, el) })
          el.appendChild(toggle)
          bindHistory(entry, el)
          fragment.appendChild(el)
        } else if (entry.type === 'assistant') {
        closePrependGroup()
        const el = document.createElement('div')
        el.className = 'message assistant'
        const textDiv = document.createElement('div')
        textDiv.className = 'assistant-text'
        textDiv.textContent = entry.text
        el.appendChild(textDiv)
        renderAssistantContent(el)
        fragment.appendChild(el)
      } else if (entry.type === 'assistantReasoning') {
        const group = ensurePrependGroup()
        const list = group.querySelector('.tool-group-list')
        const card = document.createElement('details')
        card.className = 'reasoning-card'
        card.open = false
        const summary = document.createElement('summary')
        summary.textContent = '思考过程'
        const body = document.createElement('pre')
        body.className = 'reasoning-body'
        body.textContent = entry.text
        card.appendChild(summary)
        card.appendChild(body)
        list.appendChild(card)
        prependGroupCounts.set('thinking', (prependGroupCounts.get('thinking') ?? 0) + 1)
      } else if (entry.type === 'tool') {
        const group = ensurePrependGroup()
        const list = group.querySelector('.tool-group-list')
        const item = document.createElement('div')
        item.className = 'tool-group-item tool-done'
        const header = document.createElement('div')
        header.className = 'tool-group-header'
        const title = document.createElement('span')
        title.textContent = toolLabel(entry.tool, toolArguments(entry.arguments))
        const state = document.createElement('span')
        state.className = 'tool-state'
        state.textContent = '完成'
        header.append(title, state)
        const command = document.createElement('div')
        command.className = 'tool-command'
        command.textContent = entry.arguments ?? ''
        item.append(header, command)
        list.appendChild(item)
        const cat = toolCategory(entry.tool)
        prependGroupCounts.set(cat, (prependGroupCounts.get(cat) ?? 0) + 1)
      }
    }
    closePrependGroup()
    log.insertBefore(fragment, log.firstChild)
    // Restore scroll position adjusted for the prepended content height
    conversation.scrollTop = oldScroll + (log.scrollHeight - oldHeight)
  }
  if (message.type === 'error') reportError(message.text)
  if (message.type === 'imageFileRead') {
    addImageAttachment({
      name: message.name,
      type: message.mimeType,
      size: Math.ceil(message.data.length * 3 / 4),
      data: message.data,
    })
  }
  if (message.type === 'sessionList') {
    sessions = message.sessions.filter(session => !deletingSessions.has(session.id))
    activeSessionId = deletingSessions.has(message.activeSessionId) ? '' : message.activeSessionId ?? ''
    if (!deletingSessions.size) closeSessionMenu()
    renderSessions()
    if (!activeSessionId) sessionStatus.textContent = sessions.length === 0 ? '暂无历史会话' : `${sessions.length} 个会话`
    sessionSelect.disabled = !trusted
    refreshSessions.disabled = !trusted
  }
  if (message.type === 'sessionListStatus') {
    if (message.status === 'error') pendingSessionId = ''
    const loading = message.status === 'loading' || Boolean(pendingSessionId)
    sessionStatus.textContent = loading ? '读取中…' : message.status === 'error' ? '读取失败' : `${sessions.length} 个会话`
    sessionSelect.disabled = !trusted
    refreshSessions.disabled = !trusted
  }
  if (message.type === 'sessionDeleted') {
    if (message.error && message.restorable && message.session) {
      sessions.push(message.session)
      sessions.sort((left, right) => right.updatedAt - left.updatedAt)
      deletingSessions.delete(message.sessionId)
    }
    if (!message.error) deletingSessions.delete(message.sessionId)
    activeSessionId = message.activeSessionId ?? ''
    pendingSessionId = ''
    renderSessions()
    sessionStatus.textContent = `${sessions.length} 个会话`
  }
  if (message.type === 'sessionSelected') {
    activeSessionId = message.session?.id ?? ''
    pendingSessionId = ''
    renderSessions()
    sessionSelect.disabled = !trusted
    refreshSessions.disabled = !trusted
  }
  if (message.type === 'sessionRenamed') {
    if (message.error) {
      // Revert the optimistic title update: extension refused the rename.
      sessionStatus.textContent = `重命名失败：${message.error}`
      vscode.postMessage({ type: 'sessionList' })
      return
    }
    const target = sessions.find(item => item.id === message.sessionId)
    if (target !== undefined) target.title = message.title
    renderSessions()
  }
  if (message.type === 'sessionExported') {
    if (message.cancelled) return
    if (message.error) {
      sessionStatus.textContent = `导出失败：${message.error}`
      return
    }
    sessionStatus.textContent = `已导出：${message.path}`
  }
  if (message.type === 'editorContext') {
    editorContext = message.context
    contextPreview.hidden = !message.context
    contextPreview.textContent = message.label
    contextPreview.title = message.context ? `发送时附带此文件位置${message.context.selection ? '和选区' : ''}；点击打开` : ''
  }
  if (message.type === 'assistantBoundary' || message.type === 'user') {
    finishAssistantStream(current)
    current = undefined
    reasoningNode = undefined
    reasoningCard = undefined
    reasoningBody = undefined
    flushReasoning()
    closeCurrentProcessGroup()
  }
  if (message.type === 'messageSeq') {
    const element = log.querySelector(`[data-user-seq="${message.from}"]`)
    if (element) {
      const previous = element.historyMessage ?? userMessages.get(message.from)
      updateHistoryBinding(element, { ...previous, seq: message.seq })
      if (editingUser) editingUser.cancel()
    }
  }
  // Cursor-style resend: replace the target user message and remove
  // everything after it, preserving scroll position and prior history.
  if (message.type === 'resendStart') {
    const target = log.querySelector(`[data-user-seq="${message.seq}"]`)
    if (target) {
      // Update the resent message text in place
      const textSpan = target.querySelector('span.user-collapsed')
      if (textSpan) textSpan.textContent = message.text
      // Remove all following siblings (old assistant replies, tool cards)
      let next = target.nextElementSibling
      while (next) {
        const toRemove = next
        next = next.nextElementSibling
        toRemove.remove()
      }
      // Record for stop-recovery: a resend is historical — its bubble must
      // survive stop even with no output (the rewind boundary owns cleanup).
      registerSubmission(message.text, target, true)
      console.log('[Webview] resendStart: submission registered (historical)', { seq: message.seq })
      // Reset streaming state so the new turn starts fresh
      finishAssistantStream(current)
      current = undefined
      reasoningNode = undefined
      reasoningCard = undefined
      reasoningBody = undefined
      flushReasoning()
      closeCurrentProcessGroup()
    } else {
      // Target not found (edge case): fall back to appending
      append('user', message.text, undefined, message)
    }
  }
  // After a successful resend, the backend rewinds the session and assigns
  // a new boundary seq. Update the resent user message's data-user-seq in
  // place so a second edit/resend targets the correct history position.
  if (message.type === 'resendBoundary') {
    const element = log.querySelector(`[data-user-seq="${message.from}"]`)
    if (element) {
      const previous = element.historyMessage ?? userMessages.get(message.from)
      if (previous) {
        updateHistoryBinding(element, { ...previous, seq: message.seq })
      } else {
        element.dataset.userSeq = message.seq
        userMessages.set(message.seq, { type: 'user', text: element.textContent, seq: message.seq })
      }
    }
  }
  if (message.type === 'user') {
    const el = append('user', message.text, message.context, message)
    // The extension echoes the user prompt only after admitting it to the
    // Host (post-acceptance), so this echo retires any matching pending
    // submission as observed; unmatched echoes belong to restored history.
    retireSubmissionForElement(el, 'observed')
  }
  if (message.type === 'messageCheckpoint') {
    const element = log.querySelector(`[data-user-seq="${message.seq}"]`)
    if (element) {
      const previous = element.historyMessage ?? userMessages.get(message.seq)
      const updated = { ...previous, checkpointId: message.checkpointId }
      // Update all references atomically: historyMessage for the element,
      // userMessages for lookups, and updateHistoryBinding for seq/title.
      element.historyMessage = updated
      userMessages.set(message.seq, updated)
      updateHistoryBinding(element, updated)
      if (element.querySelector('.history-edit')) {
        const text = element.querySelector('textarea').value
        editHistory(updated, element) // Pass updated directly to avoid stale reads
        element.querySelector('textarea').value = text
      }
    }
  }
  if (message.type === 'checkpointRestored') {
    const card = document.createElement('div')
    card.className = 'checkpoint-restored'
    const text = document.createElement('span')
    text.textContent = message.text
    const undo = document.createElement('button')
    undo.textContent = '撤销代码恢复'
    undo.addEventListener('click', () => { undo.disabled = true; vscode.postMessage({ type: 'undoRestore' }) })
    card.append(text)
    if (message.canUndo) card.appendChild(undo)
    log.appendChild(card)
    if (followOutput) scrollToLatest()
  }
  if (message.type === 'assistant') {
    console.log('[Webview] assistant received, text length:', message.text?.length ?? 0, 'current exists:', !!current)
    // A text-bearing assistant reply closes the current process group and
    // stands outside it, mirroring DSH's reply boundary rule.
    if (message.text && message.text.trim() !== '') {
      closeCurrentProcessGroup()
    }
    if (current) {
      const textContainer = current.querySelector('.assistant-text')
      if (textContainer) {
        textContainer.textContent += message.text
      } else {
        current.textContent += message.text
      }
      renderAssistantContent(current)
    } else {
      current = append('assistant', message.text)
      renderAssistantContent(current)
      console.log('[Webview] assistant appended, element in DOM:', log.contains(current), 'has markdown-body:', !!current.querySelector('.markdown-body'), 'log children:', log.children.length)
    }
  }
  if (message.type === 'assistantReasoning') {
    console.log('[Webview] Received reasoning, text length:', message.text?.length ?? 0)
    // Reasoning lives inside the current process group so it folds with the
    // group, mirroring DSH ui-chat's process-groups model.
    flushStream()
    const group = ensureProcessGroup()
    // DSH Compact: keep the group collapsed as reasoning streams in.
    group.card.open = false
    if (!reasoningNode) {
      finishAssistantStream(current)
      current = undefined
      const card = document.createElement('details')
      card.className = 'reasoning-card'
      card.open = false // collapsed by default; user clicks to expand
      const summary = document.createElement('summary')
      summary.textContent = '思考过程'
      const body = document.createElement('pre')
      body.className = 'reasoning-body'
      card.appendChild(summary)
      card.appendChild(body)
      group.list.appendChild(card)
      reasoningCard = card
      reasoningBody = body
      reasoningNode = body
      // Mark this group as containing reasoning for the closing summary
      group.categoryCounts.set('thinking', (group.categoryCounts.get('thinking') ?? 0) + 1)
    }
    reasoningText += message.text
    if (reasoningFrame === undefined) reasoningFrame = setTimeout(flushReasoning, 50)
    if (followOutput) scrollToLatest()
  }
  if (message.type === 'assistantDelta') {
    // Don't flush reasoning here - reasoning may continue interleaved with text.
    // Close the process group only when a new reply segment actually begins.
    if (!current) {
      closeCurrentProcessGroup()
      current = append('assistant', '')
      streamRenderedLength = 0
    }
    current.classList.add('streaming')
    if (streamNode !== current) flushStream()
    streamNode = current
    streamText += message.text
    if (streamFrame === undefined) streamFrame = setTimeout(flushStream, 50)
  }
  if (message.type === 'tool') {
    finishAssistantStream(current)
    current = undefined
    showTool(message)
  }
  if (message.type === 'toolResult') finishTool(message)
  if (message.type === 'testResult') showTestResult(message)
  if (message.type === 'verificationReport') showVerificationReport(message.report)
  if (message.type === 'conflict') {
    // Restore-time conflict validation remains active; live tool warnings stay out of chat history.
    console.warn(`[Coding Agent] External edit: ${String(message.path)}`)
  }
  if (message.type === 'questions') showQuestions(message)
  if (message.type === 'config') syncPermissionUI(message.permissionMode)
  if (message.type === 'approvalMemory') syncApprovalMemory(message.tools)
  if (message.type === 'approvalRequest') showApprovalCard(message.requestId, message.tool, message.reason)
  if (message.type === 'modelConfig') {
    currentRoute = { provider: message.provider, model: message.model }
    // Only this selection's own success/failure acknowledgement may replace
    // its visible route; a stale directory response must not undo the choice.
    const acknowledged = message.selectionId === modelSelectionVersion
    if (acknowledged) selectedRoute = undefined
    renderModels(!acknowledged)
    modelStatus.textContent = message.model
    model.title = `下一条消息使用 ${message.label}；已有会话将恢复并切换模型`
  }
  if (message.type === 'modelCatalog') {
    modelCatalogLoading = false
    // DSH built-ins `deepseek-account`/`deepseek-official` and the user's custom
    // `deepseek` preset are the same vendor — merge them into one group so the
    // dropdown and manage list do not show duplicate "DeepSeek" entries.
    const DEEPSEEK_FAMILY = ['deepseek', 'deepseek-account', 'deepseek-official']
    const merged = []
    let deepseekHandled = false
    for (const group of message.catalog.groups) {
      if (DEEPSEEK_FAMILY.includes(group.id)) {
        if (deepseekHandled) continue
        const family = message.catalog.groups.filter(g => DEEPSEEK_FAMILY.includes(g.id))
        // If the user saved a custom `deepseek` config, show only its models;
        // otherwise fall back to the built-in account/official models.
        const custom = family.find(g => g.id === 'deepseek')
        const models = custom ? custom.models : family[0].models
        const representative = custom ? 'deepseek' : family[0].id
        merged.push({ id: representative, name: 'DeepSeek', models, deletable: custom !== undefined })
        deepseekHandled = true
        continue
      }
      merged.push({ ...group, deletable: true })
    }
    modelGroups = merged.map(group => ({ provider: group.id, name: group.name, models: group.models, deletable: group.deletable }))
    console.log('[AMO-DEBUG] modelCatalog received:', {
      groups: modelGroups.map(g => ({ provider: g.provider, name: g.name, models: g.models.length })),
      totalModels: modelGroups.reduce((c, g) => c + g.models.length, 0),
      failures: message.catalog.failures,
      hasModels: modelGroups.length > 0,
    })
    console.log('[AMO-DEBUG] sample model fields:', modelGroups.flatMap(g => g.models.slice(0, 2).map(m => ({ id: m.id, hasContextWindow: m.contextWindow !== undefined, contextWindow: m.contextWindow }))))
    amoOnboarding(modelGroups.length > 0)
    renderModels()
    modelStatus.textContent = modelGroups.length === 0 ? '未发现可用模型'
      : `已加载 ${modelGroups.reduce((count, group) => count + group.models.length, 0)} 个模型`
    if (message.catalog.failures.length > 0) {
      modelStatus.title = message.catalog.failures.map(failure => `${failure.name}: ${failure.message}`).join('\n')
      reportError(`部分提供商的模型目录暂不可用：${modelStatus.title}`)
    }
  }
  if (message.type === 'modelCatalogStatus') {
    modelCatalogLoading = false
    if (message.status === 'error') modelGroups = []
    modelStatus.textContent = message.status === 'loading' ? '正在读取模型目录…' : message.text ?? '目录读取失败'
    if (message.text) reportError(message.text)
    renderModels()
  }
  if (message.type === 'queueFinished') {
    // Dequeue the oldest bubble for this session (FIFO).
    const key = message.sessionId ?? ''
    const bubbles = queuedBubbles.get(key) ?? queuedBubbles.get('')
    if (bubbles !== undefined && bubbles.length > 0) {
      bubbles.shift()?.remove()
      if (bubbles.length === 0) {
        queuedBubbles.delete(key)
        queuedBubbles.delete('')
      }
    }
  }
  if (message.type === 'modelRoute') {
    modelStatus.textContent = message.model
    modelStatus.title = `${message.provider}/${message.model}`
  }
})

function toolArguments(text) {
  if (typeof text !== 'string') return {}
  try { return JSON.parse(text) } catch { return {} }
}

const toolCategories = {
  read: 'read',
  read_image: 'readImage',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  apply_patch: 'edit',
  bash: 'commands',
  run_code: 'code',
  web_search: 'webSearch',
  web_fetch: 'webFetch',
  subagent: 'subagents',
  todo_write: 'plan',
  create_goal: 'plan',
  update_goal: 'plan',
  get_goal: 'plan',
  ask_user_question: 'questions',
  request_user_input: 'questions'
}

function toolCategory(name) {
  if (!name) return 'tools'
  if (name.endsWith('_inspect')) return 'search'
  if (name.startsWith('subagent_')) return 'subagents'
  if (name.startsWith('terminal_')) return 'commands'
  return toolCategories[name] ?? 'tools'
}

const categoryLabels = {
  read: '读取文件',
  readImage: '读取图片',
  search: '搜索代码',
  write: '写入文件',
  edit: '编辑文件',
  commands: '运行命令',
  code: '运行代码',
  webSearch: '搜索网络',
  webFetch: '访问网页',
  subagents: '协调子代理',
  plan: '更新计划',
  questions: '等待你的操作',
  tools: '调用工具',
  thinking: '思考'
}

function toolLabel(tool, args) {
  const file = args.file_path ?? args.pattern ?? args.path ?? args.command ?? args.query ?? args.url ?? args.description ?? args.title ?? ''
  const labels = { read: '读取', edit: '编辑', write: '写入', bash: '运行命令', glob: '查找文件', grep: '搜索' }
  return `${labels[tool] ?? tool}${file ? ` ${file}` : ''}`
}

// ── Process-group model (mirrors DSH ui-chat conversation-nodes/process-groups) ──
//
// A "process group" collects adjacent reasoning + tool nodes inside one Turn.
// A reply (assistant message with text content) closes the current group and
// stands alone, never folded. Steering / user input / turn boundaries also
// close the current group. Tool-category switches do NOT split a group.
//
// Structure:
//   <details class="process-group">
//     <summary>…category summary… <span class="tool-state">运行中</span></summary>
//     <div class="process-group-body">
//       <details class="reasoning-card">…思考…</details>
//       <div class="tool-group-item">…tool…</div>
//       …
//     </div>
//   </details>
//
// Replies and user messages live OUTSIDE this card, as siblings.

let currentProcessGroup = undefined

function closeCurrentProcessGroup(finalStateLabel) {
  if (!currentProcessGroup) return
  const { summaryText, stateEl, categoryCounts } = currentProcessGroup
  // Build a ranked category summary like "已读取文件并执行命令" (top 3).
  // Close only on a real phase transition, not for every delta. This preserves
  // one process group and avoids repeated style invalidation while streaming.
  const ranked = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])
  let summary = '分析完成'
  if (ranked.length === 1) summary = `已${categoryLabels[ranked[0][0]] ?? '调用工具'}`
  else if (ranked.length === 2) {
    const [a, b] = ranked.map(([k]) => categoryLabels[k] ?? '调用工具')
    summary = `已${a}并${b}`
  } else if (ranked.length > 2) {
    const [a, b, c] = ranked.map(([k]) => categoryLabels[k] ?? '调用工具')
    summary = `已${a}、${b}、${c}等`
  }
  const state = finalStateLabel ?? '完成'
  if (summaryText.textContent !== summary) summaryText.textContent = summary
  if (stateEl.textContent !== state) stateEl.textContent = state
  currentProcessGroup = undefined
}

function ensureProcessGroup() {
  if (currentProcessGroup) return currentProcessGroup
  const card = document.createElement('details')
  card.className = 'tool-call tool-group process-group'
  // DSH Standard mode: group body starts collapsed; only the header with the
  // live activity label is visible. The user can click to expand for details.
  card.open = false
  const summary = document.createElement('summary')
  const summaryText = document.createElement('span')
  summaryText.className = 'process-group-summary'
  summaryText.textContent = '正在分析'
  const stateEl = document.createElement('span')
  stateEl.className = 'tool-state'
  stateEl.textContent = '运行中'
  summary.append(summaryText, stateEl)
  card.appendChild(summary)
  const list = document.createElement('div')
  list.className = 'tool-group-list'
  card.appendChild(list)
  // Insert before the current assistant message if one exists, so reasoning
  // and tools appear above the reply text (Cursor-style process-first layout).
  if (current !== undefined && current.isConnected) {
    log.insertBefore(card, current)
  } else {
    log.appendChild(card)
  }
  empty.hidden = true
  currentProcessGroup = {
    card,
    list,
    summaryText,
    stateEl,
    categoryCounts: new Map(),
    liveCategory: undefined,
    liveDetail: ''
  }
  return currentProcessGroup
}

function noteToolCategory(group, toolName, args) {
  const cat = toolCategory(toolName)
  group.categoryCounts.set(cat, (group.categoryCounts.get(cat) ?? 0) + 1)
  group.liveCategory = cat
  // DSH Compact mode live header: just "正在读取文件", no per-tool detail.
  // The whole group stays collapsed while running and after settling;
  // users click the header to expand for details, like Cursor.
  const label = categoryLabels[cat] ?? '调用工具'
  group.summaryText.textContent = `正在${label}`
}

function showTool(message) {
  const args = toolArguments(message.arguments)
  const callId = String(message.callId ?? '')

  const group = ensureProcessGroup()
  noteToolCategory(group, message.tool, args)

  const item = document.createElement('div')
  item.className = 'tool-group-item'
  item.dataset.callId = callId
  const header = document.createElement('div')
  header.className = 'tool-group-header'
  const title = document.createElement('span')
  title.textContent = toolLabel(message.tool, args)
  const itemState = document.createElement('span')
  itemState.className = 'tool-state'
  itemState.textContent = '运行中'
  header.append(title, itemState)
  const command = document.createElement('div')
  command.className = 'tool-command'
  command.textContent = args.command ?? args.pattern ?? args.file_path ?? ''
  const content = document.createElement('pre')
  content.className = 'tool-detail'
  content.textContent = `参数\n${message.arguments ?? ''}\n\n等待结果…`
  item.append(header, command, content)
  group.list.appendChild(item)

  // DSH Compact: keep the group collapsed as tools stream in. Users expand manually.
  group.card.open = false

  toolCards.set(callId, { card: item, content, state: itemState, arguments: message.arguments, group })
  if (followOutput) scrollToLatest()
}

function finishTool(message) {
  const item = toolCards.get(String(message.callId ?? ''))
  if (!item) return
  item.state.textContent = message.error ? '失败' : '完成'
  item.card.classList.add(message.error ? 'tool-error' : 'tool-done')
  item.content.textContent = `参数\n${item.arguments ?? ''}\n\n结果\n${message.text}`
  const args = toolArguments(item.arguments)
  if (!message.error && ['edit', 'write'].includes(message.tool) && typeof args.file_path === 'string' && typeof message.checkpointSeq === 'number') {
    const diff = document.createElement('button')
    diff.className = 'tool-diff'
    diff.textContent = '查看内联修改'
    diff.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); vscode.postMessage({ type: 'openDiff', path: args.file_path, seq: message.checkpointSeq }) })
    const header = item.card.querySelector('.tool-group-header') ?? item.card.querySelector('summary')
    if (header) header.appendChild(diff)
  }
  toolCards.delete(String(message.callId ?? ''))
  if (followOutput) scrollToLatest()
}

function showTestResult(message) {
  const card = document.createElement('div')
  card.className = `test-result test-${message.status}`
  const title = document.createElement('strong')
  title.textContent = message.label
  card.appendChild(title)
  if (message.details) {
    const detail = document.createElement('span')
    detail.textContent = message.details
    card.appendChild(detail)
  }
  const tool = toolCards.get(String(message.callId ?? ''))
  if (tool) tool.card.insertAdjacentElement('afterend', card)
  else log.appendChild(card)
  empty.hidden = true
}

function showVerificationReport(report) {
  if (!report || !Array.isArray(report.runs)) return
  let card = document.getElementById('verification-report')
  if (!card) { card = document.createElement('div'); card.id = 'verification-report'; log.appendChild(card) }
  card.replaceChildren()
  const title = document.createElement('strong')
  const failures = report.failures.filter(failure => !failure.resolved)
  title.textContent = report.status === 'passed' ? '验证通过' : failures.length > 0 ? `发现 ${failures.length} 个失败测试` : '验证工作台'
  card.appendChild(title)
  for (const failure of failures) {
    const row = document.createElement('div'); row.className = 'verification-failure'
    const link = document.createElement('button'); link.textContent = failure.location ? `${failure.location.path}:${failure.location.line}` : failure.name
    link.title = '打开失败测试位置'
    if (failure.location) link.addEventListener('click', () => vscode.postMessage({ type: 'openLocation', ...failure.location }))
    else link.disabled = true
    row.appendChild(link)
    if (failure.message) { const detail = document.createElement('span'); detail.textContent = failure.message; row.appendChild(detail) }
    card.appendChild(row)
  }
  const latest = report.runs.at(-1)
  if (latest?.details) { const detail = document.createElement('div'); detail.textContent = latest.details; card.appendChild(detail) }
  if (report.files.length > 0) {
    const files = document.createElement('details')
    const summary = document.createElement('summary'); summary.textContent = `本轮修改 ${report.files.length} 个文件 · 查看 Diff 证据`
    files.appendChild(summary)
    for (const file of report.files) { const link = document.createElement('button'); link.textContent = file.path; link.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', path: file.path })); files.appendChild(link) }
    card.appendChild(files)
  }
  const rerun = report.rerunCommand
  if (rerun && report.status !== 'passed') {
    const button = document.createElement('button'); button.className = 'rerun-tests'; button.textContent = '重跑失败测试'
    button.addEventListener('click', () => { button.disabled = true; button.textContent = '测试重跑中…'; vscode.postMessage({ type: 'rerunTests', command: rerun }) })
    card.appendChild(button)
  }
  empty.hidden = true
}

function showQuestions(message) {
  current = undefined
  const card = document.createElement('div')
  card.className = 'question'
  for (const question of message.questions) {
    const title = document.createElement('div')
    title.className = 'question-title'
    title.textContent = question.question
    card.appendChild(title)
    if (question.detail) {
      const detail = document.createElement('div')
      detail.textContent = question.detail
      card.appendChild(detail)
    }
    for (const option of question.options ?? []) {
      const label = document.createElement('label')
      const choice = document.createElement('input')
      choice.type = question.multiSelect ? 'checkbox' : 'radio'
      choice.name = `${message.id}:${question.id}`
      choice.value = option.label
      choice.dataset.questionId = question.id
      label.append(choice, document.createTextNode(option.label))
      label.title = option.description ?? ''
      card.appendChild(label)
    }
    const custom = document.createElement('input')
    custom.type = 'text'
    custom.dataset.customId = question.id
    custom.placeholder = '自定义回答（可选）'
    card.appendChild(custom)
  }
  const submit = document.createElement('button')
  submit.textContent = '提交回答'
  submit.addEventListener('click', () => {
    const answers = message.questions.map(question => {
      const selected = [...card.querySelectorAll('input[type="radio"],input[type="checkbox"]')]
        .filter(input => input.dataset.questionId === question.id && input.checked).map(input => input.value)
      const custom = card.querySelector(`input[data-custom-id="${question.id}"]`).value.trim()
      return { id: question.id, selected, ...(custom ? { custom } : {}) }
    })
    if (answers.some(answer => answer.selected.length === 0 && !answer.custom)) {
      reportError('请为每个问题选择选项或填写自定义回答。')
      return
    }
    vscode.postMessage({ type: 'answerQuestions', id: message.id, answers, sessionId: activeSessionId || undefined })
    card.remove()
  })
  card.appendChild(submit)
  log.appendChild(card)
  empty.hidden = true
  if (followOutput) scrollToLatest()
}

function showQueuedBubble(text, sessionId) {
  const bubble = document.createElement('div')
  bubble.className = 'queue-item'
  const label = document.createElement('span')
  label.className = 'queue-label'
  label.textContent = '排队中'
  const content = document.createElement('span')
  content.className = 'queue-text'
  content.textContent = text
  content.title = text
  const actions = document.createElement('span')
  actions.className = 'queue-actions'
  const runNow = document.createElement('button')
  runNow.type = 'button'
  runNow.className = 'queue-steer'
  runNow.textContent = '立即执行'
  runNow.title = '打断当前任务，立即执行此条'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'queue-cancel'
  cancel.textContent = '取消'
  cancel.title = '从队列中移除'
  actions.append(runNow, cancel)
  bubble.append(label, content, actions)
  document.getElementById('queue-list').appendChild(bubble)
  const remove = () => { if (bubble.isConnected) bubble.remove() }
  runNow.addEventListener('click', () => {
    vscode.postMessage({ type: 'queueAction', action: 'steer', sessionId })
  })
  cancel.addEventListener('click', () => {
    remove()
    // Remove this specific bubble from the tracking array so queueFinished
    // does not try to remove it again later.
    for (const [key, bubbles] of queuedBubbles) {
      const index = bubbles.findIndex(item => item.remove === remove)
      if (index >= 0) { bubbles.splice(index, 1); if (bubbles.length === 0) queuedBubbles.delete(key); break }
    }
    vscode.postMessage({ type: 'queueAction', action: 'cancel', sessionId })
  })
  const entry = { remove }
  return entry
}

document.getElementById('send').addEventListener('click', () => {
  const text = input.value.trim()
  if (running) {
    if (!text) {
      // No text → stop the current task (existing behavior)
    status.textContent = '正在停止本轮任务…'
    send.disabled = true
    vscode.postMessage({ type: 'stop', sessionId: activeSessionId || undefined })
    return
  }
    // Text present while running → queue for next turn; user may steer or cancel from the bubble.
    input.value = ''
    updateInputHighlight()
    updateSendButton()
    closeFilePicker()
    const references = fileReferences.filter(reference => text.includes(`@${reference.path}`))
    fileReferences = []
    updateInputHighlight()
    let route
    try {
      const [provider, id] = JSON.parse(model.dataset.value ?? '{}')
      if (typeof provider === 'string' && typeof id === 'string') route = { provider, model: id }
    } catch { /* retain the configured fallback */ }
    const bubble = showQueuedBubble(text, activeSessionId || undefined)
    const sessionId = activeSessionId || undefined
    const key = sessionId ?? ''
    const bubbles = queuedBubbles.get(key) ?? []
    bubbles.push(bubble)
    queuedBubbles.set(key, bubbles)
    const attachments = pendingImages.map(img => ({ type: img.type, data: img.data, mimeType: img.mimeType, name: img.name }))
    clearImageAttachments()
    vscode.postMessage({ type: 'queue', text, references, attachments, sessionId, ...route ? { route } : {} })
    // Input is now empty while the previous turn still runs: show the red stop state.
    updateSendButton()
    return
  }
  if ((!text && pendingImages.length === 0) || send.disabled) return
  // The controller echoes one user event with the exact captured editor snapshot.
  input.value = ''
  updateInputHighlight()
  current = undefined
  busy(true)
  updateSendButton()
  closeFilePicker()
  const references = fileReferences.filter(reference => text.includes(`@${reference.path}`))
  fileReferences = []
  updateInputHighlight()
  const attachments = pendingImages.map(img => ({ type: img.type, data: img.data, mimeType: img.mimeType, name: img.name }))
  clearImageAttachments()
  let route
  try {
    const [provider, id] = JSON.parse(model.dataset.value ?? '{}')
    if (typeof provider === 'string' && typeof id === 'string') route = { provider, model: id }
  } catch { /* retain the configured fallback */ }
  vscode.postMessage({ type: 'send', text, references, attachments, sessionId: activeSessionId || undefined, ...route ? { route } : {} })
  // Register the local echo as pending: the extension's 'user' echo arrives
  // only after the Host admits the prompt, so a stop before that echo (a
  // failed cold start) restores the text into the input box.
  const echo = log.lastElementChild
  if (echo?.classList?.contains('message') && echo.classList.contains('user')) {
    registerSubmission(text, echo, false)
  }
})
const queuedBubbles = new Map() // sessionId → array of bubble objects (FIFO)
input.addEventListener('input', () => { updateInputHighlight(); updateFileSearch(); updateSendButton() })
input.addEventListener('scroll', () => {
  inputHighlight.scrollTop = input.scrollTop
  inputHighlight.scrollLeft = input.scrollLeft
})
input.addEventListener('click', () => { if (fileTrigger !== undefined) updateFileSearch() })
input.addEventListener('blur', () => { closeFilePicker() })

// Image paste support
input.addEventListener('paste', (event) => {
  const items = event.clipboardData?.items
  if (!items) return
  const images = extractImagesFromClipboard(items)
  if (images.length === 0) return // Let the paste proceed normally for text
  event.preventDefault()
  for (const item of images) {
    const file = item.getAsFile()
    if (file) addImageAttachment(file)
  }
})

// Image drag-and-drop support — handles both OS file drops and VS Code explorer drops
function handleDragOver(event) {
  const types = event.dataTransfer?.types ?? []
  // OS files: types includes 'Files'. VS Code explorer: types includes 'codefiles'.
  if (types.includes('Files') || types.includes('codefiles')) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }
}

async function handleDrop(event) {
  const dt = event.dataTransfer
  if (!dt) return
  console.log('[ImageDrop] types:', [...dt.types], 'files:', dt.files.length, 'items:', dt.items.length)

  // 1. OS file drop: dataTransfer.files has File objects
  const imageFiles = [...dt.files].filter(f => f.type.startsWith('image/'))
  if (imageFiles.length > 0) {
    event.preventDefault()
    event.stopPropagation()
    for (const file of imageFiles) addImageAttachment(file)
    input.focus()
    return
  }

  // 2. VS Code explorer drop: 'codefiles' contains file paths as JSON
  const codeFiles = dt.getData('codefiles')
  if (codeFiles) {
    event.preventDefault()
    event.stopPropagation()
    try {
      const paths = JSON.parse(codeFiles)
      const imagePaths = paths.filter(p => /\.(png|jpe?g|gif|webp)$/i.test(p))
      for (const path of imagePaths) {
        // Ask extension host to read the file and return base64
        vscode.postMessage({ type: 'readFileForImage', path })
      }
      if (imagePaths.length > 0) input.focus()
    } catch (e) { console.warn('[ImageDrop] codefiles parse failed:', e) }
    return
  }

  // 3. Fallback: try items API (some environments)
  for (const item of dt.items) {
    if (item.type.startsWith('image/')) {
      event.preventDefault()
      event.stopPropagation()
      const file = item.getAsFile()
      if (file) addImageAttachment(file)
    }
  }
}

input.addEventListener('dragover', handleDragOver)
input.addEventListener('drop', (e) => { void handleDrop(e) })

// Allow dropping images anywhere in the conversation area too
conversation.addEventListener('dragover', handleDragOver)
conversation.addEventListener('drop', (e) => { void handleDrop(e) })

input.addEventListener('keydown', event => {
  if (fileTrigger !== undefined && !filePicker.hidden && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      fileActiveIndex = (fileActiveIndex + (event.key === 'ArrowDown' ? 1 : -1) + filteredFiles.length) % filteredFiles.length
      fileSearch()
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (filteredFiles.length > 0) { event.preventDefault(); chooseFile(fileActiveIndex) }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); closeFilePicker(); return }
  }
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.isComposing) return
  event.preventDefault()
  send.click()
})

// Attach image button: opens file picker via hidden input
const attachImageBtn = document.getElementById('attach-image')
const imageFileInput = document.createElement('input')
imageFileInput.type = 'file'
imageFileInput.accept = 'image/*'
imageFileInput.multiple = true
imageFileInput.style.display = 'none'
imageFileInput.addEventListener('change', () => {
  for (const file of imageFileInput.files || []) {
    if (file.type.startsWith('image/')) addImageAttachment(file)
  }
  imageFileInput.value = ''
})
document.body.appendChild(imageFileInput)
attachImageBtn?.addEventListener('click', () => imageFileInput.click())

function refreshModelCatalog() {
  if (running || model.disabled || modelCatalogLoading) return
  modelCatalogLoading = true
  modelStatus.textContent = '正在请求模型目录…'
  vscode.postMessage({ type: 'modelCatalog' })
}
model.addEventListener('click', (event) => {
  if (amoById('model-menu').hidden) refreshModelCatalog()
  amoModelMenuClick(event)
})
model.addEventListener('change', () => {
  if (running || model.disabled || modelGroups.length === 0) {
    renderModels()
    return
  }
  let route
  try {
    const [provider, id] = JSON.parse(model.dataset.value)
    if (typeof provider !== 'string' || typeof id !== 'string') return
    route = { provider, model: id }
  } catch {
    renderModels()
    return
  }
  selectedRoute = route
  const selectionId = ++modelSelectionVersion
  modelStatus.textContent = '正在保存…'
  vscode.postMessage({ type: 'modelRoute', route, selectionId, catalog: { groups: modelGroups, failures: [] } })
})
sessionSelect.addEventListener('click', () => {
  if (sessionSelect.disabled) return
  sessionMenu.hidden = !sessionMenu.hidden
  sessionSelect.setAttribute('aria-expanded', String(!sessionMenu.hidden))
  if (!sessionMenu.hidden) sessionMenu.querySelector('[aria-selected="true"]')?.focus()
})
document.addEventListener('click', event => {
  if (!document.getElementById('session-picker').contains(event.target)) closeSessionMenu()
  // Close model menu when clicking outside the picker
  const modelMenu = document.getElementById('model-menu')
  if (!modelMenu.hidden && !document.getElementById('model-picker').contains(event.target)) {
    modelMenu.hidden = true
    closeAllModelMenus()
  }
  // Close history-edit model menus when clicking outside them
  document.querySelectorAll('.history-model-menu').forEach(menu => {
    if (!menu.hidden && !menu.parentElement.contains(event.target)) {
      menu.hidden = true
      closeAllModelMenus()
    }
  })
})
document.addEventListener('keydown', event => {
  if (sessionSelect.getAttribute('aria-expanded') !== 'true') return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSessionMenu()
    sessionSelect.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const options = [...sessionMenu.querySelectorAll('.session-option')]
  if (options.length === 0) return
  const currentIndex = options.indexOf(document.activeElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
    : (currentIndex < 0 ? 0 : currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
  options[index].focus()
  options[index].scrollIntoView()
})
refreshSessions.addEventListener('click', () => {
  sessionSelect.disabled = true
  refreshSessions.disabled = true
  vscode.postMessage({ type: 'sessionList' })
})
contextPreview.addEventListener('click', () => {
  if (!editorContext) return
  vscode.postMessage({ type: 'openContext', reference: { uri: editorContext.uri, line: editorContext.selection?.startLine ?? editorContext.cursorLine } })
})
document.getElementById('new').addEventListener('click', () => {
  activeSessionId = ''
  pendingSessionId = ''
  busy(false)
  renderSessions()
  vscode.postMessage({ type: 'new' })
})
document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop', sessionId: activeSessionId || undefined }))
document.getElementById('diff').addEventListener('click', () => vscode.postMessage({ type: 'openDiff', sessionId: activeSessionId || undefined }))
document.getElementById('diff-visible').addEventListener('click', () => vscode.postMessage({ type: 'openDiff', sessionId: activeSessionId || undefined }))
document.getElementById('resume').addEventListener('click', () => vscode.postMessage({ type: 'resume', sessionId: activeSessionId || undefined }))
document.getElementById('toggle-tools').addEventListener('click', event => {
  const visible = document.getElementById('tools').classList.toggle('visible')
  event.currentTarget.setAttribute('aria-expanded', String(visible))
})
document.getElementById('details').addEventListener('click', event => {
  const expand = event.currentTarget.getAttribute('aria-expanded') !== 'true'
  document.querySelectorAll('details.tool-call').forEach(card => { card.open = expand })
  event.currentTarget.setAttribute('aria-expanded', String(expand))
  event.currentTarget.title = expand ? '收起全部工具调用' : '展开全部工具调用'
})
status.textContent = '面板已就绪'
status.hidden = true
trustWorkspace.addEventListener('click', () => {
  if (trusted || trustRequestPending) return
  trustRequestPending = true
  applyTrustState()
  vscode.postMessage({ type: 'manageTrust' })
})
// --- P1-1: Webview state persistence ---
// Restore draft and scroll position after reload
// Note: acquireVsCodeApi() may not provide getState/setState in test environments
const savedState = typeof vscode.getState === 'function' ? vscode.getState() : undefined
if (savedState) {
  if (savedState.draft) input.value = savedState.draft
  if (savedState.scrollTop) conversation.scrollTop = savedState.scrollTop
  if (savedState.sessionId) activeSessionId = savedState.sessionId
}
// Save state on input and scroll
let stateSaveTimer
function saveState() {
  clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => {
    if (typeof vscode.setState === 'function') {
      vscode.setState({
        draft: input.value,
        scrollTop: conversation.scrollTop,
        sessionId: activeSessionId,
      })
    }
  }, 500)
}
input.addEventListener('input', saveState)
conversation.addEventListener('scroll', saveState)
// Save immediately before unload
window.addEventListener('beforeunload', () => {
  if (typeof vscode.setState === 'function') {
    vscode.setState({
      draft: input.value,
      scrollTop: conversation.scrollTop,
      sessionId: activeSessionId,
    })
  }
})
applyTrustState()
vscode.postMessage({ type: 'ready' })
// Eagerly index workspace files so inline file references in assistant replies
// are clickable from the first rendered message, not only after an @ keystroke.
if (!fileListRequested) { fileListRequested = true; vscode.postMessage({ type: 'fileList' }) }
