class WebGLGamepadOverlayRenderer {
    #canvas;
    #gl;
    #model;
    #theme;
    #program;
    #posBuffer;
    #colorBuffer;
    #dynamicPosBuffer;
    #dynamicColorBuffer;
    #stickPosBuffer;
    #stickColorBuffer;
    #staticPosBuffer;
    #staticColorBuffer;
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
    #vertexData;
    #colorData;
    #stickVertexData;
    #stickColorData;
    #staticVertices;
    #staticColors;
    #staticVertexData;
    #staticColorData;
    #staticVertexCount;
    #dynamicVertexCount;
    #stickVertexCount;
    #debugPerf;
    #perf;

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
        this.#vertices = [];
        this.#colors = [];
        this.#stickVerts = [];
        this.#stickColors = [];
        this.#vertexData = new Float32Array(0);
        this.#colorData = new Float32Array(0);
        this.#stickVertexData = new Float32Array(0);
        this.#stickColorData = new Float32Array(0);
        this.#staticVertices = [];
        this.#staticColors = [];
        this.#staticVertexData = new Float32Array(0);
        this.#staticColorData = new Float32Array(0);
        this.#staticVertexCount = 0;
        this.#dynamicVertexCount = 0;
        this.#stickVertexCount = 0;
        this.#debugPerf = !!debugPerf;
        this.#perf = {t0: performance.now(), frames: 0, buildMs: 0, uploadMs: 0, drawMs: 0};
        this.#initProgram();
        this.resize();
    }

    #ensureFloatCapacity(current, needed) {
        if (current.length >= needed) {
            return current;
        }
        const next = new Float32Array(Math.max(needed, Math.ceil(current.length * 1.5) + 1024));
        next.set(current);
        return next;
    }

    #copyToFloatArray(source, target) {
        for (let i = 0; i < source.length; i += 1) {
            target[i] = source[i];
        }
    }

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
        this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
        this.#rebuildStaticGeometry();
        this.draw();
    }

    #rebuildStaticGeometry() {
        const model = this.#model;
        const vertices = this.#staticVertices;
        const colors = this.#staticColors;
        vertices.length = 0;
        colors.length = 0;

        const pushTriNums = (ax, ay, bx, by, cx, cy, color) => {
            vertices.push(ax, ay, bx, by, cx, cy);
            for (let i = 0; i < 3; i += 1) {
                colors.push(color[0], color[1], color[2], color[3]);
            }
        };
        const pushPoly = (points, color) => {
            for (let i = 1; i < points.length - 1; i += 1) {
                const a = points[0];
                const b = points[i];
                const c = points[i + 1];
                pushTriNums(a.x, a.y, b.x, b.y, c.x, c.y, color);
            }
        };
        const getCircleLut = (segments) => {
            let lut = this.#circleLut.get(segments);
            if (!lut) {
                lut = [];
                for (let i = 0; i < segments; i += 1) {
                    const a = (i / segments) * Math.PI * 2;
                    lut.push([Math.cos(a), Math.sin(a)]);
                }
                this.#circleLut.set(segments, lut);
            }
            return lut;
        };
        const pushEllipse = (region, color, segments = 36) => {
            const c = region.center;
            const lut = getCircleLut(segments);
            for (let i = 0; i < segments; i += 1) {
                const p0 = lut[i];
                const p1 = lut[(i + 1) % segments];
                pushTriNums(c.x, c.y, c.x + p0[0] * region.halfSize.x, c.y + p0[1] * region.halfSize.y, c.x + p1[0] * region.halfSize.x, c.y + p1[1] * region.halfSize.y, color);
            }
        };

        pushPoly(model.leftLayout.crossPoints, this.#theme.borderOuter);
        const insetCross = model.leftLayout.crossPoints.map((p) => {
            const c = model.leftLayout.origin.center;
            const dx = p.x - c.x;
            const dy = p.y - c.y;
            return new Vector2({x: c.x + dx * 0.965, y: c.y + dy * 0.965});
        });
        pushPoly(insetCross, this.#theme.borderInner);
        this.#staticVertexData = this.#ensureFloatCapacity(this.#staticVertexData, vertices.length);
        this.#staticColorData = this.#ensureFloatCapacity(this.#staticColorData, colors.length);
        this.#copyToFloatArray(vertices, this.#staticVertexData);
        this.#copyToFloatArray(colors, this.#staticColorData);
        this.#staticVertexCount = vertices.length / 2;

        const gl = this.#gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#staticPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#staticVertexData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#staticVertexData.subarray(0, vertices.length));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#staticColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#staticColorData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#staticColorData.subarray(0, colors.length));
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
        this.#posBuffer = gl.createBuffer();
        this.#colorBuffer = gl.createBuffer();
        this.#dynamicPosBuffer = gl.createBuffer();
        this.#dynamicColorBuffer = gl.createBuffer();
        this.#stickPosBuffer = gl.createBuffer();
        this.#stickColorBuffer = gl.createBuffer();
        this.#staticPosBuffer = gl.createBuffer();
        this.#staticColorBuffer = gl.createBuffer();
    }

    draw() {
        const buildStart = performance.now();
        const gl = this.#gl;
        const model = this.#model;
        const s = model.state;
        const vertices = this.#vertices;
        const colors = this.#colors;
        vertices.length = 0;
        colors.length = 0;

        const pushTri = (a, b, c, color) => {
            vertices.push(a.x, a.y, b.x, b.y, c.x, c.y);
            for (let i = 0; i < 3; i += 1) {
                colors.push(color[0], color[1], color[2], color[3]);
            }
        };
        const pushTriNums = (ax, ay, bx, by, cx, cy, color) => {
            vertices.push(ax, ay, bx, by, cx, cy);
            for (let i = 0; i < 3; i += 1) {
                colors.push(color[0], color[1], color[2], color[3]);
            }
        };
        const pushPoly = (points, color) => {
            for (let i = 1; i < points.length - 1; i += 1) {
                pushTri(points[0], points[i], points[i + 1], color);
            }
        };
        const getCircleLut = (segments) => {
            let lut = this.#circleLut.get(segments);
            if (lut) {
                return lut;
            }
            lut = [];
            for (let i = 0; i < segments; i += 1) {
                const a = (i / segments) * Math.PI * 2;
                lut.push([Math.cos(a), Math.sin(a)]);
            }
            this.#circleLut.set(segments, lut);
            return lut;
        };
        const pushEllipse = (region, color, segments = 36) => {
            const c = region.center;
            const lut = getCircleLut(segments);
            for (let i = 0; i < segments; i += 1) {
                const p0 = lut[i];
                const p1 = lut[(i + 1) % segments];
                pushTriNums(
                    c.x,
                    c.y,
                    c.x + p0[0] * region.halfSize.x,
                    c.y + p0[1] * region.halfSize.y,
                    c.x + p1[0] * region.halfSize.x,
                    c.y + p1[1] * region.halfSize.y,
                    color
                );
            }
        };
        const pushRoundedRect = (region, radius, color, segments = 6) => {
            const r = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
            if (r < 0.01) {
                pushPoly([region.topLeft, region.topRight, region.bottomRight, region.bottomLeft], color);
                return;
            }
            const pts = [];
            const arc = (cx, cy, a0, a1) => {
                for (let i = 0; i <= segments; i += 1) {
                    const a = a0 + (a1 - a0) * (i / segments);
                    pts.push(new Vector2({x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r}));
                }
            };
            arc(region.topRight.x - r, region.topRight.y + r, -Math.PI / 2, 0);
            arc(region.bottomRight.x - r, region.bottomRight.y - r, 0, Math.PI / 2);
            arc(region.bottomLeft.x + r, region.bottomLeft.y - r, Math.PI / 2, Math.PI);
            arc(region.topLeft.x + r, region.topLeft.y + r, Math.PI, Math.PI * 1.5);
            pushPoly(pts, color);
        };
        const roundedRectLoop = (region, radius, segments = 6) => {
            const r = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
            if (r < 0.01) {
                return [region.topLeft, region.topRight, region.bottomRight, region.bottomLeft];
            }
            const pts = [];
            const arc = (cx, cy, a0, a1) => {
                for (let i = 0; i < segments; i += 1) {
                    const a = a0 + (a1 - a0) * (i / segments);
                    pts.push(new Vector2({x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r}));
                }
            };
            arc(region.topRight.x - r, region.topRight.y + r, -Math.PI / 2, 0);
            arc(region.bottomRight.x - r, region.bottomRight.y - r, 0, Math.PI / 2);
            arc(region.bottomLeft.x + r, region.bottomLeft.y - r, Math.PI / 2, Math.PI);
            arc(region.topLeft.x + r, region.topLeft.y + r, Math.PI, Math.PI * 1.5);
            return pts;
        };
        const pushRing = (outer, inner, color) => {
            const n = Math.min(outer.length, inner.length);
            for (let i = 0; i < n; i += 1) {
                const j = (i + 1) % n;
                pushPoly([outer[i], outer[j], inner[j], inner[i]], color);
            }
        };
        const mix = (base, amt, pressedOverride = null) => {
            const p = Math.max(0, Math.min(1, amt));
            const pressed = pressedOverride ?? this.#theme.pressed;
            return [
                base[0] + (pressed[0] - base[0]) * p,
                base[1] + (pressed[1] - base[1]) * p,
                base[2] + (pressed[2] - base[2]) * p,
                base[3] + (pressed[3] - base[3]) * p,
            ];
        };
        const insetRegion = (region, inset) => {
            const w = Math.max(2, region.size.x - inset * 2);
            const h = Math.max(2, region.size.y - inset * 2);
            return Region.fromCenter({center: region.center, size: new Vector2({x: w, y: h})});
        };
        const expandRegion = (region, amount) => Region.fromCenter({
            center: region.center,
            size: new Vector2({x: region.size.x + amount * 2, y: region.size.y + amount * 2}),
        });
        const scaleTri = (points, factor) => {
            const c = new Vector2({
                x: (points[0].x + points[1].x + points[2].x) / 3,
                y: (points[0].y + points[1].y + points[2].y) / 3,
            });
            return points.map((p) => new Vector2({x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor}));
        };
        const triDownPoints = (region) => [region.bottomCenter, region.topLeft, region.topRight];
        const insetTriDown = (region, factor) => scaleTri(triDownPoints(region), factor);
        const triFillSlice = (region, amount) => {
            const t = Math.max(0, Math.min(1, amount));
            const topLeft = region.topLeft;
            const topRight = region.topRight;
            const bottom = region.bottomCenter;
            const pL = new Vector2({
                x: topLeft.x + (bottom.x - topLeft.x) * t,
                y: topLeft.y + (bottom.y - topLeft.y) * t,
            });
            const pR = new Vector2({
                x: topRight.x + (bottom.x - topRight.x) * t,
                y: topRight.y + (bottom.y - topRight.y) * t,
            });
            return [topLeft, topRight, pR, pL];
        };
        const triFillSliceFromPoints = (points, amount) => {
            const t = Math.max(0, Math.min(1, amount));
            const bottom = points[0];
            const topLeft = points[1];
            const topRight = points[2];
            const pL = new Vector2({
                x: topLeft.x + (bottom.x - topLeft.x) * t,
                y: topLeft.y + (bottom.y - topLeft.y) * t,
            });
            const pR = new Vector2({
                x: topRight.x + (bottom.x - topRight.x) * t,
                y: topRight.y + (bottom.y - topRight.y) * t,
            });
            return [topLeft, topRight, pR, pL];
        };

        const drawButton = (button, base, amt, pressedOverride = null) => {
            if (!button) {
                return;
            }
            const color = mix(base, amt, pressedOverride);
            const borderPx = Math.max(2.5, this.#model.borderWidth);

            const drawShape = (shape, region, fillColor, cornerRadiusPercent = 0) => {
                if (shape === "ellipse") {
                    pushEllipse(region, fillColor);
                } else if (shape === "triDown") {
                    pushPoly([region.bottomCenter, region.topLeft, region.topRight], fillColor);
                } else {
                    const radius = Math.max(0, Math.min(region.halfSize.x, region.halfSize.y) * cornerRadiusPercent);
                    pushRoundedRect(region, radius, fillColor);
                }
            };
            const triScaleByPixels = (points, pixels) => {
                const c = new Vector2({
                    x: (points[0].x + points[1].x + points[2].x) / 3,
                    y: (points[0].y + points[1].y + points[2].y) / 3,
                });
                const d0 = Math.hypot(points[0].x - c.x, points[0].y - c.y);
                const d1 = Math.hypot(points[1].x - c.x, points[1].y - c.y);
                const d2 = Math.hypot(points[2].x - c.x, points[2].y - c.y);
                const avg = Math.max(1, (d0 + d1 + d2) / 3);
                const f = (avg + pixels) / avg;
                return points.map((p) => new Vector2({x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f}));
            };
            const drawTriangleStroke = (points, strokeColor, strokeWidth) => {
                const half = strokeWidth * 0.5;
                for (let i = 0; i < 3; i += 1) {
                    const p0 = points[i];
                    const p1 = points[(i + 1) % 3];
                    const dx = p1.x - p0.x;
                    const dy = p1.y - p0.y;
                    const len = Math.max(1e-6, Math.hypot(dx, dy));
                    const nx = -dy / len;
                    const ny = dx / len;
                    const a = new Vector2({x: p0.x + nx * half, y: p0.y + ny * half});
                    const b = new Vector2({x: p1.x + nx * half, y: p1.y + ny * half});
                    const c = new Vector2({x: p1.x - nx * half, y: p1.y - ny * half});
                    const d = new Vector2({x: p0.x - nx * half, y: p0.y - ny * half});
                    pushPoly([a, b, c, d], strokeColor);
                }
                const capSize = Vector2.splat(strokeWidth);
                for (const point of points) {
                    pushEllipse(Region.fromCenter({center: point, size: capSize}), strokeColor, 28);
                }
            };
            if (button.shape === "triDown") {
                const baseTri = triDownPoints(button.region);
                drawTriangleStroke(baseTri, this.#theme.borderOuter, borderPx * 2);
                drawTriangleStroke(baseTri, this.#theme.borderInner, borderPx);
                pushPoly(baseTri, this.#theme.borderInner);
                pushPoly(baseTri, base);
            } else {
                if (button.shape === "rect" && (button.cornerRadiusPercent || 0) > 0) {
                    const radius = Math.min(button.region.halfSize.x, button.region.halfSize.y) * button.cornerRadiusPercent;
                    // Keep fill compositing aligned with the normal button path.
                    drawShape(button.shape, expandRegion(button.region, borderPx * 0.5), this.#theme.borderInner, button.cornerRadiusPercent);
                    drawShape(button.shape, button.region, color, button.cornerRadiusPercent);

                    // Then apply rounded border bands to preserve correct corner appearance.
                    const baseLoop = roundedRectLoop(button.region, radius, 8);
                    const blackLoop = roundedRectLoop(expandRegion(button.region, borderPx * 0.5), radius + borderPx * 0.5, 8);
                    const whiteLoop = roundedRectLoop(expandRegion(button.region, borderPx), radius + borderPx, 8);
                    pushRing(whiteLoop, blackLoop, this.#theme.borderOuter);
                    pushRing(blackLoop, baseLoop, this.#theme.borderInner);
                } else {
                    drawShape(button.shape, expandRegion(button.region, borderPx), this.#theme.borderOuter, button.cornerRadiusPercent);
                    drawShape(button.shape, expandRegion(button.region, borderPx * 0.5), this.#theme.borderInner, button.cornerRadiusPercent);
                    drawShape(button.shape, button.region, color, button.cornerRadiusPercent);
                }
            }

            if (button.shape === "ellipse") {
                // already drawn via layered fill
            } else if (button.shape === "triDown") {
                if (button.pressMode === "analog" && amt > 0) {
                    const fillTri = triDownPoints(button.region);
                    pushPoly(triFillSliceFromPoints(fillTri, amt), this.#theme.pressed);
                }
            }
        };

        drawButton(model.buttons.left.leftBumper, this.#theme.idle, s.LB);
        drawButton(model.buttons.left.select, this.#theme.idle, s.SELECT);
        drawButton(model.buttons.left.leftTrigger, this.#theme.idle, s.LT);
        drawButton(model.buttons.right.start, this.#theme.idle, s.START);
        drawButton(model.buttons.right.rightBumper, this.#theme.idle, s.RB);
        drawButton(model.buttons.right.rightTrigger, this.#theme.idle, s.RT);
        drawButton(model.buttons.left.left, this.#theme.idle, s.DX < 0 ? 1 : 0);
        drawButton(model.buttons.left.right, this.#theme.idle, s.DX > 0 ? 1 : 0);
        drawButton(model.buttons.left.up, this.#theme.idle, s.DY < 0 ? 1 : 0);
        drawButton(model.buttons.left.down, this.#theme.idle, s.DY > 0 ? 1 : 0);
        drawButton(model.buttons.left.origin, this.#theme.idle, 0);
        drawButton(model.buttons.right.up, this.#theme.rightFace.up, s.Y, this.#theme.rightFacePressed.up);
        drawButton(model.buttons.right.right, this.#theme.rightFace.right, s.B, this.#theme.rightFacePressed.right);
        drawButton(model.buttons.right.left, this.#theme.rightFace.left, s.X, this.#theme.rightFacePressed.left);
        drawButton(model.buttons.right.down, this.#theme.rightFace.down, s.A, this.#theme.rightFacePressed.down);
        drawButton(model.buttons.left.analogArea, this.#theme.black, 0);
        drawButton(model.buttons.right.analogArea, this.#theme.black, 0);
        const leftOffset = clampNormalizedOffsetToEllipse({offset: {x: s.LX, y: s.LY}, halfSize: model.leftLayout.origin.halfSize});
        const rightOffset = clampNormalizedOffsetToEllipse({offset: {x: s.RX, y: s.RY}, halfSize: model.rightLayout.origin.halfSize});
        const leftStick = model.buttons.left.analogStick.region.clone().update({topLeft: model.buttons.left.analogStick.region.topLeft.clone().add(leftOffset)});
        const rightStick = model.buttons.right.analogStick.region.clone().update({topLeft: model.buttons.right.analogStick.region.topLeft.clone().add(rightOffset)});
        const leftStickRing = model.buttons.left.analogStickRing.region.clone().update({topLeft: model.buttons.left.analogStickRing.region.topLeft.clone().add(leftOffset)});
        const rightStickRing = model.buttons.right.analogStickRing.region.clone().update({topLeft: model.buttons.right.analogStickRing.region.topLeft.clone().add(rightOffset)});

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.#program);
        gl.uniform2f(this.#uResolution, this.#canvas.width, this.#canvas.height);

        const uploadStart = performance.now();
        this.#vertexData = this.#ensureFloatCapacity(this.#vertexData, vertices.length);
        this.#colorData = this.#ensureFloatCapacity(this.#colorData, colors.length);
        this.#copyToFloatArray(vertices, this.#vertexData);
        this.#copyToFloatArray(colors, this.#colorData);
        this.#dynamicVertexCount = vertices.length / 2;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#dynamicPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#vertexData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#vertexData.subarray(0, vertices.length));

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#dynamicColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#colorData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#colorData.subarray(0, colors.length));

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#staticPosBuffer);
        gl.enableVertexAttribArray(this.#aPos);
        gl.vertexAttribPointer(this.#aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#staticColorBuffer);
        gl.enableVertexAttribArray(this.#aColor);
        gl.vertexAttribPointer(this.#aColor, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, this.#staticVertexCount);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#dynamicPosBuffer);
        gl.vertexAttribPointer(this.#aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#dynamicColorBuffer);
        gl.vertexAttribPointer(this.#aColor, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, this.#dynamicVertexCount);

        const stickVerts = this.#stickVerts;
        const stickCols = this.#stickColors;
        stickVerts.length = 0;
        stickCols.length = 0;
        const pushStick = (region, color) => {
            const seg = 36;
            const lut = getCircleLut(seg);
            for (let i = 0; i < seg; i += 1) {
                const p0 = lut[i];
                const p1 = lut[(i + 1) % seg];
                stickVerts.push(
                    region.center.x, region.center.y,
                    region.center.x + p0[0] * region.halfSize.x, region.center.y + p0[1] * region.halfSize.y,
                    region.center.x + p1[0] * region.halfSize.x, region.center.y + p1[1] * region.halfSize.y
                );
                for (let j = 0; j < 3; j += 1) {
                    stickCols.push(color[0], color[1], color[2], color[3]);
                }
            }
        };
        const borderPx = Math.max(2.5, this.#model.borderWidth);
        const leftStickFill = mix(this.#theme.idle, s.LS);
        const rightStickFill = mix(this.#theme.idle, s.RS);
        const drawStickRing = (ringRegion, stickFill) => {
            const whiteOuter = expandRegion(ringRegion, borderPx);
            const whiteInner = insetRegion(whiteOuter, borderPx * 0.5);
            const blackOuter = whiteInner;
            const blackInner = insetRegion(blackOuter, borderPx * 0.5);

            pushStick(whiteOuter, this.#theme.borderOuter);
            pushStick(whiteInner, stickFill);
            pushStick(blackOuter, this.#theme.borderInner);
            pushStick(blackInner, stickFill);
        };

        pushStick(expandRegion(leftStick, borderPx), this.#theme.borderOuter);
        pushStick(expandRegion(leftStick, borderPx * 0.5), this.#theme.borderInner);
        pushStick(leftStick, leftStickFill);
        drawStickRing(leftStickRing, leftStickFill);

        pushStick(expandRegion(rightStick, borderPx), this.#theme.borderOuter);
        pushStick(expandRegion(rightStick, borderPx * 0.5), this.#theme.borderInner);
        pushStick(rightStick, rightStickFill);
        drawStickRing(rightStickRing, rightStickFill);
        this.#stickVertexData = this.#ensureFloatCapacity(this.#stickVertexData, stickVerts.length);
        this.#stickColorData = this.#ensureFloatCapacity(this.#stickColorData, stickCols.length);
        this.#copyToFloatArray(stickVerts, this.#stickVertexData);
        this.#copyToFloatArray(stickCols, this.#stickColorData);
        this.#stickVertexCount = stickVerts.length / 2;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#stickPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#stickVertexData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#stickVertexData.subarray(0, stickVerts.length));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#stickColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.#stickColorData.length * 4, gl.DYNAMIC_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#stickColorData.subarray(0, stickCols.length));

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#stickPosBuffer);
        gl.vertexAttribPointer(this.#aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#stickColorBuffer);
        gl.vertexAttribPointer(this.#aColor, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, this.#stickVertexCount);

        const drawEnd = performance.now();
        this.#perf.frames += 1;
        this.#perf.buildMs += (uploadStart - buildStart);
        this.#perf.uploadMs += (drawEnd - uploadStart);
        this.#perf.drawMs += 0;
        if (this.#debugPerf && drawEnd - this.#perf.t0 >= 1000) {
            const sec = (drawEnd - this.#perf.t0) / 1000;
            console.log(`[webgl perf] fps=${(this.#perf.frames / sec).toFixed(1)} dynVerts=${this.#dynamicVertexCount} stickVerts=${this.#stickVertexCount} build=${(this.#perf.buildMs / this.#perf.frames).toFixed(3)}ms upload+draw=${(this.#perf.uploadMs / this.#perf.frames).toFixed(3)}ms`);
            this.#perf = {t0: drawEnd, frames: 0, buildMs: 0, uploadMs: 0, drawMs: 0};
        }
    }
}
