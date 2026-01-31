import path from "node:path"

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULT_CONFIG = {
  enabled: true,
  primaryModel: "azure-openai/<deployment-name>",
  fallbackModel: "llama.cpp/qwen3-coder:a3b",
  licensing: {
    requireProviders: ["azure-openai", "github-copilot"],
  },
  restore: {
    enabled: true,
    intervalHours: 24,
  },
  fallback: {
    onStatus: [402, 429],
    onErrorCodes: ["CREDITS_EXHAUSTED", "ACCOUNT_LIMIT_REACHED", "QUOTA_EXCEEDED"],
    onMessageMatches: ["credit", "quota", "insufficient", "exceeded", "payment", "limit"],
  },
  notifications: {
    toastOnFallback: true,
    toastOnRestore: true,
    confirmOnFallback: false,
  },
}

const SERVICE_NAME = "credit-switcher"

export const CreditSwitcher = async ({ client, directory, worktree }) => {
  const state = {
    config: null,
    configPath: null,
    statePath: null,
    stateData: null,
    attemptedSessions: new Set(),
    restoreTimer: null,
  }

  const configPaths = getConfigPaths(directory, worktree)
  const initial = await loadConfig(configPaths, client)
  state.config = initial.config
  state.configPath = initial.path

  state.statePath = getStatePath(state.configPath, directory, worktree)
  state.stateData = await loadState(state.statePath, client)

  if (state.config?.restore?.enabled) {
    scheduleRestoreCheck({ state, client })
  }

  if (!state.configPath) {
    await safeLog(client, "warn", "No config found; plugin disabled", { paths: configPaths })
  }

  return {
    event: async ({ event }) => {
      if (!event || event.type !== "session.error") return

      if (!state.config || !state.config.enabled) return

      const config = state.config

      if (!isCreditExhausted(event, config)) return

      const sessionId = extractSessionId(event)
      if (!sessionId) {
        await safeLog(client, "warn", "Credit error without session id", { event })
        return
      }

      if (state.attemptedSessions.has(sessionId)) return

      if (!(await hasRequiredProviders(client, config))) {
        await safeLog(client, "warn", "Required providers not configured; skipping fallback", {
          required: config.licensing?.requireProviders || [],
        })
        return
      }

      const primaryModel = parseModel(config.primaryModel)
      const fallbackModel = parseModel(config.fallbackModel)

      if (!fallbackModel) {
        await safeLog(client, "error", "Invalid fallbackModel in config", {
          value: config.fallbackModel,
          path: state.configPath,
        })
        return
      }

      const sessionModel = await getSessionModel(client, sessionId)
      if (primaryModel && sessionModel && sessionModel.providerId) {
        if (sessionModel.providerId !== primaryModel.providerId) return
      }

      const lastUserMessage = await getLastUserMessage(client, sessionId)
      if (!lastUserMessage) {
        await safeLog(client, "warn", "No user message to retry", { sessionId })
        return
      }

      const shouldRetry = await confirmFallback({
        client,
        config,
        sessionId,
        fallbackModel,
      })

      if (!shouldRetry) {
        state.attemptedSessions.add(sessionId)
        await safeLog(client, "info", "User declined fallback retry", { sessionId })
        return
      }

      state.attemptedSessions.add(sessionId)

      await safeLog(client, "info", "Retrying with fallback model", {
        sessionId,
        fallback: fallbackModel,
      })

      if (state.stateData) {
        const now = Date.now()
        state.stateData.sessions[sessionId] = {
          exhaustedAt: now,
          lastFallbackAt: now,
          originalModel: modelToString(sessionModel || primaryModel),
          fallbackModel: modelToString(fallbackModel),
        }
        await saveState(state.statePath, state.stateData, client)
      }

      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: {
            providerID: fallbackModel.providerId,
            modelID: fallbackModel.modelId,
          },
          parts: lastUserMessage.parts,
        },
      })

      if (config.notifications?.toastOnFallback) {
        try {
          await client.tui.showToast({
            body: {
              message: "Credits exhausted. Switched to fallback model.",
              variant: "warning",
            },
          })
        } catch (error) {
          await safeLog(client, "debug", "Toast failed", { error: String(error) })
        }
      }
    },
  }
}

function getConfigPaths(directory, worktree) {
  const paths = []
  if (Bun.env.OPENCODE_CREDIT_SWITCHER_CONFIG) {
    paths.push(Bun.env.OPENCODE_CREDIT_SWITCHER_CONFIG)
  }
  if (worktree) paths.push(`${worktree}/.opencode/credit-switcher.json`)
  if (directory && directory !== worktree) {
    paths.push(`${directory}/.opencode/credit-switcher.json`)
  }
  if (Bun.env.HOME) paths.push(`${Bun.env.HOME}/.config/opencode/credit-switcher.json`)
  return paths
}

function getStatePath(configPath, directory, worktree) {
  if (configPath) return path.join(path.dirname(configPath), "credit-switcher.state.json")
  if (worktree) return path.join(worktree, ".opencode", "credit-switcher.state.json")
  if (directory) return path.join(directory, ".opencode", "credit-switcher.state.json")
  if (Bun.env.HOME) return path.join(Bun.env.HOME, ".config", "opencode", "credit-switcher.state.json")
  return null
}

async function loadConfig(paths, client) {
  for (const path of paths) {
    if (!path) continue
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) continue
      const text = await file.text()
      const raw = JSON.parse(text)
      return { config: normalizeConfig(raw), path }
    } catch (error) {
      await safeLog(client, "error", "Failed to load config", { path, error: String(error) })
      return { config: { enabled: false }, path }
    }
  }

  return { config: { enabled: false }, path: null }
}

async function loadState(statePath, client) {
  const empty = { sessions: {}, lastCheckAt: 0 }
  if (!statePath) return empty

  try {
    const file = Bun.file(statePath)
    if (!(await file.exists())) return empty
    const text = await file.text()
    const raw = JSON.parse(text)
    return { ...empty, ...raw, sessions: raw.sessions || {} }
  } catch (error) {
    await safeLog(client, "error", "Failed to load state", { path: statePath, error: String(error) })
    return empty
  }
}

async function saveState(statePath, stateData, client) {
  if (!statePath) return

  try {
    await Bun.mkdir(path.dirname(statePath), { recursive: true })
    await Bun.write(statePath, JSON.stringify(stateData, null, 2))
  } catch (error) {
    await safeLog(client, "error", "Failed to save state", { path: statePath, error: String(error) })
  }
}

function normalizeConfig(raw) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    licensing: { ...DEFAULT_CONFIG.licensing, ...(raw.licensing || {}) },
    restore: { ...DEFAULT_CONFIG.restore, ...(raw.restore || {}) },
    fallback: { ...DEFAULT_CONFIG.fallback, ...(raw.fallback || {}) },
    notifications: { ...DEFAULT_CONFIG.notifications, ...(raw.notifications || {}) },
  }

  merged.licensing.requireProviders = normalizeArray(
    merged.licensing.requireProviders,
    DEFAULT_CONFIG.licensing.requireProviders
  )

  merged.fallback.onStatus = normalizeArray(merged.fallback.onStatus, DEFAULT_CONFIG.fallback.onStatus)
  merged.fallback.onErrorCodes = normalizeArray(
    merged.fallback.onErrorCodes,
    DEFAULT_CONFIG.fallback.onErrorCodes
  )
  merged.fallback.onMessageMatches = normalizeArray(
    merged.fallback.onMessageMatches,
    DEFAULT_CONFIG.fallback.onMessageMatches
  )

  return merged
}

function normalizeArray(value, fallback) {
  if (Array.isArray(value)) return value
  return Array.isArray(fallback) ? fallback : []
}

function parseModel(value) {
  if (!value || typeof value !== "string") return null
  const parts = value.split("/")
  if (parts.length < 2) return null
  return { providerId: parts[0], modelId: parts.slice(1).join("/") }
}

function modelToString(model) {
  if (!model) return null
  if (typeof model === "string") return model
  if (model.providerId && model.modelId) return `${model.providerId}/${model.modelId}`
  return null
}

function modelsEqual(a, b) {
  if (!a || !b) return false
  return a.providerId === b.providerId && a.modelId === b.modelId
}

function isCreditExhausted(event, config) {
  const status = extractStatus(event)
  const code = extractCode(event)
  const text = extractText(event)

  const statusMatches = config.fallback.onStatus.some((value) => Number(value) === status)
  const codeMatches = code
    ? config.fallback.onErrorCodes.some((value) => value.toLowerCase() === code.toLowerCase())
    : false
  const textMatches = text
    ? config.fallback.onMessageMatches.some((value) => text.includes(value.toLowerCase()))
    : false

  return statusMatches || codeMatches || textMatches
}

function extractStatus(event) {
  const candidates = [
    event?.properties?.error?.status,
    event?.properties?.status,
    event?.error?.status,
    event?.status,
  ]
  for (const value of candidates) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractCode(event) {
  const candidates = [
    event?.properties?.error?.code,
    event?.properties?.code,
    event?.error?.code,
    event?.code,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function extractText(event) {
  const candidates = [
    event?.properties?.error?.message,
    event?.properties?.message,
    event?.error?.message,
    event?.message,
  ]

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.toLowerCase()
  }

  try {
    return JSON.stringify(event).toLowerCase()
  } catch {
    return ""
  }
}

function extractSessionId(event) {
  const candidates = [
    event?.properties?.session?.id,
    event?.properties?.sessionId,
    event?.properties?.id,
    event?.session?.id,
    event?.sessionId,
    event?.id,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

async function hasRequiredProviders(client, config) {
  const required = config.licensing?.requireProviders || []
  if (!required.length) return true

  const providers = await getProviders(client)
  if (!providers.length) return false

  const ids = providers
    .map((provider) => provider.id || provider.providerID || provider.name)
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())

  return required.every((value) => ids.includes(String(value).toLowerCase()))
}

async function getProviders(client) {
  try {
    const response = await client.config.providers()
    const payload = response?.data ?? response
    return payload?.providers || []
  } catch {
    return []
  }
}

async function getSessionModel(client, sessionId) {
  try {
    const response = await client.session.get({ path: { id: sessionId } })
    const session = response?.data ?? response
    const model = session?.model || session?.config?.model || session?.current?.model

    if (!model) return null
    if (typeof model === "string") return parseModel(model)

    const providerId = model.providerID || model.providerId || model.provider
    const modelId = model.modelID || model.modelId || model.id

    if (providerId && modelId) {
      return { providerId, modelId }
    }
  } catch {
    return null
  }

  return null
}

async function setSessionModel(client, sessionId, model) {
  if (!model) return false
  try {
    await client.session.update({
      path: { id: sessionId },
      body: {
        model: {
          providerID: model.providerId,
          modelID: model.modelId,
        },
      },
    })
    return true
  } catch {
    return false
  }
}

async function getLastUserMessage(client, sessionId) {
  try {
    const response = await client.session.messages({ path: { id: sessionId } })
    const messages = response?.data ?? response
    if (!Array.isArray(messages)) return null

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      const info = entry?.info || entry?.message || {}
      const role = info.role || info.type || info.kind
      const isUser = role === "user" || role === "UserMessage" || info.user === true
      if (isUser && Array.isArray(entry.parts) && entry.parts.length) {
        return entry
      }
    }
  } catch {
    return null
  }

  return null
}

async function confirmFallback({ client, config, sessionId, fallbackModel }) {
  if (!config.notifications?.confirmOnFallback) return true
  if (!client?.tui?.showConfirm) return true

  try {
    const response = await client.tui.showConfirm({
      body: {
        message: "Credits exhausted. Retry with fallback model?",
        confirmText: "Retry",
        cancelText: "Cancel",
      },
    })
    const payload = response?.data ?? response
    if (typeof payload === "boolean") return payload

    const confirmed =
      payload?.confirmed ?? payload?.accepted ?? payload?.value ?? payload?.ok ?? payload?.success

    if (typeof confirmed === "boolean") return confirmed
  } catch (error) {
    await safeLog(client, "debug", "Confirm prompt failed", {
      sessionId,
      error: String(error),
      fallback: fallbackModel,
    })
  }

  return true
}

function scheduleRestoreCheck({ state, client }) {
  if (state.restoreTimer) clearInterval(state.restoreTimer)
  const hours = Number(state.config?.restore?.intervalHours || 24)
  const intervalMs = Math.max(1, hours) * 60 * 60 * 1000

  state.restoreTimer = setInterval(() => {
    void runRestoreCheck({ state, client, intervalMs })
  }, intervalMs)

  void runRestoreCheck({ state, client, intervalMs })
}

async function runRestoreCheck({ state, client, intervalMs }) {
  if (!state.config?.restore?.enabled) return
  if (!state.stateData) return

  const now = Date.now()
  const lastCheckAt = Number(state.stateData.lastCheckAt || 0)
  const threshold = intervalMs || DAY_MS

  if (now - lastCheckAt < threshold) return

  state.stateData.lastCheckAt = now
  const sessions = state.stateData.sessions || {}

  for (const [sessionId, record] of Object.entries(sessions)) {
    const exhaustedAt = Number(record?.exhaustedAt || 0)
    if (!exhaustedAt || now - exhaustedAt < threshold) continue

    const originalModel = parseModel(record.originalModel || state.config.primaryModel)
    const fallbackModel = parseModel(record.fallbackModel || state.config.fallbackModel)
    if (!originalModel || !fallbackModel) continue

    const sessionModel = await getSessionModel(client, sessionId)
    if (sessionModel && modelsEqual(sessionModel, originalModel)) {
      record.restoredAt = now
      continue
    }
    if (sessionModel && !modelsEqual(sessionModel, fallbackModel)) continue

    const updated = await setSessionModel(client, sessionId, originalModel)
    record.lastRestoreAttemptAt = now

    if (updated) {
      record.restoredAt = now
      if (state.config.notifications?.toastOnRestore) {
        try {
          await client.tui.showToast({
            body: {
              message: "Credits restored. Switched back to primary model.",
              variant: "success",
            },
          })
        } catch (error) {
          await safeLog(client, "debug", "Restore toast failed", { error: String(error) })
        }
      }
    } else {
      await safeLog(client, "warn", "Failed to restore primary model", {
        sessionId,
        model: originalModel,
      })
    }
  }

  await saveState(state.statePath, state.stateData, client)
}

async function safeLog(client, level, message, extra = {}) {
  try {
    await client.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    })
  } catch {
    return
  }
}
