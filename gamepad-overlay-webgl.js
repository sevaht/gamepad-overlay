const WebglCore = OverlayCore;
const WebglDomainBorderModel = OverlayDomain.BorderModel;
const webglBuildRasterRenderPlans = OverlayDomain.buildRasterRenderPlans;
const webglBuildButtonDrawOps = OverlayDomain.buildButtonDrawOps;
const webglBuildStickDrawOps = OverlayDomain.buildStickDrawOps;

class WebglBufferStream {
    #gl;
    #posBuffer;
    #colorBuffer;
    #vertexData;
    #colorData;
    #vertexCount;

    constructor(gl) {
        this.#gl = gl;
        this.#posBuffer = gl.createBuffer();
        this.#colorBuffer = gl.createBuffer();
        this.#vertexData = new Float32Array(0);
        this.#colorData = new Float32Array(0);
        this.#vertexCount = 0;
    }

    // Uploads interleaved position/color arrays into dedicated buffers.
    // Call bind() + draw() after upload().

    #ensureFloatCapacity(currentData, requiredLength) {
        if (currentData.length >= requiredLength) {
            return currentData;
        }
        const expandedData = new Float32Array(Math.max(requiredLength, Math.ceil(currentData.length * 1.5) + 1024));
        expandedData.set(currentData);
        return expandedData;
    }

    #copyToFloatArray(sourceValues, targetValues) {
        for (let index = 0; index < sourceValues.length; index += 1) {
            targetValues[index] = sourceValues[index];
        }
    }

    upload(vertices, colors) {
        this.#vertexData = this.#ensureFloatCapacity(this.#vertexData, vertices.length);
        this.#colorData = this.#ensureFloatCapacity(this.#colorData, colors.length);
        this.#copyToFloatArray(vertices, this.#vertexData);
        this.#copyToFloatArray(colors, this.#colorData);
        this.#vertexCount = vertices.length / 2;

        const gl = this.#gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#vertexData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#vertexData.subarray(0, vertices.length));

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#colorData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#colorData.subarray(0, colors.length));
    }

    bind(aPos, aColor) {
        const gl = this.#gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#posBuffer);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#colorBuffer);
        gl.enableVertexAttribArray(aColor);
        gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 0, 0);
    }

    draw() {
        this.#gl.drawArrays(this.#gl.TRIANGLES, 0, this.#vertexCount);
    }

    get vertexCount() {
        return this.#vertexCount;
    }
}

class PerfTracker {
    #enabled;
    #state;
    constructor(enabled = false) {
        this.#enabled = enabled;
        this.#state = {windowStartTimestamp: performance.now(), frameCount: 0, geometryBuildMilliseconds: 0, uploadAndDrawMilliseconds: 0};
    }

    // Records one rendered frame and emits a periodic 1-second summary when enabled.
    addFrame({geometryBuildMilliseconds, uploadAndDrawMilliseconds, dynamicVertexCount, stickVertexCount}) {
        this.#state.frameCount += 1;
        this.#state.geometryBuildMilliseconds += geometryBuildMilliseconds;
        this.#state.uploadAndDrawMilliseconds += uploadAndDrawMilliseconds;
        const nowTimestamp = performance.now();
        if (this.#enabled && nowTimestamp - this.#state.windowStartTimestamp >= 1000) {
            const elapsedSeconds = (nowTimestamp - this.#state.windowStartTimestamp) / 1000;
            console.log(`[webgl perf] fps=${(this.#state.frameCount / elapsedSeconds).toFixed(1)} dynVerts=${dynamicVertexCount} stickVerts=${stickVertexCount} build=${(this.#state.geometryBuildMilliseconds / this.#state.frameCount).toFixed(3)}ms upload+draw=${(this.#state.uploadAndDrawMilliseconds / this.#state.frameCount).toFixed(3)}ms`);
            this.#state = {windowStartTimestamp: nowTimestamp, frameCount: 0, geometryBuildMilliseconds: 0, uploadAndDrawMilliseconds: 0};
        }
    }
}

class WebglGeometryBuilder {
    #circleLookupBySegmentCount;

    constructor(circleLookupBySegmentCount) {
        this.#circleLookupBySegmentCount = circleLookupBySegmentCount;
    }

    #ellipseSegmentCountForRegion(region) {
        const rx = Math.max(1, region.halfSize.x);
        const ry = Math.max(1, region.halfSize.y);
        const r = Math.max(rx, ry);
        return Math.ceil(Math.max(40, Math.min(128, r * 0.9)));
    }

    #roundedRectCornerSegmentCount(region) {
        const r = Math.max(1, Math.min(region.halfSize.x, region.halfSize.y));
        return Math.ceil(Math.max(8, Math.min(24, r * 0.2)));
    }

    // Returns cached unit-circle lookup points for a segment count.

    getCircleLookupTable(segmentCount) {
        let unitCircleLookupTable = this.#circleLookupBySegmentCount.get(segmentCount);
        if (!unitCircleLookupTable) {
            unitCircleLookupTable = [];
            for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
                const radians = (segmentIndex / segmentCount) * Math.PI * 2;
                unitCircleLookupTable.push([Math.cos(radians), Math.sin(radians)]);
            }
            this.#circleLookupBySegmentCount.set(segmentCount, unitCircleLookupTable);
        }
        return unitCircleLookupTable;
    }

    mixColor(baseColor, inputAmount, pressedColor) {
        const clampedAmount = Math.max(0, Math.min(1, inputAmount));
        return [
            baseColor[0] + (pressedColor[0] - baseColor[0]) * clampedAmount,
            baseColor[1] + (pressedColor[1] - baseColor[1]) * clampedAmount,
            baseColor[2] + (pressedColor[2] - baseColor[2]) * clampedAmount,
            baseColor[3] + (pressedColor[3] - baseColor[3]) * clampedAmount,
        ];
    }

    expandRegion(region, amount) {
        return WebglCore.Region.fromCenter({
            center: region.center,
            size: new WebglCore.Vector2({x: region.size.x + amount * 2, y: region.size.y + amount * 2}),
        });
    }

    insetRegion(region, inset) {
        const width = Math.max(2, region.size.x - inset * 2);
        const height = Math.max(2, region.size.y - inset * 2);
        return WebglCore.Region.fromCenter({center: region.center, size: new WebglCore.Vector2({x: width, y: height})});
    }

    pushTri(vertices, colors, ax, ay, bx, by, cx, cy, color) {
        vertices.push(ax, ay, bx, by, cx, cy);
        for (let i = 0; i < 3; i += 1) {
            colors.push(color[0], color[1], color[2], color[3]);
        }
    }

    pushPoly(vertices, colors, polygonPoints, color) {
        for (let pointIndex = 1; pointIndex < polygonPoints.length - 1; pointIndex += 1) {
            const firstPoint = polygonPoints[0];
            const secondPoint = polygonPoints[pointIndex];
            const thirdPoint = polygonPoints[pointIndex + 1];
            this.pushTri(vertices, colors, firstPoint.x, firstPoint.y, secondPoint.x, secondPoint.y, thirdPoint.x, thirdPoint.y, color);
        }
    }

    pushEllipse(vertices, colors, region, color, segmentCount = null) {
        const center = region.center;
        const resolvedSegmentCount = Math.max(12, Math.floor(segmentCount || this.#ellipseSegmentCountForRegion(region)));
        const unitCircleLookupTable = this.getCircleLookupTable(resolvedSegmentCount);
        for (let segmentIndex = 0; segmentIndex < resolvedSegmentCount; segmentIndex += 1) {
            const currentUnitPoint = unitCircleLookupTable[segmentIndex];
            const nextUnitPoint = unitCircleLookupTable[(segmentIndex + 1) % resolvedSegmentCount];
            this.pushTri(
                vertices,
                colors,
                center.x,
                center.y,
                center.x + currentUnitPoint[0] * region.halfSize.x,
                center.y + currentUnitPoint[1] * region.halfSize.y,
                center.x + nextUnitPoint[0] * region.halfSize.x,
                center.y + nextUnitPoint[1] * region.halfSize.y,
                color,
            );
        }
    }

    pushRoundedRect(vertices, colors, region, radius, color, segmentCount = null) {
        const resolvedSegmentCount = Math.max(3, Math.floor(segmentCount || this.#roundedRectCornerSegmentCount(region)));
        const cornerRadius = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
        if (cornerRadius < 0.01) {
            this.pushPoly(vertices, colors, [region.topLeft, region.topRight, region.bottomRight, region.bottomLeft], color);
            return;
        }
        const polygonPoints = [];
        const appendArcPoints = (centerX, centerY, startRadians, endRadians) => {
            for (let segmentIndex = 0; segmentIndex <= resolvedSegmentCount; segmentIndex += 1) {
                const radians = startRadians + (endRadians - startRadians) * (segmentIndex / resolvedSegmentCount);
                polygonPoints.push(new WebglCore.Vector2({x: centerX + Math.cos(radians) * cornerRadius, y: centerY + Math.sin(radians) * cornerRadius}));
            }
        };
        appendArcPoints(region.topRight.x - cornerRadius, region.topRight.y + cornerRadius, -Math.PI / 2, 0);
        appendArcPoints(region.bottomRight.x - cornerRadius, region.bottomRight.y - cornerRadius, 0, Math.PI / 2);
        appendArcPoints(region.bottomLeft.x + cornerRadius, region.bottomLeft.y - cornerRadius, Math.PI / 2, Math.PI);
        appendArcPoints(region.topLeft.x + cornerRadius, region.topLeft.y + cornerRadius, Math.PI, Math.PI * 1.5);
        this.pushPoly(vertices, colors, polygonPoints, color);
    }

    roundedRectLoop(region, radius, segmentCount = null) {
        const resolvedSegmentCount = Math.max(3, Math.floor(segmentCount || this.#roundedRectCornerSegmentCount(region)));
        const cornerRadius = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
        if (cornerRadius < 0.01) {
            return [region.topLeft, region.topRight, region.bottomRight, region.bottomLeft];
        }
        const polygonPoints = [];
        const appendArcPoints = (centerX, centerY, startRadians, endRadians) => {
            for (let segmentIndex = 0; segmentIndex < resolvedSegmentCount; segmentIndex += 1) {
                const radians = startRadians + (endRadians - startRadians) * (segmentIndex / resolvedSegmentCount);
                polygonPoints.push(new WebglCore.Vector2({x: centerX + Math.cos(radians) * cornerRadius, y: centerY + Math.sin(radians) * cornerRadius}));
            }
        };
        appendArcPoints(region.topRight.x - cornerRadius, region.topRight.y + cornerRadius, -Math.PI / 2, 0);
        appendArcPoints(region.bottomRight.x - cornerRadius, region.bottomRight.y - cornerRadius, 0, Math.PI / 2);
        appendArcPoints(region.bottomLeft.x + cornerRadius, region.bottomLeft.y - cornerRadius, Math.PI / 2, Math.PI);
        appendArcPoints(region.topLeft.x + cornerRadius, region.topLeft.y + cornerRadius, Math.PI, Math.PI * 1.5);
        return polygonPoints;
    }

    pushRing(vertices, colors, outer, inner, color) {
        const pointCount = Math.min(outer.length, inner.length);
        for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
            const nextPointIndex = (pointIndex + 1) % pointCount;
            this.pushPoly(vertices, colors, [outer[pointIndex], outer[nextPointIndex], inner[nextPointIndex], inner[pointIndex]], color);
        }
    }

    drawTriangleStroke(vertices, colors, points, strokeColor, strokeWidth) {
        const halfStrokeWidth = strokeWidth * 0.5;
        for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
            const startPoint = points[edgeIndex];
            const endPoint = points[(edgeIndex + 1) % 3];
            const deltaX = endPoint.x - startPoint.x;
            const deltaY = endPoint.y - startPoint.y;
            const edgeLength = Math.max(1e-6, Math.hypot(deltaX, deltaY));
            const normalX = -deltaY / edgeLength;
            const normalY = deltaX / edgeLength;
            const offsetStartPositive = new WebglCore.Vector2({x: startPoint.x + normalX * halfStrokeWidth, y: startPoint.y + normalY * halfStrokeWidth});
            const offsetEndPositive = new WebglCore.Vector2({x: endPoint.x + normalX * halfStrokeWidth, y: endPoint.y + normalY * halfStrokeWidth});
            const offsetEndNegative = new WebglCore.Vector2({x: endPoint.x - normalX * halfStrokeWidth, y: endPoint.y - normalY * halfStrokeWidth});
            const offsetStartNegative = new WebglCore.Vector2({x: startPoint.x - normalX * halfStrokeWidth, y: startPoint.y - normalY * halfStrokeWidth});
            this.pushPoly(vertices, colors, [offsetStartPositive, offsetEndPositive, offsetEndNegative, offsetStartNegative], strokeColor);
        }
        this.pushEllipse(vertices, colors, WebglCore.Region.fromCenter({center: points[0], size: WebglCore.Vector2.splat(strokeWidth)}), strokeColor, 28);
        this.pushEllipse(vertices, colors, WebglCore.Region.fromCenter({center: points[1], size: WebglCore.Vector2.splat(strokeWidth)}), strokeColor, 28);
        this.pushEllipse(vertices, colors, WebglCore.Region.fromCenter({center: points[2], size: WebglCore.Vector2.splat(strokeWidth)}), strokeColor, 28);
    }
}

// Architecture overview:
// 1) Static geometry (left dpad border) is built once and uploaded to staticStream.
// 2) Dynamic button geometry is rebuilt per frame from latest gamepad state.
// 3) Analog stick geometry is rebuilt per frame from stick offsets/press amounts.
// 4) Streams are drawn in order: static -> dynamic buttons -> sticks.
// 5) Rendering is coalesced to requestAnimationFrame, with optional maxFps throttling.
class WebGLGamepadOverlayRenderer {
    #canvas;
    #gl;
    #model;
    #theme;
    #program;
    #dynamicStream;
    #stickStream;
    #cutoutStream;
    #staticStream;
    #aPos;
    #aColor;
    #uResolution;
    #uColor;
    #queuedState;
    #renderScheduled;
    #lastRenderMs;
    #minFrameMs;
    #circleLut;
    #vertices;
    #colors;
    #stickVerts;
    #stickColors;
    #cutoutVerts;
    #cutoutColors;
    #staticVertices;
    #staticColors;
    #staticVertexCount;
    #perf;
    #geometryBuilder;
    #borderModel;
    #alphaScale;
    #outputGamma;

    #cornerRadiusPixels(shapeModel) {
        const shapeRegion = shapeModel.region;
        const percent = shapeModel.cornerRadiusPercent;
        if (typeof percent === "number") {
            return Math.max(0, Math.min(shapeRegion.halfSize.x, shapeRegion.halfSize.y) * percent);
        }
        const px = Number(percent?.x);
        const py = Number(percent?.y);
        if (Number.isFinite(px) && Number.isFinite(py)) {
            return Math.max(0, Math.min(shapeRegion.halfSize.x * px, shapeRegion.halfSize.y * py));
        }
        return 0;
    }

    #polygonSignedArea(points) {
        let area = 0;
        for (let index = 0; index < points.length; index += 1) {
            const current = points[index];
            const next = points[(index + 1) % points.length];
            area += (current.x * next.y) - (next.x * current.y);
        }
        return area / 2;
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
        return new WebglCore.Vector2({x, y});
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
                a: new WebglCore.Vector2({x: start.x + offsetX, y: start.y + offsetY}),
                b: new WebglCore.Vector2({x: end.x + offsetX, y: end.y + offsetY}),
            };
        });
        return points.map((point, index) => {
            const previousEdge = offsetEdges[(index - 1 + offsetEdges.length) % offsetEdges.length];
            const nextEdge = offsetEdges[index];
            if (previousEdge == null || nextEdge == null) {
                return point;
            }
            return this.#lineIntersection(previousEdge.a, previousEdge.b, nextEdge.a, nextEdge.b) ?? point;
        });
    }

    #drawShape(vertices, colors, shapeModel, fillColor) {
        const shapeType = shapeModel.shapeType;
        const shapeRegion = shapeModel.region;
        if (shapeType === "ellipse") {
            this.#geometryBuilder.pushEllipse(vertices, colors, shapeRegion, fillColor);
            return;
        }
        if (shapeType === "triDown") {
            this.#geometryBuilder.pushPoly(vertices, colors, [shapeRegion.bottomCenter, shapeRegion.topLeft, shapeRegion.topRight], fillColor);
            return;
        }
        const cornerRadius = this.#cornerRadiusPixels(shapeModel);
        this.#geometryBuilder.pushRoundedRect(vertices, colors, shapeRegion, cornerRadius, fillColor);
    }

    #drawButtonPlan(vertices, colors, plan) {
        const ops = webglBuildButtonDrawOps({
            shapeModel: plan.shapeModel,
            borderModel: this.#borderModel,
            inputAmount: plan.inputAmount,
            pressMode: plan.pressMode,
            baseColorToken: plan.baseColorToken,
            pressedColorToken: plan.pressedColorToken,
        });
        this.#executeDrawOps(vertices, colors, ops);
    }

    #drawStickPlan(vertices, colors, plan) {
        const ops = webglBuildStickDrawOps({
            stickShape: plan.stickShape,
            ringShape: plan.ringShape,
            borderModel: this.#borderModel,
            fillColorSpec: plan.fillColorSpec,
        });
        this.#executeDrawOps(vertices, colors, ops);
    }

    #resolveColor(colorSpec) {
        if (!colorSpec || colorSpec.mode === "solid") {
            return this.#theme[colorSpec?.token || "idle"];
        }
        if (colorSpec.mode === "blend") {
            return this.#geometryBuilder.mixColor(this.#theme[colorSpec.baseToken], colorSpec.amount, this.#theme[colorSpec.pressedToken]);
        }
        return this.#theme.idle;
    }

    #shapeLoop(shapeModel) {
        const region = shapeModel.region;
        if (shapeModel.shapeType === "ellipse") {
            const unitLut = this.#geometryBuilder.getCircleLookupTable(48);
            return unitLut.map(([ux, uy]) => new WebglCore.Vector2({
                x: region.center.x + ux * region.halfSize.x,
                y: region.center.y + uy * region.halfSize.y,
            }));
        }
        const radius = this.#cornerRadiusPixels(shapeModel);
        return this.#geometryBuilder.roundedRectLoop(region, radius, 8);
    }

    #executeDrawOps(vertices, colors, ops, cutoutVertices = null, cutoutColors = null) {
        for (const op of ops) {
            if (op.kind === "shapeFill") {
                this.#drawShape(vertices, colors, op.shapeModel, this.#resolveColor(op.color));
                continue;
            }
            if (op.kind === "triangleStroke") {
                this.#geometryBuilder.drawTriangleStroke(vertices, colors, op.points, this.#resolveColor(op.color), op.strokeWidth);
                continue;
            }
            if (op.kind === "polygonFill") {
                this.#geometryBuilder.pushPoly(vertices, colors, op.points, this.#resolveColor(op.color));
                continue;
            }
            if (op.kind === "polygonRing") {
                this.#geometryBuilder.pushRing(vertices, colors, op.outerPoints, op.innerPoints, this.#resolveColor(op.color));
                continue;
            }
            if (op.kind === "trianglePressFill") {
                const points = op.points;
                const leftEdgePoint = new WebglCore.Vector2({x: points[1].x + (points[0].x - points[1].x) * op.amount, y: points[1].y + (points[0].y - points[1].y) * op.amount});
                const rightEdgePoint = new WebglCore.Vector2({x: points[2].x + (points[0].x - points[2].x) * op.amount, y: points[2].y + (points[0].y - points[2].y) * op.amount});
                this.#geometryBuilder.pushPoly(vertices, colors, [points[1], points[2], rightEdgePoint, leftEdgePoint], this.#resolveColor(op.color));
                continue;
            }
            if (op.kind === "borderRing") {
                this.#drawShape(vertices, colors, op.outerShape, this.#resolveColor(op.color));
                continue;
            }
            if (op.kind === "cutoutShape") {
                if (cutoutVertices != null && cutoutColors != null) {
                    this.#drawShape(cutoutVertices, cutoutColors, op.shapeModel, [0, 0, 0, 1]);
                }
                continue;
            }
            if (op.kind === "roundedBorderRing") {
                const innerLoop = this.#shapeLoop(op.innerShape);
                const outerLoop = this.#shapeLoop(op.outerShape);
                this.#geometryBuilder.pushRing(vertices, colors, outerLoop, innerLoop, this.#resolveColor(op.color));
            }
        }
    }

    // ---------- Geometry and color helpers ----------

    constructor({canvas, model, maxFps = 0, debugPerf = false, alphaScale = 1, outputGamma = 1.45}) {
        this.#canvas = canvas;
        this.#model = model;
        this.#gl = canvas.getContext("webgl", {
            alpha: true,
            premultipliedAlpha: true,
            antialias: true,
            preserveDrawingBuffer: false,
            stencil: true,
        });
        if (!this.#gl) {
            throw new Error("WebGL unavailable in this browser");
        }
        this.#alphaScale = Math.max(0.1, Math.min(2, Number(alphaScale) || 1));
        this.#outputGamma = Math.max(1.0, Math.min(3.0, Number(outputGamma) || 1.45));
        this.#theme = this.#buildTheme();
        this.#queuedState = null;
        this.#renderScheduled = false;
        this.#lastRenderMs = 0;
        const parsedMaxFps = Number(maxFps) || 0;
        this.#minFrameMs = parsedMaxFps > 0 ? (1000 / Math.max(1, parsedMaxFps)) : 0;
        this.#circleLut = new Map();
        this.#geometryBuilder = new WebglGeometryBuilder(this.#circleLut);
        this.#vertices = [];
        this.#colors = [];
        this.#stickVerts = [];
        this.#stickColors = [];
        this.#cutoutVerts = [];
        this.#cutoutColors = [];
        this.#staticVertices = [];
        this.#staticColors = [];
        this.#staticVertexCount = 0;
        this.#perf = new PerfTracker(!!debugPerf);
        this.#borderModel = new WebglDomainBorderModel({innerSize: this.#model.borderWidth});
        this.#initProgram();
        this.resize();
    }

    // ---------- Lifecycle and frame scheduling ----------

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
        this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
        this.#borderModel = new WebglDomainBorderModel({innerSize: this.#model.borderWidth});
        this.#rebuildStaticGeometry();
        this.draw();
    }

    #rebuildStaticGeometry() {
        const overlayModel = this.#model;
        const staticVertexPositions = this.#staticVertices;
        const staticVertexColors = this.#staticColors;
        staticVertexPositions.length = 0;
        staticVertexColors.length = 0;

        const crossFacePoints = overlayModel.leftLayout.crossPoints;
        const crossCenter = overlayModel.leftLayout.origin.center;
        const expandFromCenter = (points, distance) => points.map((point) => {
            const deltaX = point.x - crossCenter.x;
            const deltaY = point.y - crossCenter.y;
            const length = Math.hypot(deltaX, deltaY);
            if (!(length > 0)) {
                return point;
            }
            const scale = (length + distance) / length;
            return new WebglCore.Vector2({x: crossCenter.x + (deltaX * scale), y: crossCenter.y + (deltaY * scale)});
        });
        const crossBlackOuterPoints = expandFromCenter(crossFacePoints, this.#borderModel.halfWidth);
        const crossWhiteOuterPoints = expandFromCenter(crossFacePoints, this.#borderModel.width);
        this.#geometryBuilder.pushRing(staticVertexPositions, staticVertexColors, crossWhiteOuterPoints, crossBlackOuterPoints, this.#theme.borderOuter);
        this.#geometryBuilder.pushRing(staticVertexPositions, staticVertexColors, crossBlackOuterPoints, crossFacePoints, this.#theme.borderInner);
        this.#staticStream.upload(staticVertexPositions, staticVertexColors);
        this.#staticVertexCount = staticVertexPositions.length / 2;
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
        const idleRgb = parseCssRgbTriplet(root.getPropertyValue("--btn-idle-rgb"), [44, 47, 51]);
        const baseIdleAlpha = Number.parseFloat(root.getPropertyValue("--btn-idle-alpha")) || 0.7;
        const idleAlpha = Math.max(0, Math.min(1, baseIdleAlpha * this.#alphaScale));
        return {
            idle: [idleRgb[0] / 255, idleRgb[1] / 255, idleRgb[2] / 255, idleAlpha],
            pressed: [63 / 255, 140 / 255, 1, 1],
            black: [0, 0, 0, 1],
            borderOuter: [1, 1, 1, 1],
            borderInner: [0, 0, 0, 1],
            rightFaceUp: [95 / 255, 95 / 255, 31 / 255, idleAlpha],
            rightFaceRight: [95 / 255, 31 / 255, 31 / 255, idleAlpha],
            rightFaceLeft: [31 / 255, 31 / 255, 95 / 255, idleAlpha],
            rightFaceDown: [31 / 255, 79 / 255, 32 / 255, idleAlpha],
            rightFacePressedUp: [1, 1, 51 / 255, 1],
            rightFacePressedRight: [1, 51 / 255, 51 / 255, 1],
            rightFacePressedLeft: [51 / 255, 119 / 255, 1, 1],
            rightFacePressedDown: [63 / 255, 207 / 255, 63 / 255, 1],
        };
    }

    #rebuildTheme() {
        this.#theme = this.#buildTheme();
    }

    // ---------- GPU pipeline setup ----------

    #initProgram() {
        const gl = this.#gl;
        const vert = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vert, "attribute vec2 a_pos; attribute vec4 a_color; uniform vec2 u_resolution; varying vec4 v_color; void main(){ vec2 zeroToOne = a_pos / u_resolution; vec2 clip = zeroToOne * 2.0 - 1.0; gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0); v_color = a_color; }");
        gl.compileShader(vert);
        const frag = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(frag, `precision highp float; varying vec4 v_color; void main(){ vec3 encoded = pow(max(v_color.rgb, vec3(0.0)), vec3(1.0 / ${this.#outputGamma.toFixed(4)})); gl_FragColor = vec4(encoded, v_color.a); }`);
        gl.compileShader(frag);

        this.#program = gl.createProgram();
        gl.attachShader(this.#program, vert);
        gl.attachShader(this.#program, frag);
        gl.linkProgram(this.#program);

        this.#aPos = gl.getAttribLocation(this.#program, "a_pos");
        this.#aColor = gl.getAttribLocation(this.#program, "a_color");
        this.#uResolution = gl.getUniformLocation(this.#program, "u_resolution");
        this.#dynamicStream = new WebglBufferStream(gl);
        this.#stickStream = new WebglBufferStream(gl);
        this.#cutoutStream = new WebglBufferStream(gl);
        this.#staticStream = new WebglBufferStream(gl);
    }

    #buildDynamicButtons(buttonPlans) {
        const dynamicVertexPositions = this.#vertices;
        const dynamicVertexColors = this.#colors;
        dynamicVertexPositions.length = 0;
        dynamicVertexColors.length = 0;
        for (const plan of buttonPlans) {
            this.#drawButtonPlan(dynamicVertexPositions, dynamicVertexColors, plan);
        }
    }

    // ---------- Dynamic geometry builders ----------

    #buildSticks(stickPlans) {
        const stickVertexPositions = this.#stickVerts;
        const stickVertexColors = this.#stickColors;
        const cutoutVertexPositions = this.#cutoutVerts;
        const cutoutVertexColors = this.#cutoutColors;
        stickVertexPositions.length = 0;
        stickVertexColors.length = 0;
        for (const stickPlan of stickPlans) {
            const ops = webglBuildStickDrawOps({
                stickShape: stickPlan.stickShape,
                ringShape: stickPlan.ringShape,
                borderModel: this.#borderModel,
                fillColorSpec: stickPlan.fillColorSpec,
            });
            this.#executeDrawOps(stickVertexPositions, stickVertexColors, ops, cutoutVertexPositions, cutoutVertexColors);
        }
    }

    // ---------- Rendering ----------

    #renderStreams() {
        const gl = this.#gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.#program);
        gl.uniform2f(this.#uResolution, this.#canvas.width, this.#canvas.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.#staticStream.bind(this.#aPos, this.#aColor);
        this.#staticStream.draw();
        this.#dynamicStream.bind(this.#aPos, this.#aColor);
        this.#dynamicStream.draw();
        this.#cutoutStream.bind(this.#aPos, this.#aColor);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        this.#cutoutStream.draw();
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.#stickStream.bind(this.#aPos, this.#aColor);
        this.#stickStream.draw();
    }

    draw() {
        const buildStartTimestamp = performance.now();
        const plans = webglBuildRasterRenderPlans({
            model: this.#model,
            state: this.#model.state,
            clampOffset: ({offset, halfSize}) => WebglCore.clampNormalizedOffsetToEllipse({offset, halfSize}),
        });
        this.#cutoutVerts.length = 0;
        this.#cutoutColors.length = 0;
        this.#buildDynamicButtons(plans.buttonPlans);
        const uploadStartTimestamp = performance.now();
        this.#dynamicStream.upload(this.#vertices, this.#colors);
        this.#buildSticks(plans.stickPlans);
        this.#cutoutStream.upload(this.#cutoutVerts, this.#cutoutColors);
        this.#stickStream.upload(this.#stickVerts, this.#stickColors);
        this.#renderStreams();
        const drawEndTimestamp = performance.now();
        this.#perf.addFrame({
            geometryBuildMilliseconds: (uploadStartTimestamp - buildStartTimestamp),
            uploadAndDrawMilliseconds: (drawEndTimestamp - uploadStartTimestamp),
            dynamicVertexCount: this.#dynamicStream.vertexCount,
            stickVertexCount: this.#stickStream.vertexCount,
        });
    }

    setOutputGamma(value) {
        this.#outputGamma = Math.max(1.0, Math.min(3.0, Number(value) || 1.45));
        this.#initProgram();
        this.draw();
    }

    setAlphaScale(value) {
        this.#alphaScale = Math.max(0.1, Math.min(2.0, Number(value) || 1));
        this.#rebuildTheme();
        this.draw();
    }

    readPixelsRgba() {
        const width = this.#canvas.width;
        const height = this.#canvas.height;
        const pixels = new Uint8Array(width * height * 4);
        this.#gl.readPixels(0, 0, width, height, this.#gl.RGBA, this.#gl.UNSIGNED_BYTE, pixels);
        return pixels;
    }
}
