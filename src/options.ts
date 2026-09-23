import * as os from "node:os"
import * as path from "node:path"
import { DEFAULT_CACHE_DIR, DEFAULT_CACHE_LIMIT } from "./cache.js"

/** opencode 的数据目录（与 opencode.db 同级），图片默认落在这里而不是项目里 */
export function defaultImageDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const base = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share")
  return path.join(base, "opencode", "opencode-image")
}

/**
 * 解析图片输出目录：
 * - 未配置 → 全局数据目录，和项目/会话解耦
 * - 相对路径 → 基于当前项目目录（例如 ".opencode-images" 就回到项目里）
 * - 绝对路径 → 原样使用
 */
export function resolveOutDir(directory: string, outDir?: string) {
  if (!outDir) return defaultImageDir()
  return path.isAbsolute(outDir) ? outDir : path.join(directory, outDir)
}

/** 插件可配置项，通过 opencode 配置的 `plugin` 元组第二个元素传入 */
export type PluginOptions = {
  /** OpenAI 兼容的图像接口地址，默认从 PI_IMAGE_BASE_URL 读取 */
  baseURL?: string
  /** 接口密钥，默认从 PI_IMAGE_API_KEY 读取 */
  apiKey?: string
  /** 图像模型名 */
  model?: string
  /**
   * 图片输出目录。默认是全局数据目录（建议保持默认，跟项目/会话解耦）；
   * 填相对路径（如 ".opencode-images"）会落在当前项目里。
   */
  outDir?: string
  /** 落盘图片的最长边上限（像素），超出会等比缩小 */
  maxSize?: number
  /** 对话里展示时的最长边（像素）。0 = 不缩放，直接显示原图（默认，右键复制即原图） */
  displayMaxSize?: number
  /** 本地图片服务端口；默认 0 = 由项目目录派生（同一项目恒定），需要避开占用时手动指定 */
  serverPort?: number
  /** 本地图片服务的空闲关闭时间（毫秒），0 表示不主动关闭 */
  serverIdleMs?: number
  /** 首次出图时查一次 npm 最新版，落后则在工具输出末尾附升级提示。默认开启 */
  updateCheck?: boolean
  /** 往系统提示里注入一条"用哪个工具生图"的规则。默认开启 */
  injectPrompt?: boolean
  /** 对话里展示用的缩略图缓存目录，默认 <系统临时目录>/opencode-image */
  cacheDir?: string
  /** 缩略图缓存最多保留多少个文件，超出按最久未访问淘汰；0 表示不限制 */
  cacheLimit?: number
  /** 单次图像请求超时（毫秒） */
  timeoutMs?: number
}

export const DEFAULT_BASE_URL = "https://pi-ai.roiscloud.com/v1"
export const DEFAULT_MODEL = "gpt-image-2"
export const DEFAULT_MAX_SIZE = 1024
/** 0 = 不缩放，直接把落盘的原图显示出来（右键复制/另存拿到的就是原图） */
export const DEFAULT_DISPLAY_MAX_SIZE = 0
/** 0 表示由项目目录派生端口，保证同一项目跨重启链接不变 */
export const DEFAULT_SERVER_PORT = 0
export const DEFAULT_SERVER_IDLE_MS = 0
export const DEFAULT_TIMEOUT_MS = 600_000

export type ResolvedOptions = {
  baseURL: string
  apiKey: string
  model: string
  outDir?: string
  maxSize: number
  displayMaxSize: number
  serverPort: number
  serverIdleMs: number
  updateCheck: boolean
  injectPrompt: boolean
  cacheDir: string
  cacheLimit: number
  timeoutMs: number
}

/** 合并默认值、环境变量与用户配置；缺少 apiKey 时直接抛错 */
export function resolveOptions(options: PluginOptions | undefined): ResolvedOptions {
  const opts = options ?? {}
  const apiKey = opts.apiKey ?? process.env.PI_IMAGE_API_KEY
  if (!apiKey) {
    throw new Error(
      "opencode-image: missing apiKey. Pass it in the plugin options or set PI_IMAGE_API_KEY.",
    )
  }
  return {
    baseURL: (opts.baseURL ?? process.env.PI_IMAGE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    outDir: opts.outDir,
    maxSize: opts.maxSize ?? DEFAULT_MAX_SIZE,
    displayMaxSize: opts.displayMaxSize ?? DEFAULT_DISPLAY_MAX_SIZE,
    serverPort: opts.serverPort ?? DEFAULT_SERVER_PORT,
    serverIdleMs: opts.serverIdleMs ?? DEFAULT_SERVER_IDLE_MS,
    updateCheck: opts.updateCheck ?? true,
    injectPrompt: opts.injectPrompt ?? true,
    cacheDir: opts.cacheDir ?? DEFAULT_CACHE_DIR,
    cacheLimit: opts.cacheLimit ?? DEFAULT_CACHE_LIMIT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}
