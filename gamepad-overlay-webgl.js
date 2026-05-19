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
        return Region.fromCenter({
            center: region.center,
            size: new Vector2({x: region.size.x + amount * 2, y: region.size.y + amount * 2}),
        });
    }

    insetRegion(region, inset) {
        const width = Math.max(2, region.size.x - inset * 2);
        const height = Math.max(2, region.size.y - inset * 2);
        return Region.fromCenter({center: region.center, size: new Vector2({x: width, y: height})});
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

    pushEllipse(vertices, colors, region, color, segmentCount = 36) {
        const center = region.center;
        const unitCircleLookupTable = this.getCircleLookupTable(segmentCount);
        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
            const currentUnitPoint = unitCircleLookupTable[segmentIndex];
            const nextUnitPoint = unitCircleLookupTable[(segmentIndex + 1) % segmentCount];
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

    pushRoundedRect(vertices, colors, region, radius, color, segmentCount = 6) {
        const cornerRadius = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
        if (cornerRadius < 0.01) {
            this.pushPoly(vertices, colors, [region.topLeft, region.topRight, region.bottomRight, region.bottomLeft], color);
            return;
        }
        const polygonPoints = [];
        const appendArcPoints = (centerX, centerY, startRadians, endRadians) => {
            for (let segmentIndex = 0; segmentIndex <= segmentCount; segmentIndex += 1) {
                const radians = startRadians + (endRadians - startRadians) * (segmentIndex / segmentCount);
                polygonPoints.push(new Vector2({x: centerX + Math.cos(radians) * cornerRadius, y: centerY + Math.sin(radians) * cornerRadius}));
            }
        };
        appendArcPoints(region.topRight.x - cornerRadius, region.topRight.y + cornerRadius, -Math.PI / 2, 0);
        appendArcPoints(region.bottomRight.x - cornerRadius, region.bottomRight.y - cornerRadius, 0, Math.PI / 2);
        appendArcPoints(region.bottomLeft.x + cornerRadius, region.bottomLeft.y - cornerRadius, Math.PI / 2, Math.PI);
        appendArcPoints(region.topLeft.x + cornerRadius, region.topLeft.y + cornerRadius, Math.PI, Math.PI * 1.5);
        this.pushPoly(vertices, colors, polygonPoints, color);
    }

    roundedRectLoop(region, radius, segmentCount = 6) {
        const cornerRadius = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
        if (cornerRadius < 0.01) {
            return [region.topLeft, region.topRight, region.bottomRight, region.bottomLeft];
        }
        const polygonPoints = [];
        const appendArcPoints = (centerX, centerY, startRadians, endRadians) => {
            for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
                const radians = startRadians + (endRadians - startRadians) * (segmentIndex / segmentCount);
                polygonPoints.push(new Vector2({x: centerX + Math.cos(radians) * cornerRadius, y: centerY + Math.sin(radians) * cornerRadius}));
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
            const offsetStartPositive = new Vector2({x: startPoint.x + normalX * halfStrokeWidth, y: startPoint.y + normalY * halfStrokeWidth});
            const offsetEndPositive = new Vector2({x: endPoint.x + normalX * halfStrokeWidth, y: endPoint.y + normalY * halfStrokeWidth});
            const offsetEndNegative = new Vector2({x: endPoint.x - normalX * halfStrokeWidth, y: endPoint.y - normalY * halfStrokeWidth});
            const offsetStartNegative = new Vector2({x: startPoint.x - normalX * halfStrokeWidth, y: startPoint.y - normalY * halfStrokeWidth});
            this.pushPoly(vertices, colors, [offsetStartPositive, offsetEndPositive, offsetEndNegative, offsetStartNegative], strokeColor);
        }
        this.pushEllipse(vertices, colors, Region.fromCenter({center: points[0], size: Vector2.splat(strokeWidth)}), strokeColor, 28);
        this.pushEllipse(vertices, colors, Region.fromCenter({center: points[1], size: Vector2.splat(strokeWidth)}), strokeColor, 28);
        this.pushEllipse(vertices, colors, Region.fromCenter({center: points[2], size: Vector2.splat(strokeWidth)}), strokeColor, 28);
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
    #staticVertices;
    #staticColors;
    #staticVertexCount;
    #perf;
    #geometryBuilder;

    // ---------- Geometry and color helpers ----------

    constructor({canvas, model, maxFps = 0, debugPerf = false}) {
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
        this.#staticVertices = [];
        this.#staticColors = [];
        this.#staticVertexCount = 0;
        this.#perf = new PerfTracker(!!debugPerf);
        this.#initProgram();
        this.resize();
    }

    // ---------- Lifecycle and frame scheduling ----------

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
        this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
        this.#rebuildStaticGeometry();
        this.draw();
    }

    #rebuildStaticGeometry() {
        const overlayModel = this.#model;
        const staticVertexPositions = this.#staticVertices;
        const staticVertexColors = this.#staticColors;
        staticVertexPositions.length = 0;
        staticVertexColors.length = 0;

        const pushTriangle = (ax, ay, bx, by, cx, cy, color) => {
            staticVertexPositions.push(ax, ay, bx, by, cx, cy);
            for (let i = 0; i < 3; i += 1) {
                staticVertexColors.push(color[0], color[1], color[2], color[3]);
            }
        };
        const pushPolygon = (polygonPoints, color) => {
            for (let pointIndex = 1; pointIndex < polygonPoints.length - 1; pointIndex += 1) {
                const firstPoint = polygonPoints[0];
                const secondPoint = polygonPoints[pointIndex];
                const thirdPoint = polygonPoints[pointIndex + 1];
                pushTriangle(firstPoint.x, firstPoint.y, secondPoint.x, secondPoint.y, thirdPoint.x, thirdPoint.y, color);
            }
        };

        pushPolygon(overlayModel.leftLayout.crossPoints, this.#theme.borderOuter);
        const insetCrossPoints = overlayModel.leftLayout.crossPoints.map((point) => {
            const center = overlayModel.leftLayout.origin.center;
            const deltaX = point.x - center.x;
            const deltaY = point.y - center.y;
            return new Vector2({x: center.x + deltaX * 0.965, y: center.y + deltaY * 0.965});
        });
        pushPolygon(insetCrossPoints, this.#theme.borderInner);
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
        const idleAlpha = Number.parseFloat(root.getPropertyValue("--btn-idle-alpha")) || 0.7;
        return {
            idle: [idleRgb[0] / 255, idleRgb[1] / 255, idleRgb[2] / 255, idleAlpha],
            pressed: [63 / 255, 140 / 255, 1, 1],
            black: [0, 0, 0, 1],
            borderOuter: [1, 1, 1, 1],
            borderInner: [0, 0, 0, 1],
            rightFace: {
                up: [95 / 255, 95 / 255, 31 / 255, idleAlpha],
                right: [95 / 255, 31 / 255, 31 / 255, idleAlpha],
                left: [31 / 255, 31 / 255, 95 / 255, idleAlpha],
                down: [31 / 255, 79 / 255, 32 / 255, idleAlpha],
            },
            rightFacePressed: {
                up: [1, 1, 51 / 255, 1],
                right: [1, 51 / 255, 51 / 255, 1],
                left: [51 / 255, 119 / 255, 1, 1],
                down: [63 / 255, 207 / 255, 63 / 255, 1],
            },
        };
    }

    // ---------- GPU pipeline setup ----------

    #initProgram() {
        const gl = this.#gl;
        const vert = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vert, "attribute vec2 a_pos; attribute vec4 a_color; uniform vec2 u_resolution; varying vec4 v_color; void main(){ vec2 zeroToOne = a_pos / u_resolution; vec2 clip = zeroToOne * 2.0 - 1.0; gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0); v_color = a_color; }");
        gl.compileShader(vert);
        const frag = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(frag, "precision mediump float; varying vec4 v_color; void main(){ gl_FragColor = v_color; }");
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
        this.#staticStream = new WebglBufferStream(gl);
    }

    #buildDynamicButtons(state) {
        const overlayModel = this.#model;
        const dynamicVertexPositions = this.#vertices;
        const dynamicVertexColors = this.#colors;
        dynamicVertexPositions.length = 0;
        dynamicVertexColors.length = 0;
        const drawButton = (buttonSpec, baseColor, inputAmount, pressedColorOverride = null) => {
            if (!buttonSpec) { return; }
            const blendedFillColor = this.#geometryBuilder.mixColor(baseColor, inputAmount, pressedColorOverride ?? this.#theme.pressed);
            const borderThickness = Math.max(2.5, this.#model.borderWidth);
            const drawButtonShape = (shapeType, buttonRegion, fillColor, cornerRadiusPercent = 0) => {
                if (shapeType === "ellipse") {
                    this.#geometryBuilder.pushEllipse(dynamicVertexPositions, dynamicVertexColors, buttonRegion, fillColor);
                } else if (shapeType === "triDown") {
                    this.#geometryBuilder.pushPoly(dynamicVertexPositions, dynamicVertexColors, [buttonRegion.bottomCenter, buttonRegion.topLeft, buttonRegion.topRight], fillColor);
                } else {
                    const cornerRadius = Math.max(0, Math.min(buttonRegion.halfSize.x, buttonRegion.halfSize.y) * cornerRadiusPercent);
                    this.#geometryBuilder.pushRoundedRect(dynamicVertexPositions, dynamicVertexColors, buttonRegion, cornerRadius, fillColor);
                }
            };
            if (buttonSpec.shape === "triDown") {
                const trianglePoints = [buttonSpec.region.bottomCenter, buttonSpec.region.topLeft, buttonSpec.region.topRight];
                this.#geometryBuilder.drawTriangleStroke(dynamicVertexPositions, dynamicVertexColors, trianglePoints, this.#theme.borderOuter, borderThickness * 2);
                this.#geometryBuilder.drawTriangleStroke(dynamicVertexPositions, dynamicVertexColors, trianglePoints, this.#theme.borderInner, borderThickness);
                drawButtonShape("triDown", buttonSpec.region, this.#theme.borderInner);
                drawButtonShape("triDown", buttonSpec.region, baseColor);
                if (buttonSpec.pressMode === "analog" && inputAmount > 0) {
                    const clampedAmount = Math.max(0, Math.min(1, inputAmount));
                    const leftEdgePoint = new Vector2({x: trianglePoints[1].x + (trianglePoints[0].x - trianglePoints[1].x) * clampedAmount, y: trianglePoints[1].y + (trianglePoints[0].y - trianglePoints[1].y) * clampedAmount});
                    const rightEdgePoint = new Vector2({x: trianglePoints[2].x + (trianglePoints[0].x - trianglePoints[2].x) * clampedAmount, y: trianglePoints[2].y + (trianglePoints[0].y - trianglePoints[2].y) * clampedAmount});
                    this.#geometryBuilder.pushPoly(dynamicVertexPositions, dynamicVertexColors, [trianglePoints[1], trianglePoints[2], rightEdgePoint, leftEdgePoint], this.#theme.pressed);
                }
            } else if (buttonSpec.shape === "rect" && (buttonSpec.cornerRadiusPercent || 0) > 0) {
                drawButtonShape(buttonSpec.shape, this.#geometryBuilder.expandRegion(buttonSpec.region, borderThickness * 0.5), this.#theme.borderInner, buttonSpec.cornerRadiusPercent);
                drawButtonShape(buttonSpec.shape, buttonSpec.region, blendedFillColor, buttonSpec.cornerRadiusPercent);
                const cornerRadius = Math.min(buttonSpec.region.halfSize.x, buttonSpec.region.halfSize.y) * buttonSpec.cornerRadiusPercent;
                const baseLoop = this.#geometryBuilder.roundedRectLoop(buttonSpec.region, cornerRadius, 8);
                const blackBorderLoop = this.#geometryBuilder.roundedRectLoop(this.#geometryBuilder.expandRegion(buttonSpec.region, borderThickness * 0.5), cornerRadius + borderThickness * 0.5, 8);
                const whiteBorderLoop = this.#geometryBuilder.roundedRectLoop(this.#geometryBuilder.expandRegion(buttonSpec.region, borderThickness), cornerRadius + borderThickness, 8);
                this.#geometryBuilder.pushRing(dynamicVertexPositions, dynamicVertexColors, whiteBorderLoop, blackBorderLoop, this.#theme.borderOuter);
                this.#geometryBuilder.pushRing(dynamicVertexPositions, dynamicVertexColors, blackBorderLoop, baseLoop, this.#theme.borderInner);
            } else {
                drawButtonShape(buttonSpec.shape, this.#geometryBuilder.expandRegion(buttonSpec.region, borderThickness), this.#theme.borderOuter, buttonSpec.cornerRadiusPercent);
                drawButtonShape(buttonSpec.shape, this.#geometryBuilder.expandRegion(buttonSpec.region, borderThickness * 0.5), this.#theme.borderInner, buttonSpec.cornerRadiusPercent);
                drawButtonShape(buttonSpec.shape, buttonSpec.region, blendedFillColor, buttonSpec.cornerRadiusPercent);
            }
        };

        drawButton(overlayModel.buttons.left.leftBumper, this.#theme.idle, state.LB);
        drawButton(overlayModel.buttons.left.select, this.#theme.idle, state.SELECT);
        drawButton(overlayModel.buttons.left.leftTrigger, this.#theme.idle, state.LT);
        drawButton(overlayModel.buttons.right.start, this.#theme.idle, state.START);
        drawButton(overlayModel.buttons.right.rightBumper, this.#theme.idle, state.RB);
        drawButton(overlayModel.buttons.right.rightTrigger, this.#theme.idle, state.RT);
        drawButton(overlayModel.buttons.left.left, this.#theme.idle, state.DX < 0 ? 1 : 0);
        drawButton(overlayModel.buttons.left.right, this.#theme.idle, state.DX > 0 ? 1 : 0);
        drawButton(overlayModel.buttons.left.up, this.#theme.idle, state.DY < 0 ? 1 : 0);
        drawButton(overlayModel.buttons.left.down, this.#theme.idle, state.DY > 0 ? 1 : 0);
        drawButton(overlayModel.buttons.left.origin, this.#theme.idle, 0);
        drawButton(overlayModel.buttons.right.up, this.#theme.rightFace.up, state.Y, this.#theme.rightFacePressed.up);
        drawButton(overlayModel.buttons.right.right, this.#theme.rightFace.right, state.B, this.#theme.rightFacePressed.right);
        drawButton(overlayModel.buttons.right.left, this.#theme.rightFace.left, state.X, this.#theme.rightFacePressed.left);
        drawButton(overlayModel.buttons.right.down, this.#theme.rightFace.down, state.A, this.#theme.rightFacePressed.down);
        drawButton(overlayModel.buttons.left.analogArea, this.#theme.black, 0);
        drawButton(overlayModel.buttons.right.analogArea, this.#theme.black, 0);
    }

    // ---------- Dynamic geometry builders ----------

    #buildSticks(state) {
        const overlayModel = this.#model;
        const stickVertexPositions = this.#stickVerts;
        const stickVertexColors = this.#stickColors;
        stickVertexPositions.length = 0;
        stickVertexColors.length = 0;
        const pushStick = (stickRegion, fillColor) => {
            const unitCircleLookupTable = this.#geometryBuilder.getCircleLookupTable(36);
            for (let segmentIndex = 0; segmentIndex < 36; segmentIndex += 1) {
                const currentUnitPoint = unitCircleLookupTable[segmentIndex];
                const nextUnitPoint = unitCircleLookupTable[(segmentIndex + 1) % 36];
                stickVertexPositions.push(stickRegion.center.x, stickRegion.center.y, stickRegion.center.x + currentUnitPoint[0] * stickRegion.halfSize.x, stickRegion.center.y + currentUnitPoint[1] * stickRegion.halfSize.y, stickRegion.center.x + nextUnitPoint[0] * stickRegion.halfSize.x, stickRegion.center.y + nextUnitPoint[1] * stickRegion.halfSize.y);
                for (let colorComponentIndex = 0; colorComponentIndex < 3; colorComponentIndex += 1) {
                    stickVertexColors.push(fillColor[0], fillColor[1], fillColor[2], fillColor[3]);
                }
            }
        };
        const borderThickness = Math.max(2.5, this.#model.borderWidth);
        const leftStickOffset = clampNormalizedOffsetToEllipse({offset: {x: state.LX, y: state.LY}, halfSize: overlayModel.leftLayout.origin.halfSize});
        const rightStickOffset = clampNormalizedOffsetToEllipse({offset: {x: state.RX, y: state.RY}, halfSize: overlayModel.rightLayout.origin.halfSize});
        const leftStickRegion = overlayModel.buttons.left.analogStick.region.clone().update({topLeft: overlayModel.buttons.left.analogStick.region.topLeft.clone().add(leftStickOffset)});
        const rightStickRegion = overlayModel.buttons.right.analogStick.region.clone().update({topLeft: overlayModel.buttons.right.analogStick.region.topLeft.clone().add(rightStickOffset)});
        const leftRingRegion = overlayModel.buttons.left.analogStickRing.region.clone().update({topLeft: overlayModel.buttons.left.analogStickRing.region.topLeft.clone().add(leftStickOffset)});
        const rightRingRegion = overlayModel.buttons.right.analogStickRing.region.clone().update({topLeft: overlayModel.buttons.right.analogStickRing.region.topLeft.clone().add(rightStickOffset)});
        const leftStickFillColor = this.#geometryBuilder.mixColor(this.#theme.idle, state.LS, this.#theme.pressed);
        const rightStickFillColor = this.#geometryBuilder.mixColor(this.#theme.idle, state.RS, this.#theme.pressed);
        const drawRing = (ringRegion, ringFillColor) => {
            const whiteBorderOuterRegion = this.#geometryBuilder.expandRegion(ringRegion, borderThickness);
            const whiteBorderInnerRegion = this.#geometryBuilder.insetRegion(whiteBorderOuterRegion, borderThickness * 0.5);
            const blackBorderOuterRegion = whiteBorderInnerRegion;
            const blackBorderInnerRegion = this.#geometryBuilder.insetRegion(blackBorderOuterRegion, borderThickness * 0.5);
            pushStick(whiteBorderOuterRegion, this.#theme.borderOuter);
            pushStick(whiteBorderInnerRegion, ringFillColor);
            pushStick(blackBorderOuterRegion, this.#theme.borderInner);
            pushStick(blackBorderInnerRegion, ringFillColor);
        };
        pushStick(this.#geometryBuilder.expandRegion(leftStickRegion, borderThickness), this.#theme.borderOuter);
        pushStick(this.#geometryBuilder.expandRegion(leftStickRegion, borderThickness * 0.5), this.#theme.borderInner);
        pushStick(leftStickRegion, leftStickFillColor);
        drawRing(leftRingRegion, leftStickFillColor);
        pushStick(this.#geometryBuilder.expandRegion(rightStickRegion, borderThickness), this.#theme.borderOuter);
        pushStick(this.#geometryBuilder.expandRegion(rightStickRegion, borderThickness * 0.5), this.#theme.borderInner);
        pushStick(rightStickRegion, rightStickFillColor);
        drawRing(rightRingRegion, rightStickFillColor);
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
        this.#stickStream.bind(this.#aPos, this.#aColor);
        this.#stickStream.draw();
    }

    draw() {
        const buildStartTimestamp = performance.now();
        this.#buildDynamicButtons(this.#model.state);
        const uploadStartTimestamp = performance.now();
        this.#dynamicStream.upload(this.#vertices, this.#colors);
        this.#buildSticks(this.#model.state);
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
}
