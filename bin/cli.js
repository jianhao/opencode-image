#!/usr/bin/env node
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PACKAGE = "opencode-image"
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "opencode-image")

const args = process.argv.slice(2)

const version = (() => {
  try {
    const file = new URL("../package.json", import.meta.url)
    return JSON.parse(fs.readFileSync(file, "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()

const USAGE = `${PACKAGE} v${version}

用法:
  npx ${PACKAGE} --update              清理 opencode 的插件缓存并重启 opencode，即可装上最新版
  npx ${PACKAGE} --clean-cache         清理对话缩略图缓存（不影响生成的图片）
  npx ${PACKAGE} --version             显示版本
  npx ${PACKAGE} --help                显示帮助

选项:
  --cache-dir <path>   缩略图缓存目录，默认 <系统临时目录>/opencode-image
                       （如果你的配置里改过 cacheDir，用这个参数或 OPENCODE_IMAGE_CACHE_DIR 指过去）

为什么需要 --update:
  opencode 对 npm 形式的插件不做版本检查——只要缓存目录里已经装过就直接复用。
  所以发布新版后必须清掉缓存，opencode 才会重新下载。详见 README「升级」一节。
`

function flag(name) {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? "") : undefined
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** opencode 的插件缓存在 <cache>/packages/<spec>，spec 可能是 opencode-image 或 opencode-image@latest */
function pluginCacheRoot() {
  return process.env.OPENCODE_IMAGE_PLUGIN_CACHE ?? path.join(os.homedir(), ".cache", "opencode", "packages")
}

function update() {
  const root = pluginCacheRoot()
  if (!fs.existsSync(root)) {
    console.log(`缓存目录不存在，无需清理：${root}`)
    console.log("直接重启 opencode 即可。")
    return
  }

  const targets = fs
    .readdirSync(root)
    .filter((entry) => entry === PACKAGE || entry.startsWith(`${PACKAGE}@`))
    .map((entry) => path.join(root, entry))

  if (targets.length === 0) {
    console.log(`没有找到 ${PACKAGE} 的缓存，无需清理。`)
    console.log("直接重启 opencode 即可。")
    return
  }

  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`已删除 ${target}`)
  }
  console.log("")
  console.log(`✅ 已清理 ${targets.length} 个缓存目录，重启 opencode 后会重新下载最新版。`)
}

function cleanCache() {
  const dir = flag("--cache-dir") ?? process.env.OPENCODE_IMAGE_CACHE_DIR ?? DEFAULT_CACHE_DIR
  if (!fs.existsSync(dir)) {
    console.log(`缩略图缓存目录不存在，无需清理：${dir}`)
    return
  }

  let count = 0
  let bytes = 0
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".png")) continue
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      bytes += stat.size
      count += 1
      fs.rmSync(file, { force: true })
    } catch {
      // 单个文件删不掉就跳过，最后按实际删掉的数量汇报
    }
  }

  console.log(`✅ 已清理缩略图缓存：${count} 个文件 / ${humanBytes(bytes)}`)
  console.log(`目录：${dir}`)
  console.log("生成的图片不受影响，会话里的图片仍能显示（需要时会重新生成缩略图）。")
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(version)
  process.exit(0)
}

if (args.includes("--update")) {
  update()
  process.exit(0)
}

if (args.includes("--clean-cache")) {
  cleanCache()
  process.exit(0)
}

console.log(USAGE)
process.exit(1)
