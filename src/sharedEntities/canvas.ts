import { diff, type IChange } from 'json-diff-ts';
import { debounce } from 'obsidian';
import * as Y from 'yjs'

export const addCanvasToYDoc = (canvas: any, doc: Y.Doc) => {

  doc.transact(() => {
    const yCanvas = doc.getMap('canvas')
    const yNodes = new Y.Map()
    yCanvas.set('nodes', yNodes)
    const yEdges = new Y.Map()
    yCanvas.set('edges', yEdges)

    const nodes = canvas.nodes

    if (nodes) {
      for (const node of nodes) {
        const yNode = createYMapFromObject(node)
        yNodes.set(node.id, yNode)
      }
    }

    const edges = canvas.edges

    if (edges) {
      for (const edge of edges) {
        const yEdge = createYMapFromObject(edge)
        yEdges.set(edge.id, yEdge)
      }
    }
  })
  return doc
}

export const yDocToCanvasJSON = (doc: Y.Doc) => {
  const canvas = doc.getMap('canvas').toJSON()
  canvas.nodes = Object.values(canvas.nodes ?? [])
  canvas.edges = Object.values(canvas.edges ?? [])
  return canvas
}

export const applyDataChangesToDoc = (data: any, yDoc: Y.Doc) => {
  yDoc.transact(() => {
    const diffs = diffCanvases(yDocToCanvasJSON(yDoc), data)
    const yCanvas = yDoc.getMap('canvas')
    applyChanges(yCanvas, diffs)
  })
}

export const debouncedApplyDataChangesToDoc = debounce(applyDataChangesToDoc, 10, true)

export const diffCanvases = (oldCanvas: any, newCanvas: any) => {
  return diff(oldCanvas, newCanvas, {
    embeddedObjKeys: {
      edges: 'id',
      nodes: 'id'
    }
  })
}

const applyChanges = (yMap: Y.Map<any>, changes: Array<IChange>, path: Array<string> = []) => {
  for (const change of changes) {
    if (change.changes) {
      path.push(change.key)
      const entry = yMap.get(change.key) || yMap.set(change.key, new Y.Map())
      applyChanges(entry, change.changes, path)
    } else if (change.value) {

      let include = true
      // postpone edges until they have an end-node
      if (path.length === 1 && path[0] === "edges") {
        const toNode = change.value?.toNode
        if (toNode) {
          const node = (yMap.doc?.getMap("canvas")?.get("nodes") as Y.Map<any>)?.get(toNode)
          if (!node) {
            include = false
          }
        }
      }
      if (include) {
      if (change.type === "UPDATE") {
        yMap.set(change.key, change.value)
      } else if (change.type === "ADD") {
          if (change.value instanceof Array) {
            yMap.set(change.key, createYArrayFromArray(change.value));
          }
          else if (change.value instanceof Object) {
            yMap.set(change.key, createYMapFromObject(change.value));
          }
          else {
            yMap.set(change.key, change.value);
          }
        }
      } if (change.type === "REMOVE") {
        yMap.delete(change.key)
      }
    }
  }
}


export const createYMapFromObject = (object: any) => {
  const ymap = new Y.Map();

  for (const property in object) {
    if (object[property] instanceof Array) {
      ymap.set(property, createYArrayFromArray(object[property]));
    }

    else if (object[property] instanceof Object) {
      ymap.set(property, createYMapFromObject(object[property]));
    }
    else {
      if (property === "text" && typeof object[property] === "string" && object["type"] === "text") {
        ymap.set(property, new Y.Text(object[property]))
      } else {
        ymap.set(property, object[property]);
      }
    }
  }

  return ymap;
};

const createYArrayFromArray = (array: Array<any>) => {
  const yarray = new Y.Array();

  for (let index in array) {
    if (array[index] instanceof Array)
      yarray.push([createYArrayFromArray(array[index])]);

    else if (array[index] instanceof Object)
      yarray.push([createYMapFromObject(array[index])]);

    else
      yarray.push([array[index]]);
  }

  return yarray;
};