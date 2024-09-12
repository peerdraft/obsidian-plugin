import { debounce, type ItemView, type TFile } from "obsidian";
import * as Y from 'yjs'
import { around } from "monkey-around"
import { applyDataChangesToDoc, debouncedApplyDataChangesToDoc, yDocToCanvasJSON } from "src/sharedEntities/canvas";
import { Mutex } from "async-mutex";
import type { SharedDocument } from "src/sharedEntities/sharedDocument";

export interface CanvasView extends ItemView {
  file: TFile
  canvas: Canvas
}

export interface Canvas {
  markMoved: () => any
  markDirty: () => any
  getData: () => any
  setData: (data: any) => any
  rerenderViewport: () => any
  createTextNode: () => any
  createFileNode: () => any
  createFileNodes: () => any
  createGroupNode: () => any
  createLinkNode: () => any
  removeNode: () => any
  removeEdge: () => any
  setViewData: () => any
  load: () => any
  nodes: Map<string, Node>

}

export interface Node {
  setData: () => any
  setText: () => any
  getData: () => NodeData
  text: string
}

export interface NodeData {
  type: "text"
}


export const addCanvasExtension = (doc: SharedDocument, view: CanvasView) => {

  if (!doc.isCanvas) return;

  const canvas = view.canvas
  const mutex = new Mutex()

  console.log("add canvas extension to:")
  console.log(view)

  const triggerDocUpdate = () => {
    mutex.runExclusive(() => {
      const data = canvas.getData()
      if (doc.file != view?.file) return
      applyDataChangesToDoc(data, doc.yDoc)
    })
  }

  for(const node of canvas.nodes.values()) {
    if (node.getData().type === "text") {
      patchTextNode(node, triggerDocUpdate)
    }
  }

  const unpatchCanvas = around(canvas, {

    load(next) {
      return function (...args) {
        console.log("start loading")
        const result = next.apply(this, args)
        console.log("end loading")
        return result
      }
    },

    markMoved(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    markDirty(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    createTextNode(next) {
      return function (...args) {
        const result = next.apply(this, args) as Node
        patchTextNode(result, triggerDocUpdate)
        triggerDocUpdate()
        return result
      }
    },
    createFileNode(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    createFileNodes(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    createGroupNode(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    createLinkNode(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    removeNode(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    },
    removeEdge(next) {
      return function (...args) {
        const result = next.apply(this, args)
        triggerDocUpdate()
        return result
      }
    }
  })
  const observer: (events: Array<Y.YEvent<any>>, tx: Y.Transaction) => void = (events, tx) => {
    if (view.file != doc.file || tx.local) return

    for (const event of events) {
      console.log(event.currentTarget)
      console.log(event.path)
      console.log(event.changes)
    }

    canvas.setData(yDocToCanvasJSON(doc.yDoc))
  }

  doc.yDoc.getMap("canvas").observeDeep(observer)

  /*

  doc.yDoc.on("update", (x, y, z, tx) => {
    if (tx.local) return
    mutex.runExclusive(() => {
      if (view.file != doc.file) return
      canvas.setData(yDocToCanvasJSON(doc.yDoc))
    })
  })
    */

  return () => {
    unpatchCanvas()
    doc.yDoc.getMap("canvas").unobserveDeep(observer)
  }

}

const patchTextNode = (node: Node, triggerDocUpdate: () => any) => {

  let text = node.text
  Object.defineProperty(node, 'text', {
    get: function () {
      return text;
    },
    set: function (x) {
      text = x;
      triggerDocUpdate()
    }
  })
}


