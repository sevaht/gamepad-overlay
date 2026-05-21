(() => {
    const Vector2 = OverlayCore.Vector2;
    const Region = OverlayCore.Region;

    class OverlayShapeModel {
        #region;
        #shapeType;
        #cornerRadiusPercent;

        constructor({region, shapeType, cornerRadiusPercent = 0}) {
            this.#region = region;
            this.#shapeType = shapeType;
            this.#cornerRadiusPercent = this.#normalizeCornerRadiusPercent(cornerRadiusPercent);
        }

        get region() { return this.#region; }
        get shapeType() { return this.#shapeType; }
        get cornerRadiusPercent() { return this.#cornerRadiusPercent; }

        #normalizeCornerRadiusPercent(value) {
            if (value == null) {
                return Vector2.ZERO;
            }
            if (value instanceof Vector2) {
                return value;
            }
            if (typeof value === "number") {
                return Vector2.splat(value);
            }
            const x = Number(value.x);
            const y = Number(value.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                return new Vector2({x, y});
            }
            return Vector2.ZERO;
        }

        expanded(arg1, arg2) {
            const amount = typeof arg2 === "number" ? arg2 : arg1;
            if (!(amount > 0)) {
                return this;
            }
            const expandRegion = typeof arg2 === "number"
                ? (region, value) => arg1.expandRegion(region, value)
                : (region, value) => Region.fromCenter({
                    center: region.center,
                    size: region.size.clone().add(Vector2.splat(value * 2)),
                });
            const expandedRegion = expandRegion(this.#region, amount);
            let cornerRadiusPercent = this.#cornerRadiusPercent;
            if (this.#shapeType === "rect" || (typeof ShapeType !== "undefined" && this.#shapeType === ShapeType.RECTANGLE)) {
                const originalRadiusX = this.#region.halfSize.x * this.#cornerRadiusPercent.x;
                const originalRadiusY = this.#region.halfSize.y * this.#cornerRadiusPercent.y;
                const expandedRadiusX = Math.min(expandedRegion.halfSize.x, Math.max(0, originalRadiusX + amount));
                const expandedRadiusY = Math.min(expandedRegion.halfSize.y, Math.max(0, originalRadiusY + amount));
                cornerRadiusPercent = new Vector2({
                    x: expandedRegion.halfSize.x === 0 ? 0 : expandedRadiusX / expandedRegion.halfSize.x,
                    y: expandedRegion.halfSize.y === 0 ? 0 : expandedRadiusY / expandedRegion.halfSize.y,
                });
            }
            return new OverlayShapeModel({
                region: expandedRegion,
                shapeType: this.#shapeType,
                cornerRadiusPercent,
            });
        }

        trianglePoints() {
            const shapeType = this.#shapeType;
            const region = this.#region;
            if (shapeType === "triUp" || (typeof ShapeType !== "undefined" && shapeType === ShapeType.TRIANGLE_UP)) {
                return [region.topCenter, region.bottomLeft, region.bottomRight];
            }
            if (shapeType === "triDown" || (typeof ShapeType !== "undefined" && shapeType === ShapeType.TRIANGLE_DOWN)) {
                return [region.bottomCenter, region.topLeft, region.topRight];
            }
            if (shapeType === "triLeft" || (typeof ShapeType !== "undefined" && shapeType === ShapeType.TRIANGLE_LEFT)) {
                return [region.centerLeft, region.topRight, region.bottomRight];
            }
            if (shapeType === "triRight" || (typeof ShapeType !== "undefined" && shapeType === ShapeType.TRIANGLE_RIGHT)) {
                return [region.centerRight, region.topLeft, region.bottomLeft];
            }
            return null;
        }
    }

    class OverlayBorderModel {
        #innerSize;
        constructor({innerSize = 0} = {}) {
            this.#innerSize = Math.max(0, Number(innerSize) || 0);
        }
        get innerSize() { return this.#innerSize; }
        get halfInnerSize() { return this.#innerSize / 2; }
        get width() { return this.#innerSize; }
        get halfWidth() { return this.#innerSize / 2; }
        appliesToBordered(includeBorder) {
            return Boolean(includeBorder) && this.#innerSize > 0;
        }
        expandAmount() {
            return this.#innerSize / 2;
        }
        expandedShape(shapeModel, includeBorder) {
            if (!this.appliesToBordered(includeBorder)) {
                return shapeModel;
            }
            return shapeModel.expanded(this.expandAmount());
        }
        expandedRegion(builder, region) {
            return builder.expandRegion(region, this.#innerSize);
        }
        expandedRegionHalf(builder, region) {
            return builder.expandRegion(region, this.#innerSize / 2);
        }
    }

    class OverlayControlRenderPlan {
        constructor(values) {
            Object.assign(this, values);
        }
    }

    class OverlayStickRenderPlan {
        constructor(values) {
            Object.assign(this, values);
        }
    }

    function resolveStickOffset({offset, halfSize, clampOffset}) {
        if (typeof clampOffset === "function") {
            return clampOffset({offset, halfSize});
        }
        if (typeof clampNormalizedOffsetToEllipse === "function") {
            return clampNormalizedOffsetToEllipse({offset, halfSize});
        }
        const x = Math.max(-1, Math.min(1, Number(offset?.x) || 0));
        const y = Math.max(-1, Math.min(1, Number(offset?.y) || 0));
        const length = Math.hypot(x, y);
        const scale = length > 1 ? (1 / length) : 1;
        return new Vector2({x: x * scale * halfSize.x, y: y * scale * halfSize.y});
    }

    function buildRasterRenderPlans({model, state, clampOffset}) {
        const buttonPlans = [];
        const pushButtonPlan = (buttonSpec, baseColorToken, inputAmount, pressedColorToken = "pressed") => {
            if (!buttonSpec) {
                return;
            }
            buttonPlans.push(new OverlayControlRenderPlan({
                shapeModel: new OverlayShapeModel({
                    region: buttonSpec.region,
                    shapeType: buttonSpec.shape,
                    cornerRadiusPercent: buttonSpec.cornerRadiusPercent || 0,
                }),
                baseColorToken,
                pressedColorToken,
                inputAmount,
                pressMode: buttonSpec.pressMode || "digital",
                includeOuterBorder: buttonSpec.includeOuterBorder !== false,
            }));
        };

        pushButtonPlan(model.buttons.left.leftBumper, "idle", state.LB);
        pushButtonPlan(model.buttons.left.select, "idle", state.SELECT);
        pushButtonPlan(model.buttons.left.leftTrigger, "idle", state.LT);
        pushButtonPlan(model.buttons.right.start, "idle", state.START);
        pushButtonPlan(model.buttons.right.rightBumper, "idle", state.RB);
        pushButtonPlan(model.buttons.right.rightTrigger, "idle", state.RT);
        pushButtonPlan(model.buttons.left.left, "idle", state.DX < 0 ? 1 : 0);
        pushButtonPlan(model.buttons.left.right, "idle", state.DX > 0 ? 1 : 0);
        pushButtonPlan(model.buttons.left.up, "idle", state.DY < 0 ? 1 : 0);
        pushButtonPlan(model.buttons.left.down, "idle", state.DY > 0 ? 1 : 0);
        pushButtonPlan(model.buttons.left.origin, "idle", 0);
        pushButtonPlan(model.buttons.right.up, "rightFaceUp", state.Y, "rightFacePressedUp");
        pushButtonPlan(model.buttons.right.right, "rightFaceRight", state.B, "rightFacePressedRight");
        pushButtonPlan(model.buttons.right.left, "rightFaceLeft", state.X, "rightFacePressedLeft");
        pushButtonPlan(model.buttons.right.down, "rightFaceDown", state.A, "rightFacePressedDown");
        pushButtonPlan(model.buttons.left.analogArea, "black", 0);
        pushButtonPlan(model.buttons.right.analogArea, "black", 0);

        const leftStickOffset = resolveStickOffset({
            offset: {x: state.LX, y: state.LY},
            halfSize: model.leftLayout.origin.halfSize,
            clampOffset,
        });
        const rightStickOffset = resolveStickOffset({
            offset: {x: state.RX, y: state.RY},
            halfSize: model.rightLayout.origin.halfSize,
            clampOffset,
        });
        const leftStickRegion = model.buttons.left.analogStick.region.clone().update({topLeft: model.buttons.left.analogStick.region.topLeft.clone().add(leftStickOffset)});
        const rightStickRegion = model.buttons.right.analogStick.region.clone().update({topLeft: model.buttons.right.analogStick.region.topLeft.clone().add(rightStickOffset)});
        const leftRingRegion = model.buttons.left.analogStickRing.region.clone().update({topLeft: model.buttons.left.analogStickRing.region.topLeft.clone().add(leftStickOffset)});
        const rightRingRegion = model.buttons.right.analogStickRing.region.clone().update({topLeft: model.buttons.right.analogStickRing.region.topLeft.clone().add(rightStickOffset)});

        const stickPlans = [
            new OverlayStickRenderPlan({
                stickShape: new OverlayShapeModel({region: leftStickRegion, shapeType: "ellipse"}),
                ringShape: new OverlayShapeModel({region: leftRingRegion, shapeType: "ellipse"}),
                fillColorSpec: {mode: "blend", baseToken: "idle", pressedToken: "pressed", amount: state.LS},
                stickIncludeOuterBorder: model.buttons.left.analogStick?.includeOuterBorder !== false,
                ringIncludeOuterBorder: model.buttons.left.analogStickRing?.includeOuterBorder === true,
            }),
            new OverlayStickRenderPlan({
                stickShape: new OverlayShapeModel({region: rightStickRegion, shapeType: "ellipse"}),
                ringShape: new OverlayShapeModel({region: rightRingRegion, shapeType: "ellipse"}),
                fillColorSpec: {mode: "blend", baseToken: "idle", pressedToken: "pressed", amount: state.RS},
                stickIncludeOuterBorder: model.buttons.right.analogStick?.includeOuterBorder !== false,
                ringIncludeOuterBorder: model.buttons.right.analogStickRing?.includeOuterBorder === true,
            }),
        ];

        return {buttonPlans, stickPlans};
    }

    function solidColor(token) {
        return {mode: "solid", token};
    }

    function blendColor(baseToken, pressedToken, amount) {
        return {mode: "blend", baseToken, pressedToken, amount: Math.max(0, Math.min(1, Number(amount) || 0))};
    }

    function polygonSignedArea(points) {
        let area = 0;
        for (let index = 0; index < points.length; index += 1) {
            const current = points[index];
            const next = points[(index + 1) % points.length];
            area += (current.x * next.y) - (next.x * current.y);
        }
        return area / 2;
    }

    function lineIntersection(a1, a2, b1, b2) {
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

    function offsetConvexPolygon(points, distance) {
        if (!(distance > 0) || points.length < 3) {
            return points;
        }
        const area = polygonSignedArea(points);
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
            return lineIntersection(previousEdge.a, previousEdge.b, nextEdge.a, nextEdge.b) ?? point.clone();
        });
    }

    function buildButtonDrawOps({shapeModel, borderModel, inputAmount = 0, pressMode = "digital", baseColorToken = "idle", pressedColorToken = "pressed", includeOuterBorder = true}) {
        const ops = [];
        const blendedFaceColor = blendColor(baseColorToken, pressedColorToken, inputAmount);
        const isTriangle = typeof shapeModel.shapeType === "string" && shapeModel.shapeType.startsWith("tri");

        if (isTriangle) {
            const facePoints = shapeModel.trianglePoints();
            const blackOuterPoints = offsetConvexPolygon(facePoints, borderModel.halfWidth);
            const whiteOuterPoints = offsetConvexPolygon(facePoints, borderModel.width);
            if (includeOuterBorder) {
                ops.push({kind: "polygonRing", innerPoints: blackOuterPoints, outerPoints: whiteOuterPoints, color: solidColor("borderOuter")});
            }
            ops.push({kind: "polygonRing", innerPoints: facePoints, outerPoints: blackOuterPoints, color: solidColor("borderInner")});
            ops.push({kind: "polygonFill", points: facePoints, color: solidColor("borderInner")});
            ops.push({kind: "polygonFill", points: facePoints, color: solidColor(baseColorToken)});
            if (pressMode === "analog" && inputAmount > 0.01) {
                ops.push({kind: "trianglePressFill", points: facePoints, amount: Math.max(0, Math.min(1, Number(inputAmount) || 0)), color: solidColor(pressedColorToken)});
            }
            return ops;
        }

        const halfExpanded = shapeModel.expanded(borderModel.halfWidth);
        const fullExpanded = shapeModel.expanded(borderModel.width);
        if (includeOuterBorder) {
            ops.push({kind: "borderRing", innerShape: halfExpanded, outerShape: fullExpanded, color: solidColor("borderOuter")});
        }
        ops.push({kind: "borderRing", innerShape: shapeModel, outerShape: halfExpanded, color: solidColor("borderInner")});
        ops.push({kind: "shapeFill", shapeModel, color: blendedFaceColor});
        return ops;
    }

    function buildStickDrawOps({stickShape, ringShape, borderModel, fillColorSpec = solidColor("idle"), stickIncludeOuterBorder = true, ringIncludeOuterBorder = false}) {
        const ops = [];
        const ringRegion = ringShape.region;
        const whiteOuterRegion = borderModel.expandedRegion({expandRegion: (r, amount) => Region.fromCenter({center: r.center, size: r.size.clone().add(Vector2.splat(amount * 2))})}, ringRegion);
        const whiteInnerRegion = Region.fromCenter({
            center: whiteOuterRegion.center,
            size: whiteOuterRegion.size.clone().add(Vector2.splat(-borderModel.halfWidth * 2)),
        });
        const blackOuterRegion = whiteInnerRegion;
        const blackInnerRegion = Region.fromCenter({
            center: blackOuterRegion.center,
            size: blackOuterRegion.size.clone().add(Vector2.splat(-borderModel.halfWidth * 2)),
        });

        const stickOuterShape = stickShape.expanded(borderModel.width);
        const ringOuterRegion = ringIncludeOuterBorder ? whiteOuterRegion : whiteInnerRegion;
        const ringOuterShape = new OverlayShapeModel({region: ringOuterRegion, shapeType: "ellipse"});

        ops.push({kind: "cutoutShape", shapeModel: stickOuterShape});
        if (stickIncludeOuterBorder) {
            ops.push({kind: "borderRing", innerShape: stickShape.expanded(borderModel.halfWidth), outerShape: stickOuterShape, color: solidColor("borderOuter"), composite: "stick"});
        }
        ops.push({kind: "borderRing", innerShape: stickShape, outerShape: stickShape.expanded(borderModel.halfWidth), color: solidColor("borderInner"), composite: "stick"});
        ops.push({kind: "cutoutShape", shapeModel: stickShape});
        ops.push({kind: "shapeFill", shapeModel: stickShape, color: fillColorSpec});

        ops.push({kind: "cutoutShape", shapeModel: ringOuterShape});
        if (ringIncludeOuterBorder) {
            ops.push({kind: "borderRing", innerShape: new OverlayShapeModel({region: whiteInnerRegion, shapeType: "ellipse"}), outerShape: ringOuterShape, color: solidColor("borderOuter"), composite: "stick"});
        }
        ops.push({kind: "cutoutShape", shapeModel: new OverlayShapeModel({region: whiteInnerRegion, shapeType: "ellipse"})});
        ops.push({kind: "shapeFill", shapeModel: new OverlayShapeModel({region: whiteInnerRegion, shapeType: "ellipse"}), color: fillColorSpec});
        ops.push({kind: "borderRing", innerShape: new OverlayShapeModel({region: blackInnerRegion, shapeType: "ellipse"}), outerShape: new OverlayShapeModel({region: blackOuterRegion, shapeType: "ellipse"}), color: solidColor("borderInner"), composite: "stick"});
        ops.push({kind: "cutoutShape", shapeModel: new OverlayShapeModel({region: blackInnerRegion, shapeType: "ellipse"})});
        ops.push({kind: "shapeFill", shapeModel: new OverlayShapeModel({region: blackInnerRegion, shapeType: "ellipse"}), color: fillColorSpec});
        return ops;
    }

    window.OverlayDomain = Object.freeze({
        ShapeModel: OverlayShapeModel,
        BorderModel: OverlayBorderModel,
        ControlRenderPlan: OverlayControlRenderPlan,
        StickRenderPlan: OverlayStickRenderPlan,
        offsetConvexPolygon,
        buildButtonDrawOps,
        buildStickDrawOps,
        buildRasterRenderPlans,
    });
})();
