import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { renderPreview } from "./image.js"

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

type ServedFile = { file: string; mime: string }

/**
 * 本地图片服务：把生成结果通过 http://127.0.0.1:<port>/img/<id>?w=<width> 暴露给客户端渲染。
 *
 * 客户端限制说明：图片只有出现在助手回复的 Markdown 正文里才会渲染，
 * 而正文里的 file:// 会被 Chromium 拦截，所以必须走本地 HTTP。
 *
 * 安全边界：只服务显式 register() 过的文件，id 为随机值，URL 里没有真实路径，
 * 因此无法通过路径穿越读取任意文件。
 */
export class ImageServer {
  private server?: http.Server
  private port = 0
  private registry = new Map<string, ServedFile>()
  private previews = new Map<string, string>()
  private timer?: NodeJS.Timeout
  private starting?: Promise<void>

  constructor(private readonly idleMs: number) {}

  get baseURL() {
    return this.port ? `http://127.0.0.1:${this.port}` : ""
  }

  /** 注册文件并返回可访问的 id */
  register(file: string): string {
    const id = randomUUID().replace(/-/g, "").slice(0, 16)
    const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream"
    this.registry.set(id, { file, mime })
    return id
  }

  url(id: string, width: number) {
    return `${this.baseURL}/img/${id}?w=${width}`
  }

  /** 懒启动：首次需要时监听随机端口；unref 后不阻塞宿主进程退出 */
  async start() {
    if (this.server) {
      this.arm()
      return
    }
    // 并发调用复用同一个启动过程，避免起出多个 server 导致端口泄漏
    if (!this.starting) {
      this.starting = this.listen().finally(() => {
        this.starting = undefined
      })
    }
    await this.starting
    this.arm()
  }

  /**
   * 关闭服务并清理预览缓存。
   * 默认不调用：历史消息里的图片会重新请求，提前关闭会 404。
   */
  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const server = this.server
    this.server = undefined
    this.port = 0
    // 先断开 keep-alive 连接，否则 close() 会一直等待
    server?.closeAllConnections?.()
    server?.close()
    for (const file of this.previews.values()) fs.rmSync(file, { force: true })
    this.previews.clear()
  }

  private async listen() {
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.unref()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    if (!port) {
      server.close()
      throw new Error("opencode-image: image server did not bind a port")
    }
    this.server = server
    this.port = port
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer)
    if (this.idleMs <= 0) return
    this.timer = setTimeout(() => this.stop(), this.idleMs)
    this.timer.unref()
  }

  private preview(source: string, max: number) {
    const key = `${source}@${max}`
    const cached = this.previews.get(key)
    if (cached && fs.existsSync(cached)) return Promise.resolve(cached)
    const destination = path.join(os.tmpdir(), `opencode-image-${process.pid}-${randomUUID()}.png`)
    return renderPreview(source, destination, max).then((file) => {
      if (file !== source) this.previews.set(key, file)
      return file
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    this.arm()
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1")
    const id = /^\/img\/([0-9a-f]{8,64})$/.exec(parsed.pathname)?.[1]
    const entry = id ? this.registry.get(id) : undefined
    if (!entry || !fs.existsSync(entry.file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("not found")
      return
    }
    void this.send(entry, Number(parsed.searchParams.get("w")), res)
  }

  private async send(entry: ServedFile, width: number, res: http.ServerResponse) {
    try {
      const target = width > 0 ? await this.preview(entry.file, Math.round(width)) : entry.file
      const body = fs.readFileSync(target)
      res.writeHead(200, {
        "content-type": entry.mime,
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
