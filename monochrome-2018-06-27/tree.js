// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

/**
 * @fileoverview
 * UI classes and methods for the Tree View in the
 * Binary Size Analysis HTML report.
 */

{
  /**
   * @enum {number} Various byte units and the corresponding amount of bytes
   * that one unit represents.
   */
  const _BYTE_UNITS = {
    GiB: 1024 ** 3,
    MiB: 1024 ** 2,
    KiB: 1024 ** 1,
    B: 1024 ** 0,
  };
  /** Set of all byte units */
  const _BYTE_UNITS_SET = new Set(Object.keys(_BYTE_UNITS));

  const _icons = document.getElementById('icons');
  /**
   * @enum {SVGSVGElement} Icon elements that correspond to each symbol type.
   */
  const _SYMBOL_ICONS = {
    D: _icons.querySelector('.foldericon'),
    F: _icons.querySelector('.fileicon'),
    b: _icons.querySelector('.bssicon'),
    d: _icons.querySelector('.dataicon'),
    r: _icons.querySelector('.readonlyicon'),
    t: _icons.querySelector('.codeicon'),
    v: _icons.querySelector('.vtableicon'),
    '*': _icons.querySelector('.generatedicon'),
    x: _icons.querySelector('.dexicon'),
    m: _icons.querySelector('.dexmethodicon'),
    p: _icons.querySelector('.localpakicon'),
    P: _icons.querySelector('.nonlocalpakicon'),
    o: _icons.querySelector('.othericon'), // used as default icon
  };

  // Templates for tree nodes in the UI.
  const _leafTemplate = document.getElementById('treeitem');
  const _treeTemplate = document.getElementById('treefolder');

  /**
   * @type {WeakMap<HTMLElement, Readonly<TreeNode>>}
   * Associates UI nodes with the corresponding tree data object
   * so that event listeners and other methods can
   * query the original data.
   */
  const _uiNodeData = new WeakMap();

  /**
   * Replace the contexts of the size element for a tree node.
   * If in method count mode, size instead represents the amount of methods in
   * the node. In this case, don't append a unit at the end.
   * @param {HTMLElement} sizeElement Element that should display the count
   * @param {number} methodCount Number of methods to use for the count text
   */
  function _setMethodCountContents(sizeElement, methodCount) {
    const methodStr = methodCount.toLocaleString(undefined, {
      useGrouping: true,
    });

    const textNode = document.createTextNode(methodStr);
    dom.replace(sizeElement, textNode);
    sizeElement.title = `${methodStr} methods`;
  }

  /**
   * Replace the contexts of the size element for a tree node.
   * The unit to use is selected from the current state,
   * and the original number of bytes will be displayed as
   * hover text over the element.
   * @param {HTMLElement} sizeElement Element that should display the size
   * @param {number} bytes Number of bytes to use for the size text
   */
  function _setSizeContents(sizeElement, bytes) {
    // Get unit from query string, will fallback for invalid query
    const suffix = state.get('byteunit', {
      default: 'MiB',
      valid: _BYTE_UNITS_SET,
    });
    const value = _BYTE_UNITS[suffix];

    // Format the bytes as a number with 2 digits after the decimal point
    const text = (bytes / value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const textNode = document.createTextNode(`${text} `);

    // Display the suffix with a smaller font
    const suffixElement = document.createElement('small');
    suffixElement.textContent = suffix;

    // Replace the contents of '.size' and change its title
    dom.replace(sizeElement, dom.createFragment([textNode, suffixElement]));
    sizeElement.title =
      bytes.toLocaleString(undefined, {useGrouping: true}) + ' bytes';
  }

  /**
   * Click event handler to expand or close the child group of a tree.
   * @param {Event} event
   */
  function _toggleTreeElement(event) {
    event.preventDefault();

    const link = event.currentTarget;
    const element = link.parentElement;
    const group = link.nextElementSibling;

    const isExpanded = element.getAttribute('aria-expanded') === 'true';
    if (isExpanded) {
      element.setAttribute('aria-expanded', 'false');
      group.setAttribute('hidden', '');
    } else {
      if (group.children.length === 0) {
        const data = _uiNodeData.get(link);
        group.appendChild(
          dom.createFragment(data.children.map(child => newTreeElement(child)))
        );
      }

      element.setAttribute('aria-expanded', 'true');
      group.removeAttribute('hidden');
    }
  }

  /**
   * Inflate a template to create an element that represents one tree node.
   * The element will represent a tree or a leaf, depending on if the tree
   * node object has any children. Trees use a slightly different template
   * and have click event listeners attached.
   * @param {TreeNode} data Data to use for the UI.
   * @returns {HTMLElement}
   */
  function newTreeElement(data) {
    const isLeaf = data.children.length === 0;
    const template = isLeaf ? _leafTemplate : _treeTemplate;
    const element = document.importNode(template.content, true);

    // Associate clickable node & tree data
    const link = element.querySelector('.node');
    _uiNodeData.set(link, Object.freeze(data));

    // Icons are predefined in the HTML through hidden SVG elements
    const iconTemplate = _SYMBOL_ICONS[data.type] || _SYMBOL_ICONS.o;
    const icon = iconTemplate.cloneNode(true);
    // Insert an SVG icon at the start of the link to represent type
    link.insertBefore(icon, link.firstElementChild);

    // Set the symbol name and hover text
    const symbolName = element.querySelector('.symbol-name');
    symbolName.textContent = data.shortName;
    symbolName.title = data.idPath;

    // Set the byte size and hover text
    const _setSize = state.has('method_count')
      ? _setMethodCountContents
      : _setSizeContents;
    _setSize(element.querySelector('.size'), data.size);

    if (!isLeaf) {
      link.addEventListener('click', _toggleTreeElement);
    }

    return element;
  }

  // When the `byteunit` state changes, update all .size elements in the page
  form.byteunit.addEventListener('change', event => {
    // Update existing size elements with the new unit
    for (const sizeElement of document.getElementsByClassName('size')) {
      const data = _uiNodeData.get(sizeElement.parentElement);
      _setSizeContents(sizeElement, data.size);
    }
  });

  self.newTreeElement = newTreeElement;
}

{
  const blob = new Blob([
    `
    // Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// @ts-check
'use strict';

/**
 * @fileoverview
 * Web worker code to parse JSON data from binary_size into data for the UI to
 * display.
 * Note: backticks (\`) are banned from this file as the file contents are
 * turned into a Javascript string encapsulated by backticks.
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
 * @prop {number} p - source_path_index
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
  SOURCE_PATH_INDEX: 'p',
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
      node.shortName += sep + child.shortName;
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
 * Sorts nodes in place based on their sizes.
 * @param {TreeNode} node Node whose children will be sorted. Will be modified
 * by this function.
 */
function sortTree(node) {
  node.children.sort((a, b) => b.size - a.size);
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
 * Build a tree from a list of symbol objects.
 * @param {object} options
 * @param {Iterable<FileEntry>} options.symbols List of basic symbols.
 * @param {(file: FileEntry) => string} options.getPath Called to get the id
 * path of a symbol's file.
 * @param {(symbol: TreeNode) => boolean} options.filterTest Called to see if
 * a symbol should be included. If a symbol fails the test, it will not be
 * attached to the tree.
 * @param {string} options.sep Path seperator used to find parent names.
 * @param {boolean} options.methodCountMode If true, return number of dex
 * methods instead of size.
 * @returns {TreeNode} Root node of the new tree
 */
function makeTree(options) {
  const {symbols, sep, methodCountMode, getPath, filterTest} = options;
  const rootNode = createNode(
    {idPath: '/', shortName: '/', type: _DIRECTORY_TYPE},
    sep
  );

  /** @type {Map<string, TreeNode>} Cache for directory nodes */
  const parents = new Map();
  /**
   * Helper to return the parent of the given node. The parent is determined
   * based in the idPath and the path seperator. If the parent doesn't yet
   * exist, one is created and stored in the parents map.
   * @param {TreeNode} node
   */
  function getOrMakeParentNode(node) {
    // Get idPath of this node's parent.
    let parentPath;
    if (node.idPath === '') parentPath = _NO_NAME;
    else parentPath = dirname(node.idPath, sep);

    // check if parent exists
    let parentNode;
    if (parentPath === '') {
      // parent is root node if dirname is ''
      parentNode = rootNode;
    } else {
      // get parent from cache if it exists, otherwise create it
      parentNode = parents.get(parentPath);
      if (parentNode == null) {
        parentNode = createNode(
          {idPath: parentPath, type: _DIRECTORY_TYPE},
          sep
        );
        parents.set(parentPath, parentNode);
      }
    }

    // attach node to the newly found parent
    attachToParent(node, parentNode);
  }

  // Iterate through every file node generated by supersize. Each node includes
  // symbols that belong to that file. Create a tree node for each file with
  // tree nodes for that file's symbols attached. Afterwards attach that node to
  // its parent directory node, or create it if missing.
  for (const fileNode of symbols) {
    // make path for this
    const idPath = getPath(fileNode);
    // make node for this
    const node = createNode({idPath, type: _FILE_TYPE}, sep);
    // build child nodes for this file's symbols and attach to self
    for (const symbol of fileNode[_KEYS.FILE_SYMBOLS]) {
      const size = methodCountMode ? 1 : symbol[_KEYS.SIZE];
      const symbolNode = createNode(
        {
          idPath: idPath + ':' + symbol[_KEYS.SYMBOL_NAME],
          shortName: symbol[_KEYS.SYMBOL_NAME],
          size,
          type: symbol[_KEYS.TYPE],
        },
        sep
      );
      if (filterTest(symbolNode)) attachToParent(symbolNode, node);
    }
    // build parent node and attach file to parent,
    // unless we filtered out every symbol belonging to this file
    if (node.children.length > 0) getOrMakeParentNode(node);
  }

  // build parents for the directories until reaching the root node
  for (const directory of parents.values()) {
    getOrMakeParentNode(directory);
  }

  // Collapse nodes such as "java"->"com"->"google" into "java/com/google".
  combineSingleChildNodes(rootNode, sep);
  // Sort the tree so that larger items are higher.
  sortTree(rootNode);

  return rootNode;
}

/**
 * Assemble a tree when this worker receives a message.
 * @param {MessageEvent} event Event for when this worker receives a message.
 */
self.onmessage = event => {
  /**
   * @type {{tree:DataFile,options:string}} JSON data parsed from a string
   * supplied by the UI thread. Includes JSON representing the symbol tree as a
   * flat list of files, and options represented as a query string.
   */
  const {tree, options} = JSON.parse(event.data);

  const params = new URLSearchParams(options);
  const sep = params.get('sep') || '/';
  const methodCountMode = params.has('method_count');
  let typeFilter;
  if (methodCountMode) typeFilter = new Set('m');
  else {
    const types = params.getAll('types');
    typeFilter = new Set(types.length === 0 ? 'bdrtv*xmpPo' : types);
  }

  const rootNode = makeTree({
    symbols: tree.file_nodes,
    sep,
    methodCountMode,
    getPath: s => tree.source_paths[s[_KEYS.SOURCE_PATH_INDEX]],
    filterTest: s => typeFilter.has(s.type),
  });

  // @ts-ignore
  self.postMessage({root: rootNode, meta: tree.meta});
};

    `,
  ]);
  // We use a worker to keep large tree creation logic off the UI thread
  const worker = new Worker(URL.createObjectURL(blob));

  /**
   * Displays the given data as a tree view
   * @param {{data:{root:TreeNode,meta:object}}} param0
   */
  worker.onmessage = ({data}) => {
    const root = newTreeElement(data.root);
    // Expand the root UI node
    root.querySelector('.node').click();

    dom.replace(document.getElementById('symboltree'), root);
  };

  /**
   * Loads the tree data given on a worker thread and replaces the tree view in
   * the UI once complete. Uses query string as state for the options.
   * @param {string} treeData JSON string to be parsed on the worker thread.
   */
  function loadTree(treeData) {
    // Post as a JSON string for better performance
    worker.postMessage(
      `{"tree":${treeData}, "options":"${location.search.slice(1)}"}`
    );
  }

  self.loadTree = loadTree;
}
