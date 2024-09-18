import { type ItemView, type TFile } from "obsidian";
import * as Y from 'yjs'
import { around } from "monkey-around"
import { applyDataChangesToDoc, createYMapFromObject, debouncedApplyDataChangesToDoc, yDocToCanvasJSON } from "src/sharedEntities/canvas";
import { Mutex } from "async-mutex";
import { SharedDocument } from "src/sharedEntities/sharedDocument";
import { yCollab } from "y-codemirror.next";
import { EditorView, ViewUpdate } from '@codemirror/view';
import { Compartment } from "@codemirror/state";
import { StateEffect } from "@codemirror/state";

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
  removeNode: (node: Node) => any
  removeEdge: (edge: Edge) => any
  setViewData: () => any
  load: () => any
  addEdge: (edge: Edge) => any
  clear: (edge: Edge) => any
  edges: Map<string, Edge>
  nodes: Map<string, Node>
  pointer: any
}

export interface Node {
  setData: (data: any) => any
  setText: () => any
  getData: () => NodeData
  text: string
  [key: string]: any;
}
export interface Edge {
  setData: (data: any) => any
  label: string | undefined
  [key: string]: any;
}

export interface NodeData {
  type: "text"
}


export const addCanvasExtension = (doc: SharedDocument, view: CanvasView) => {

  if (!doc.isCanvas) return;

  const canvas = view.canvas
  const mutex = new Mutex()
  const awareness = doc.webRTCProvider?.awareness

  let edgeConstructor: any
  const yCanvas = doc.yDoc.getMap("canvas") as Y.Map<Y.Map<Y.Map<any>>>

  const triggerDocUpdate = () => {
    mutex.runExclusive(() => {
      const data = canvas.getData()
      if (doc.file != view?.file) return
      applyDataChangesToDoc(data, doc.yDoc)
    })
  }
  const yNodes = yCanvas.get("nodes") as Y.Map<any>
  for (const node of canvas.nodes.values()) {
    const type = node.getData().type
    if (type === "text") {
      patchTextNode(node, triggerDocUpdate, yNodes, doc)
    } else if (type === "file") {
      patchFileNode(node)
    }
  }

  for (const edge of canvas.edges.values()) {
    patchEdge(edge, triggerDocUpdate)
    edgeConstructor = edgeConstructor || edge.constructor
  }

  const unpatchCanvas = around(canvas, {
    clear(next) {
      return function (...args) {
        unpatchCanvas()
        const result = next.apply(this, args)
        return result
      }
    },
    addEdge(next) {
      return function (...args) {
        const result = next.apply(this, args)
        patchEdge(args[0], triggerDocUpdate)
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
        const yNode = createYMapFromObject(result.getData())
        yCanvas.get("nodes")?.set(result.id, yNode)
        const yNodes = yCanvas.get("nodes")
        if (yNodes) {
          patchTextNode(result, triggerDocUpdate, yNodes, doc)
        }
        return result
      }
    },
    createFileNode(next) {
      return function (...args) {
        const result = next.apply(this, args)
        patchFileNode(result)
        triggerDocUpdate()
        return result
      }
    },
    createFileNodes(next) {
      return function (...args) {
        const result = next.apply(this, args)
        if (result instanceof Array) {
          result.map(patchFileNode)
        }
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
      if (event.path?.length === 1) {
        if (event.path[0] === "edges") {
          for (const key of event.changes.keys) {
            const change = key[1].action
            switch (change) {
              case "add":
                if (edgeConstructor) {
                  const yEdge = (doc.yDoc.getMap("canvas").get("edges") as Y.Map<Y.Map<any>>).get(key[0])
                  if (yEdge) {
                    const fromNodeId = yEdge.get('fromNode')
                    const toNodeId = yEdge.get('toNode')
                    new edgeConstructor(canvas, key[0], fromNodeId, toNodeId)
                  } else {
                    canvas.setData(yDocToCanvasJSON(doc.yDoc))
                  }
                }
                break;
              case "delete": {
                const edge = canvas.edges.get(key[0])
                if (edge) {
                  canvas.removeEdge(edge)
                } else {
                  canvas.setData(yDocToCanvasJSON(doc.yDoc))
                }
              }
                break;
              default:
                canvas.setData(yDocToCanvasJSON(doc.yDoc))
                break;
            }
          }
        } else if (event.path[0] === "nodes") {
          for (const key of event.changes.keys) {
            const change = key[1].action
            switch (change) {
              case "add":
                canvas.setData(yDocToCanvasJSON(doc.yDoc))
                const node = canvas.nodes.get(key[0])
                if (node) {
                  const yNodes = yCanvas.get("nodes")
                  if (yNodes) {
                    const type = node.getData().type
                    if (type === "text") {
                      patchTextNode(node, triggerDocUpdate, yNodes, doc)
                    } else if (type === "file") {
                      patchFileNode(node)
                    }
                  }
                }
                break;
              case "delete": {
                const node = canvas.nodes.get(key[0])
                if (node) {
                  canvas.removeNode(node)
                } else {
                  canvas.setData(yDocToCanvasJSON(doc.yDoc))
                }
              }
                break;
              default:
                canvas.setData(yDocToCanvasJSON(doc.yDoc))
                break;
            }
          }
        } else {
          canvas.setData(yDocToCanvasJSON(doc.yDoc))
        }
      } else if (event.path?.length === 2) {

        const entityType = event.path[0] as string
        if (entityType === "edges" || entityType === "nodes") {
          const id = event.path[1] as string
          const yEntity = (doc.yDoc.getMap("canvas").get(entityType) as Y.Map<any>)?.get(id) as Y.Map<any>
          let entity: Node | Edge | undefined

          switch (entityType) {
            case "edges":
              entity = canvas.edges.get(id)
              break;
            case "nodes":
              entity = canvas.nodes.get(id)
              break;
            default:
              canvas.setData(yDocToCanvasJSON(doc.yDoc))
              break;
          }
          if (entity) {
            entity.setData(yEntity.toJSON())

            for (const key of event.keys) {
              const action = key[1].action
              switch (action) {
                case "add":
                case "update":
                  entity[key[0]] = yEntity.get(key[0])
                  break
                case "delete":
                  delete entity[key[0]]
                  break;
                default:
                  entity.setData(yEntity.toJSON())
                  break;
              }
            }

          } else {
            canvas.setData(yDocToCanvasJSON(doc.yDoc))
          }
        } else {
          canvas.setData(yDocToCanvasJSON(doc.yDoc))
        }
      } else {
        canvas.setData(yDocToCanvasJSON(doc.yDoc))
      }
    }
  }

  doc.yDoc.getMap("canvas").observeDeep(observer)
  /*

  let pointer = canvas.pointer
  Object.defineProperty(canvas, 'pointer', {
    get: function () {
      return pointer;
    },
    set: function (x) {
      pointer = x;
      console.log(x)
      // triggerDocUpdate()
    }
  })*/

  return () => {
    unpatchCanvas()
    doc.yDoc.getMap("canvas").unobserveDeep(observer)
  }

}

const addExtensionToTextNode = (yNodes: Y.Map<Y.Map<any>>, id: string, cm: EditorView, doc: SharedDocument) => {
  const compartment = new Compartment()
  const text = yNodes.get(id)?.get("text")
  if (text) {
    if (typeof text == "string") {
      const extension = EditorView.updateListener.of((v: ViewUpdate) => {
        if (v.docChanged) {
          yNodes.get(id)?.set("text", v.state.doc.toString())
        }
      })
      cm.dispatch({
        effects: StateEffect.appendConfig.of(compartment.of(extension))
      })
    } else if (text instanceof Y.Text) {
  
      const undoManager = new Y.UndoManager(text)
      const awareness = doc.webRTCProvider?.awareness
      if (awareness) {
        awareness.setLocalStateField('user', {
          name: doc.plugin.settings.name,
          color: SharedDocument._userColor.dark,
          colorLight: SharedDocument._userColor.light
        })
      }
      const extension = yCollab(text, awareness, { undoManager })
      const compartment = new Compartment()
      cm.dispatch({
        effects: StateEffect.appendConfig.of(compartment.of(extension))
      })
    }
  }
}

const patchTextNode = (node: Node, triggerDocUpdate: () => any, yNodes: Y.Map<any>, doc: SharedDocument) => {

  let isEditing = node.isEditing
  if (isEditing) {
    console.log(node)
    addExtensionToTextNode(yNodes, node.id, node.child.editor.cm, doc)
  }
  Object.defineProperty(node, 'isEditing', {
    get: function () {
      return isEditing;
    },
    set: function (x) {
      isEditing = x;
      if (isEditing && node.child?.editor?.cm) {
        addExtensionToTextNode(yNodes, node.id, node.child.editor.cm, doc)
      } else {
        const awareness = doc.webRTCProvider?.awareness
        if (awareness) {
          awareness.setLocalState({})
        }
      }
    }
  })
}

const addExtensionToFileNode = (node: Node) => {
  const file = node.file as TFile
  if (file) {
    const sharedDoc = SharedDocument.findByPath(file.path)
    if (sharedDoc) {
      sharedDoc.addExtensionToCanvasFileNode(node)
    }
  }
}

const removeExtensionFromFileNode = (node: Node) => {
  const file = node.file as TFile
  if (file) {
    const sharedDoc = SharedDocument.findByPath(file.path)
    if (sharedDoc) {
      sharedDoc.removeExtensionFromCanvasFileNode(node)
    }
  }
}

const patchFileNode = (node: Node) => {
  let isEditing = node.isEditing
  if (isEditing) {
    addExtensionToFileNode(node)
  }
  Object.defineProperty(node, 'isEditing', {
    get: function () {
      return isEditing;
    },
    set: function (x) {
      isEditing = x;
      if (isEditing) {
        addExtensionToFileNode(node)
      } else {
        removeExtensionFromFileNode(node)
      }
    }
  })
}

const patchEdge = (edge: Edge, triggerDocUpdate: () => any) => {
  let label = edge.label
  Object.defineProperty(edge, 'label', {
    get: function () {
      return label;
    },
    set: function (x) {
      label = x;
      triggerDocUpdate()
    }
  })
}


