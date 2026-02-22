const SVG_NS = 'http://www.w3.org/2000/svg';

const nextMonotonicId = new Map();
function monotonicId(prefix) {
    const n = nextMonotonicId.get(prefix) ?? 1;
    nextMonotonicId.set(prefix, n + 1);
    return `${prefix}${n}`;
}

function getIdPrefixedChild({target, prefix}) {
    return target.querySelector(`:scope > [id^="${prefix}-"]`);
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
function createSvgUse(id, attributes = {}) {
    return createSvgElement("use", {
        href: `#${id}`,
        ...attributes
    });
}

function setMask(element, id) {
    return setAttributes(element, {
        mask: id == null ? null : `url(#${id})`,
    });
}

function setTranslation(element, offset) {
    return setAttributes(element, {
        transform: (offset == null || Vector2.ZERO.equals(offset))
            ? null
            : `translate(${offset.x} ${offset.y})`,
    });
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
    equals(other) {
        return other instanceof Vector2
            && this.x == other.x
            && this.y == other.y;
    }

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
    scale(factor) {
        return this.update(Region.fromCenter({
            center: this.center,
            size: new Vector2({x: this.size.x * factor.x, y: this.size.y * factor.y}),
        }));
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
    static fromCenter({ buttonLength, buttonWidth, center }) {
        return new this({
            buttonLength,
            buttonWidth,
            topLeft: center.clone().subtract(
                Vector2.splat(buttonLength + buttonWidth / 2)
            ),
        });
    }
    // TODO: diagonal special buttons not handled; could return a cell
    // but would need to know a padding offset (at LEAST to allocate
    // for the cross borders + some spacing).  Centered most likely.
    #size;
    #buttonCentersRegion;
    #horizontalButtonSize;
    #verticalButtonSize;
    #cornerButtonSize;
    #originSize;
    #cache = Object.create(null);

    constructor({buttonLength, buttonWidth, topLeft}) {
        this.#size = Object.freeze(Vector2.splat(buttonLength * 2 + buttonWidth));
        // all points on this region will be the centers of inputs/buttons
        this.#buttonCentersRegion = new Region({
            topLeft: topLeft.clone().add(Vector2.splat(buttonLength / 2)),
            size: Vector2.splat(buttonWidth + buttonLength),
        });
        this.#horizontalButtonSize = new Vector2({x: buttonLength, y: buttonWidth});
        this.#verticalButtonSize = new Vector2({x: buttonWidth, y: buttonLength});
        this.#cornerButtonSize = Vector2.splat(buttonLength);
        this.#originSize = Vector2.splat(buttonWidth);
    }
    get size() { return this.#size; }
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
    get topLeft() {
        return this.#cache.topLeft ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.topLeft,
            size: this.#cornerButtonSize,
        }));
    }
    get bottomLeft() {
        return this.#cache.bottomLeft ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.bottomLeft,
            size: this.#cornerButtonSize,
        }));
    }
    get topRight() {
        return this.#cache.topRight ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.topRight,
            size: this.#cornerButtonSize,
        }));
    }
    get bottomRight() {
        return this.#cache.bottomRight ??= Object.freeze(Region.fromCenter({
            center: this.#buttonCentersRegion.bottomRight,
            size: this.#cornerButtonSize,
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
    get analogRegion() {
        return this.#cache.analogRegion ??= Object.freeze(Region.fromCenter({
            center: this.origin.center,
            size: Vector2.splat(Math.hypot(this.origin.size.x, this.origin.size.y)),
        }));
    }
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

    addMask(id) {
        const mask = createSvgElement("mask", {
            id,
            maskUnits: "userSpaceOnUse",
            maskContentUnits: "userSpaceOnUse",
            ...this.constructor.#MASK_SIZE_ATTRIBUTES,
        });
        mask.appendChild(createSvgUse(this.everythingRectId, {
            fill: "white",
        }));
        this.addDefinition(mask);
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

class GamepadEntity {
    #context;
    #element;
    #connectedElements;
    #mask;

    constructor({context, element, parent, layers=[{}], offset=Vector2.ZERO}) {
        // TODO: null validation?
        this.#context = context;
        this.#element = element;
        this.#connectedElements = [this.#element];
        this.setTranslation(offset);
        this.#context.addDefinition(this.#element);

        for (const layer of layers) {
            const useElement = createSvgUse(this.element.id);
            const classList = layer.classes == null ? [] : [].concat(layer.classes);
            for (const className of classList) {
                useElement.classList.add(className);
            }
            if (layer.id) {
                useElement.setAttribute("id", layer.id);
            }
            if (layer.cutout) {
                setMask(useElement, this.mask.id);
            }
            this.#context.addChild(useElement, {parent});
        }
    }
    connect(element) {
        this.#connectedElements.push(element);
        return this;
    }
    setTranslation(offset) {
        // update all transforms in one paint (no visible desync)
        requestAnimationFrame(() => {
            const transform = `translate(${offset.x} ${offset.y})`;
            for (const element of this.#connectedElements) {
                element.setAttribute("transform", transform);
            }
        });
        return this;
    }
    get element() {
        return this.#element;
    }
    get cutoutId() {  // cache?
        return `cutout-${this.element.id}`;
    }
    createMaskRect() {
        return createSvgUse(this.element.id, {
            fill: "black",
        });
    }

    get mask() {
        this.#mask ??= this.#context.queryChild(this.cutoutId);
        if (this.#mask == null) {
            this.#mask = this.#context.addMask(this.cutoutId);
            this.#mask.appendChild(this.createMaskRect());
        }
        return this.#mask;
    }
}


//function clampToUnitCircle(x, y) {
//    const len = Math.hypot(x, y);
//    if (len > 1) {
//        return { x: x / len, y: y / len };
//    }
//    return { x, y };
//}
