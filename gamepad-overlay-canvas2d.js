const CanvasCore = OverlayCore;
const canvasBuildRasterRenderPlans = OverlayDomain.buildRasterRenderPlans;
const canvasBuildButtonDrawOps = OverlayDomain.buildButtonDrawOps;
const canvasBuildStickDrawOps = OverlayDomain.buildStickDrawOps;
const CanvasBorderModel = OverlayDomain.BorderModel;

class Canvas2DGamepadOverlayRenderer {
    #canvas;
    #ctx;
    #model;
    #theme;
    #borderModel;
    #queuedState;
    #renderScheduled;
    #lastRenderMs;
    #minFrameMs;

    constructor({canvas, model, maxFps = 0}) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext("2d", {alpha: true, desynchronized: true});
        this.#model = model;
        this.#theme = this.#buildTheme();
        this.#borderModel = new CanvasBorderModel({innerSize: this.#model.borderWidth});
        this.#queuedState = null;
        this.#renderScheduled = false;
        this.#lastRenderMs = 0;
        const parsedMaxFps = Number(maxFps) || 0;
        this.#minFrameMs = parsedMaxFps > 0 ? (1000 / Math.max(1, parsedMaxFps)) : 0;
        this.resize();
    }

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
        this.#borderModel = new CanvasBorderModel({innerSize: this.#model.borderWidth});
        this.draw();
    }

    applyState(state) {
        this.#queuedState = state;
        if (!this.#renderScheduled) {
            this.#renderScheduled = true;
            requestAnimationFrame((now) => this.#onAnimationFrame(now));
        }
    }

    #onAnimationFrame(now) {
        this.#renderScheduled = false;
        if (!this.#queuedState) {
            return;
        }
        if (now - this.#lastRenderMs < this.#minFrameMs) {
            this.#renderScheduled = true;
            requestAnimationFrame((nextNow) => this.#onAnimationFrame(nextNow));
            return;
        }
        applyGamepadStateToModel(this.#model, this.#queuedState);
        this.#queuedState = null;
        this.#lastRenderMs = now;
        this.draw();
    }

    #buildTheme() {
        const root = getComputedStyle(document.documentElement);
        return OverlayTheme.buildThemeForCanvas2D({rootStyles: root});
    }

    #resolveColor(colorSpec) {
        if (!colorSpec || colorSpec.mode === "solid") {
            return this.#theme[colorSpec?.token || "idle"];
        }
        if (colorSpec.mode === "blend") {
            return mixColor(this.#theme[colorSpec.baseToken], this.#theme[colorSpec.pressedToken], colorSpec.amount);
        }
        return this.#theme.idle;
    }

    #trianglePressPolygon(points, amount, direction) {
        const resolvedDirection = direction || "outward";
        const pickAnchorIndex = () => {
            if (resolvedDirection === "up") {
                return points.reduce((best, point, index) => (point.y < points[best].y ? index : best), 0);
            }
            if (resolvedDirection === "down") {
                return points.reduce((best, point, index) => (point.y > points[best].y ? index : best), 0);
            }
            if (resolvedDirection === "left") {
                return points.reduce((best, point, index) => (point.x < points[best].x ? index : best), 0);
            }
            if (resolvedDirection === "right") {
                return points.reduce((best, point, index) => (point.x > points[best].x ? index : best), 0);
            }
            return 0;
        };
        const anchorIndex = pickAnchorIndex();
        const baseAIndex = (anchorIndex + 1) % points.length;
        const baseBIndex = (anchorIndex + 2) % points.length;
        const anchor = points[anchorIndex];
        const baseA = points[baseAIndex];
        const baseB = points[baseBIndex];
        const edgeA = new CanvasCore.Vector2({x: baseA.x + (anchor.x - baseA.x) * amount, y: baseA.y + (anchor.y - baseA.y) * amount});
        const edgeB = new CanvasCore.Vector2({x: baseB.x + (anchor.x - baseB.x) * amount, y: baseB.y + (anchor.y - baseB.y) * amount});
        return [baseA, baseB, edgeB, edgeA];
    }

    #ellipseSeamOverlapPx(innerShape, outerShape) {
        const outerRegion = outerShape?.region;
        const innerRegion = innerShape?.region;
        if (!outerRegion || !innerRegion) {
            return 0;
        }
        const radialX = Math.max(0, outerRegion.halfSize.x - innerRegion.halfSize.x);
        const radialY = Math.max(0, outerRegion.halfSize.y - innerRegion.halfSize.y);
        const minRadial = Math.min(radialX, radialY);
        if (!(minRadial > 0)) {
            return 0;
        }
        return Math.min(0.75, Math.max(0.2, minRadial * 0.2));
    }

    #insetEllipseShape(shapeModel, insetPx) {
        if (!Number.isFinite(insetPx) || insetPx === 0 || shapeModel.shapeType !== "ellipse") {
            return shapeModel;
        }
        const region = shapeModel.region;
        const insetSizeX = Math.max(0, region.size.x - insetPx * 2);
        const insetSizeY = Math.max(0, region.size.y - insetPx * 2);
        return {
            shapeType: "ellipse",
            cornerRadiusPercent: shapeModel.cornerRadiusPercent,
            region: CanvasCore.Region.fromCenter({
                center: region.center,
                size: new CanvasCore.Vector2({x: insetSizeX, y: insetSizeY}),
            }),
        };
    }

    #shapePath(shapeModel, {append = false} = {}) {
        const region = shapeModel.region;
        const shapeType = shapeModel.shapeType;
        const ctx = this.#ctx;
        if (!append) {
            ctx.beginPath();
        }
        if (shapeType === "ellipse") {
            ctx.ellipse(region.center.x, region.center.y, region.halfSize.x, region.halfSize.y, 0, 0, Math.PI * 2);
            return;
        }
        if (shapeType === "triDown") {
            ctx.moveTo(region.bottomCenter.x, region.bottomCenter.y);
            ctx.lineTo(region.topLeft.x, region.topLeft.y);
            ctx.lineTo(region.topRight.x, region.topRight.y);
            ctx.closePath();
            return;
        }
        const percent = shapeModel.cornerRadiusPercent;
        const px = Number(percent?.x);
        const py = Number(percent?.y);
        const radius = (Number.isFinite(px) && Number.isFinite(py))
            ? Math.max(0, Math.min(region.halfSize.x * px, region.halfSize.y * py))
            : 0;
        ctx.roundRect(region.topLeft.x, region.topLeft.y, region.size.x, region.size.y, radius);
    }

    #drawShapeFill(shapeModel, color) {
        const ctx = this.#ctx;
        this.#shapePath(shapeModel);
        ctx.fillStyle = colorToCss(color);
        ctx.fill();
    }

    #drawTriangleStroke(points, strokeColor, strokeWidth) {
        const ctx = this.#ctx;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.closePath();
        ctx.strokeStyle = colorToCss(strokeColor);
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = "miter";
        ctx.lineCap = "butt";
        ctx.miterLimit = 2;
        ctx.stroke();
    }

    #drawRoundedRing(innerShape, outerShape, color) {
        const ctx = this.#ctx;
        ctx.beginPath();
        const outerRegion = outerShape.region;
        const outerPercent = outerShape.cornerRadiusPercent;
        const outerRadius = Math.max(0, Math.min(outerRegion.halfSize.x * outerPercent.x, outerRegion.halfSize.y * outerPercent.y));
        ctx.roundRect(outerRegion.topLeft.x, outerRegion.topLeft.y, outerRegion.size.x, outerRegion.size.y, outerRadius);
        const innerRegion = innerShape.region;
        const innerPercent = innerShape.cornerRadiusPercent;
        const innerRadius = Math.max(0, Math.min(innerRegion.halfSize.x * innerPercent.x, innerRegion.halfSize.y * innerPercent.y));
        ctx.roundRect(innerRegion.topLeft.x, innerRegion.topLeft.y, innerRegion.size.x, innerRegion.size.y, innerRadius);
        ctx.fillStyle = colorToCss(color);
        ctx.fill("evenodd");
    }

    #executeDrawOps(ops) {
        for (let index = 0; index < ops.length; index += 1) {
            const op = ops[index];
            const nextOp = ops[index + 1] ?? null;

            const isSolidToken = (colorSpec, token) =>
                colorSpec != null && colorSpec.mode === "solid" && colorSpec.token === token;

            const isTriangleUnderfillPair = op.kind === "polygonFill"
                && nextOp?.kind === "polygonFill"
                && isSolidToken(op.color, "borderInner")
                && nextOp.points === op.points;

            if (isTriangleUnderfillPair) {
                continue;
            }

            if (op.kind === "shapeFill") {
                this.#drawShapeFill(op.shapeModel, this.#resolveColor(op.color));
                continue;
            }
            if (op.kind === "triangleStroke") {
                this.#drawTriangleStroke(op.points, this.#resolveColor(op.color), op.strokeWidth);
                continue;
            }
            if (op.kind === "polygonFill") {
                const ctx = this.#ctx;
                ctx.beginPath();
                ctx.moveTo(op.points[0].x, op.points[0].y);
                for (let index = 1; index < op.points.length; index += 1) {
                    ctx.lineTo(op.points[index].x, op.points[index].y);
                }
                ctx.closePath();
                ctx.fillStyle = colorToCss(this.#resolveColor(op.color));
                ctx.fill();
                continue;
            }
            if (op.kind === "polygonRing") {
                const ctx = this.#ctx;
                ctx.beginPath();
                ctx.moveTo(op.outerPoints[0].x, op.outerPoints[0].y);
                for (let index = 1; index < op.outerPoints.length; index += 1) {
                    ctx.lineTo(op.outerPoints[index].x, op.outerPoints[index].y);
                }
                ctx.closePath();
                ctx.moveTo(op.innerPoints[0].x, op.innerPoints[0].y);
                for (let index = 1; index < op.innerPoints.length; index += 1) {
                    ctx.lineTo(op.innerPoints[index].x, op.innerPoints[index].y);
                }
                ctx.closePath();
                ctx.fillStyle = colorToCss(this.#resolveColor(op.color));
                ctx.fill("evenodd");
                continue;
            }
            if (op.kind === "trianglePressFill") {
                const polygon = this.#trianglePressPolygon(op.points, op.amount, op.direction);
                const ctx = this.#ctx;
                ctx.beginPath();
                ctx.moveTo(polygon[0].x, polygon[0].y);
                ctx.lineTo(polygon[1].x, polygon[1].y);
                ctx.lineTo(polygon[2].x, polygon[2].y);
                ctx.lineTo(polygon[3].x, polygon[3].y);
                ctx.closePath();
                ctx.fillStyle = colorToCss(this.#resolveColor(op.color));
                ctx.fill();
                continue;
            }
            if (op.kind === "borderRing" || op.kind === "roundedBorderRing") {
                const isInnerBlackRing = op.color?.mode === "solid"
                    && op.color?.token === "borderInner"
                    && op.composite === "stick";
                if (isInnerBlackRing && op.innerShape?.shapeType === "ellipse" && op.outerShape?.shapeType === "ellipse") {
                    const seamPx = this.#ellipseSeamOverlapPx(op.innerShape, op.outerShape);
                    const expandedOuter = this.#insetEllipseShape(op.outerShape, -seamPx * 0.5);
                    const insetInner = this.#insetEllipseShape(op.innerShape, seamPx * 1.25);
                    this.#drawRingBetween(insetInner, expandedOuter, this.#resolveColor(op.color));
                } else {
                    this.#drawRingBetween(op.innerShape, op.outerShape, this.#resolveColor(op.color));
                }
                continue;
            }
            if (op.kind === "cutoutShape") {
                const ctx = this.#ctx;
                ctx.save();
                ctx.globalCompositeOperation = "destination-out";
                this.#shapePath(op.shapeModel);
                ctx.fillStyle = "rgba(0,0,0,1)";
                ctx.fill();
                ctx.restore();
                continue;
            }
        }
    }

    #drawRingBetween(innerShape, outerShape, color) {
        const ctx = this.#ctx;
        const adjustedInnerShape = (() => {
            if (innerShape?.shapeType === "ellipse" && outerShape?.shapeType === "ellipse") {
                return this.#insetEllipseShape(innerShape, this.#ellipseSeamOverlapPx(innerShape, outerShape));
            }
            return innerShape;
        })();
        ctx.beginPath();
        this.#shapePath(outerShape, {append: true});
        this.#shapePath(adjustedInnerShape, {append: true});
        ctx.fillStyle = colorToCss(color);
        ctx.fill("evenodd");
    }

    #drawCrossBorder(points) {
        const crossFacePoints = points;
        const crossCenter = this.#model.leftLayout.origin.center;
        const expandFromCenter = (polygonPoints, distance) => polygonPoints.map((point) => {
            const deltaX = point.x - crossCenter.x;
            const deltaY = point.y - crossCenter.y;
            const length = Math.hypot(deltaX, deltaY);
            if (!(length > 0)) {
                return point;
            }
            const scale = (length + distance) / length;
            return new CanvasCore.Vector2({x: crossCenter.x + (deltaX * scale), y: crossCenter.y + (deltaY * scale)});
        });
        const crossBlackOuterPoints = expandFromCenter(crossFacePoints, this.#borderModel.halfWidth);
        const crossWhiteOuterPoints = expandFromCenter(crossFacePoints, this.#borderModel.width);
        this.#executeDrawOps([
            {kind: "polygonRing", innerPoints: crossBlackOuterPoints, outerPoints: crossWhiteOuterPoints, color: {mode: "solid", token: "borderOuter"}},
            {kind: "polygonRing", innerPoints: crossFacePoints, outerPoints: crossBlackOuterPoints, color: {mode: "solid", token: "borderInner"}},
        ]);
    }

    #cutoutCrossUnderDpadButtons() {
        const buttons = this.#model.buttons.left;
        const ctx = this.#ctx;
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        for (const key of ["left", "right", "up", "down", "origin"]) {
            const button = buttons[key];
            if (!button) {
                continue;
            }
            this.#shapePath({
                shapeType: button.shape,
                region: button.region,
                cornerRadiusPercent: button.cornerRadiusPercent ?? 0,
            });
            ctx.fillStyle = "rgba(0,0,0,1)";
            ctx.fill();
        }
        ctx.restore();
    }

    draw() {
        const ctx = this.#ctx;
        const state = this.#model.state;
        ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);

        this.#drawCrossBorder(this.#model.leftLayout.crossPoints);
        this.#cutoutCrossUnderDpadButtons();

        const plans = canvasBuildRasterRenderPlans({
            model: this.#model,
            state,
            clampOffset: ({offset, halfSize}) => CanvasCore.clampNormalizedOffsetToEllipse({offset, halfSize}),
        });

        for (const plan of plans.buttonPlans) {
            const ops = canvasBuildButtonDrawOps({
                shapeModel: plan.shapeModel,
                borderModel: this.#borderModel,
                inputAmount: plan.inputAmount,
                pressMode: plan.pressMode,
                pressFillDirection: plan.pressFillDirection,
                baseColorToken: plan.baseColorToken,
                pressedColorToken: plan.pressedColorToken,
                includeOuterBorder: plan.includeOuterBorder,
            });
            this.#executeDrawOps(ops);
        }

        for (const plan of plans.stickPlans) {
            const ops = canvasBuildStickDrawOps({
                stickShape: plan.stickShape,
                ringShape: plan.ringShape,
                borderModel: this.#borderModel,
                fillColorSpec: plan.fillColorSpec,
                stickIncludeOuterBorder: plan.stickIncludeOuterBorder,
                ringIncludeOuterBorder: plan.ringIncludeOuterBorder,
            });
            this.#executeDrawOps(ops);
        }
    }
}
