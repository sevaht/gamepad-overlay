const CanvasCore = OverlayCore;
const buildRasterRenderPlans = OverlayDomain.buildRasterRenderPlans;
const buildButtonDrawOps = OverlayDomain.buildButtonDrawOps;
const buildStickDrawOps = OverlayDomain.buildStickDrawOps;
const CanvasBorderModel = OverlayDomain.BorderModel;

class Canvas2DGamepadOverlayRenderer {
    #canvas;
    #ctx;
    #model;
    #theme;
    #borderModel;

    constructor({canvas, model}) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext("2d", {alpha: true, desynchronized: true});
        this.#model = model;
        this.#theme = this.#buildTheme();
        this.#borderModel = new CanvasBorderModel({innerSize: Math.max(2.5, this.#model.borderWidth)});
        this.resize();
    }

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
        this.#borderModel = new CanvasBorderModel({innerSize: Math.max(2.5, this.#model.borderWidth)});
        this.draw();
    }

    applyState(state) {
        applyGamepadStateToModel(this.#model, state);
        this.draw();
    }

    #buildTheme() {
        const root = getComputedStyle(document.documentElement);
        const idleRgb = parseCssRgbTriplet(root.getPropertyValue("--btn-idle-rgb"), [44, 47, 51]);
        const idleAlpha = Number.parseFloat(root.getPropertyValue("--btn-idle-alpha")) || 0.7;
        return {
            idle: [idleRgb[0], idleRgb[1], idleRgb[2], idleAlpha],
            pressed: [63, 140, 255, 1],
            black: [0, 0, 0, 1],
            borderOuter: [255, 255, 255, 1],
            borderInner: [0, 0, 0, 1],
            rightFaceUp: [95, 95, 31, idleAlpha],
            rightFaceRight: [95, 31, 31, idleAlpha],
            rightFaceLeft: [31, 31, 95, idleAlpha],
            rightFaceDown: [31, 79, 32, idleAlpha],
            rightFacePressedUp: [255, 255, 51, 1],
            rightFacePressedRight: [255, 51, 51, 1],
            rightFacePressedLeft: [51, 119, 255, 1],
            rightFacePressedDown: [63, 207, 63, 1],
        };
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
                const points = op.points;
                const leftEdgePoint = new CanvasCore.Vector2({x: points[1].x + (points[0].x - points[1].x) * op.amount, y: points[1].y + (points[0].y - points[1].y) * op.amount});
                const rightEdgePoint = new CanvasCore.Vector2({x: points[2].x + (points[0].x - points[2].x) * op.amount, y: points[2].y + (points[0].y - points[2].y) * op.amount});
                const ctx = this.#ctx;
                ctx.beginPath();
                ctx.moveTo(points[1].x, points[1].y);
                ctx.lineTo(points[2].x, points[2].y);
                ctx.lineTo(rightEdgePoint.x, rightEdgePoint.y);
                ctx.lineTo(leftEdgePoint.x, leftEdgePoint.y);
                ctx.closePath();
                ctx.fillStyle = colorToCss(this.#resolveColor(op.color));
                ctx.fill();
                continue;
            }
            if (op.kind === "borderRing" || op.kind === "roundedBorderRing") {
                this.#drawRingBetween(op.innerShape, op.outerShape, this.#resolveColor(op.color));
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
        ctx.beginPath();
        this.#shapePath(outerShape, {append: true});
        this.#shapePath(innerShape, {append: true});
        ctx.fillStyle = colorToCss(color);
        ctx.fill("evenodd");
    }

    #drawCrossBorder(points) {
        const ctx = this.#ctx;
        const draw = (color, width) => {
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (let index = 1; index < points.length; index += 1) {
                ctx.lineTo(points[index].x, points[index].y);
            }
            ctx.closePath();
            ctx.strokeStyle = colorToCss(color);
            ctx.lineWidth = width;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.stroke();
        };
        draw(this.#theme.borderOuter, this.#model.borderWidth * 2);
        draw(this.#theme.borderInner, this.#model.borderWidth);
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

        const plans = buildRasterRenderPlans({
            model: this.#model,
            state,
            clampOffset: ({offset, halfSize}) => CanvasCore.clampNormalizedOffsetToEllipse({offset, halfSize}),
        });

        for (const plan of plans.buttonPlans) {
            const ops = buildButtonDrawOps({
                shapeModel: plan.shapeModel,
                borderModel: this.#borderModel,
                inputAmount: plan.inputAmount,
                pressMode: plan.pressMode,
                baseColorToken: plan.baseColorToken,
                pressedColorToken: plan.pressedColorToken,
            });
            this.#executeDrawOps(ops);
        }

        for (const plan of plans.stickPlans) {
            const ops = buildStickDrawOps({
                stickShape: plan.stickShape,
                ringShape: plan.ringShape,
                borderModel: this.#borderModel,
                fillColorSpec: plan.fillColorSpec,
            });
            this.#executeDrawOps(ops);
        }
    }
}
