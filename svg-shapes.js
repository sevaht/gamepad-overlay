const SVG_NS = 'http://www.w3.org/2000/svg';

let nextMonotonicId = 0;
function monotonicId(prefix) {
    return `${prefix}-${nextMonotonicId++}`;
}

function toClassList(classes) {
    if (!classes) return [];
    return Array.isArray(classes) ? classes : [classes];
}

function toDimensions(value) {
    if (typeof value === "number") {
        return {x: value, y: value};
    }
    return {x: value.x, y: value.y};
}

const ShapeType = Object.freeze({
    RECTANGLE: Symbol("RECTANGLE"),
    ELLIPSE: Symbol("ELLIPSE"),
    TRIANGLE_UP: Symbol("TRIANGLE_UP"),
    TRIANGLE_DOWN: Symbol("TRIANGLE_DOWN"),
    TRIANGLE_LEFT: Symbol("TRIANGLE_LEFT"),
    TRIANGLE_RIGHT: Symbol("TRIANGLE_RIGHT"),
});

class Point {
    #x;
    #y;

    constructor(x, y) {
        this.#x = x;
        this.#y = y;
    }

    static from({ x, y }) {
        return new this(x, y);
    }

    get x() { return this.#x; }
    get y() { return this.#y; }

    toString() {
        return `${this.#x},${this.#y}`;
    }
}

class LayeredSvgElement {
    #id;
    #svg;
    #element;
    #cutoutId;
    constructor({svg, element, cell}) {
        this.#id = element.getAttribute("id") ?? monotonicId(element.tagName);
        this.#svg = svg;
        this.#element = element;
        this.#element.setAttribute("id", this.#id);

        let defs = this.#svg.querySelector("defs");
        if (!defs) {
            defs = document.createElementNS(SVG_NS, "defs");
            svg.insertBefore(defs, svg.firstChild);
        }
        defs.appendChild(this.#element);
        // NOTE: this needs to be large enough to cover anything in the
        // coordinate systems of rendered objects.  Just picking a large
        // value, but in my testing 30_000_000 works, but 40_000_000
        // fails due to rendering engine limits.  This should be safe.
        const HALF_MAX = 100_000;
        const FULL_MAX = HALF_MAX*2;
        const allCoordinates = {
            x: -HALF_MAX,
            y: -HALF_MAX,
            width: FULL_MAX,
            height: FULL_MAX,
        };
        let mask = document.createElementNS(SVG_NS, 'mask');
        mask.setAttribute("id", monotonicId("cutout"));
        mask.setAttribute("maskUnits", "userSpaceOnUse");
        mask.setAttribute("maskContentUnits", "userSpaceOnUse");
        // add double the area
        mask.setAttribute("x", allCoordinates.x);
        mask.setAttribute("y", allCoordinates.y);
        mask.setAttribute("width", allCoordinates.width);
        mask.setAttribute("height", allCoordinates.height);
        defs.appendChild(mask, svg.firstChild);
        this.#cutoutId = mask.getAttribute("id");
        let everythingMask = document.createElementNS(SVG_NS, 'rect');
        everythingMask.setAttribute("id", monotonicId("everything-mask"));
        everythingMask.setAttribute("x", allCoordinates.x);
        everythingMask.setAttribute("y", allCoordinates.y);
        everythingMask.setAttribute("width", allCoordinates.width);
        everythingMask.setAttribute("height", allCoordinates.height);
        everythingMask.setAttribute("fill", "white");
        mask.appendChild(everythingMask, mask.firstChild);
        let shapeRemove = this.#createUseElement();
        shapeRemove.setAttribute("fill", "black");
        mask.appendChild(shapeRemove);
    }

    #createUseElement() {
        const element = document.createElementNS(SVG_NS, 'use');
        element.setAttribute("href", `#${this.#id}`);
        return element;
    }

    get element() { return this.#element; }
    /**
     * Create and append an SVG group positioned around a center point, containing one or more
     * layered `<use>` elements that reference this instance’s predefined SVG definition.
     *
     * The group is positioned so that the referenced artwork is centered at the given point.
     * Layers are appended in the order provided; earlier layers render beneath later ones.
     *
     * @param {Object} params
     *
     * @param {SVGElement} [params.container]
     *   The SVG element to append the group into. If omitted or `null`, the root SVG element
     *   provided to the constructor is used. If provided, it must be a descendant of that
     *   root SVG element so the referenced definition is available.
     *
     * @param {Object} params.center
     *   The point (in SVG user units) at which the referenced artwork will be centered.
     * @param {number} params.center.x
     *   X coordinate of the center point.
     * @param {number} params.center.y
     *   Y coordinate of the center point.
     *
     * @param {Array<Object>} [params.layers]
     *   Ordered list of layer descriptors. Each descriptor produces one `<use>` element
     *   referencing the same definition. If omitted, a single default layer is created.
     *
     * @param {string|string[]} [params.layers[].classes]
     *   Optional CSS class name or list of class names to apply to the layer.
     *
     * @param {string} [params.layers[].id]
     *   Optional `id` attribute to assign to the layer’s `<use>` element.
     *
     * @returns {SVGGElement}
     *   The created `<g>` element containing the layered `<use>` elements.
     *
     * @throws {Error}
     *   If `container` is provided and is not a descendant of the root SVG element associated
     *   with this instance.
     */
    appendGroup({container, center, layers}) {
        layers ??= [{}];
        if (container == null) {
            container = this.#svg;
        } else if (!this.#svg.contains(container)) {
            // this matters because the def won't be defined.
            throw new Error("Passed container is not a child of the svg given in the constructor.");
        }
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute(
            "transform",
            `translate(${center.x} ${center.y})`
        );
        const baseUse = this.#createUseElement();

        for (const layer of layers) {
            const use = baseUse.cloneNode(false);
            for (const className of toClassList(layer.classes)) {
                use.classList.add(className);
            }
            if (layer.id) {
                use.setAttribute("id", id);
            }
            if (layer.cutout) {
                use.setAttribute("mask", `url(#${this.#cutoutId})`);
            }
            group.appendChild(use);
        }
        container.appendChild(group);
        //return group;
        return {
            group,
            center,
            cutoutId: this.#cutoutId,
            id: this.#id,
        };
    }
}

/**
 * Computes geometric positions for a grid cell.
 *
 * The cell is centered at ((column * 2 + 1) * extent + offset.x,
 *                          (row * 2 + 1) * extent + offset.y)
 * and has width and height of 2 * extent.
 *
 * @param {Object} params
 * @param {number} params.extent    Half-size of the cell
 * @param {number} params.column    Column index (0-based)
 * @param {number} params.row       Row index (0-based)
 * @param {Object=} params.offset   Optional offset applied to all coordinates
 * @param {number} params.offset.x  Horizontal offset
 * @param {number} params.offset.y  Vertical offset
 *
 * @returns {Object} Frozen object containing cell geometry and anchor points
 */
function gridCell({extents, column, row, offset}) {
    offset ??= {x: 0, y: 0};
    const topLeft = new Point(
        column * 2 * extents.x + offset.x,
        row * 2 * extents.y + offset.y
    );
    const center = new Point(topLeft.x + extents.x, topLeft.y + extents.y);
    const bottomRight = new Point(center.x + extents.x, center.y + extents.y);
    return Object.freeze({
        extents: Object.freeze({x: extents.x, y: extents.y}),
        width: extents.x * 2,
        height: extents.y * 2,

        topLeft,
        topCenter: new Point(center.x, topLeft.y),
        topRight: new Point(bottomRight.x, topLeft.y),

        centerLeft: new Point(topLeft.x, center.y),
        center,
        centerRight: new Point(bottomRight.x, center.y),

        bottomLeft: new Point(topLeft.x, bottomRight.y),
        bottomCenter: new Point(center.x, bottomRight.y),
        bottomRight,
    });
}

class CompassLayout {
    #cellExtent;
    #originOffset;
    #cell;
    #innerCells = Object.create(null);
    constructor(cellExtent) {
        this.#cellExtent = cellExtent;
        const extent = this.#cellExtent * 3;
        this.#originOffset = {x: -extent, y: -extent};
        this.#cell = gridCell({
            extents: toDimensions(extent),
            column: 0,
            row: 0,
            offset: this.#originOffset,
        });
    }
    #gridCell(column, row) {
        return gridCell({
            extents: toDimensions(this.#cellExtent),
            column,
            row,
            offset: this.#originOffset,
        });
    }

    get cell() { return this.#cell; }


    get northwest() { return this.#innerCells.northwest ??= this.#gridCell(0, 0); }
    get north() { return this.#innerCells.north ??= this.#gridCell(1, 0); }
    get northeast() { return this.#innerCells.northeast ??= this.#gridCell(2, 0); }

    get west() { return this.#innerCells.west ??= this.#gridCell(0, 1); }
    get origin() { return this.#innerCells.origin ??= this.#gridCell(1, 1); }
    get east() { return this.#innerCells.east ??= this.#gridCell(2, 1); }

    get southwest() { return this.#innerCells.southwest ??= this.#gridCell(0, 2); }
    get south() { return this.#innerCells.south ??= this.#gridCell(1, 2); }
    get southeast() { return this.#innerCells.southeast ??= this.#gridCell(2, 2); }
}


class Cross extends CompassLayout {
    #svg;
    #layeredSvgElement;
    constructor({svg, cellExtent}) {
        super(cellExtent);
        this.#svg = svg;
        const element = document.createElementNS(SVG_NS, 'polygon');
        element.setAttribute(
            "points",
            `${this.west.bottomRight} ` +
            `${this.west.bottomLeft} ` +
            `${this.west.topLeft} ` +
            `${this.north.bottomLeft} ` +
            `${this.north.topLeft} ` +
            `${this.north.topRight} ` +
            `${this.east.topLeft} ` +
            `${this.east.topRight} ` +
            `${this.east.bottomRight} ` +
            `${this.south.topRight} ` +
            `${this.south.bottomRight} ` +
            `${this.south.bottomLeft}`
        );
        this.#layeredSvgElement = new LayeredSvgElement({svg, element, cell: this.cell});
    }
    get element() { return this.#layeredSvgElement.element; }

    appendGroup({container, center, layers}) {
        return this.#layeredSvgElement.appendGroup({container, center, layers});
    }
}

class Shape {
    #svg;
    #cell;
    #layeredSvgElement;
    constructor({svg, extents, shapeType, corner_radius_percent}) {
        corner_radius_percent = toDimensions(corner_radius_percent ?? { x: 0, y: 0 });
        this.#svg = svg;
        extents = toDimensions(extents); // freeze?
        const originOffset = new Point(-extents.x, -extents.y);
        this.#cell = gridCell({extents: extents, column: 0, row: 0, offset: originOffset});

        let element;
        switch (shapeType) {
            case ShapeType.RECTANGLE:
                element = document.createElementNS(SVG_NS, 'rect');
                element.setAttribute('width', this.#cell.width);
                element.setAttribute('height', this.#cell.height);
                element.setAttribute('rx', this.#cell.extents.x * corner_radius_percent.x);
                element.setAttribute('ry', this.#cell.extents.y * corner_radius_percent.y);
                element.setAttribute('x', this.#cell.topLeft.x);
                element.setAttribute('y', this.#cell.topLeft.y);
                break;
            case ShapeType.ELLIPSE:
                element = document.createElementNS(SVG_NS, 'ellipse');
                element.setAttribute('rx', this.#cell.extents.x);
                element.setAttribute('ry', this.#cell.extents.y);
                element.setAttribute('cx', this.#cell.center.x);
                element.setAttribute('cy', this.#cell.center.y);
                break;
            case ShapeType.TRIANGLE_UP:
                element = document.createElementNS(SVG_NS, 'polygon');
                element.setAttribute(
                    "points",
                    `${this.#cell.topCenter} ` +
                    `${this.#cell.bottomLeft} ` +
                    `${this.#cell.bottomRight}`
                );
                break;
            case ShapeType.TRIANGLE_DOWN:
                element = document.createElementNS(SVG_NS, 'polygon');
                element.setAttribute(
                    "points",
                    `${this.#cell.bottomCenter} ` +
                    `${this.#cell.topLeft} ` +
                    `${this.#cell.topRight}`
                );
                break;
            case ShapeType.TRIANGLE_LEFT:
                element = document.createElementNS(SVG_NS, 'polygon');
                element.setAttribute(
                    "points",
                    `${this.#cell.centerLeft} ` +
                    `${this.#cell.topRight} ` +
                    `${this.#cell.bottomRight}`
                );
                break;
            case ShapeType.TRIANGLE_RIGHT:
                element = document.createElementNS(SVG_NS, 'polygon');
                element.setAttribute(
                    "points",
                    `${this.#cell.centerRight} ` +
                    `${this.#cell.topLeft} ` +
                    `${this.#cell.bottomLeft}`
                );
                break;
            default:
                throw new Error(`Unknown shape type: ${String(shapeType)}`);
        }
        this.#layeredSvgElement = new LayeredSvgElement({svg, element, cell: this.cell});
    }
    get element() { return this.#layeredSvgElement.element; }

    get cell() { return this.#cell; }

    appendGroup({container, center, layers}) {
        return this.#layeredSvgElement.appendGroup({container, center, layers});
    }
}

