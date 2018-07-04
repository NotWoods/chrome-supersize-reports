// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

/**
 * @fileoverview
 * Web worker code to parse JSON data from binary_size into data for the UI to
 * display.
 */

/**
 * @typedef {object} DataFile JSON data created by html_report python script
 * @prop {FileEntry[]} file_nodes - List of file entries
 * @prop {string[]} source_paths - Array of source_paths referenced by index in
 * the symbols.
 * @prop {string[]} components - Array of components referenced by index in the
 * symbols.
 * @prop {object} meta - Metadata about the data
 */

/**
 * @typedef {object} FileEntry JSON object representing a single file and its
 * symbols.
 * @prop {number} p - source_path
 * @prop {number} c - component_index
 * @prop {Array<{n:string,b:number,t:string}>} s - Symbols belonging to this
 * node. Array of objects.
 *    n - name of the symbol
 *    b - size of the symbol in bytes, divided by num_aliases.
 *    t - single character string to indicate the symbol type
 */

/**
 * @typedef {object} TreeNode Node object used to represent the file tree
 * @prop {TreeNode[]} children Child tree nodes
 * @prop {TreeNode | null} parent Parent tree node. null if this is a root node.
 * @prop {string} idPath
 * @prop {string} shortName
 * @prop {number} size
 * @prop {string} type
 */

/**
 * Abberivated keys used by FileEntrys in the JSON data file.
 * @const
 * @enum {string}
 */
const _KEYS = {
  SOURCE_PATH: 'p',
  COMPONENT_INDEX: 'c',
  FILE_SYMBOLS: 's',
  SYMBOL_NAME: 'n',
  SIZE: 'b',
  TYPE: 't',
};

const _NO_NAME = '(No path)';
const _DIRECTORY_TYPE = 'D';
const _COMPONENT_TYPE = 'C';
const _FILE_TYPE = 'F';

/**
 * Return the basename of the pathname 'path'. In a file path, this is the name
 * of the file and its extension. In a folder path, this is the name of the
 * folder.
 * @param {string} path Path to find basename of.
 * @param {string} sep Path seperator, such as '/'.
 */
function basename(path, sep) {
  const sepIndex = path.lastIndexOf(sep);
  const pathIndex = path.lastIndexOf('/');
  return path.substring(Math.max(sepIndex, pathIndex) + 1);
}

/**
 * Return the basename of the pathname 'path'. In a file path, this is the
 * full path of its folder.
 * @param {string} path Path to find dirname of.
 * @param {string} sep Path seperator, such as '/'.
 */
function dirname(path, sep) {
  const sepIndex = path.lastIndexOf(sep);
  const pathIndex = path.lastIndexOf('/');
  return path.substring(0, Math.max(sepIndex, pathIndex));
}

/**
 * Compare two nodes for sorting. Used in sortTree.
 * @param {TreeNode} a
 * @param {TreeNode} b
 */
function _compareFunc(a, b) {
  return Math.abs(b.size) - Math.abs(a.size);
}

/**
 * Sorts nodes in place based on their sizes.
 * @param {TreeNode} node Node whose children will be sorted. Will be modified
 * by this function.
 */
function sortTree(node) {
  node.children.sort(_compareFunc);
  node.children.forEach(sortTree);
}

/**
 * Link a node to a new parent. Will go up the tree to update parent sizes to
 * include the new child.
 * @param {TreeNode} node Child node.
 * @param {TreeNode} parent New parent node.
 */
function attachToParent(node, parent) {
  // Link the nodes together
  parent.children.push(node);
  node.parent = parent;

  // Update the size of all ancestors
  const {size} = node;
  while (node != null && node.parent != null) {
    node.parent.size += size;
    node = node.parent;
  }
}

/**
 * Make a node with some default arguments
 * @param {Partial<TreeNode>} options Values to use for the node. If a value is
 * omitted, a default will be used instead.
 * @param {string} sep Path seperator, such as '/'. Used for creating a default
 * shortName.
 * @returns {TreeNode}
 */
function createNode(options, sep) {
  const {idPath, type, shortName = basename(idPath, sep), size = 0} = options;
  return {
    children: [],
    parent: null,
    idPath,
    shortName,
    size,
    type,
  };
}

/**
 * Class used to build a tree from a list of symbol objects.
 * Add each file node using `addFileEntry()`, then call `build()` to finalize
 * the tree and return the root node. The in-progress tree can be obtained from
 * the `rootNode` property.
 */
class TreeBuilder {
  /**
   * @param {object} options
   * @param {(file: FileEntry) => string} options.getPath Called to get the id
   * path of a symbol's file.
   * @param {(symbol: TreeNode) => boolean} options.filterTest Called to see if
   * a symbol should be included. If a symbol fails the test, it will not be
   * attached to the tree.
   * @param {string} options.sep Path seperator used to find parent names.
   * @param {boolean} options.methodCountMode If true, return number of dex
   * methods instead of size.
   */
  constructor(options) {
    this._getPath = options.getPath;
    this._filterTest = options.filterTest;
    this._sep = options.sep || '/';
    this._methodCountMode = options.methodCountMode || false;

    this.rootNode = createNode(
      {idPath: this._sep, shortName: this._sep, type: _DIRECTORY_TYPE},
      this._sep
    );
    /** @type {Map<string, TreeNode>} Cache for directory nodes */
    this._parents = new Map();
  }

  /**
   * Helper to return the parent of the given node. The parent is determined
   * based in the idPath and the path seperator. If the parent doesn't yet
   * exist, one is created and stored in the parents map.
   * @param {TreeNode} node
   * @private
   */
  _getOrMakeParentNode(node) {
    // Get idPath of this node's parent.
    let parentPath;
    if (node.idPath === '') parentPath = _NO_NAME;
    else parentPath = dirname(node.idPath, this._sep);

    // check if parent exists
    let parentNode;
    if (parentPath === '') {
      // parent is root node if dirname is ''
      parentNode = this.rootNode;
    } else {
      // get parent from cache if it exists, otherwise create it
      parentNode = this._parents.get(parentPath);
      if (parentNode == null) {
        const useAltType =
          node.idPath.lastIndexOf(this._sep) > node.idPath.lastIndexOf('/');
        parentNode = createNode(
          {
            idPath: parentPath,
            type: useAltType ? _COMPONENT_TYPE : _DIRECTORY_TYPE,
          },
          this._sep
        );
        this._parents.set(parentPath, parentNode);
      }
    }

    // attach node to the newly found parent
    attachToParent(node, parentNode);
    return parentNode;
  }

  /**
   * Iterate through every file node generated by supersize. Each node includes
   * symbols that belong to that file. Create a tree node for each file with
   * tree nodes for that file's symbols attached. Afterwards attach that node to
   * its parent directory node, or create it if missing.
   * @param {FileEntry} fileNode
   */
  addFileEntry(fileNode) {
    // make path for this
    const filePath = fileNode[_KEYS.SOURCE_PATH];
    const idPath = this._getPath(fileNode);
    // make node for this
    const node = createNode(
      {idPath, shortName: basename(filePath, this._sep), type: _FILE_TYPE},
      this._sep
    );
    // build child nodes for this file's symbols and attach to self
    for (const symbol of fileNode[_KEYS.FILE_SYMBOLS]) {
      const size = this._methodCountMode ? 1 : symbol[_KEYS.SIZE];
      const symbolNode = createNode(
        {
          idPath: idPath + ':' + symbol[_KEYS.SYMBOL_NAME],
          shortName: symbol[_KEYS.SYMBOL_NAME],
          size,
          type: symbol[_KEYS.TYPE],
        },
        this._sep
      );
      if (this._filterTest(symbolNode)) attachToParent(symbolNode, node);
    }
    // unless we filtered out every symbol belonging to this file,
    if (node.children.length > 0) {
      // build all ancestor nodes for this file
      let orphanNode = node;
      while (orphanNode.parent == null && orphanNode !== this.rootNode) {
        orphanNode = this._getOrMakeParentNode(orphanNode);
      }
    }
  }

  /**
   * Finalize the creation of the tree and return the root node.
   */
  build() {
    // Sort the tree so that larger items are higher.
    sortTree(this.rootNode);

    return this.rootNode;
  }
}

/**
 * Transforms a binary stream into a newline delimited JSON (.ndjson) stream.
 * Each yielded value corresponds to one line in the stream.
 * @param {ReadableStream} stream Readable stream to convert to text, such
 * as a response body.
 */
async function* newlineDelimtedJsonStream(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  let buffer = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, {stream: true});
    buffer += chunk;
    if (chunk.includes('\n')) {
      const lines = buffer.split('\n');
      [buffer] = lines.splice(lines.length - 1, 1);

      for (const line of lines) {
        yield JSON.parse(line);
      }
    }
  }
}

let responsePromise = fetch('data.ndjson');

/**
 * Assemble a tree when this worker receives a message.
 * @param {MessageEvent} event Event for when this worker receives a message.
 */
self.onmessage = async event => {
  const params = new URLSearchParams(event.data);
  const groupBy = params.get('group_by') || 'source_path';
  const methodCountMode = params.has('method_count');
  let typeFilter;
  if (methodCountMode) typeFilter = new Set('m');
  else {
    const types = params.getAll('types');
    typeFilter = new Set(types.length === 0 ? 'bdrtv*xmpPo' : types);
  }

  /** Object from the first line of the data file */
  let meta = null;

  const getPathMap = {
    component(fileEntry) {
      const component = meta.components[fileEntry[_KEYS.COMPONENT_INDEX]];
      const path = getPathMap.source_path(fileEntry);
      return (component || '(No component)') + '>' + path;
    },
    source_path(fileEntry) {
      return fileEntry[_KEYS.SOURCE_PATH];
    },
  };
  const sepMap = {
    component: '>',
  };

  const builder = new TreeBuilder({
    sep: sepMap[groupBy],
    methodCountMode,
    getPath: getPathMap[groupBy],
    filterTest: s => typeFilter.has(s.type),
  });

  /**
   * Post data to the UI thread. Defaults will be used for the root and percent
   * values if not specified.
   * @param {{root?:TreeNode,percent?:number,error?:Error}} data Default data
   * values to post.
   */
  function postToUi(data = {}) {
    let {percent} = data;
    if (percent == null) {
      if (meta == null) {
        percent = 0;
      } else {
        percent = Math.max(builder.rootNode.size / meta.total, 0.1);
      }
    }

    const message = {root: data.root || builder.rootNode, percent};
    if (data.error) {
      message.error = data.error.message;
    }

    // @ts-ignore
    self.postMessage(message);
  }

  try {
    let response = await responsePromise;
    if (response.bodyUsed) {
      response = await fetch('data.ndjson');
    }

    // Post partial state every 5 seconds
    const interval = setInterval(postToUi, 5000);
    for await (const line of newlineDelimtedJsonStream(response.body)) {
      if (meta == null) {
        meta = line;
        postToUi();
      } else {
        builder.addFileEntry(line);
      }
    }
    clearInterval(interval);
  } catch (error) {
    console.error(error);
    postToUi({error});
  }

  postToUi({root: builder.build(), percent: 1});
};
