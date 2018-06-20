// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file
// @ts-check

/**
 * @fileoverview
 * UI classes and methods for the Binary Size Analysis HTML report.
 */

{
  /** @const @type {Map<string, HTMLElement>} */
  const _elementCache = new Map();
  /**
   * Gets an element by its ID, but uses a cache to do so
   * @param {string} id
   * @returns {HTMLElement}
   */
  function getElementById(id) {
    let element = _elementCache.get(id);
    if (element == null) {
      element = document.getElementById(id);
      _elementCache.set(id, element);
    }
    return element;
  }

  /** @const @type {[number, string][]} */
  const _BYTE_MULTIPLES = [
    [1024 ** 3, 'GiB'],
    [1024 ** 2, 'MiB'],
    [1024 ** 1, 'KiB'],
    [0, 'B'],
  ];
  function bytesToElement(bytes) {
    for (const [value, suffix] of _BYTE_MULTIPLES) {
      if (bytes >= value) {
        const frag = document.createDocumentFragment();
        const text = (bytes / value).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        });
        frag.textContent = text + ' ';

        const suffixNode = document.createElement('small');
        suffixNode.textContent = suffix;
        frag.appendChild(suffixNode);

        return frag;
      }
    }
  }

  /** @enum {string} Symbol type -> icon ID */
  const _SYMBOL_ICONS = {
    D: 'foldericon',
    F: 'fileicon',
    b: 'bssicon',
    d: 'dataicon',
    r: 'readonlyicon',
    t: 'codeicon',
    v: 'vtableicon',
    '!': 'generatedicon',
    x: 'dexicon',
    m: 'dexmethodicon',
    p: 'localpakicon',
    P: 'nonlocalpakicon',
  };

  /**
   * Get a SVG icon to represent this symbol type.
   * The icons are predefined in the HTML through hidden SVG elements with
   * certain IDs.
   * @param {string} symbolType
   * @return {SVGSVGElement}
   */
  function getIcon(symbolType) {
    const className = `.${_SYMBOL_ICONS[symbolType] || 'othericon'}`;
    const icons = getElementById('icons');

    let icon = _elementCache.get(className);
    if (icon == null) {
      icon = icons.querySelector(className);
      if (icon == null) throw new Error(`Cannot find ${className} icon`);

      _elementCache.set(className, icon);
    }

    return /** @type {SVGSVGElement} */ (icon.cloneNode(true));
  }

  class Leaf {
    /**
     * @param {HTMLTemplateElement} template
     */
    constructor(template) {
      /** @protected @const @type {HTMLElement} */
      this.node = document.importNode(template.content, true);
      /** @public @const @type {HTMLSpanElement | HTMLAnchorElement} */
      this.link = this.node.querySelector('.node');
      /** @private @const @type {HTMLLIElement} */
      this.content = this.node.querySelector('[role="treeitem"]');
      /** @private @const @type {HTMLDivElement} */
      this.icon = this.node.querySelector('.icon-box');
      /** @private @const @type {HTMLSpanElement} */
      this.symbolName = this.node.querySelector('.symbol-name');
      /** @private @const @type {HTMLSpanElement} */
      this.size = this.node.querySelector('.size');
      /** @private @const @type {HTMLSpanElement} */
      this.percent = this.node.querySelector('.percent');

      /** @private @type {EventListener | null} */
      this._onhover = null;
    }

    /**
     * Set the icon to use for this node
     * @param {DocumentFragment} fragment
     */
    setIcon(fragment) {
      this.icon.appendChild(fragment);
    }

    /**
     * Set the symbol name displayed in this node
     * @param {string} name
     */
    setName(name, path) {
      this.symbolName.textContent = name;
      this.symbolName.title = path;
    }

    /**
     * Set the symbol size displayed in this node
     * @param {number} bytes Size of this symbol in bytes
     * @param {number} totalBytes Size of the entire root in bytes
     */
    setSize(bytes, totalBytes) {
      const byteElement = bytesToElement(bytes);
      this.size.appendChild(byteElement);

      const byteString = bytes.toLocaleString(undefined, {useGrouping: true});
      this.size.title = `${byteString} bytes`;

      const totalPercent = bytes / totalBytes;
      this.percent.textContent = totalPercent.toLocaleString(undefined, {
        style: 'percent',
        minimumFractionDigits: 2,
      });
    }

    destroy() {
      this.content.remove();
    }
  }

  class Tree extends Leaf {
    /**
     * @param {HTMLTemplateElement} template
     */
    constructor(template) {
      super(template);
      /** @private @const @type {HTMLUListElement | null} */
      this.group = this.node.querySelector('[role="group"]');
      /** @type {HTMLAnchorElement} */
      this.link;

      /** @private @type {boolean} - is this tree open? */
      this.expanded = false;
      /** @private @type {TreeNode[]} - child tree node elements */
      this.children = [];
      /** @private */
      this._onclick = e => {
        e.preventDefault();
        this.expand();
      };

      this.link.addEventListener('click', this._onclick);
    }

    /**
     * Toggles the node open or closed.
     */
    expand() {
      if (this.expanded) {
        this.content.setAttribute('aria-expanded', 'false');
        this.group.setAttribute('hidden', '');
      } else {
        // Create DOM nodes if nessecary
        if (this.group.children.length === 0) {
          const fragment = document.createDocumentFragment();
          for (const child of this.children) {
            const uiNode = createUiNode(child);
            fragment.appendChild(uiNode.content);
          }
          this.group.appendChild(fragment);
        }

        this.content.setAttribute('aria-expanded', 'true');
        this.group.removeAttribute('hidden');
      }
      this.expanded = !this.expanded;
    }

    /**
     * Sets child nodes and removes any existing children.
     * @param {TreeNode[]} nodes
     */
    setChildren(nodes) {
      this.children = nodes;
      while (this.group.firstChild) {
        this.group.removeChild(this.group.firstChild);
      }
    }

    destroy() {
      super.destroy();
      this.link.removeEventListener('click', this._onclick);
    }
  }

  let _rootSize = 0;

  /**
   * Creates either a Leaf or a Tree depending on the inputted TreeNode.
   * Returns Tree if the TreeNode has at least 1 child node.
   * @param {TreeNode} node
   * @returns {Leaf}
   */
  function createUiNode(node, rootSize = _rootSize) {
    if (rootSize !== _rootSize) _rootSize = rootSize;

    let leaf;
    if (node.children.length > 0) {
      leaf = new Tree(getElementById('treefolder'));
      leaf.setChildren(node.children);
    } else {
      leaf = new Leaf(getElementById('treeitem'));
    }

    leaf.setName(node.shortName, node.idPath);
    leaf.setSize(node.size, rootSize);
    leaf.setIcon(getIcon(node.type));

    return leaf;
  }

  const blob = new Blob([
    `
// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file
// @ts-check

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
 * @param {Iterable<FileEntry>} symbols List of basic symbols.
 * @param {(symbol: FileEntry) => string} getPath Called to get the id path of
 * a symbol.
 * @param {string} sep Path seperator used to find parent names.
 * Defaults to '/'.
 * @returns {TreeNode} Root node of the new tree
 */
function makeTree(symbols, getPath, sep) {
  const rootNode = createNode(
    {idPath: '/', shortName: '/', type: _DIRECTORY_TYPE},
    sep
  );

  /** @type {Map<string, TreeNode>} Cache for directory nodes */
  const parents = new Map();
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

  for (const fileNode of symbols) {
    // make path for this
    const idPath = getPath(fileNode);
    // make node for this
    const node = createNode({idPath, type: _FILE_TYPE}, sep);
    // build child nodes for this file's symbols and attach to self
    for (const symbol of fileNode[_KEYS.FILE_SYMBOLS]) {
      const symbolNode = createNode(
        {
          idPath: idPath + ':' + symbol[_KEYS.SYMBOL_NAME],
          shortName: symbol[_KEYS.SYMBOL_NAME],
          size: symbol[_KEYS.SIZE],
          type: symbol[_KEYS.TYPE],
        },
        sep
      );
      attachToParent(symbolNode, node);
    }
    // build parent node and attach to parent
    getOrMakeParentNode(node);
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

/** Create a tree when this worker receives a message. */
self.onmessage = ({data}) => {
  const {treeData, sep = '/'} = data;
  /** @type {DataFile} JSON tree parsed from string sent over */
  const tree = JSON.parse(treeData);
  const rootNode = makeTree(
    tree.file_nodes,
    s => tree.source_paths[s[_KEYS.SOURCE_PATH_INDEX]],
    sep
  );

  // @ts-ignore
  self.postMessage(rootNode);
};
    `,
  ]);
  const blobUrl = URL.createObjectURL(blob);

  const worker = new Worker(blobUrl);

  /**
   * Displays the given data as a tree view
   * @param {{data:TreeNode}} param0
   */
  worker.onmessage = ({data}) => {
    const root = /** @type {Tree} */ (createUiNode(data, data.size));
    root.expand();

    const dest = getElementById('symboltree');
    while (dest.firstChild) dest.removeChild(dest.firstChild);
    dest.appendChild(root.content);
  };

  function loadTree(treeData) {
    worker.postMessage({treeData, sep: '/', filters: window.location.search});
  }

  window.loadTree = loadTree;
}
