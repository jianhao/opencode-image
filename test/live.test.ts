import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import sharp from "sharp"
import { OpenCodeImagePlugin } from "../src/index.js"
import type { PluginOptions } from "../src/options.js"

/**
 * Live test: talks to the real image endpoint. Opt in with
 *   OPENCODE_IMAGE_LIVE=1 bun test test/live.test.ts
 * Options are read from the user's `~/.config/opencode/opencode.json` plugin entry so no secret
 * lives in this repo.
 */
function configOptions(): PluginOptions | undefined {
  const file = path.join(os.homedir(), ".config", "opencode", "opencode.json")
  if (!fs.existsSync(file)) return undefined
  const config = JSON.parse(fs.readFileSync(file, "utf8"))
  const entry = (config.plugin ?? []).find(
    (item: unknown) => Array.isArray(item) && item[0] === "opencode-image",
  ) as [string, PluginOptions] | undefined
  return entry?.[1]
}

const live = process.env.OPENCODE_IMAGE_LIVE === "1"
const options = configOptions()
const run = live && options?.apiKey ? test : test.skip

describe("live generation", () => {
  run(
    "generates a real image and serves it inline",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-image-live-"))
      const directory = path.join(root, "project")
      const tools = new Map<string, any>()
      const ctx = {
        location: { directory },
        options: { ...options, updateCheck: false, outDir: path.join(root, "images"), displayMaxSize: 448 },
        tool: {
          transform: async (fn: (editor: any) => void) => {
            fn({ add: (tool: any) => tools.set(tool.name, tool) })
          },
        },
        session: { hook: async () => {} },
      }

      const cleanup = await OpenCodeImagePlugin.setup(ctx as any)
      try {
        const result = await tools.get("image_generate").execute(
          { prompt: "a minimalist red square on a white background, flat design" },
          {
            sessionID: "s",
            messageID: "m",
            agent: "test",
            id: "call",
            signal: new AbortController().signal,
            progress: async () => {},
          },
        )

        const output = typeof result.content === "string" ? result.content : result.content.find((c: any) => c.type === "text").text
        console.log("\n[live] model:", options?.model, "\n[live] out:", result.metadata.file, "\n[live] output:\n" + output + "\n")

        expect(fs.existsSync(result.metadata.file)).toBe(true)
        const meta = await sharp(result.metadata.file).metadata()
        expect(meta.format).toBe("png")
        expect(meta.width ?? 0).toBeGreaterThan(0)

        const url = /!\[[^\]]*\]\((http:\/\/127\.0\.0\.1:\d+\/img\/[^)]+)\)/.exec(output)?.[1]
        expect(url).toBeDefined()
        const served = await fetch(url!)
        expect(served.status).toBe(200)
        expect(served.headers.get("content-type")).toBe("image/png")

        fs.rmSync(root, { recursive: true, force: true })
      } finally {
        if (typeof cleanup === "function") await cleanup()
      }
    },
    300_000,
  )
})
