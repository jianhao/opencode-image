import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import { editImage, fetchImageBytes, generateImage, withTimeout } from "./api.js"
import { PreviewCache, humanAge, humanBytes } from "./cache.js"
import { imageDimensions, persistImage, toPngBuffer } from "./image.js"
import { resolveOptions, resolveOutDir, type PluginOptions } from "./options.js"
import { checkForUpdate, readOwnVersion } from "./update.js"
import { ImageServer } from "./server.js"

const z = tool.schema

function resolveDestination(filename: string | undefined, outDir: string | undefined, ctx: ToolContext) {
  const dir = resolveOutDir(ctx.directory, outDir)

  if (filename) {
    const target = path.isAbsolute(filename) ? filename : path.join(dir, filename)
    return `${target.replace(/\.[A-Za-z0-9]+$/, "")}.png`
  }
  const stamp = new Date().toISOString().replace(/\..+$/, "").replace(/[:T]/g, "-")
  const suffix = Math.random().toString(36).slice(2, 6)
  return path.join(dir, `image-${stamp}-${suffix}.png`)
}

function asAttachment(file: string) {
  return [
    {
      type: "file" as const,
      mime: "image/png",
      filename: path.basename(file),
      url: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`,
    },
  ]
}

export const OpenCodeImagePlugin: Plugin = async (_input, rawOptions) => {
  const options = resolveOptions(rawOptions as PluginOptions | undefined)
  const cache = new PreviewCache(options.cacheDir, options.cacheLimit)
  const server = new ImageServer(options.serverIdleMs, options.serverPort, cache)

  // 首次出图时查一次 npm 最新版；结果在进程内缓存，最多查一次
  const selfVersion = readOwnVersion()
  let updateHint: string | undefined
  let updateChecked = false
  const upgradeNotice = async () => {
    if (!options.updateCheck || updateChecked || !selfVersion) return updateHint
    updateChecked = true
    updateHint = await checkForUpdate(selfVersion)
    return updateHint
  }

  /**
   * 组装工具返回值。
   * 关键点：桌面端只在助手回复的 Markdown 正文里渲染图片，
   * 所以第一行给出可直接粘贴进正文的 Markdown 图片，走本地 HTTP。
   */
  const result = async (label: string, prompt: string, file: string, ctx: ToolContext, usage: unknown) => {
    const { width, height } = await imageDimensions(file)
    let display: string
    try {
      await server.start({ outDir: resolveOutDir(ctx.directory, options.outDir) })
      const alt = prompt.slice(0, 60)
      const lines = [`![${alt}](${server.url(file, options.displayMaxSize)})`]
      // 客户端不支持「图片套链接」（link renderer 取的是原始文本），
      // 所以缩略图模式下另起一行给一个指向原图的普通链接
      if (options.displayMaxSize > 0) lines.push(`[查看原图](${server.url(file, 0)})`)
      display = lines.join("\n")
    } catch (error) {
      display = `[opencode-image: local image server unavailable, cannot render inline: ${String(error)}]`
    }
    const notice = await upgradeNotice()
    const output = [
      display,
      `${label} saved to ${file} (${width}x${height})`,
      `Refine it by calling image_edit with image="${file}" and a prompt describing the change.`,
      `IMPORTANT: copy the Markdown image line above verbatim into your reply text, otherwise the user cannot see the picture.`,
    ]
    if (notice) output.push(notice)
    // 缩略图缓存的溢出通知在「上一次图片被客户端请求」时产生，这里顺带展示
    const cacheNotice = server.consumeCacheNotice()
    if (cacheNotice) output.push(cacheNotice)

    return {
      title: `${label}: ${prompt.slice(0, 60)}`,
      output: output.join("\n"),
      metadata: { file, prompt, usage },
      attachments: asAttachment(file),
    }
  }

  const generate = async (args: { prompt: string; filename?: string }, ctx: ToolContext) => {
    ctx.metadata({ title: `Generating image: ${args.prompt.slice(0, 60)}` })
    const { signal, clear } = withTimeout(ctx.abort, options.timeoutMs)
    try {
      const remote = await generateImage(options, args.prompt, signal)
      const raw = await fetchImageBytes(remote, signal)
      const destination = resolveDestination(args.filename, options.outDir, ctx)
      await persistImage(raw, destination, options.maxSize)
      return result("Image generated", args.prompt, destination, ctx, remote.usage)
    } finally {
      clear()
    }
  }

  const edit = async (args: { image: string; prompt: string; filename?: string }, ctx: ToolContext) => {
    const source = path.isAbsolute(args.image) ? args.image : path.resolve(ctx.directory, args.image)
    if (!fs.existsSync(source)) throw new Error(`image_edit: source image not found: ${source}`)

    ctx.metadata({ title: `Editing image: ${args.prompt.slice(0, 60)}` })
    const { signal, clear } = withTimeout(ctx.abort, options.timeoutMs)
    try {
      const upload = await toPngBuffer(source, options.maxSize)
      const remote = await editImage(options, upload, `${path.basename(source, path.extname(source))}.png`, args.prompt, signal)
      const raw = await fetchImageBytes(remote, signal)
      const destination = resolveDestination(args.filename, options.outDir, ctx)
      await persistImage(raw, destination, options.maxSize)
      return result("Image edited", args.prompt, destination, ctx, remote.usage)
    } finally {
      clear()
    }
  }

  return {
    tool: {
      image_generate: tool({
        description:
          "Generate a new image from a text prompt using an OpenAI-compatible image API. " +
          "The result starts with a Markdown image line (plus a separate 查看原图 link when displayMaxSize is set) that you MUST copy verbatim into your reply text, " +
          "If the output contains a line starting with [请转述给用户], relay that line to the user in your reply. " +
          "otherwise the user cannot see the picture. To iterate on a result, call image_edit with the returned path.",
        args: {
          prompt: z.string().describe("Detailed description of the image to generate"),
          filename: z.string().optional().describe("Optional output file name or path; defaults to a timestamped name"),
        },
        execute: generate,
      }),
      image_edit: tool({
        description:
          "Edit an existing image with a text instruction (image-to-image). Pass the exact path returned by a previous " +
          "image_generate or image_edit call to keep refining the same picture. " +
          "The result starts with a Markdown image line (plus a separate 查看原图 link when displayMaxSize is set) that you MUST copy verbatim into your reply text, " +
          "If the output contains a line starting with [请转述给用户], relay that line to the user in your reply. " +
          "otherwise the user cannot see the picture.",
        args: {
          image: z.string().describe("Path to the source image, normally the file returned by image_generate/image_edit"),
          prompt: z.string().describe("What to change, e.g. 'make the hat red, keep everything else identical'"),
          filename: z.string().optional().describe("Optional output file name or path; defaults to a timestamped name"),
        },
        execute: edit,
      }),
      image_cache: tool({
        description:
          "Inspect or clear the preview-thumbnail cache used for rendering images in the conversation. " +
          "Use action=\"status\" to report the cache directory, file count, total size and age of the oldest entry; " +
          "action=\"clean\" to delete every cached preview (the generated images in outDir are NOT touched). " +
          "This returns text only — do not turn it into a Markdown image line.",
        args: {
          action: z.enum(["status", "clean"]).describe("status = 查看缓存；clean = 清空缓存"),
        },
        execute: async (args) => {
          if (args.action === "clean") {
            const removed = server.cleanCache()
            return {
              title: `已清理图片缓存（${removed.count} 个 / ${humanBytes(removed.bytes)}）`,
              output: [
                `已清理 ${removed.count} 个预览文件，共 ${humanBytes(removed.bytes)}。`,
                `缓存目录：${removed.dir}`,
                `注意：这不影响 outDir 里的原图，会话里的图片仍能正常显示（需要时会重新生成缩略图）。`,
              ].join("\n"),
              metadata: removed,
            }
          }
          const stats = server.cacheStats()
          return {
            title: `图片缓存：${stats.count} 个 / ${humanBytes(stats.bytes)}`,
            output: [
              `缓存目录：${stats.dir}`,
              `文件数量：${stats.count}`,
              `占用大小：${humanBytes(stats.bytes)}`,
              `最旧一个：${stats.oldestMs === undefined ? "（空缓存）" : `已存在 ${humanAge(stats.oldestMs)}`}`,
              `上限：${options.cacheLimit} 个（可通过 cacheLimit 配置，0 = 不限制）`,
            ].join("\n"),
            metadata: stats,
          }
        },
      }),
    },
    dispose: async () => {
      server.stop()
    },
  }
}

export default OpenCodeImagePlugin
