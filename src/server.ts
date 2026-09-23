import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { renderPreview } from "./image.js"
import { PreviewCache } from "./cache.js"

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

// 末尾可以带一段「装饰性文件名」（/img/<id>/<name>），解析时忽略，只为浏览器的「另存为」提供正常文件名
const ID_PATTERN = /^\/img\/([A-Za-z0-9_-]{1,2048})(?:\/[^/]*)?$/
const APP_NAME = "opencode-image"

/**
 * 端口由「图片根目录」派生：同一个根目录永远同一个端口，所以历史消息里的链接跨重启仍然有效。
 * 默认根目录是全局数据目录，因此全机通用一个端口、一个服务；
 * 若把 outDir 指到项目里，则那个项目有自己稳定的端口。需要覆盖时用 serverPort 配置项。
 */
export function derivePort(key: string) {
  const digest = createHash("sha1").update(key).digest()
  return 41000 + (digest.readUInt16BE(0) % 4000)
}

/**
 * 本地图片服务：把生成结果通过 http://127.0.0.1:<port>/img/<id>?w=<width> 暴露给客户端渲染。
 *
 * 客户端限制说明：图片只有出现在助手回复的 Markdown 正文里才会渲染，
 * 而正文里的 file:// 会被 Chromium 拦截，所以必须走本地 HTTP。
 *
 * 稳定性：id 是「文件相对 outDir 的路径」做 base64url 编码，可逆且稳定。
 * 因此服务不需要任何内存登记表——同一个文件在任何一次启动里都能解析出同一个 id，
 * 重启后历史消息里的旧链接依然可访问。
 *
 * 安全边界：请求里的 id 只允许解析成 outDir 内部的普通文件，
 * 解析后会做 containment + realpath 双重校验，防路径穿越与符号链接逃逸。
 */
export class ImageServer {
  private server?: http.Server
  private port = 0
  private root?: string
  private ready = false
  private owned = false
  /** outDir 之外的文件退回进程内随机 id（仅本次运行有效） */
  private extra = new Map<string, string>()
  private timer?: NodeJS.Timeout
  private starting?: Promise<void>

  constructor(
    private readonly idleMs: number,
    private readonly configuredPort: number,
    private readonly cache: PreviewCache,
  ) {}

  get baseURL() {
    return this.port ? `http://127.0.0.1:${this.port}` : ""
  }

  /** 生成稳定 id；outDir 内的文件跨重启一致 */
  idFor(file: string) {
    const root = this.root
    if (root) {
      const relative = path.relative(root, file)
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return Buffer.from(relative.split(path.sep).join("/"), "utf8").toString("base64url")
      }
    }
    for (const [id, registered] of this.extra) {
      if (registered === file) return id
    }
    const id = randomUUID().replace(/-/g, "").slice(0, 16)
    this.extra.set(id, file)
    return id
  }

  /**
   * width > 0 时给出缩略图地址；width <= 0 时是原图地址（不带查询参数）。
   * 末尾拼一段真实的文件名，纯粹为了让浏览器「另存为」时有个正常名字。
   */
  url(file: string, width: number) {
    const query = width > 0 ? `?w=${Math.round(width)}` : ""
    const name = encodeURIComponent(path.basename(file))
    return `${this.baseURL}/img/${this.idFor(file)}/${name}${query}`
  }

  /** 懒启动：首次需要时按派生端口监听；unref 后不阻塞宿主进程退出 */
  async start(opts: { outDir: string }) {
    this.root = path.resolve(opts.outDir)
    if (this.ready) {
      this.arm()
      return
    }
    // 并发调用复用同一个启动过程，避免起出多个 server 导致端口泄漏
    if (!this.starting) {
      this.starting = this.listen(opts).finally(() => {
        this.starting = undefined
      })
    }
    await this.starting
    this.ready = true
    this.arm()
  }

  /**
   * 关闭服务并清理预览缓存。
   * 默认不调用：历史消息里的图片会重新请求，提前关闭会 404。
   */
  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.owned) {
      // 先断开 keep-alive 连接，否则 close() 会一直等待
      this.server?.closeAllConnections?.()
      this.server?.close()
    }
    this.server = undefined
    this.owned = false
    this.ready = false
    this.port = 0
  }

  /** 缩略图缓存的统计 / 清理，透传给上层工具与展示通知 */
  cacheStats() {
    return this.cache.stats()
  }

  cleanCache() {
    return this.cache.clean()
  }

  consumeCacheNotice() {
    return this.cache.consumeNotice()
  }

  private async listen(opts: { outDir: string }) {
    const port = this.configuredPort || derivePort(path.resolve(opts.outDir))
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.unref()
    const failure = await new Promise<Error | undefined>((resolve) => {
      server.once("error", resolve)
      server.listen(port, "127.0.0.1", () => resolve(undefined))
    })
    if (!failure) {
      this.server = server
      this.port = port
      this.owned = true
      return
    }
    server.close()
    // 同一个项目已经有实例在服务同样的 outDir：直接复用它的端口（id 是路径派生的，双方都能解析）
    if ((failure as NodeJS.ErrnoException).code === "EADDRINUSE" && (await this.servedByUs(port, opts.outDir))) {
      this.port = port
      this.owned = false
      return
    }
    throw new Error(
      `opencode-image: cannot listen on 127.0.0.1:${port} (${String(failure)}). ` +
        `Set the serverPort option to a free port, or stop whatever is using it.`,
    )
  }

  private async servedByUs(port: number, outDir: string) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (!res.ok) return false
      const body = (await res.json()) as { app?: string; root?: string }
      return body.app === APP_NAME && body.root === path.resolve(outDir)
    } catch {
      return false
    }
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer)
    if (this.idleMs <= 0) return
    this.timer = setTimeout(() => this.stop(), this.idleMs)
    this.timer.unref()
  }

  private async preview(source: string, max: number) {
    const hit = this.cache.hit(source, max)
    if (hit) return hit
    const staging = path.join(os.tmpdir(), `opencode-image-${process.pid}-${randomUUID()}.png`)
    const rendered = await renderPreview(source, staging, max)
    // 源图本身就不超过 max 时不需要缩略图，直接服务原图
    if (rendered === source) return source
    return this.cache.put(source, max, rendered)
  }

  /** id -> 文件；只接受 outDir 内、真实存在、且 realpath 不逃逸的普通文件 */
  private resolve(id: string) {
    const registered = this.extra.get(id)
    if (registered) return fs.existsSync(registered) ? registered : undefined

    const root = this.root
    if (!root) return undefined

    let relative: string
    try {
      relative = Buffer.from(id, "base64url").toString("utf8")
    } catch {
      return undefined
    }
    if (!relative || relative.includes("\0") || path.isAbsolute(relative)) return undefined

    const target = path.resolve(root, relative)
    if (target === root || !target.startsWith(root + path.sep)) return undefined

    try {
      if (!fs.statSync(target).isFile()) return undefined
      const real = fs.realpathSync(target)
      const realRoot = fs.realpathSync(root)
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined
    } catch {
      return undefined
    }
    return target
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    this.arm()
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1")
    if (parsed.pathname === "/health") {
      const body = JSON.stringify({ app: APP_NAME, root: this.root ?? "" })
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
      res.end(body)
      return
    }
    const id = ID_PATTERN.exec(parsed.pathname)?.[1]
    const file = id ? this.resolve(id) : undefined
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("not found")
      return
    }
    void this.send(file, Number(parsed.searchParams.get("w")), res)
  }

  private async send(file: string, width: number, res: http.ServerResponse) {
    try {
      const target = width > 0 ? await this.preview(file, Math.round(width)) : file
      const body = fs.readFileSync(target)
      res.writeHead(200, {
        "content-type": MIME_BY_EXT[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "private, max-age=86400",
      })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      res.end(`opencode-image: cannot serve image: ${String(error)}`)
    }
  }
}
