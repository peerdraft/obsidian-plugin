import { PeerdraftRecord } from "src/utils/peerdraftRecord";
import { PeerdraftLeaf } from "./peerdraftLeaf";
import { MarkdownView, Workspace, normalizePath } from "obsidian";
import { PeerdraftCanvas } from "./peerdraftCanvas";
import type { CanvasView } from "src/ui/canvas";

export const updatePeerdraftWorkspace = (ws: Workspace, pws: {
  markdown: PeerdraftRecord<PeerdraftLeaf>,
  canvas: PeerdraftRecord<PeerdraftCanvas>,
}) => {
  handleMarkdownLeafs(ws, pws.markdown)
  handleCanvasLeafs(ws, pws.canvas)
}

export const getLeafsByPath = (path: string, pws: PeerdraftRecord<PeerdraftLeaf>) => {
  return pws.keys.map((key) => {
    return pws.get(key)
  }).filter((leaf) => {
    return leaf.path === path
  })
}

export const getLeafIdsByPath = (path: string, pws: PeerdraftRecord<PeerdraftLeaf>) => {
  const normalizedPath = normalizePath(path)
  return pws.keys.filter((key) => {
    return normalizePath(pws.get(key).path) === normalizedPath
  })
}

export const getCanvasLeafsByPath = (path: string, pws: PeerdraftRecord<PeerdraftCanvas>) => {
  return pws.keys.map((key) => {
    return pws.get(key)
  }).filter((leaf) => {
    return leaf.path === path
  })
}

const handleCanvasLeafs = (ws: Workspace, canvas: PeerdraftRecord<PeerdraftCanvas>) => {
  const leafs = ws.getLeavesOfType("canvas")

  const oldLeafIds = canvas.keys
  const existingLeafIds = leafs.map(leaf => {
    // @ts-expect-error
    return leaf.id as string
  })

  for (const leaf of leafs) {
    // @ts-expect-error
    const leafId = leaf.id as string

    const path = (leaf.view as (CanvasView)).file?.path ?? ''

    let pleaf = canvas.get(leafId)
    if (pleaf) {
      pleaf.path = path
    } else {
      pleaf = new PeerdraftCanvas(path)
      canvas.set(leafId, pleaf)
    }
  }

  for (const oldLeafId of oldLeafIds) {
    if (!existingLeafIds.contains(oldLeafId)) {
      canvas.delete(oldLeafId)
    }
  }
}

const handleMarkdownLeafs = (ws: Workspace, markdown: PeerdraftRecord<PeerdraftLeaf>) => {
  const leafs = ws.getLeavesOfType("markdown")

  const oldLeafIds = markdown.keys
  const existingLeafIds = leafs.map(leaf => {
    // @ts-expect-error
    return leaf.id as string
  })

  for (const leaf of leafs) {
    // @ts-expect-error
    const leafId = leaf.id as string

    const isPreview = leaf.view.containerEl.getAttribute("data-mode") === "preview"
    const path = (leaf.view as (MarkdownView)).file?.path ?? ''

    let pleaf = markdown.get(leafId)
    if (pleaf) {
      pleaf.isPreview = isPreview
      pleaf.path = path
    } else {
      pleaf = new PeerdraftLeaf(path, isPreview)
      markdown.set(leafId, pleaf)
    }
  }

  for (const oldLeafId of oldLeafIds) {
    if (!existingLeafIds.contains(oldLeafId)) {
      markdown.delete(oldLeafId)
    }
  }
}