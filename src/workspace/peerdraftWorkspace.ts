import { PeerdraftRecord } from "src/utils/peerdraftRecord";
import { PeerdraftLeaf } from "./peerdraftLeaf";
import { MarkdownView, Workspace, normalizePath } from "obsidian";

export const updatePeerdraftWorkspace = (ws: Workspace, pws: PeerdraftRecord<PeerdraftLeaf>) => {
  const leafs = ws.getLeavesOfType("markdown")
  
  const oldLeafIds = pws.keys
  const existingLeafIds = leafs.map(leaf => {
    // @ts-expect-error
    return leaf.id as string
  })

  for (const leaf of leafs) {
    // @ts-expect-error
    const leafId = leaf.id as string

    const isPreview = leaf.view.containerEl.getAttribute("data-mode") === "preview"
    const path = (leaf.view as (MarkdownView)).file?.path ?? ''

    let pleaf = pws.get(leafId)
    if (pleaf) {
      pleaf.isPreview = isPreview
      pleaf.path = path
    } else {
      pleaf = new PeerdraftLeaf(path, isPreview)
      pws.set(leafId, pleaf)
    }
  }

  for (const oldLeafId of oldLeafIds) { 
    if(!existingLeafIds.contains(oldLeafId)) {
      pws.delete(oldLeafId)
    }
  }

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