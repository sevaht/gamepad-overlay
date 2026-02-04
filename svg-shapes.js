const SVG_NS = 'http://www.w3.org/2000/svg';

// TODO: allow users to give id prefixes instead of just using the tag name

const nextMonotonicId = new Map();
function monotonicId(prefix) {
    const n = nextMonotonicId.get(prefix) ?? 1;
    nextMonotonicId.set(prefix, n + 1);
    return `${prefix}-${n}`;
}

function getIdPrefixedChild({target, prefix}) {
    return target.querySelector(`:scope > [id^="${prefix}-"]`);
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

function setAttributes(element, attributes) {
    for (const [name, value] of Object.entries(attributes)) {
        if (value == null) {
            element.removeAttribute(name);
        } else {
            element.setAttribute(name, String(value));
        }
    }
    return element;
}
///////////////////////////////////////////////
const OVERLAY_ASSERTION_ENABLE = true; // flip to false for production

function requireFiniteNumber(value, name) {
    if (Number.isFinite(value)) {
        return value;
    }
    const type = typeof value;
    const got = value?.constructor?.name ?? type;
    if (type !== "number") {
        throw new TypeError(`${name} must be a number; got ${got}`);
    }
    throw new RangeError(`${name} must be a finite number; got ${value}`);
}
function assertFiniteNumber(value, name) {
    if (!OVERLAY_ASSERTION_ENABLE) {
        return value;
    }
    return requireFiniteNumber(value, name);
}

function requireInstanceOf(value, ctor, name) {
    if (value instanceof ctor) {
        return value;
    }
    const got = value?.constructor?.name ?? typeof value;
    throw new TypeError(`${name} must be an instance of ${ctor.name}; got ${got}`);
}
function assertInstanceOf(value, ctor, name) {
    if (!OVERLAY_ASSERTION_ENABLE) {
        return value;
    }
    return requireInstanceOf(value, ctor, name);
}


function unreachable(message = "Unreachable") {
    const error = new Error(message);
    error.name = "AssertionError";
    throw error;
}

class Vector2 {
    static ZERO = Object.freeze(new this({x: 0, y: 0}));

    static #ADD = 0;
    static #SUBTRACT = 1;
    static #MULTIPLY = 2;
    static #DIVIDE = 3;

    static require(value, name) {
        return requireInstanceOf(value, this, name);
    }

    static assert(value, name) {
        return assertInstanceOf(value, this, name);
    }

    #x;
    #y;
    constructor({ x, y } = {}) {
        this.set({x, y});
    }
    set x(value) { this.#x = assertFiniteNumber(value, "x"); }
    set y(value) { this.#y = assertFiniteNumber(value, "y"); }
    set({ x, y } = {}) {
        this.x = x;
        this.y = y;
        return this;
    }
    update({ x, y } = {}) {
        if (x != null) { this.x = x; }
        if (y != null) { this.y = y; }
        return this;
    }
    add({ x, y } = {}) {
        this.#applyComponent(Vector2.#ADD, true, x, 0);
        this.#applyComponent(Vector2.#ADD, false, y, 0);
        return this;
    }
    subtract({ x, y } = {}) {
        this.#applyComponent(Vector2.#SUBTRACT, true, x, 0);
        this.#applyComponent(Vector2.#SUBTRACT, false, y, 0);
        return this;
    }
    multiply({ x, y } = {}) {
        this.#applyComponent(Vector2.#MULTIPLY, true, x, 1);
        this.#applyComponent(Vector2.#MULTIPLY, false, y, 1);
        return this;
    }
    divide({ x, y } = {}) {
        this.#applyComponent(Vector2.#DIVIDE, true, x, 1);
        this.#applyComponent(Vector2.#DIVIDE, false, y, 1);
        return this;
    }
    half() { return this.divide({ x: 2, y: 2 }); }

    get x() { return this.#x; }
    get y() { return this.#y; }

    clone() { return new this.constructor(this); }
    toString() { return `${this.x},${this.y}`; }

    #applyComponent(operation, isX, operand, skipValue) {
        if (operand == null || operand === skipValue) { return; }
        const name = isX ? "x" : "y";
        assertFiniteNumber(operand, name);
        let result = isX ? this.#x : this.#y;
        switch (operation) {
            case Vector2.#ADD:
                result += operand;
                break;
            case Vector2.#SUBTRACT:
                result -= operand;
                break;
            case Vector2.#MULTIPLY:
                result *= operand;
                break;
            case Vector2.#DIVIDE:
                if (operand === 0) { throw new RangeError(`${name} divisor must not be 0`); }
                result /= operand;
                break;
            default:
                unreachable("Invalid operation");
        }
        assertFiniteNumber(result, name);
        if (isX) { this.#x = result; }
        else { this.#y = result; }
    }
}

class Cell {
    #topLeft;
    #size;
    #cache;
    constructor({ topLeft, size }) {
        this.set({topLeft, size});
    }
    set topLeft(value) {
        this.#setTopLeft(value);
        this.#clearCache();
    }
    set size(value) {
        this.#setSize(value);
        this.#clearCache();
    }
    set({ topLeft, size }) {
        this.#setTopLeft(topLeft);
        this.#setSize(size);
        this.#clearCache();
        return this;
    }
    update({ topLeft, size } = {}) {
        let changed = false;
        if (topLeft != null) { this.#setTopLeft(topLeft); changed=true; }
        if (size != null) { this.#setSize(size); changed=true; }
        if (changed) {
            this.#clearCache();
        }
        return this;
    }
    get topLeft() { return this.#topLeft; }
    get size() { return this.#size; }
    get halfSize() {
        return this.#cache.halfSize ??=
            Object.freeze(this.#size.clone().half());
    }
    get topCenter() {
        return this.#cache.topCenter ??=
            Object.freeze(this.#topLeft.clone().add({x: this.halfSize.x}));
    }
    get topRight() {
        return this.#cache.topRight ??=
            Object.freeze(this.#topLeft.clone().add({x: this.#size.x}));
    }
    get centerLeft() {
        return this.#cache.centerLeft ??=
            Object.freeze(this.#topLeft.clone().add({y: this.halfSize.y}));
    }
    get center() {
        return this.#cache.center ??=
            Object.freeze(this.#topLeft.clone().add(this.halfSize));
    }
    get centerRight() {
        return this.#cache.centerRight ??=
            Object.freeze(this.#topLeft.clone().add({x: this.#size.x, y: this.halfSize.y}));
    }
    get bottomLeft() {
        return this.#cache.bottomLeft ??=
            Object.freeze(this.#topLeft.clone().add({y: this.#size.y}));
    }
    get bottomCenter() {
        return this.#cache.bottomCenter ??=
            Object.freeze(this.#topLeft.clone().add({x: this.halfSize.x, y: this.#size.y}));
    }
    get bottomRight() {
        return this.#cache.bottomRight ??=
            Object.freeze(this.#topLeft.clone().add(this.#size));
    }

    clone() { return new this.constructor(this); }
    toString() { return `${this.topLeft} ${this.size.x}x${this.size.y}`; }

    #clearCache() {
        this.#cache = Object.create(null);
    }
    #setTopLeft(topLeft) {
        this.#topLeft = Object.freeze(Vector2.assert(topLeft, "topLeft").clone());
    }
    #setSize(size) {
        this.#size = Object.freeze(Vector2.assert(size, "size").clone());
    }
}

// TODO: refactor/complete (it isn't even done!) to use Vector2 and Cell
class DpadLayout {
    #cellLength;
    #cellWidth;
    #centerPadding;
    constructor({cellLength, cellWidth, centerPadding, center}) {
        center ??= {x: 0, y: 0};
        this.#cellLength = cellLength;
        this.#cellWidth = cellWidth;
        this.#centerPadding = centerPadding;

        const halfWidth = this.#cellWidth / 2;
        const insideEdge = halfWidth + this.#centerPadding;
        const outerEdge = insideEdge + this.#cellLength;

        this.#cells = {
            west: new Cell({
                x: center.x - outerEdge,
                y: center.y - halfWidth,
                width: this.#cellLength,
                height: this.#cellWidth,
            }),
            north: new Cell({
                x: center.x - halfWidth,
                y: center.y - outerEdge,
                width: this.#cellWidth,
                height: this.#cellLength,
            }),
            east: new Cell({
                x: center.x + insideEdge,
                y: center.y - halfWidth,
                width: this.#cellLength,
                height: this.#cellWidth,
            }),
            south: new Cell({
                x: center.x - halfWidth,
                y: center.y + insideEdge,
                width: this.#cellWidth,
                height: this.#cellLength,
            })
        }
        // TODO: center cell?  circle radius?



        

        


    }

}

function createUseElement(id, attributes) {
    const element = document.createElementNS(SVG_NS, "use");
    element.setAttribute("href", `#${id}`);
    if (attributes != null) {
        setAttributes(element, attributes);
    }
    return element;
}

class SvgEntity {
    #container;
    #group;
    //#center;
    #maskId;
    #id;
    constructor({container, group, maskId, id}) {  // center?
        this.#container = container;
        this.#group = group;
        this.#maskId = maskId;
        this.#id = id;
    }
    get container() { return this.#container; }
    get group() { return this.#group; }
    get maskId() { return this.#maskId; }
    get id() { return this.#id; }
}

// creates/uses defs and a mask of everything
class SvgContext {
    #svg;
    #defs;
    #everythingRectId;
    #maskSizeAttributes;

    static #MASK_SIZE_ATTRIBUTES = (() => {
        // NOTE: this needs to be large enough to cover anything in the
        // coordinate systems of rendered objects.  Just picking a large
        // value, but in my testing 30_000_000 works, but 40_000_000
        // fails due to rendering engine limits.  This should be safe.
        const HALF = 100_000;
        const FULL = HALF * 2;
        return Object.freeze({
            x: -HALF,
            y: -HALF,
            width: FULL,
            height: FULL,
        });
    })();
    constructor(svg) {
        this.#svg = svg;
        this.#defs = this.#svg.querySelector("defs");
        if (!this.#defs) {
            this.#defs = document.createElementNS(SVG_NS, "defs");
            this.#svg.insertBefore(this.#defs, this.#svg.firstChild);
        }
        let prefix = "everything";
        let everythingRect = getIdPrefixedChild({target: this.#defs, prefix});
        if (!everythingRect) {
            // NOTE: this needs to be large enough to cover anything in the
            // coordinate systems of rendered objects.  Just picking a large
            // value, but in my testing 30_000_000 works, but 40_000_000
            // fails due to rendering engine limits.  This should be safe.
            const HALF_MAX = 100_000;
            const FULL_MAX = HALF_MAX*2;
            everythingRect = setAttributes(document.createElementNS(SVG_NS, "rect"), {
                id: monotonicId("everything"),
                ...this.constructor.#MASK_SIZE_ATTRIBUTES,
            });
            this.#defs.insertBefore(everythingRect, this.#defs.firstChild);
        }
        this.#everythingRectId = everythingRect.getAttribute("id");
    }
    get svg() { return this.#svg; }
    get defs() { return this.#defs; }

    hasAncestor(element) {
        return this.#svg.contains(element);
    }

    ensureMask(id) {
        const maskId = `cutout-${id}`;
        let mask = this.#defs.querySelector(`:scope > #${maskId}`);
        if (mask == null) {
            mask = setAttributes(document.createElementNS(SVG_NS, 'mask'), {
                id: maskId,
                maskUnits: "userSpaceOnUse",
                maskContentUnits: "userSpaceOnUse",
                ...this.constructor.#MASK_SIZE_ATTRIBUTES,
            });
            mask.appendChild(setAttributes(document.createElementNS(SVG_NS, 'use'), {
                href: `#${this.#everythingRectId}`,
                fill: "white",
            }));
            mask.appendChild(createUseElement(id, {fill: "black"}));
            this.#defs.appendChild(mask);
        }
        return maskId;
    }

    registerDefinition(element) {
        let id = element.getAttribute("id");
        if (!id) {
            id = monotonicId(element.tagName);
            element.setAttribute("id", id);
        }
        this.#defs.appendChild(element);
        return id;
    }

    appendEntity({id, center, layers, target}) {
        layers ??= [{}];
        if (target == null) {
            target = this.#svg;
        } else if (!this.hasAncestor(target)) {
            throw new Error("Passed target is not a child of the svg given in the constructor.");
        }
        const container = setAttributes(document.createElementNS(SVG_NS, "g"), {
            "transform": `translate(${center.x} ${center.y})`
        });
        const group = document.createElementNS(SVG_NS, "g");
        container.appendChild(group);

        const baseUseElement = createUseElement(id);
        let maskId;
        for (const layer of layers) {
            const useElement = baseUseElement.cloneNode(false);
            for (const className of toClassList(layer.classes)) {
                useElement.classList.add(className);
            }
            if (layer.id) {
                useElement.setAttribute("id", layer.id);
            }
            if (layer.cutout) {
                maskId = this.ensureMask(id);
                useElement.setAttribute("mask", `url(#${maskId})`);
            }
            group.appendChild(useElement);
        }
        target.appendChild(container);

        return new SvgEntity({container, group, maskId, id}); // center?
    }
};


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
    #context;
    #definition;
    #id;
    constructor({context, cellExtent}) {
        super(cellExtent);
        this.#context = context;
        this.#definition = setAttributes(document.createElementNS(SVG_NS, 'polygon'), {
            "points":
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
                `${this.south.bottomLeft}`,
        });
        this.#id = this.#context.registerDefinition(this.#definition);
    }
    get definition() { return this.#definition; }

    appendEntity({center, layers, target}) {
        return this.#context.appendEntity({id: this.#id, center, layers, target});
    }
}



const ShapeType = Object.freeze({
    RECTANGLE: Symbol("RECTANGLE"),
    ELLIPSE: Symbol("ELLIPSE"),
    TRIANGLE_UP: Symbol("TRIANGLE_UP"),
    TRIANGLE_DOWN: Symbol("TRIANGLE_DOWN"),
    TRIANGLE_LEFT: Symbol("TRIANGLE_LEFT"),
    TRIANGLE_RIGHT: Symbol("TRIANGLE_RIGHT"),
});
class Shape {
    #context;
    #definition;
    #id;
    #cell;
    constructor({context, extents, shapeType, corner_radius_percent}) {
        corner_radius_percent = toDimensions(corner_radius_percent ?? { x: 0, y: 0 }); // ?
        this.#context = context;
        extents = toDimensions(extents); // freeze?
        const originOffset = new Point(-extents.x, -extents.y);
        this.#cell = gridCell({extents: extents, column: 0, row: 0, offset: originOffset});

        switch (shapeType) {
            case ShapeType.RECTANGLE:
                this.#definition = setAttributes(document.createElementNS(SVG_NS, 'rect'), {
                    width: this.#cell.width,
                    height: this.#cell.height,
                    rx: this.#cell.extents.x * corner_radius_percent.x,
                    ry: this.#cell.extents.y * corner_radius_percent.y,
                    x: this.#cell.topLeft.x,
                    y: this.#cell.topLeft.y,
                });
                break;
            case ShapeType.ELLIPSE:
                this.#definition = setAttributes(document.createElementNS(SVG_NS, 'ellipse'), {
                    rx: this.#cell.extents.x,
                    ry: this.#cell.extents.y,
                    cx: this.#cell.center.x,
                    cy: this.#cell.center.y,
                });
                break;
            case ShapeType.TRIANGLE_UP:
                this.#definition = setAttributes(document.createElementNS(SVG_NS, 'polygon'), {
                    points:
                        `${this.#cell.topCenter} ` +
                        `${this.#cell.bottomLeft} ` +
                        `${this.#cell.bottomRight}`,
                });
                break;
            case ShapeType.TRIANGLE_DOWN:
                this.#definition = setAttributes(document.createElementNS(SVG_NS, 'polygon'), {
                    points:
                        `${this.#cell.bottomCenter} ` +
                        `${this.#cell.topLeft} ` +
                        `${this.#cell.topRight}`,
                });
                break;
            case ShapeType.TRIANGLE_LEFT:
                this.#definition = setAttributes(document.createElementNS(SVG_NS, 'polygon'), {
                    points:
                        `${this.#cell.centerLeft} ` +
                        `${this.#cell.topRight} ` +
                        `${this.#cell.bottomRight}`,
                });
                break;
            case ShapeType.TRIANGLE_RIGHT:
                this.#definition = setAttributes(document.createElementNS(SVG_NS, 'polygon'), {
                    points:
                        `${this.#cell.centerRight} ` +
                        `${this.#cell.topLeft} ` +
                        `${this.#cell.bottomLeft}`,
                });
                break;
            default:
                throw new Error(`Unknown shape type: ${String(shapeType)}`);
        }
        this.#id = this.#context.registerDefinition(this.#definition);
    }
    get definition() { return this.#definition; }

    get cell() { return this.#cell; }

    appendEntity({center, layers, target}) {
        return this.#context.appendEntity({id: this.#id, center, layers, target});
    }
}

