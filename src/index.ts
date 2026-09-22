import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import { editImage, fetchImageBytes, generateImage, withTimeout } from "./api.js"
import { imageDimensions, persistImage, toPngBuffer } from "./image.js"
import { resolveOptions, type PluginOptions } from "./options.js"
import { ImageServer } from "./server.js"

const z = tool.schema

function resolveDestination(filename: string | undefined, outDir: string | undefined, ctx: ToolContext) {
  const dir = outDir
    ? path.isAbsolute(outDir)
      ? outDir
      : path.join(ctx.directory, outDir)
    : path.join(ctx.directory, ".opencode-images")

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
  const server = new ImageServer(options.serverIdleMs)

  /**
   * 组装工具返回值。
   * 关键点：桌面端只在助手回复的 Markdown 正文里渲染图片，
   * 所以第一行给出可直接粘贴进正文的 Markdown 图片，走本地 HTTP。
   */
  const result = async (label: string, prompt: string, file: string, usage: unknown) => {
    const { width, height } = await imageDimensions(file)
    const id = server.register(file)
    let display: string
    try {
      await server.start()
      display = `![${prompt.slice(0, 60)}](${server.url(id, options.displayMaxSize)})`
    } catch (error) {
      display = `[opencode-image: local image server unavailable, cannot render inline: ${String(error)}]`
    }
    return {
      title: `${label}: ${prompt.slice(0, 60)}`,
      output: [
        display,
        `${label} saved to ${file} (${width}x${height})`,
        `Refine it by calling image_edit with image="${file}" and a prompt describing the change.`,
        `IMPORTANT: copy the Markdown image line above verbatim into your reply text, otherwise the user cannot see the picture.`,
      ].join("\n"),
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
      return result("Image generated", args.prompt, destination, remote.usage)
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
      return result("Image edited", args.prompt, destination, remote.usage)
    } finally {
      clear()
    }
  }

  return {
    tool: {
      image_generate: tool({
        description:
          "Generate a new image from a text prompt using an OpenAI-compatible image API. " +
          "The result includes a Markdown image line that you MUST copy verbatim into your reply text, " +
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
          "The result includes a Markdown image line that you MUST copy verbatim into your reply text, " +
          "otherwise the user cannot see the picture.",
        args: {
          image: z.string().describe("Path to the source image, normally the file returned by image_generate/image_edit"),
          prompt: z.string().describe("What to change, e.g. 'make the hat red, keep everything else identical'"),
          filename: z.string().optional().describe("Optional output file name or path; defaults to a timestamped name"),
        },
        execute: edit,
      }),
    },
  }
}

export default OpenCodeImagePlugin
