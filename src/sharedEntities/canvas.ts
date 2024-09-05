import { diff, type IChange } from 'json-diff-ts';
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
  canvas.nodes = Object.values(canvas.nodes)
  canvas.edges = Object.values(canvas.edges)
  return canvas
}

export const applyFileChangesToDoc = (canvas: any, yDoc: Y.Doc) => {

  yDoc.transact(() => {
    const diffs = diffCanvases(yDocToCanvasJSON(yDoc), canvas)

    console.log("diffs before applying")
    console.log(diffs)

    const yCanvas = yDoc.getMap('canvas')

    applyChanges(yCanvas, diffs)

    console.log("Diff after changes")
    console.log(diff(yDocToCanvasJSON(yDoc), canvas, {
      embeddedObjKeys: {
        edges: 'id',
        nodes: 'id'
      }
    }))
  })
}
export const diffCanvases = (oldCanvas: any, newCanvas: any) => {
  return diff(oldCanvas, newCanvas, {
    embeddedObjKeys: {
      edges: 'id',
      nodes: 'id'
    }
  })
}

const applyChanges = (yMap: Y.Map<any>, changes: Array<IChange>) => {
  for (const change of changes) {
    if (change.changes) {
      applyChanges(yMap.get(change.key) as Y.Map<any>, change.changes)
    } else if (change.value) {
      if (change.type === "UPDATE") {
        yMap.set(change.key, change.value)
      } else if (change.type === "ADD") {
        console.log(change.key)
        if (change.value instanceof Array) {
          yMap.set(change.key, createYArrayFromArray(change.value));
        }
        else if (change.value instanceof Object) {
          yMap.set(change.key, createYMapFromObject(change.value));
        }
        else {
          yMap.set(change.key, change.value);
        }
      } else if (change.type === "REMOVE") {
        yMap.delete(change.key)
      }
    }
  }
}


const createYMapFromObject = (object: any) => {
  const ymap = new Y.Map();

  for (const property in object) {
    if (object[property] instanceof Array) {
      ymap.set(property, createYArrayFromArray(object[property]));
    }

    else if (object[property] instanceof Object) {
      ymap.set(property, createYMapFromObject(object[property]));
    }
    else {
      ymap.set(property, object[property]);
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