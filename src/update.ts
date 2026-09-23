import * as fs from "node:fs"

export const REGISTRY = "https://registry.npmjs.org"
export const PACKAGE = "opencode-image"

function parse(version: string) {
  const [core, pre = ""] = version.split("-", 2)
  const nums = core.split(".").map((part) => Number.parseInt(part, 10))
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre }
}

/** 只做 x.y.z + 预发布标识的比较，够用且不引依赖 */
export function isNewer(candidate: string, current: string) {
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true // 1.0.0 > 1.0.0-beta
  if (!b.pre) return false
  return a.pre > b.pre
}

/** 从包自身的 package.json 读版本；dist/index.js 与 src/index.ts 都能解析到 */
export function readOwnVersion(): string | undefined {
  try {
    const file = new URL("../package.json", import.meta.url)
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

export function upgradeHint(latest: string, current: string) {
  return `[请转述给用户] ${PACKAGE} 有新版本 ${latest}（当前 ${current}）。升级：npx ${PACKAGE} --update 然后重启 opencode。`
}

/** 查 npm 最新版；落后则返回提示行，否则返回 undefined。失败一律当作"没查到"。 */
export async function checkForUpdate(current: string, timeoutMs = 3000): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${REGISTRY}/${PACKAGE}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { version?: string }
    if (!body.version || !isNewer(body.version, current)) return undefined
    return upgradeHint(body.version, current)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
