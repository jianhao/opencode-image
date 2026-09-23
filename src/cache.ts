import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

export const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "opencode-image")
export const DEFAULT_CACHE_LIMIT = 50

export type CacheStats = {
  dir: string
  count: number
  bytes: number
  /** 最旧一个预览文件已经存在了多久（毫秒）；空缓存时为 undefined */
  oldestMs?: number
}

export function humanBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function humanAge(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "不到 1 分钟"
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/**
 * 对话里展示用的缩略图缓存。
 *
 * 文件名由「源文件绝对路径 + 文件大小 + mtime + 目标宽度」哈希而成，所以：
 * - 同一个文件同一尺寸永远命中同一个文件名 → 不重复生成，跨重启也能复用
 * - 源文件内容变了（mtime/size 变）就是新 key → 不会拿到过期缩略图
 * - 缓存目录里只有我们自己的 *.png，清理时不会误伤其它文件
 *
 * 超过上限时按访问时间（mtime，命中时会 utimes 刷新）淘汰最旧的，并记一条待展示的通知。
 */
export class PreviewCache {
  private notice?: string

  constructor(
    private readonly dir: string,
    private readonly limit: number,
  ) {}

  get directory() {
    return this.dir
  }

  private target(source: string, max: number) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(source)
    } catch {
      return undefined
    }
    const hash = createHash("sha1")
      .update(`${path.resolve(source)}|${stat.size}|${Math.floor(stat.mtimeMs)}|${max}`)
      .digest("hex")
      .slice(0, 16)
    return path.join(this.dir, `${hash}.png`)
  }

  /** 命中则刷新访问时间并返回缓存文件；未命中返回 undefined */
  hit(source: string, max: number) {
    const file = this.target(source, max)
    if (!file || !fs.existsSync(file)) return undefined
    const now = new Date()
    try {
      fs.utimesSync(file, now, now)
    } catch {
      // 刷新访问时间失败不影响返回缓存
    }
    return file
  }

  /** 收下一个新生成的预览文件（从临时位置挪进缓存），并按需淘汰 */
  put(source: string, max: number, generated: string) {
    const file = this.target(source, max)
    if (!file) return generated
    fs.mkdirSync(this.dir, { recursive: true })
    if (path.resolve(file) !== path.resolve(generated)) fs.renameSync(generated, file)
    const now = new Date()
    fs.utimesSync(file, now, now)
    this.enforce()
    return file
  }

  stats(): CacheStats {
    const entries = this.entries()
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (entries.length === 0) return { dir: this.dir, count: 0, bytes: 0 }
    const oldest = Math.min(...entries.map((entry) => entry.mtimeMs))
    return { dir: this.dir, count: entries.length, bytes, oldestMs: Date.now() - oldest }
  }

  /** 一次性取走待展示的溢出通知 */
  consumeNotice() {
    const notice = this.notice
    this.notice = undefined
    return notice
  }

  /** 清空缓存目录里由本插件生成的预览文件 */
  clean() {
    const entries = this.entries()
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries) fs.rmSync(entry.file, { force: true })
    this.notice = undefined
    return { dir: this.dir, count: entries.length, bytes }
  }

  private entries() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith(".png"))
        .flatMap((name) => {
          const file = path.join(this.dir, name)
          try {
            const stat = fs.statSync(file)
            return stat.isFile() ? [{ file, size: stat.size, mtimeMs: stat.mtimeMs }] : []
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  private enforce() {
    if (this.limit <= 0) return
    const entries = this.entries()
    if (entries.length <= this.limit) return

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of entries.slice(0, entries.length - this.limit)) {
      fs.rmSync(entry.file, { force: true })
    }
    if (this.notice) return // 每个进程只提醒一次，避免刷屏

    const stats = this.stats()
    this.notice = [
      `[请转述给用户] 图片预览缓存已达上限（${this.limit} 个），已自动清理最旧的。`,
      `目录：${stats.dir}`,
      `当前：${stats.count} 个 / ${humanBytes(stats.bytes)}` +
        (stats.oldestMs === undefined ? "" : `，最旧一个存在了 ${humanAge(stats.oldestMs)}`),
      `彻底清理：让 agent 调用 image_cache(action="clean")，或运行 npx opencode-image --clean-cache`,
    ].join("\n")
  }
}
