import fs from "node:fs/promises"
import path from "node:path"

const home = process.env.HOME
if (!home) {
  throw new Error("HOME is not set; cannot locate OpenCode config")
}

const root = process.cwd()
const distDir = path.join(root, "dist")
const pluginSource = path.join(distDir, ".opencode", "plugins", "credit-switcher.js")
const configSource = path.join(root, ".opencode", "credit-switcher.json")

const targetDir = path.join(home, ".config", "opencode")
const pluginTarget = path.join(targetDir, "plugins", "credit-switcher.js")
const configTarget = path.join(targetDir, "credit-switcher.json")

await fs.mkdir(path.dirname(pluginTarget), { recursive: true })
await fs.copyFile(pluginSource, pluginTarget)

try {
  await fs.access(configTarget)
} catch {
  await fs.copyFile(configSource, configTarget)
}
