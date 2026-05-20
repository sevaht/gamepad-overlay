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
            if (element.hasAttribute(name)) {
                element.removeAttribute(name);
            }
        } else {
            const nextValue = String(value);
            if (element.getAttribute(name) !== nextValue) {
                element.setAttribute(name, nextValue);
            }
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

function clampNormalizedOffsetToEllipse({offset, halfSize}) {
    const x = assertFiniteNumber(offset.x, "offset.x");
    const y = assertFiniteNumber(offset.y, "offset.y");
    const halfWidth = Math.max(0, assertFiniteNumber(halfSize.x, "halfSize.x"));
    const halfHeight = Math.max(0, assertFiniteNumber(halfSize.y, "halfSize.y"));
    if (halfWidth === 0 || halfHeight === 0) {
        return Vector2.ZERO;
    }

    const scaledX = x;
    const scaledY = y;
    const unitDistance = (scaledX * scaledX) + (scaledY * scaledY);
    if (unitDistance <= 1) {
        return new Vector2({x: x * halfWidth, y: y * halfHeight});
    }
    const scale = 1 / Math.sqrt(unitDistance);
    return new Vector2({
        x: x * scale * halfWidth,
        y: y * scale * halfHeight,
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
    static THREE = Object.freeze(this.splat(3));

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

const PressFillDirection = Object.freeze({
    DOWN: Symbol("DOWN"),
    UP: Symbol("UP"),
    RIGHT: Symbol("RIGHT"),
    LEFT: Symbol("LEFT"),
    OUTWARD: Symbol("OUTWARD"),
});

function createSvgPolygon(points, attributes = {}) {
    return createSvgElement("polygon", {
        points: Array.isArray(points) ? points.map(String).join(" ") : String(points),
        ...attributes,
    });
}

const SHAPE_SNAP_STEP = 0.5;

function snapNumberToStep(value, step = SHAPE_SNAP_STEP) {
    if (!Number.isFinite(value) || step <= 0) {
        return value;
    }
    return Math.round(value / step) * step;
}

function snapRegionToStep(region, step = SHAPE_SNAP_STEP) {
    return new Region({
        topLeft: new Vector2({
            x: snapNumberToStep(region.topLeft.x, step),
            y: snapNumberToStep(region.topLeft.y, step),
        }),
        size: new Vector2({
            x: Math.max(step, snapNumberToStep(region.size.x, step)),
            y: Math.max(step, snapNumberToStep(region.size.y, step)),
        }),
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
    #topLeft;
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
    #connectionTransforms;
    #translation;
    #mask;
    #layerParent;
    #pressVisual;
    #pressFillDirection;
    #styleSourceElement;
    #layerElements;
    #pressMode;
    #digitalThreshold;
    #digitalRenderMode;
    #transformFramePending;
    #pressedClassName;
    #isPressed;
    #themeVariables;
    #cutoutMasksBySourceId;
    #pressVisualSourceId;
    #primaryCutoutSourceId;
    #styleSourceMaskId;
    #classToggleFramePending;
    #pendingClassTogglePressed;

    constructor({context, element, parent, layers=[{}], offset=Vector2.ZERO, themeVariables = {}, pressVisualSourceId = null}) {
        // TODO: null validation?
        this.#context = context;
        this.#element = element;
        this.#connectedElements = [this.#element];
        this.#connectionTransforms = new WeakMap();
        this.#translation = Vector2.ZERO;
        this.#layerParent = parent;
        this.#pressVisual = null;
        this.#pressFillDirection = PressFillDirection.OUTWARD;
        this.#styleSourceElement = null;
        this.#layerElements = [];
        this.#pressMode = "digital";
        this.#digitalThreshold = 0.5;
        this.#transformFramePending = false;
        this.#digitalRenderMode = "fill";
        this.#pressedClassName = "is-pressed";
        this.#isPressed = false;
        this.#themeVariables = {...themeVariables};
        this.#cutoutMasksBySourceId = new Map();
        this.#pressVisualSourceId = pressVisualSourceId ?? this.element.id;
        this.#primaryCutoutSourceId = this.element.id;
        this.#styleSourceMaskId = null;
        this.#classToggleFramePending = false;
        this.#pendingClassTogglePressed = null;
        this.setTranslation(offset);
        this.#context.addDefinition(this.#element);
        const connectedSourceIds = new Set([this.element.id]);

        for (const layer of layers) {
            const sourceId = layer.sourceId ?? this.element.id;
            const useElement = createSvgUse(sourceId);
            const classList = layer.classes == null ? [] : [].concat(layer.classes);
            for (const className of classList) {
                useElement.classList.add(className);
            }
            if (layer.id) {
                useElement.setAttribute("id", layer.id);
            }
            if (layer.attributes) {
                setAttributes(useElement, layer.attributes);
            }
            if (layer.cutout) {
                const cutoutSourceId = layer.cutoutSourceId ?? this.element.id;
                this.#primaryCutoutSourceId = cutoutSourceId;
                // cutoutSourceId is a mask-only definition source. It may be
                // distinct from the rendered sourceId and must move with this
                // entity when translations are applied.
                setMask(useElement, this.getMaskIdForSource(cutoutSourceId));
                if (!connectedSourceIds.has(cutoutSourceId)) {
                    const cutoutSourceElement = this.#context.queryChild(cutoutSourceId);
                    if (cutoutSourceElement != null) {
                        connectedSourceIds.add(cutoutSourceId);
                        this.#connectedElements.push(cutoutSourceElement);
                        this.#connectionTransforms.set(cutoutSourceElement, {extraTransform: null, includeTranslation: true});
                    }
                }
            }
            this.#context.addChild(useElement, {parent});
            this.#layerElements.push(useElement);
            if (!connectedSourceIds.has(sourceId)) {
                const sourceElement = this.#context.queryChild(sourceId);
                if (sourceElement != null) {
                    connectedSourceIds.add(sourceId);
                    this.#connectedElements.push(sourceElement);
                    this.#connectionTransforms.set(sourceElement, {extraTransform: null, includeTranslation: true});
                }
            }
            if (layer.styleSource) {
                this.#styleSourceElement = useElement;
                this.#applyThemeVariablesToElement(this.#styleSourceElement);
            }
        }
    }
    enablePressVisual({
        className = "gamepad-button-pressed-fill",
        fillDirection = this.#pressFillDirection,
        prepend = false,
    } = {}) {
        if (this.#pressVisual != null) {
            return this;
        }
        this.#resolvePressFillAttributes(0.5, fillDirection);
        this.#pressFillDirection = fillDirection;

        const useElement = createSvgUse(this.#pressVisualSourceId);
        useElement.classList.add(className);
        if (this.#styleSourceElement != null) {
            for (const sourceClass of this.#styleSourceElement.classList) {
                if (sourceClass !== "gamepad-button" && sourceClass !== "gamepad-button-bordered") {
                    useElement.classList.add(sourceClass);
                }
            }
            const side = this.#styleSourceElement.getAttribute("data-side");
            const role = this.#styleSourceElement.getAttribute("data-role");
            if (side != null) { useElement.setAttribute("data-side", side); }
            if (role != null) { useElement.setAttribute("data-role", role); }

        }
        this.#applyThemeVariablesToElement(useElement);
        if (this.#styleSourceMaskId != null) {
            setMask(useElement, this.#styleSourceMaskId);
        }
        this.#context.addChild(useElement, {parent: this.#layerParent, prepend});

        if (fillDirection === PressFillDirection.OUTWARD) {
            this.connect(useElement, {
                extraTransform: () => this.#resolveOutwardTransform(this.#pressVisual?.amount ?? 0),
                includeTranslation: false,
            });
            this.#pressVisual = {
                mode: "outward",
                amount: 0,
            };
        } else {
            const clipPath = createSvgElement("clipPath", {
                id: monotonicId(`press-clip-${this.element.id}-`),
                clipPathUnits: "objectBoundingBox",
            });
            const clipRect = createSvgElement("rect", {
                x: 0,
                y: 0,
                width: 1,
                height: 0,
            });
            clipPath.appendChild(clipRect);
            this.#context.addDefinition(clipPath);
            setAttributes(useElement, {
                "clip-path": `url(#${clipPath.id})`,
            });
            this.#pressVisual = {
                mode: "directional",
                clipRect,
                amount: 0,
                fillDirection,
            };
        }

        this.#applyTransforms();
        return this;
    }
    setPressAmount(amount) {
        this.enablePressVisual();
        amount = Math.max(0, Math.min(1, assertFiniteNumber(amount, "amount")));
        if (amount === this.#pressVisual.amount) {
            return this;
        }
        this.#pressVisual.amount = amount;
        if (this.#pressVisual.mode === "outward") {
            this.#applyTransforms();
        } else {
            const attributes = this.#resolvePressFillAttributes(amount, this.#pressVisual.fillDirection);
            setAttributes(this.#pressVisual.clipRect, attributes);
        }
        return this;
    }
    setPressFillDirection(fillDirection) {
        if (this.#pressVisual != null) {
            throw new Error("setPressFillDirection must be called before setPressAmount/enablePressVisual");
        }
        this.#resolvePressFillAttributes(0.5, fillDirection);
        this.#pressFillDirection = fillDirection;
        return this;
    }
    setPressBehavior({
        mode = this.#pressMode,
        threshold = this.#digitalThreshold,
        digitalRenderMode = this.#digitalRenderMode,
        pressedClassName = this.#pressedClassName,
    } = {}) {
        if (mode !== "analog" && mode !== "digital") {
            throw new Error(`Unknown press mode: ${String(mode)}`);
        }
        if (digitalRenderMode !== "fill" && digitalRenderMode !== "class-toggle") {
            throw new Error(`Unknown digital render mode: ${String(digitalRenderMode)}`);
        }
        this.#pressMode = mode;
        this.#digitalThreshold = Math.max(0, Math.min(1, assertFiniteNumber(threshold, "threshold")));
        this.#digitalRenderMode = digitalRenderMode;
        this.#pressedClassName = String(pressedClassName || "is-pressed");
        return this;
    }
    setInputAmount(rawAmount) {
        const amount = Math.max(0, Math.min(1, assertFiniteNumber(rawAmount, "rawAmount")));
        if (this.#pressMode === "analog") {
            return this.setPressAmount(amount);
        }
        const isPressed = amount >= this.#digitalThreshold;
        if (this.#digitalRenderMode === "class-toggle") {
            if (this.#isPressed === isPressed) {
                return this;
            }
            this.#pendingClassTogglePressed = isPressed;
            if (!this.#classToggleFramePending) {
                this.#classToggleFramePending = true;
                requestAnimationFrame(() => {
                    this.#classToggleFramePending = false;
                    if (this.#pendingClassTogglePressed == null) {
                        return;
                    }
                    this.#isPressed = this.#pendingClassTogglePressed;
                    this.#pendingClassTogglePressed = null;
                    this.#styleSourceElement?.classList.toggle(this.#pressedClassName, this.#isPressed);
                });
            }
            return this;
        }
        return this.setPressAmount(isPressed ? 1 : 0);
    }
    bringLayersToFront() {
        for (const element of this.#layerElements) {
            element.parentNode?.appendChild(element);
        }
        return this;
    }

    #resolvePressFillAttributes(amount, fillDirection) {
        switch (fillDirection) {
            case PressFillDirection.DOWN:
                return {x: 0, y: 0, width: 1, height: amount};
            case PressFillDirection.UP:
                return {x: 0, y: 1 - amount, width: 1, height: amount};
            case PressFillDirection.RIGHT:
                return {x: 0, y: 0, width: amount, height: 1};
            case PressFillDirection.LEFT:
                return {x: 1 - amount, y: 0, width: amount, height: 1};
            case PressFillDirection.OUTWARD: {
                const half = amount / 2;
                return {
                    x: 0.5 - half,
                    y: 0.5 - half,
                    width: amount,
                    height: amount,
                };
            }
            default:
                throw new Error(`Unknown fillDirection: ${String(fillDirection.description ?? fillDirection)}`);
        }
    }
    #applyThemeVariablesToElement(element) {
        for (const [name, value] of Object.entries(this.#themeVariables)) {
            element.style.setProperty(name, value);
        }
    }
    connect(element, {extraTransform = null, includeTranslation = true} = {}) {
        this.#connectedElements.push(element);
        this.#connectionTransforms.set(element, {extraTransform, includeTranslation});
        this.#applyTransforms();
        return this;
    }
    setTranslation(offset) {
        if (offset == null) {
            offset = Vector2.ZERO;
        }
        if (this.#translation != null && offset instanceof Vector2 && this.#translation.equals(offset)) {
            return this;
        }
        this.#translation = offset;
        this.#applyTransforms();
        return this;
    }
    getConnectedDefinitionElements() {
        return [...this.#connectedElements];
    }
    getPressVisualSourceId() {
        return this.#pressVisualSourceId;
    }
    getPrimaryCutoutSourceId() {
        return this.#primaryCutoutSourceId;
    }
    maskStyleSourceBySourceId(sourceId) {
        if (this.#styleSourceElement == null) {
            return this;
        }
        this.#styleSourceMaskId = this.getMaskIdForSource(sourceId);
        setMask(this.#styleSourceElement, this.#styleSourceMaskId);
        return this;
    }
    get element() {
        return this.#element;
    }
    get cutoutId() {  // cache?
        return `cutout-${this.element.id}`;
    }
    createMaskRect({sourceId = this.element.id} = {}) {
        return createSvgUse(sourceId, {
            fill: "black",
        });
    }

    getMaskIdForSource(sourceId = this.element.id) {
        const key = String(sourceId);
        const cached = this.#cutoutMasksBySourceId.get(key);
        if (cached) {
            return cached.id;
        }
        if (sourceId === this.element.id) {
            return this.mask.id;
        }
        const maskId = `${this.cutoutId}-source-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        let mask = this.#context.queryChild(maskId);
        if (mask == null) {
            mask = this.#context.addMask(maskId);
            mask.appendChild(this.createMaskRect({sourceId}));
        }
        this.#cutoutMasksBySourceId.set(key, mask);
        return mask.id;
    }

    get mask() {
        this.#mask ??= this.#context.queryChild(this.cutoutId);
        if (this.#mask == null) {
            this.#mask = this.#context.addMask(this.cutoutId);
            this.#mask.appendChild(this.createMaskRect());
        }
        this.#cutoutMasksBySourceId.set(String(this.element.id), this.#mask);
        return this.#mask;
    }

    #resolveOutwardTransform(amount) {
        const bbox = this.#element.getBBox();
        const cx = bbox.x + bbox.width / 2;
        const cy = bbox.y + bbox.height / 2;
        return `translate(${cx} ${cy}) scale(${amount}) translate(${-cx} ${-cy})`;
    }

    #applyTransforms() {
        if (this.#transformFramePending) {
            return;
        }
        this.#transformFramePending = true;
        requestAnimationFrame(() => {
            this.#transformFramePending = false;
            const translate = this.#translation == null || Vector2.ZERO.equals(this.#translation)
                ? null
                : `translate(${this.#translation.x} ${this.#translation.y})`;

            for (const element of this.#connectedElements) {
                const config = this.#connectionTransforms.get(element) ?? {extraTransform: null, includeTranslation: true};
                const extraTransform = typeof config.extraTransform === "function"
                    ? config.extraTransform()
                    : config.extraTransform;
                const elementTranslate = config.includeTranslation ? translate : null;

                const transform = [elementTranslate, extraTransform]
                    .filter((value) => value != null && value !== "")
                    .join(" ");
                setAttributes(element, {
                    transform: transform || null,
                });
            }
        });
    }
}


//function clampToUnitCircle(x, y) {
//    const len = Math.hypot(x, y);
//    if (len > 1) {
//        return { x: x / len, y: y / len };
//    }
//    return { x, y };
//}
//


class GamepadOverlay {
    #context;
    #leftLayout;
    #rightLayout;
    #entities;
    #cornerCompensation;
    #borderWidth;
    #innerBorderSize;
    #region;
    #digitalThreshold;
    #digitalRenderMode;
    #themeVariables;
    #prewarmPressVisuals;

    static #DEFAULT_SIDE_OPTIONS = Object.freeze({
        left: Object.freeze({
            cardinalShapeType: ShapeType.RECTANGLE,
            cornerButtons: Object.freeze({
                leftBumper: Object.freeze({
                    regionName: "topLeft",
                    scale: Object.freeze({x: 0.9, y: 0.6}),
                    shapeType: ShapeType.RECTANGLE,
                    cornerRadiusPercent: Object.freeze({x: 0.25, y: 0.25}),
                }),
                leftTrigger: Object.freeze({
                    regionName: "bottomLeft",
                    scale: Object.freeze({x: 1.0, y: 1.0}),
                    shapeType: ShapeType.TRIANGLE_DOWN,
                    pressFillDirection: PressFillDirection.DOWN,
                    pressMode: "analog",
                }),
                select: Object.freeze({
                    regionName: "topRight",
                    scale: Object.freeze({x: 0.7, y: 0.7}),
                    shapeType: ShapeType.ELLIPSE,
                }),
                leftSpecial: false,
            }),
        }),
        right: Object.freeze({
            cardinalShapeType: ShapeType.ELLIPSE,
            cornerButtons: Object.freeze({
                start: Object.freeze({
                    regionName: "topLeft",
                    scale: Object.freeze({x: 0.7, y: 0.7}),
                    shapeType: ShapeType.ELLIPSE,
                }),
                rightBumper: Object.freeze({
                    regionName: "topRight",
                    scale: Object.freeze({x: 0.9, y: 0.6}),
                    shapeType: ShapeType.RECTANGLE,
                    cornerRadiusPercent: Object.freeze({x: 0.25, y: 0.25}),
                }),
                rightSpecial: false,
                rightTrigger: Object.freeze({
                    regionName: "bottomRight",
                    scale: Object.freeze({x: 1.0, y: 1.0}),
                    shapeType: ShapeType.TRIANGLE_DOWN,
                    pressFillDirection: PressFillDirection.DOWN,
                    pressMode: "analog",
                }),
            }),
        }),
    });

    static #parseCssNumber(value, fallback = 0) {
        const parsed = Number.parseFloat(String(value ?? "").trim());
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    static #resolveBorderWidthFromCss(context) {
        const styles = getComputedStyle(context.svg);
        const inner = this.#parseCssNumber(styles.getPropertyValue("--overlay-border-inner-size"));
        const outer = this.#parseCssNumber(styles.getPropertyValue("--overlay-border-outer-size"));
        return inner + outer;
    }

    static #resolveInnerBorderSizeFromCss(context) {
        const styles = getComputedStyle(context.svg);
        return Math.max(0, this.#parseCssNumber(styles.getPropertyValue("--overlay-border-inner-size"), 0));
    }

    constructor({
        context,
        buttonLength,
        buttonWidth,
        topLeft,
        borderWidth = null,
        gap,
        betweenHalvesGap = 0,
        digitalThreshold = 0.5,
        digitalRenderMode = "fill",
        themeVariables = {},
        prewarmPressVisuals = true,
        hasAnalogStick = true,
        leftSide = {},
        rightSide = {},
    }) {
        this.#context = context;
        borderWidth ??= this.constructor.#resolveBorderWidthFromCss(context);
        const gapPixels = gap * borderWidth;
        const betweenHalvesGapPixels = betweenHalvesGap * borderWidth;
        this.#borderWidth = borderWidth;
        this.#innerBorderSize = this.constructor.#resolveInnerBorderSizeFromCss(context);
        this.#digitalThreshold = digitalThreshold;
        this.#digitalRenderMode = digitalRenderMode;
        this.#themeVariables = {...themeVariables};
        this.#prewarmPressVisuals = Boolean(prewarmPressVisuals);
        this.#cornerCompensation = gapPixels + borderWidth * 2;
        const leftLayoutPosition = topLeft.clone()
            .add(Vector2.splat(borderWidth));
        this.#leftLayout = new DpadLayout({buttonLength, buttonWidth, topLeft: leftLayoutPosition});
        this.#rightLayout = new DpadLayout({
            buttonLength,
            buttonWidth,
            topLeft: leftLayoutPosition.clone()
                .add(new Vector2({x: this.#leftLayout.size.x + borderWidth*2 + gapPixels + betweenHalvesGapPixels, y:0}))
        });
        const size = new Vector2({
            x: this.#rightLayout.topRight.bottomRight.x - topLeft.x + borderWidth,
            y: this.#leftLayout.bottomLeft.bottomRight.y - topLeft.y + borderWidth,
        });
        this.#region = new Region({
            topLeft: topLeft.clone(),
            size,
        });
        this.#entities = this.#build({hasAnalogStick, leftSide, rightSide});
    }

    get entities() {
        return this.#entities;
    }
    get leftLayout() {
        return this.#leftLayout;
    }
    get rightLayout() {
        return this.#rightLayout;
    }
    get region() {
        return this.#region;
    }
    get size() {
        return this.#region.size;
    }
    get width() {
        return this.#region.size.x;
    }
    get height() {
        return this.#region.size.y;
    }
    get leftAnalogClampHalfSize() {
        return this.#leftLayout.origin.halfSize;
    }
    get rightAnalogClampHalfSize() {
        return this.#rightLayout.origin.halfSize;
    }

    #inflateRegion(region, amount) {
        if (amount <= 0) {
            return region;
        }
        return Region.fromCenter({
            center: region.center,
            size: region.size.clone().add(Vector2.splat(amount * 2)),
        });
    }

    #expandPointsFromCenter(points, center, amount) {
        if (!(amount > 0)) {
            return points;
        }
        return points.map((point) => {
            const deltaX = point.x - center.x;
            const deltaY = point.y - center.y;
            const length = Math.hypot(deltaX, deltaY);
            if (length === 0) {
                return point.clone();
            }
            const scale = (length + amount) / length;
            return new Vector2({
                x: center.x + deltaX * scale,
                y: center.y + deltaY * scale,
            });
        });
    }

    #trianglePointsForRegion(shapeType, region) {
        switch (shapeType) {
            case ShapeType.TRIANGLE_UP:
                return [region.topCenter, region.bottomLeft, region.bottomRight];
            case ShapeType.TRIANGLE_DOWN:
                return [region.bottomCenter, region.topLeft, region.topRight];
            case ShapeType.TRIANGLE_LEFT:
                return [region.centerLeft, region.topRight, region.bottomRight];
            case ShapeType.TRIANGLE_RIGHT:
                return [region.centerRight, region.topLeft, region.bottomLeft];
            default:
                return null;
        }
    }

    #polygonSignedArea(points) {
        let sum = 0;
        for (let i = 0; i < points.length; i += 1) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            sum += (a.x * b.y) - (b.x * a.y);
        }
        return sum / 2;
    }

    #lineIntersection(a1, a2, b1, b2) {
        const x1 = a1.x;
        const y1 = a1.y;
        const x2 = a2.x;
        const y2 = a2.y;
        const x3 = b1.x;
        const y3 = b1.y;
        const x4 = b2.x;
        const y4 = b2.y;

        const denominator = ((x1 - x2) * (y3 - y4)) - ((y1 - y2) * (x3 - x4));
        if (Math.abs(denominator) < 1e-9) {
            return null;
        }

        const pre = (x1 * y2) - (y1 * x2);
        const post = (x3 * y4) - (y3 * x4);
        const x = ((pre * (x3 - x4)) - ((x1 - x2) * post)) / denominator;
        const y = ((pre * (y3 - y4)) - ((y1 - y2) * post)) / denominator;
        return new Vector2({x, y});
    }

    #offsetConvexPolygon(points, distance) {
        if (!(distance > 0) || points.length < 3) {
            return points;
        }

        const area = this.#polygonSignedArea(points);
        const winding = area >= 0 ? 1 : -1;

        const offsetEdges = points.map((start, index) => {
            const end = points[(index + 1) % points.length];
            const edgeX = end.x - start.x;
            const edgeY = end.y - start.y;
            const edgeLength = Math.hypot(edgeX, edgeY);
            if (edgeLength === 0) {
                return null;
            }

            const normalScale = winding / edgeLength;
            const outwardNormalX = edgeY * normalScale;
            const outwardNormalY = -edgeX * normalScale;
            const offsetX = outwardNormalX * distance;
            const offsetY = outwardNormalY * distance;

            return {
                a: new Vector2({x: start.x + offsetX, y: start.y + offsetY}),
                b: new Vector2({x: end.x + offsetX, y: end.y + offsetY}),
            };
        });

        return points.map((point, index) => {
            const previousEdge = offsetEdges[(index - 1 + offsetEdges.length) % offsetEdges.length];
            const nextEdge = offsetEdges[index];
            if (previousEdge == null || nextEdge == null) {
                return point.clone();
            }
            return this.#lineIntersection(previousEdge.a, previousEdge.b, nextEdge.a, nextEdge.b) ?? point.clone();
        });
    }

    #createButton({
        group,
        id,
        region,
        shapeType,
        cornerRadiusPercent,
        includeBorder = false,
        buttonClasses = "gamepad-button",
        semanticClasses = [],
        semanticAttributes = {},
        pressMode = "digital",
        digitalThreshold = this.#digitalThreshold,
        digitalRenderMode = this.#digitalRenderMode,
        themeVariables = this.#resolveThemeVariables(semanticAttributes),
        prewarmPressVisual = this.#prewarmPressVisuals && pressMode === "digital" && digitalRenderMode === "fill",
    }) {
        const includeBorderStroke = includeBorder && this.#innerBorderSize > 0;
        const borderExpandAmount = this.#innerBorderSize / 2;
        const trianglePoints = this.#trianglePointsForRegion(shapeType, region);
        const expandedRegion = includeBorderStroke
            ? this.#inflateRegion(region, borderExpandAmount)
            : region;
        let expandedCornerRadiusPercent = cornerRadiusPercent;
        if (includeBorderStroke && shapeType === ShapeType.RECTANGLE) {
            const innerHalf = this.#innerBorderSize / 2;
            const originalRadiusX = region.halfSize.x * cornerRadiusPercent.x;
            const originalRadiusY = region.halfSize.y * cornerRadiusPercent.y;
            const expandedRadiusX = Math.min(
                expandedRegion.halfSize.x,
                Math.max(0, originalRadiusX + innerHalf),
            );
            const expandedRadiusY = Math.min(
                expandedRegion.halfSize.y,
                Math.max(0, originalRadiusY + innerHalf),
            );
            expandedCornerRadiusPercent = new Vector2({
                x: expandedRegion.halfSize.x === 0 ? 0 : expandedRadiusX / expandedRegion.halfSize.x,
                y: expandedRegion.halfSize.y === 0 ? 0 : expandedRadiusY / expandedRegion.halfSize.y,
            });
        }
        const fillCutoutShapeId = includeBorderStroke
            ? monotonicId(`${id}-cutout-`)
            : null;
        const layers = [];
        if (includeBorder) {
            layers.push({
                classes: "outer-border",
                cutout: true,
                cutoutSourceId: fillCutoutShapeId ?? id,
            });
        }
        layers.push({
            classes: [].concat(buttonClasses, semanticClasses, includeBorderStroke ? ["gamepad-button-bordered"] : []),
            attributes: semanticAttributes,
            styleSource: true,
        });
        if (fillCutoutShapeId != null) {
            this.#context.addDefinition(createSvgShape(
                {region, shapeType, cornerRadiusPercent},
                {id: fillCutoutShapeId},
            ));
        }
        const element = (() => {
            if (includeBorderStroke && trianglePoints != null) {
                const expandedTrianglePoints = this.#offsetConvexPolygon(trianglePoints, borderExpandAmount);
                return createSvgPolygon(expandedTrianglePoints, {id});
            }
            return createSvgShape(
                {region: expandedRegion, shapeType, cornerRadiusPercent: expandedCornerRadiusPercent},
                {id},
            );
        })();

        const entity = new GamepadEntity({
            context: this.#context,
            element,
            layers,
            parent: group,
            themeVariables,
            pressVisualSourceId: fillCutoutShapeId ?? id,
        });
        entity.setPressBehavior({
            mode: pressMode,
            threshold: digitalThreshold,
            digitalRenderMode,
        });
        if (prewarmPressVisual) {
            entity.enablePressVisual();
        }
        return entity;
    }

    #resolveThemeVariables(semanticAttributes) {
        const side = semanticAttributes?.["data-side"];
        const role = semanticAttributes?.["data-role"];
        const bySideRole = side != null && role != null
            ? this.#themeVariables[`${side}:${role}`]
            : null;
        const byRole = role != null ? this.#themeVariables[`role:${role}`] : null;
        const global = this.#themeVariables.global;
        return {
            ...(global || {}),
            ...(byRole || {}),
            ...(bySideRole || {}),
        };
    }

    #createCrossBorder({group, id, layout}) {
        const innerCrossId = monotonicId(`${id}-inner-cross-`);
        this.#context.addDefinition(createSvgPolygon(layout.crossPoints, {id: innerCrossId}));
        const expandedPoints = this.#expandPointsFromCenter(
            layout.crossPoints,
            layout.origin.center,
            this.#innerBorderSize / 2,
        );
        return new GamepadEntity({
            context: this.#context,
            element: createSvgPolygon(expandedPoints, {id}),
            layers: [
                {
                    classes: "outer-border",
                    cutout: true,
                    cutoutSourceId: innerCrossId,
                },
                {classes: "black-border-stroke"},
            ],
            parent: group,
            pressVisualSourceId: innerCrossId,
        });
    }

    #createCornerButton({group, sidePrefix, sideName, roleName, layout, idSuffix, spec}) {
        if (!spec) {
            return null;
        }
        const {
            regionName,
            scale = {x: 1, y: 1},
            shapeType = ShapeType.RECTANGLE,
            cornerRadiusPercent,
            compensateOuterEdges = true,
            pressFillDirection,
            pressMode = "digital",
            digitalThreshold,
        } = spec;
        const region = layout[regionName];
        if (!(region instanceof Region)) {
            throw new Error(`Invalid corner region '${String(regionName)}' for ${sidePrefix}${idSuffix}`);
        }
        const compensation = this.#resolveCornerCompensationVector(spec.cornerCompensation);
        const scaleVector = new Vector2(scale);
        const cornerRadiusPercentVector = cornerRadiusPercent == null
            ? undefined
            : new Vector2(cornerRadiusPercent);
        const compensatedRegion = this.#applyCornerCompensation(
            region,
            regionName,
            compensation,
            {compensateOuterEdges},
        );

        const button = this.#createButton({
            group,
            id: `${sidePrefix}${idSuffix}`,
            region: compensatedRegion.scale(scaleVector),
            shapeType,
            cornerRadiusPercent: cornerRadiusPercentVector,
            includeBorder: true,
            semanticClasses: [`side-${sideName}`, `role-${roleName}`],
            semanticAttributes: {"data-side": sideName, "data-role": roleName},
            pressMode,
            digitalThreshold,
            prewarmPressVisual: pressFillDirection == null,
        });
        if (pressFillDirection != null) {
            button.setPressFillDirection(pressFillDirection);
            if (this.#prewarmPressVisuals && pressMode === "digital" && this.#digitalRenderMode === "fill") {
                button.enablePressVisual();
            }
        }
        return button;
    }

    #resolveCornerCompensationVector(value) {
        if (value == null) {
            return Vector2.splat(this.#cornerCompensation);
        }
        if (typeof value === "number") {
            return Vector2.splat(assertFiniteNumber(value, "cornerCompensation"));
        }
        return new Vector2(value);
    }

    #applyCornerCompensation(region, regionName, compensation, {compensateOuterEdges = false} = {}) {
        const x = Math.max(0, compensation.x);
        const y = Math.max(0, compensation.y);
        const insets = {top: 0, right: 0, bottom: 0, left: 0};

        switch (regionName) {
            case "topLeft":
                insets.right += x;
                insets.bottom += y;
                if (compensateOuterEdges) {
                    insets.left += x;
                    insets.top += y;
                }
                break;
            case "topRight":
                insets.left += x;
                insets.bottom += y;
                if (compensateOuterEdges) {
                    insets.right += x;
                    insets.top += y;
                }
                break;
            case "bottomLeft":
                insets.right += x;
                insets.top += y;
                if (compensateOuterEdges) {
                    insets.left += x;
                    insets.bottom += y;
                }
                break;
            case "bottomRight":
                insets.left += x;
                insets.top += y;
                if (compensateOuterEdges) {
                    insets.right += x;
                    insets.bottom += y;
                }
                break;
            default:
                throw new Error(`Unsupported corner region for compensation: ${String(regionName)}`);
        }

        const size = new Vector2({
            x: Math.max(0, region.size.x - insets.left - insets.right),
            y: Math.max(0, region.size.y - insets.top - insets.bottom),
        });
        const topLeft = region.topLeft.clone().add({x: insets.left, y: insets.top});

        return new Region({topLeft, size});
    }

    #resolveSideOptions(sideName, sideOptions = {}) {
        const defaults = this.constructor.#DEFAULT_SIDE_OPTIONS[sideName];
        sideOptions.cornerButtons ??= {};
        const defaultCorners = defaults.cornerButtons;
        const cornerButtons = {
            ...defaultCorners,
            ...sideOptions.cornerButtons,
        };
        for (const [key, incomingSpec] of Object.entries(sideOptions.cornerButtons)) {
            const defaultSpec = defaultCorners[key];
            if (defaultSpec && incomingSpec && typeof defaultSpec === "object" && typeof incomingSpec === "object") {
                cornerButtons[key] = {
                    ...defaultSpec,
                    ...incomingSpec,
                };
            }
        }
        for (const [key, value] of Object.entries(defaultCorners)) {
            if (cornerButtons[key] === undefined) {
                cornerButtons[key] = value;
            }
        }
        return {
            cardinalShapeType: sideOptions.cardinalShapeType ?? defaults.cardinalShapeType,
            cornerButtons,
        };
    }

    #buildSide({
        sidePrefix,
        sideName,
        layout,
        topGroup,
        hasAnalogStick,
        drawCrossBorder,
        analogAreaHasOuterBorder,
        cardinalHasBorder,
        cardinalShapeType = ShapeType.RECTANGLE,
        cornerButtons,
    }) {
        const backgroundGroup = this.#context.addChild(
            createSvgElement("g", {id: `${sidePrefix}BackgroundGroup`} ),
            {parent: topGroup},
        );
        const dpadGroup = this.#context.addChild(
            createSvgElement("g", {id: `${sidePrefix}DpadGroup`} ),
            {parent: backgroundGroup},
        );

        let dpadBorder = null;
        if (drawCrossBorder) {
            dpadBorder = this.#createCrossBorder({
                group: dpadGroup,
                id: `${sidePrefix}DpadBorder`,
                layout,
            });
        }

        const leftButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}LeftButton`,
            region: layout.left,
            shapeType: cardinalShapeType,
            includeBorder: cardinalHasBorder,
            semanticClasses: [`side-${sideName}`, "role-left"],
            semanticAttributes: {"data-side": sideName, "data-role": "left"},
        });
        const upButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}UpButton`,
            region: layout.up,
            shapeType: cardinalShapeType,
            includeBorder: cardinalHasBorder,
            semanticClasses: [`side-${sideName}`, "role-up"],
            semanticAttributes: {"data-side": sideName, "data-role": "up"},
        });
        const rightButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}RightButton`,
            region: layout.right,
            shapeType: cardinalShapeType,
            includeBorder: cardinalHasBorder,
            semanticClasses: [`side-${sideName}`, "role-right"],
            semanticAttributes: {"data-side": sideName, "data-role": "right"},
        });
        const downButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}DownButton`,
            region: layout.down,
            shapeType: cardinalShapeType,
            includeBorder: cardinalHasBorder,
            semanticClasses: [`side-${sideName}`, "role-down"],
            semanticAttributes: {"data-side": sideName, "data-role": "down"},
        });
        const originButton = drawCrossBorder
            ? this.#createButton({
                group: dpadGroup,
                id: `${sidePrefix}OriginButton`,
                region: layout.origin,
                shapeType: ShapeType.RECTANGLE,
                includeBorder: false,
                semanticClasses: [`side-${sideName}`, "role-origin"],
                semanticAttributes: {"data-side": sideName, "data-role": "origin"},
            })
            : null;

        const leftBumper = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "left-bumper",
            layout,
            idSuffix: "LeftBumperButton",
            spec: cornerButtons.leftBumper,
        });
        const select = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "select",
            layout,
            idSuffix: "SelectButton",
            spec: cornerButtons.select,
        });
        const leftTrigger = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "left-trigger",
            layout,
            idSuffix: "LeftTriggerButton",
            spec: cornerButtons.leftTrigger,
        });
        const leftSpecial = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "left-special",
            layout,
            idSuffix: "LeftSpecialButton",
            spec: cornerButtons.leftSpecial,
        });
        const start = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "start",
            layout,
            idSuffix: "StartButton",
            spec: cornerButtons.start,
        });
        const rightBumper = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "right-bumper",
            layout,
            idSuffix: "RightBumperButton",
            spec: cornerButtons.rightBumper,
        });
        const rightSpecial = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "right-special",
            layout,
            idSuffix: "RightSpecialButton",
            spec: cornerButtons.rightSpecial,
        });
        const rightTrigger = this.#createCornerButton({
            group: dpadGroup,
            sidePrefix,
            sideName,
            roleName: "right-trigger",
            layout,
            idSuffix: "RightTriggerButton",
            spec: cornerButtons.rightTrigger,
        });

        let analogAreaGroup = null;
        let analogArea = null;
        let analogStickGroup = null;
        let analogStick = null;
        let analogStickRing = null;

        if (hasAnalogStick) {
            analogAreaGroup = this.#context.addChild(
                createSvgElement("g", {id: `${sidePrefix}AnalogAreaGroup`} ),
                {parent: backgroundGroup},
            );
            const analogAreaRegion = Region.fromCenter({
                center: layout.analogRegion.center,
                size: layout.analogRegion.size.clone(),
            });
            analogArea = this.#createButton({
                group: analogAreaGroup,
                id: `${sidePrefix}AnalogArea`,
                region: analogAreaRegion,
                shapeType: ShapeType.ELLIPSE,
                includeBorder: analogAreaHasOuterBorder,
                semanticClasses: [`side-${sideName}`, "role-analog-area"],
                semanticAttributes: {"data-side": sideName, "data-role": "analog-area"},
                pressMode: "digital",
                digitalRenderMode: "class-toggle",
            });

            setMask(dpadGroup, analogArea.mask.id);

            analogStickGroup = this.#context.addChild(
                createSvgElement("g", {id: `${sidePrefix}AnalogStickGroup`} ),
                {parent: topGroup},
            );
            const analogStickSize = layout.analogRegion.size.clone().multiply(Vector2.splat(0.65));
            analogStick = this.#createButton({
                group: analogStickGroup,
                id: `${sidePrefix}AnalogStick`,
                region: Region.fromCenter({
                    center: layout.analogRegion.center,
                    size: analogStickSize,
                }),
                shapeType: ShapeType.ELLIPSE,
                includeBorder: true,
                semanticClasses: [`side-${sideName}`, "role-analog-stick"],
                semanticAttributes: {"data-side": sideName, "data-role": "analog-stick"},
                pressMode: "digital",
                digitalRenderMode: "class-toggle",
            });
            const analogStickRingRegion = Region.fromCenter({
                center: layout.analogRegion.center,
                size: analogStickSize.clone().multiply(Vector2.splat(0.75)),
            });
            analogStickRing = this.#createButton({
                group: analogStickGroup,
                id: `${sidePrefix}AnalogStickRing`,
                region: analogStickRingRegion,
                shapeType: ShapeType.ELLIPSE,
                includeBorder: true,
                buttonClasses: "gamepad-button",
                semanticClasses: [`side-${sideName}`, "role-analog-stick-ring"],
                semanticAttributes: {"data-side": sideName, "data-role": "analog-stick-ring"},
                pressMode: "digital",
                digitalRenderMode: "class-toggle",
                digitalThreshold: 0.01,
            });
            for (const connectedElement of analogStickRing.getConnectedDefinitionElements()) {
                analogStick.connect(connectedElement);
            }
            analogStick.maskStyleSourceBySourceId(analogStickRing.element.id);
            setMask(backgroundGroup, analogStick.mask.id);
        }

        dpadBorder?.bringLayersToFront();

        return {
            groups: {backgroundGroup, dpadGroup, analogAreaGroup, analogStickGroup},
            entities: {
                dpadBorder,
                leftButton,
                upButton,
                rightButton,
                downButton,
                originButton,
                leftBumper,
                select,
                leftTrigger,
                leftSpecial,
                start,
                rightBumper,
                rightSpecial,
                rightTrigger,
                analogArea,
                analogStick,
                analogStickRing,
            },
        };
    }

    #build({hasAnalogStick, leftSide, rightSide}) {
        const rootGroup = this.#context.addChild(createSvgElement("g", {id: "gamepadOverlayGroup"}));
        const leftOptions = this.#resolveSideOptions("left", leftSide);
        const rightOptions = this.#resolveSideOptions("right", rightSide);

        const left = this.#buildSide({
            sidePrefix: "left",
            sideName: "left",
            layout: this.#leftLayout,
            topGroup: rootGroup,
            hasAnalogStick,
            drawCrossBorder: true,
            analogAreaHasOuterBorder: true,
            cardinalHasBorder: false,
            cardinalShapeType: leftOptions.cardinalShapeType,
            cornerButtons: leftOptions.cornerButtons,
        });

        const right = this.#buildSide({
            sidePrefix: "right",
            sideName: "right",
            layout: this.#rightLayout,
            topGroup: rootGroup,
            hasAnalogStick,
            drawCrossBorder: false,
            analogAreaHasOuterBorder: true,
            cardinalHasBorder: true,
            cardinalShapeType: rightOptions.cardinalShapeType,
            cornerButtons: rightOptions.cornerButtons,
        });

        return {rootGroup, left, right};
    }

}
