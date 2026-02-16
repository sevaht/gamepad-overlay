const SVG_NS = 'http://www.w3.org/2000/svg';

// TODO: allow users to give id prefixes instead of just using the tag name

const nextMonotonicId = new Map();
function monotonicId(prefix) {
    const n = nextMonotonicId.get(prefix) ?? 1;
    nextMonotonicId.set(prefix, n + 1);
    return `${prefix}${n}`;
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

function setAttributes(element, attributes = {}) {
    for (const [name, value] of Object.entries(attributes)) {
        if (value == null) {
            element.removeAttribute(name);
        } else {
            element.setAttribute(name, String(value));
        }
    }
    return element;
}
function createSvgElement(name, attributes = {}) {
    return setAttributes(document.createElementNS(SVG_NS, name), attributes);
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
    // common numbers
    static ZERO = Object.freeze(this.splat(0));
    static ONE = Object.freeze(this.splat(1));
    static TWO = Object.freeze(this.splat(2));

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
    static splat(value) {
        return new this({x: value, y: value});
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

    get x() { return this.#x; }
    get y() { return this.#y; }

    clone() { return new this.constructor(this); }
    toString() { return `${this.x},${this.y}`; }
    toObject() { return {x: this.x, y: this.y}; }

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

class Region {
    static fromCenter({ center, size }) {
        const topLeft = center.clone().subtract(size.clone().divide(Vector2.TWO));
        return new this({topLeft, size});
    }
    #topLeft;
    #size;
    #cache = Object.create(null);
    constructor({ topLeft, size }) {
        // using these directly to prevent unnecessary cach clear from set()
        this.#setTopLeft(topLeft);
        this.#setSize(size);
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
            Object.freeze(this.#size.clone().divide(Vector2.TWO));
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

const ShapeType = Object.freeze({
    RECTANGLE: Symbol("RECTANGLE"),
    ELLIPSE: Symbol("ELLIPSE"),
    TRIANGLE_UP: Symbol("TRIANGLE_UP"),
    TRIANGLE_DOWN: Symbol("TRIANGLE_DOWN"),
    TRIANGLE_LEFT: Symbol("TRIANGLE_LEFT"),
    TRIANGLE_RIGHT: Symbol("TRIANGLE_RIGHT"),
});

function createSvgPolygon(points, attributes = {}) {
    return createSvgElement("polygon", {
        points: Array.isArray(points) ? points.map(String).join(" ") : String(points),
        ...attributes,
    });
}
function createSvgShape({region, shapeType, cornerRadiusPercent = Vector2.ZERO}, attributes = {}) {
    let element;
    switch (shapeType) {
        case ShapeType.RECTANGLE:
            element = createSvgElement("rect", {
                x: region.topLeft.x,
                y: region.topLeft.y,
                width: region.size.x,
                height: region.size.y,
                rx: region.halfSize.x * cornerRadiusPercent.x,
                ry: region.halfSize.y * cornerRadiusPercent.y,
            });
            break;
        case ShapeType.ELLIPSE:
            element = createSvgElement("ellipse", {
                cx: region.center.x,
                cy: region.center.y,
                rx: region.halfSize.x,
                ry: region.halfSize.y,
            });
            break;
        case ShapeType.TRIANGLE_UP:
            element = createSvgElement("polygon", {
                points: 
                    `${region.topCenter} ` +
                    `${region.bottomLeft} ` +
                    `${region.bottomRight} `,
            });
            break;
        case ShapeType.TRIANGLE_DOWN:
            element = createSvgElement("polygon", {
                points: 
                    `${region.bottomCenter} ` +
                    `${region.topLeft} ` +
                    `${region.topRight} `,
            });
            break;
        case ShapeType.TRIANGLE_LEFT:
            element = createSvgElement("polygon", {
                points: 
                    `${region.centerLeft} ` +
                    `${region.topRight} ` +
                    `${region.bottomRight} `,
            });
            break;
        case ShapeType.TRIANGLE_RIGHT:
            element = createSvgElement("polygon", {
                points: 
                    `${region.centerRight} ` +
                    `${region.topLeft} ` +
                    `${region.bottomLeft} `,
            });
            break;
        default:
            throw new Error(`Unknown shape type: ${String(shapeType)}`);
    }
    return setAttributes(element, attributes);
}

class DpadLayout {
    // TODO: diagonal special buttons not handled; could return a cell
    // but would need to know a padding offset (at LEAST to allocate
    // for the cross borders + some spacing).  Centered most likely.
    #buttonCentersRegion;
    #horizontalButtonSize;
    #verticalButtonSize;
    #originSize;
    #cache = Object.create(null);
    constructor({buttonLength, buttonWidth, center}) {
        const halfButtonLength = buttonLength / 2;
        const halfButtonWidth = buttonWidth / 2;
        const diagonalCenterOffset = Object.freeze(
            Vector2.splat(halfButtonWidth + halfButtonLength)
        );
        // all of the points on this cell will correlate to the centers of the
        // inputs/buttons
        this.#buttonCentersRegion = new Region({
            topLeft: center.clone().subtract(diagonalCenterOffset),
            size: diagonalCenterOffset.clone().multiply(Vector2.TWO),
        });
        this.#horizontalButtonSize = new Vector2({x: buttonLength, y: buttonWidth});
        this.#verticalButtonSize = new Vector2({x: buttonWidth, y: buttonLength});
        this.#originSize = Vector2.splat(buttonWidth);
    }
    get origin() {
        return this.#cache.origin ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.center,
            size: this.#originSize,
        }));
    }
    get left() {
        return this.#cache.left ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.centerLeft,
            size: this.#horizontalButtonSize,
        }));
    }
    get right() {
        return this.#cache.right ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.centerRight,
            size: this.#horizontalButtonSize,
        }));
    }
    get up() {
        return this.#cache.up ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.topCenter,
            size: this.#verticalButtonSize,
        }));
    }
    get down() {
        return this.#cache.down ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.bottomCenter,
            size: this.#verticalButtonSize,
        }));
    }
    get crossPoints() {  // TODO: rename?
        return this.#cache.crossPoints ??= Object.freeze([
            this.left.bottomRight,
            this.left.bottomLeft,
            this.left.topLeft,
            this.up.bottomLeft,
            this.up.topLeft,
            this.up.topRight,
            this.right.topLeft,
            this.right.topRight,
            this.right.bottomRight,
            this.down.topRight,
            this.down.bottomRight,
            this.down.bottomLeft,
        ]);
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

class SvgContext {
    #svg;
    #defs;
    #everythingRectId;
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

    addChild(element, {parent, prepend=false} = {}) {
        if (parent == null) {
            parent = this.#svg;
        } else if (!this.hasAncestor(parent)) {
            throw new Error("Passed parent is not a child of the svg given in the constructor.");
        }
        if (prepend) {
            parent.insertBefore(element, parent.firstChild);
        } else {
            parent.appendChild(element);
        }
        return element;
    }

    get everythingRectId() {
        return this.#everythingRectId ??= (
            this.resolvePrefixedChildId("everything-") ?? this.addDefinition(
                createSvgElement("rect", {
                    id: monotonicId("everything-"),
                    ...this.constructor.#MASK_SIZE_ATTRIBUTES,
                }),
                { prepend: true },
            ).id
        );
    }

    constructor(svg) {
        this.#svg = svg;
        this.#defs = this.#svg.querySelector("defs") ?? this.addChild(
            createSvgElement("defs"),
            {prepend: true}
        );
    }
    get svg() { return this.#svg; }
    get defs() { return this.#defs; }

    hasAncestor(element) {
        return this.#svg.contains(element);
    }

    queryChild(idOrPrefix, { prefix = false } = {}) {
        if (idOrPrefix == null) { return null; }
        const escaped = CSS.escape(String(idOrPrefix));
        return this.#svg.querySelector(prefix ? `[id^="${escaped}"]` : `#${escaped}`);
    }

    resolvePrefixedChildId(prefix) {
        return this.queryChild(prefix, {prefix: true})?.id || null;
    }

    addDefinition(element, {prepend = false} = {}) {
        element.id ||= monotonicId(`${element.tagName}-`);
        this.addChild(element, {parent: this.#defs, prepend});
        return element;
    }

    // NOTE: this DOES NOT add any removal ref!  doesn't change id with "cutout" prefix!
    ensureMask(id) {
        let mask = this.queryChild(id);
        if (mask == null) {
            mask = createSvgElement("mask", {
                id,
                maskUnits: "userSpaceOnUse",
                maskContentUnits: "userSpaceOnUse",
                ...this.constructor.#MASK_SIZE_ATTRIBUTES,
            });
            mask.appendChild(createSvgElement("use", {
                href: `#${this.#everythingRectId}`,
                fill: "white",
            }));
            this.addDefinition(mask);
        }
        return mask;
    }

    // TODO: masks? use refs?
    // the general principle will be that a given mask maps to a specific
    // def, and any updates need to be made on that definition.
    // ... so masks will just be two uses; everything rect + target
    // and each target will be moved, but as only a single mask can apply
    // to something I may need a mechanism to combine masks/append to them.



    // equivalent to appendEntity, or implement that some other way?
}



// creates/uses defs and a mask of everything
/*
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
*/


