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
const _FILE_TYPE = 'F';

/**
 * Return the basename of the pathname 'path'. In a file path, this is the name
 * of the file and its extension. In a folder path, this is the name of the
 * folder.
 * @param {string} path Path to find basename of.
 * @param {string} sep Path seperator, such as '/'.
 */
function basename(path, sep) {
  const idx = path.lastIndexOf(sep);
  return path.substring(idx + 1);
}

/**
 * Return the basename of the pathname 'path'. In a file path, this is the
 * full path of its folder.
 * @param {string} path Path to find dirname of.
 * @param {string} sep Path seperator, such as '/'.
 */
function dirname(path, sep) {
  const idx = path.lastIndexOf(sep);
  return path.substring(0, idx);
}

/**
 * Collapse "java"->"com"->"google" into "java/com/google". Nodes will only be
 * collapsed if they are the same type, most commonly by merging directories.
 * @param {TreeNode} node Node to potentially collapse. Will be modified by
 * this function.
 * @param {string} sep Path seperator, such as '/'.
 */
function combineSingleChildNodes(node, sep) {
  if (node.children.length > 0) {
    const [child] = node.children;
    // If there is only 1 child and its the same type, merge it in.
    if (node.children.length === 1 && node.type === child.type) {
      // size & type should be the same, so don't bother copying them.
      node.shortName += sep + '\u200b' + child.shortName;
      node.idPath = child.idPath;
      node.children = child.children;
      // Search children of this node.
      combineSingleChildNodes(node, sep);
    } else {
      // Search children of this node.
      node.children.forEach(child => combineSingleChildNodes(child, sep));
    }
  }
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
    this._sep = options.sep;
    this._methodCountMode = options.methodCountMode;

    this.rootNode = createNode(
      {idPath: '/', shortName: '/', type: _DIRECTORY_TYPE},
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
        parentNode = createNode(
          {idPath: parentPath, type: _DIRECTORY_TYPE},
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
    const idPath = this._getPath(fileNode);
    // make node for this
    const node = createNode({idPath, type: _FILE_TYPE}, this._sep);
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
    // Collapse nodes such as "java"->"com"->"google" into "java/com/google".
    combineSingleChildNodes(this.rootNode, this._sep);
    // Sort the tree so that larger items are higher.
    sortTree(this.rootNode);

    return this.rootNode;
  }
}

/**
 * Build a tree from a list of symbol objects.
 * @param {object} options
 * @param {Iterable<FileEntry> | AsyncIterator<FileEntry>} options.symbols List of basic symbols.
 * @param {(file: FileEntry) => string} options.getPath Called to get the id
 * path of a symbol's file.
 * @param {(symbol: TreeNode) => boolean} options.filterTest Called to see if
 * a symbol should be included. If a symbol fails the test, it will not be
 * attached to the tree.
 * @param {string} options.sep Path seperator used to find parent names.
 * @param {boolean} options.methodCountMode If true, return number of dex
 * methods instead of size.
 * @returns {Promise<TreeNode>} Root node of the new tree
 */
async function makeTree(options) {
  const builder = new TreeBuilder(options);
  for (const fileNode of options.symbols) builder.addFileEntry(fileNode);
  return builder.build();
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
  const sep = params.get('sep') || '/';
  const methodCountMode = params.has('method_count');
  let typeFilter;
  if (methodCountMode) typeFilter = new Set('m');
  else {
    const types = params.getAll('types');
    typeFilter = new Set(types.length === 0 ? 'bdrtv*xmpPo' : types);
  }

  const builder = new TreeBuilder({
    sep,
    methodCountMode,
    getPath: s => s[_KEYS.SOURCE_PATH],
    filterTest: s => typeFilter.has(s.type),
  });

  let response = await responsePromise;
  if (response.bodyUsed) {
    response = await fetch('data.ndjson');
  }

  let meta = null;
  function postPartialTree() {
    let percent = 0;
    if (meta != null) {
      // Include percentage of data loaded.
      // Use 0.1 as the smallest value, as 0 will indicate the response hasn't
      // resolved yet.
      percent = Math.max(builder.rootNode.size / meta.total, 0.1);
    }
    self.postMessage({root: builder.rootNode, percent});
  }

  // Post partial state every 5 seconds
  const interval = setInterval(postPartialTree, 5000);
  for await (const line of newlineDelimtedJsonStream(response.body)) {
    if (meta == null) {
      meta = line;
      postPartialTree();
    } else {
      builder.addFileEntry(line);
    }
  }
  clearInterval(interval);

  // @ts-ignore
  self.postMessage({root: builder.build(), percent: 1});
};
