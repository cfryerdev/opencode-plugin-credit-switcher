import fs from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const distDir = path.join(root, "dist")

const files = [
  {
    src: path.join(root, "index.js"),
    dest: path.join(distDir, "index.js"),
  },
  {
    src: path.join(root, ".opencode", "plugins", "credit-switcher.js"),
    dest: path.join(distDir, ".opencode", "plugins", "credit-switcher.js"),
  },
]

await fs.rm(distDir, { recursive: true, force: true })
await fs.mkdir(distDir, { recursive: true })

for (const file of files) {
  await fs.mkdir(path.dirname(file.dest), { recursive: true })
  await fs.copyFile(file.src, file.dest)
}
