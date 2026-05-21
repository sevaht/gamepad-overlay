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

const assertFiniteNumber = OverlayCore.assertFiniteNumber;
const Vector2 = OverlayCore.Vector2;
const Region = OverlayCore.Region;
const DpadLayout = OverlayCore.DpadLayout;
const clampNormalizedOffsetToEllipse = OverlayCore.clampNormalizedOffsetToEllipse;

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

const DomainShapeModel = OverlayDomain.ShapeModel;
const DomainBorderModel = OverlayDomain.BorderModel;

function createSvgPolygon(points, attributes = {}) {
    return createSvgElement("polygon", {
        points: Array.isArray(points) ? points.map(String).join(" ") : String(points),
        ...attributes,
    });
}

// Terminology glossary:
// - pressFillShapeId: shape used for press-fill visuals (must match intended fill area).
// - borderCutoutShapeId: shape used to cut out the white border under black stroke.
// - LayerSpec: declarative render plan for one SVG <use> layer.
// - ShapeModel: center-based geometry model for one shape.
// - BorderModel: border sizing/expansion policy for external stroke-style borders.

class LayerSpec {
    #sourceId;
    #classes;
    #cutout;
    #cutoutSourceId;
    #styleSource;
    #attributes;
    #id;

    constructor({sourceId = null, classes = [], cutout = false, cutoutSourceId = null, styleSource = false, attributes = null, id = null} = {}) {
        this.#sourceId = sourceId;
        this.#classes = classes == null ? [] : [].concat(classes);
        this.#cutout = Boolean(cutout);
        this.#cutoutSourceId = cutoutSourceId;
        this.#styleSource = Boolean(styleSource);
        this.#attributes = attributes;
        this.#id = id;
    }

    get sourceId() { return this.#sourceId; }
    get classes() { return this.#classes; }
    get cutout() { return this.#cutout; }
    get cutoutSourceId() { return this.#cutoutSourceId; }
    get styleSource() { return this.#styleSource; }
    get attributes() { return this.#attributes; }
    get id() { return this.#id; }
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
    #pressFillVisual;
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
    #pressFillShapeId;
    #borderCutoutShapeId;
    #styleSourceMaskId;
    #classToggleFramePending;
    #pendingClassTogglePressed;

    constructor({context, element, parent, layers=[{}], offset=Vector2.ZERO, themeVariables = {}, pressFillShapeId = null}) {
        // TODO: null validation?
        this.#context = context;
        this.#element = element;
        this.#connectedElements = [this.#element];
        this.#connectionTransforms = new WeakMap();
        this.#translation = Vector2.ZERO;
        this.#layerParent = parent;
        this.#pressFillVisual = null;
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
        this.#pressFillShapeId = pressFillShapeId ?? this.element.id;
        this.#borderCutoutShapeId = this.element.id;
        this.#styleSourceMaskId = null;
        this.#classToggleFramePending = false;
        this.#pendingClassTogglePressed = null;
        this.setTranslation(offset);
        this.#context.addDefinition(this.#element);
        const connectedSourceIds = new Set([this.element.id]);

        for (const rawLayer of layers) {
            const layer = rawLayer instanceof LayerSpec
                ? rawLayer
                : new LayerSpec(rawLayer);
            const sourceId = layer.sourceId ?? this.element.id;
            const useElement = createSvgUse(sourceId);
            const classList = layer.classes;
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
                this.#borderCutoutShapeId = cutoutSourceId;
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
        if (this.#pressFillVisual != null) {
            return this;
        }
        this.#resolvePressFillAttributes(0.5, fillDirection);
        this.#pressFillDirection = fillDirection;

        const useElement = createSvgUse(this.#pressFillShapeId);
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
                extraTransform: () => this.#resolveOutwardTransform(this.#pressFillVisual?.amount ?? 0),
                includeTranslation: false,
            });
            this.#pressFillVisual = {
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
            this.#pressFillVisual = {
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
        if (amount === this.#pressFillVisual.amount) {
            return this;
        }
        this.#pressFillVisual.amount = amount;
        if (this.#pressFillVisual.mode === "outward") {
            this.#applyTransforms();
        } else {
            const attributes = this.#resolvePressFillAttributes(amount, this.#pressFillVisual.fillDirection);
            setAttributes(this.#pressFillVisual.clipRect, attributes);
        }
        return this;
    }
    setPressFillDirection(fillDirection) {
        if (this.#pressFillVisual != null) {
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
    getPressFillShapeId() {
        return this.#pressFillShapeId;
    }
    getBorderCutoutShapeId() {
        return this.#borderCutoutShapeId;
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

class RenderableControl {
    #entity;

    constructor(entity) {
        this.#entity = entity;
    }

    get entity() { return this.#entity; }
    get element() { return this.#entity.element; }

    setInputAmount(value) { this.#entity.setInputAmount(value); return this; }
    setTranslation(offset) { this.#entity.setTranslation(offset); return this; }
    setPressFillDirection(direction) { this.#entity.setPressFillDirection(direction); return this; }
    enablePressVisual(options) { this.#entity.enablePressVisual(options); return this; }
    bringLayersToFront() { this.#entity.bringLayersToFront(); return this; }
    maskStyleSourceBySourceId(sourceId) { this.#entity.maskStyleSourceBySourceId(sourceId); return this; }
    connect(element, options) { this.#entity.connect(element, options); return this; }
    getConnectedDefinitionElements() { return this.#entity.getConnectedDefinitionElements(); }
    getBorderCutoutShapeId() { return this.#entity.getBorderCutoutShapeId(); }
}

class CompositeControl {
    #translationTarget;
    #pressTargets;
    #layerTargets;

    constructor({translationTarget, pressTargets = [], layerTargets = []}) {
        this.#translationTarget = translationTarget;
        this.#pressTargets = pressTargets;
        this.#layerTargets = layerTargets;
    }

    get element() { return this.#translationTarget.element; }
    setTranslation(offset) { this.#translationTarget.setTranslation(offset); return this; }
    setInputAmount(value) {
        for (const target of this.#pressTargets) {
            target.setInputAmount(value);
        }
        return this;
    }
    setPressFillDirection(direction) {
        for (const target of this.#pressTargets) {
            target.setPressFillDirection(direction);
        }
        return this;
    }
    enablePressVisual(options) {
        for (const target of this.#pressTargets) {
            target.enablePressVisual(options);
        }
        return this;
    }
    bringLayersToFront() {
        for (const target of this.#layerTargets) {
            target.bringLayersToFront();
        }
        return this;
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


class SvgGamepadOverlay {
    #context;
    #model;
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
    #prewarmPressFillVisuals;

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
        model = null,
        buttonLength,
        buttonWidth,
        topLeft,
        borderWidth = null,
        gap,
        betweenHalvesGap = 0,
        digitalThreshold = 0.5,
        digitalRenderMode = "fill",
        themeVariables = {},
        prewarmPressFillVisuals = true,
        hasAnalogStick = true,
        leftSide = {},
        rightSide = {},
    }) {
        this.#context = context;
        borderWidth ??= this.constructor.#resolveBorderWidthFromCss(context);
        this.#innerBorderSize = this.constructor.#resolveInnerBorderSizeFromCss(context);
        if (model == null) {
            model = createRasterOverlayModel({
                buttonLength,
                buttonWidth,
                borderWidth,
                innerBorderSize: this.#innerBorderSize,
                gap,
                betweenHalvesGap,
            });
        }
        this.#model = model;
        this.#borderWidth = this.#model.borderWidth;
        this.#digitalThreshold = digitalThreshold;
        this.#digitalRenderMode = digitalRenderMode;
        this.#themeVariables = {...themeVariables};
        this.#prewarmPressFillVisuals = Boolean(prewarmPressFillVisuals);
        this.#cornerCompensation = (gap * this.#model.borderWidth) + this.#model.borderWidth * 2;
        this.#leftLayout = this.#model.leftLayout;
        this.#rightLayout = this.#model.rightLayout;
        const size = new Vector2({x: this.#model.width, y: this.#model.height});
        this.#region = new Region({
            topLeft: topLeft.clone(),
            size,
        });
        this.#entities = this.#build({hasAnalogStick});
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

    #createBorderedLayerSpecs({fillShapeId, includeBorderStroke, includeOuterBorder, faceClasses, semanticAttributes}) {
        const layers = [];
        if (includeBorderStroke && includeOuterBorder) {
            layers.push(new LayerSpec({
                classes: "outer-border",
                cutout: true,
                cutoutSourceId: fillShapeId,
            }));
        }
        layers.push(new LayerSpec({
            classes: faceClasses,
            attributes: semanticAttributes,
            styleSource: true,
        }));
        return layers;
    }

    #createButton({
        group,
        id,
        region,
        shapeType,
        cornerRadiusPercent,
        includeBorder = false,
        includeOuterBorder = true,
        buttonClasses = "gamepad-button",
        semanticClasses = [],
        semanticAttributes = {},
        pressMode = "digital",
        digitalThreshold = this.#digitalThreshold,
        digitalRenderMode = this.#digitalRenderMode,
        themeVariables = this.#resolveThemeVariables(semanticAttributes),
        prewarmPressFillVisual = this.#prewarmPressFillVisuals && pressMode === "digital" && digitalRenderMode === "fill",
    }) {
        const shapeModel = new DomainShapeModel({region, shapeType, cornerRadiusPercent});
        const borderModel = new DomainBorderModel({innerSize: this.#innerBorderSize});
        const includeBorderStroke = borderModel.appliesToBordered(includeBorder);
        const borderExpandAmount = borderModel.expandAmount();
        const trianglePoints = shapeModel.trianglePoints();
        const expandedShapeModel = borderModel.expandedShape(shapeModel, includeBorder);
        const fillCutoutShapeId = includeBorderStroke
            ? monotonicId(`${id}-cutout-`)
            : null;
        const layers = this.#createBorderedLayerSpecs({
            fillShapeId: fillCutoutShapeId ?? id,
            includeBorderStroke,
            includeOuterBorder,
            faceClasses: [].concat(buttonClasses, semanticClasses, includeBorderStroke ? ["gamepad-button-bordered"] : []),
            semanticAttributes,
        });
        if (fillCutoutShapeId != null) {
            this.#context.addDefinition(createSvgShape({
                region: shapeModel.region,
                shapeType: shapeModel.shapeType,
                cornerRadiusPercent: shapeModel.cornerRadiusPercent,
            }, {id: fillCutoutShapeId}));
        }
        const element = (() => {
            if (includeBorderStroke && trianglePoints != null) {
                const expandedTrianglePoints = this.#offsetConvexPolygon(trianglePoints, borderExpandAmount);
                return createSvgPolygon(expandedTrianglePoints, {id});
            }
            return createSvgShape({
                region: expandedShapeModel.region,
                shapeType: expandedShapeModel.shapeType,
                cornerRadiusPercent: expandedShapeModel.cornerRadiusPercent,
            }, {id});
        })();

        const entity = new GamepadEntity({
            context: this.#context,
            element,
            layers,
            parent: group,
            themeVariables,
            pressFillShapeId: fillCutoutShapeId ?? id,
        });
        entity.setPressBehavior({
            mode: pressMode,
            threshold: digitalThreshold,
            digitalRenderMode,
        });
        if (prewarmPressFillVisual) {
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
        const expandedPoints = this.#offsetConvexPolygon(layout.crossPoints, this.#innerBorderSize / 2);
        return new GamepadEntity({
            context: this.#context,
            element: createSvgPolygon(expandedPoints, {id}),
            layers: this.#createBorderedLayerSpecs({
                fillShapeId: innerCrossId,
                includeBorderStroke: true,
                faceClasses: "black-border-stroke",
                semanticAttributes: null,
            }),
            parent: group,
            pressFillShapeId: innerCrossId,
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
            prewarmPressFillVisual: pressFillDirection == null,
        });
        if (pressFillDirection != null) {
            button.setPressFillDirection(pressFillDirection);
            if (this.#prewarmPressFillVisuals && pressMode === "digital" && this.#digitalRenderMode === "fill") {
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

    #buildSide({
        sidePrefix,
        sideName,
        layout,
        sideButtons,
        topGroup,
        hasAnalogStick,
        drawCrossBorder,
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

        const toSvgShapeType = (shape) => {
            switch (shape) {
                case "rect": return ShapeType.RECTANGLE;
                case "ellipse": return ShapeType.ELLIPSE;
                case "triUp": return ShapeType.TRIANGLE_UP;
                case "triDown": return ShapeType.TRIANGLE_DOWN;
                case "triLeft": return ShapeType.TRIANGLE_LEFT;
                case "triRight": return ShapeType.TRIANGLE_RIGHT;
                default: return ShapeType.RECTANGLE;
            }
        };
        const makeButton = ({group, idSuffix, spec, roleName}) => {
            if (!spec) {
                return null;
            }
            const button = this.#createButton({
                group,
                id: `${sidePrefix}${idSuffix}`,
                region: spec.region,
                shapeType: toSvgShapeType(spec.shape),
                cornerRadiusPercent: spec.cornerRadiusPercent ?? 0,
                includeBorder: true,
                includeOuterBorder: spec.includeOuterBorder !== false,
                semanticClasses: [`side-${sideName}`, `role-${roleName}`],
                semanticAttributes: {"data-side": sideName, "data-role": roleName},
                pressMode: spec.pressMode === "analog" ? "analog" : "digital",
                digitalRenderMode: "class-toggle",
                digitalThreshold: spec.pressMode === "none" ? 2 : this.#digitalThreshold,
            });
            const pressFillDirection = (() => {
                switch (spec.pressFillDirection || "outward") {
                    case "up": return PressFillDirection.UP;
                    case "down": return PressFillDirection.DOWN;
                    case "left": return PressFillDirection.LEFT;
                    case "right": return PressFillDirection.RIGHT;
                    case "outward": return PressFillDirection.OUTWARD;
                    default: return PressFillDirection.OUTWARD;
                }
            })();
            button.setPressFillDirection(pressFillDirection);
            return button;
        };

        const leftButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}LeftButton`,
            region: sideButtons.left.region,
            shapeType: toSvgShapeType(sideButtons.left.shape),
            includeBorder: true,
            includeOuterBorder: sideButtons.left.includeOuterBorder !== false,
            semanticClasses: [`side-${sideName}`, "role-left"],
            semanticAttributes: {"data-side": sideName, "data-role": "left"},
        });
        const upButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}UpButton`,
            region: sideButtons.up.region,
            shapeType: toSvgShapeType(sideButtons.up.shape),
            includeBorder: true,
            includeOuterBorder: sideButtons.up.includeOuterBorder !== false,
            semanticClasses: [`side-${sideName}`, "role-up"],
            semanticAttributes: {"data-side": sideName, "data-role": "up"},
        });
        const rightButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}RightButton`,
            region: sideButtons.right.region,
            shapeType: toSvgShapeType(sideButtons.right.shape),
            includeBorder: true,
            includeOuterBorder: sideButtons.right.includeOuterBorder !== false,
            semanticClasses: [`side-${sideName}`, "role-right"],
            semanticAttributes: {"data-side": sideName, "data-role": "right"},
        });
        const downButton = this.#createButton({
            group: dpadGroup,
            id: `${sidePrefix}DownButton`,
            region: sideButtons.down.region,
            shapeType: toSvgShapeType(sideButtons.down.shape),
            includeBorder: true,
            includeOuterBorder: sideButtons.down.includeOuterBorder !== false,
            semanticClasses: [`side-${sideName}`, "role-down"],
            semanticAttributes: {"data-side": sideName, "data-role": "down"},
        });
        const originButton = drawCrossBorder
            ? this.#createButton({
                group: dpadGroup,
                id: `${sidePrefix}OriginButton`,
                region: sideButtons.origin.region,
                shapeType: toSvgShapeType(sideButtons.origin.shape),
                includeBorder: true,
                includeOuterBorder: sideButtons.origin.includeOuterBorder !== false,
                semanticClasses: [`side-${sideName}`, "role-origin"],
                semanticAttributes: {"data-side": sideName, "data-role": "origin"},
            })
            : null;

        const leftBumper = makeButton({group: dpadGroup, idSuffix: "LeftBumperButton", spec: sideButtons.leftBumper, roleName: "left-bumper"});
        const select = makeButton({group: dpadGroup, idSuffix: "SelectButton", spec: sideButtons.select, roleName: "select"});
        const leftTrigger = makeButton({group: dpadGroup, idSuffix: "LeftTriggerButton", spec: sideButtons.leftTrigger, roleName: "left-trigger"});
        const leftSpecial = makeButton({group: dpadGroup, idSuffix: "LeftSpecialButton", spec: sideButtons.leftSpecial, roleName: "left-special"});
        const start = makeButton({group: dpadGroup, idSuffix: "StartButton", spec: sideButtons.start, roleName: "start"});
        const rightBumper = makeButton({group: dpadGroup, idSuffix: "RightBumperButton", spec: sideButtons.rightBumper, roleName: "right-bumper"});
        const rightSpecial = makeButton({group: dpadGroup, idSuffix: "RightSpecialButton", spec: sideButtons.rightSpecial, roleName: "right-special"});
        const rightTrigger = makeButton({group: dpadGroup, idSuffix: "RightTriggerButton", spec: sideButtons.rightTrigger, roleName: "right-trigger"});

        let analogAreaGroup = null;
        let analogArea = null;
        let analogStickGroup = null;
        let analogStick = null;
        let analogStickRing = null;
        let analogStickControl = null;

        if (hasAnalogStick) {
            analogAreaGroup = this.#context.addChild(
                createSvgElement("g", {id: `${sidePrefix}AnalogAreaGroup`} ),
                {parent: backgroundGroup},
            );
            const analogAreaRegion = Region.fromCenter({
                center: sideButtons.analogArea.region.center,
                size: sideButtons.analogArea.region.size.clone(),
            });
            analogArea = this.#createButton({
                group: analogAreaGroup,
                id: `${sidePrefix}AnalogArea`,
                region: analogAreaRegion,
                shapeType: ShapeType.ELLIPSE,
                includeBorder: true,
                includeOuterBorder: sideButtons.analogArea.includeOuterBorder !== false,
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
            analogStick = this.#createButton({
                group: analogStickGroup,
                id: `${sidePrefix}AnalogStick`,
                region: sideButtons.analogStick.region,
                shapeType: ShapeType.ELLIPSE,
                includeBorder: true,
                includeOuterBorder: sideButtons.analogStick.includeOuterBorder !== false,
                semanticClasses: [`side-${sideName}`, "role-analog-stick"],
                semanticAttributes: {"data-side": sideName, "data-role": "analog-stick"},
                // Stick movement is analog; stick click state (LS/RS) is digital.
                pressMode: "digital",
                digitalRenderMode: "class-toggle",
            });
            analogStickRing = this.#createButton({
                group: analogStickGroup,
                id: `${sidePrefix}AnalogStickRing`,
                region: sideButtons.analogStickRing.region,
                shapeType: ShapeType.ELLIPSE,
                includeBorder: true,
                includeOuterBorder: sideButtons.analogStickRing.includeOuterBorder === true,
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
            analogStickControl = new CompositeControl({
                translationTarget: new RenderableControl(analogStick),
                pressTargets: [new RenderableControl(analogStick), new RenderableControl(analogStickRing)],
                layerTargets: [new RenderableControl(analogStickRing)],
            });
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
                analogStickControl,
            },
        };
    }

    #build({hasAnalogStick}) {
        const rootGroup = this.#context.addChild(createSvgElement("g", {id: "gamepadOverlayGroup"}));

        const left = this.#buildSide({
            sidePrefix: "left",
            sideName: "left",
            layout: this.#leftLayout,
            sideButtons: this.#model.buttons.left,
            topGroup: rootGroup,
            hasAnalogStick,
            drawCrossBorder: true,
        });

        const right = this.#buildSide({
            sidePrefix: "right",
            sideName: "right",
            layout: this.#rightLayout,
            sideButtons: this.#model.buttons.right,
            topGroup: rootGroup,
            hasAnalogStick,
            drawCrossBorder: false,
        });

        return {rootGroup, left, right};
    }

}

const GamepadOverlay = SvgGamepadOverlay;
