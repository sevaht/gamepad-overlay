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
        this.#state = {t0: performance.now(), frames: 0, buildMs: 0, uploadMs: 0};
    }
    addFrame({buildMs, uploadMs, dynamicVertices, stickVertices}) {
        this.#state.frames += 1;
        this.#state.buildMs += buildMs;
        this.#state.uploadMs += uploadMs;
        const now = performance.now();
        if (this.#enabled && now - this.#state.t0 >= 1000) {
            const sec = (now - this.#state.t0) / 1000;
            console.log(`[webgl perf] fps=${(this.#state.frames / sec).toFixed(1)} dynVerts=${dynamicVertices} stickVerts=${stickVertices} build=${(this.#state.buildMs / this.#state.frames).toFixed(3)}ms upload+draw=${(this.#state.uploadMs / this.#state.frames).toFixed(3)}ms`);
            this.#state = {t0: now, frames: 0, buildMs: 0, uploadMs: 0};
        }
    }
}

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

    #getCircleLut(segments) {
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
    }

    #pushTri(vertices, colors, ax, ay, bx, by, cx, cy, color) {
        vertices.push(ax, ay, bx, by, cx, cy);
        for (let i = 0; i < 3; i += 1) {
            colors.push(color[0], color[1], color[2], color[3]);
        }
    }

    #pushPoly(vertices, colors, points, color) {
        for (let i = 1; i < points.length - 1; i += 1) {
            const a = points[0];
            const b = points[i];
            const c = points[i + 1];
            this.#pushTri(vertices, colors, a.x, a.y, b.x, b.y, c.x, c.y, color);
        }
    }

    #pushEllipse(vertices, colors, region, color, segments = 36) {
        const c = region.center;
        const lut = this.#getCircleLut(segments);
        for (let i = 0; i < segments; i += 1) {
            const p0 = lut[i];
            const p1 = lut[(i + 1) % segments];
            this.#pushTri(
                vertices,
                colors,
                c.x,
                c.y,
                c.x + p0[0] * region.halfSize.x,
                c.y + p0[1] * region.halfSize.y,
                c.x + p1[0] * region.halfSize.x,
                c.y + p1[1] * region.halfSize.y,
                color,
            );
        }
    }

    #pushRoundedRect(vertices, colors, region, radius, color, segments = 6) {
        const r = Math.max(0, Math.min(radius, region.halfSize.x, region.halfSize.y));
        if (r < 0.01) {
            this.#pushPoly(vertices, colors, [region.topLeft, region.topRight, region.bottomRight, region.bottomLeft], color);
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
        this.#pushPoly(vertices, colors, pts, color);
    }

    #roundedRectLoop(region, radius, segments = 6) {
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
    }

    #pushRing(vertices, colors, outer, inner, color) {
        const n = Math.min(outer.length, inner.length);
        for (let i = 0; i < n; i += 1) {
            const j = (i + 1) % n;
            this.#pushPoly(vertices, colors, [outer[i], outer[j], inner[j], inner[i]], color);
        }
    }

    #drawTriangleStroke(vertices, colors, points, strokeColor, strokeWidth) {
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
            this.#pushPoly(vertices, colors, [a, b, c, d], strokeColor);
        }
        this.#pushEllipse(vertices, colors, Region.fromCenter({center: points[0], size: Vector2.splat(strokeWidth)}), strokeColor, 28);
        this.#pushEllipse(vertices, colors, Region.fromCenter({center: points[1], size: Vector2.splat(strokeWidth)}), strokeColor, 28);
        this.#pushEllipse(vertices, colors, Region.fromCenter({center: points[2], size: Vector2.splat(strokeWidth)}), strokeColor, 28);
    }

    #mix(base, amt, pressedOverride = null) {
        const p = Math.max(0, Math.min(1, amt));
        const pressed = pressedOverride ?? this.#theme.pressed;
        return [
            base[0] + (pressed[0] - base[0]) * p,
            base[1] + (pressed[1] - base[1]) * p,
            base[2] + (pressed[2] - base[2]) * p,
            base[3] + (pressed[3] - base[3]) * p,
        ];
    }

    #expandRegion(region, amount) {
        return Region.fromCenter({
            center: region.center,
            size: new Vector2({x: region.size.x + amount * 2, y: region.size.y + amount * 2}),
        });
    }

    #insetRegion(region, inset) {
        const w = Math.max(2, region.size.x - inset * 2);
        const h = Math.max(2, region.size.y - inset * 2);
        return Region.fromCenter({center: region.center, size: new Vector2({x: w, y: h})});
    }

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
        this.#staticVertices = [];
        this.#staticColors = [];
        this.#staticVertexCount = 0;
        this.#perf = new PerfTracker(!!debugPerf);
        this.#initProgram();
        this.resize();
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
        this.#staticStream.upload(vertices, colors);
        this.#staticVertexCount = vertices.length / 2;
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
        this.#dynamicStream = new WebglBufferStream(gl);
        this.#stickStream = new WebglBufferStream(gl);
        this.#staticStream = new WebglBufferStream(gl);
    }

    #buildDynamicButtons(state) {
        const model = this.#model;
        const vertices = this.#vertices;
        const colors = this.#colors;
        vertices.length = 0;
        colors.length = 0;
        // Keep existing behavior by delegating to previous draw-time logic inline replacement
        // through local composition kept minimal for refactor safety.
        const drawButton = (button, base, amt, pressedOverride = null) => {
            if (!button) { return; }
            const color = this.#mix(base, amt, pressedOverride);
            const borderPx = Math.max(2.5, this.#model.borderWidth);
            const drawShape = (shape, region, fillColor, cornerRadiusPercent = 0) => {
                if (shape === "ellipse") {
                    this.#pushEllipse(vertices, colors, region, fillColor);
                } else if (shape === "triDown") {
                    this.#pushPoly(vertices, colors, [region.bottomCenter, region.topLeft, region.topRight], fillColor);
                } else {
                    const radius = Math.max(0, Math.min(region.halfSize.x, region.halfSize.y) * cornerRadiusPercent);
                    this.#pushRoundedRect(vertices, colors, region, radius, fillColor);
                }
            };
            if (button.shape === "triDown") {
                const tri = [button.region.bottomCenter, button.region.topLeft, button.region.topRight];
                this.#drawTriangleStroke(vertices, colors, tri, this.#theme.borderOuter, borderPx * 2);
                this.#drawTriangleStroke(vertices, colors, tri, this.#theme.borderInner, borderPx);
                drawShape("triDown", button.region, this.#theme.borderInner);
                drawShape("triDown", button.region, base);
                if (button.pressMode === "analog" && amt > 0) {
                    const t = Math.max(0, Math.min(1, amt));
                    const pL = new Vector2({x: tri[1].x + (tri[0].x - tri[1].x) * t, y: tri[1].y + (tri[0].y - tri[1].y) * t});
                    const pR = new Vector2({x: tri[2].x + (tri[0].x - tri[2].x) * t, y: tri[2].y + (tri[0].y - tri[2].y) * t});
                    this.#pushPoly(vertices, colors, [tri[1], tri[2], pR, pL], this.#theme.pressed);
                }
            } else if (button.shape === "rect" && (button.cornerRadiusPercent || 0) > 0) {
                drawShape(button.shape, this.#expandRegion(button.region, borderPx * 0.5), this.#theme.borderInner, button.cornerRadiusPercent);
                drawShape(button.shape, button.region, color, button.cornerRadiusPercent);
                const radius = Math.min(button.region.halfSize.x, button.region.halfSize.y) * button.cornerRadiusPercent;
                const baseLoop = this.#roundedRectLoop(button.region, radius, 8);
                const blackLoop = this.#roundedRectLoop(this.#expandRegion(button.region, borderPx * 0.5), radius + borderPx * 0.5, 8);
                const whiteLoop = this.#roundedRectLoop(this.#expandRegion(button.region, borderPx), radius + borderPx, 8);
                this.#pushRing(vertices, colors, whiteLoop, blackLoop, this.#theme.borderOuter);
                this.#pushRing(vertices, colors, blackLoop, baseLoop, this.#theme.borderInner);
            } else {
                drawShape(button.shape, this.#expandRegion(button.region, borderPx), this.#theme.borderOuter, button.cornerRadiusPercent);
                drawShape(button.shape, this.#expandRegion(button.region, borderPx * 0.5), this.#theme.borderInner, button.cornerRadiusPercent);
                drawShape(button.shape, button.region, color, button.cornerRadiusPercent);
            }
        };

        drawButton(model.buttons.left.leftBumper, this.#theme.idle, state.LB);
        drawButton(model.buttons.left.select, this.#theme.idle, state.SELECT);
        drawButton(model.buttons.left.leftTrigger, this.#theme.idle, state.LT);
        drawButton(model.buttons.right.start, this.#theme.idle, state.START);
        drawButton(model.buttons.right.rightBumper, this.#theme.idle, state.RB);
        drawButton(model.buttons.right.rightTrigger, this.#theme.idle, state.RT);
        drawButton(model.buttons.left.left, this.#theme.idle, state.DX < 0 ? 1 : 0);
        drawButton(model.buttons.left.right, this.#theme.idle, state.DX > 0 ? 1 : 0);
        drawButton(model.buttons.left.up, this.#theme.idle, state.DY < 0 ? 1 : 0);
        drawButton(model.buttons.left.down, this.#theme.idle, state.DY > 0 ? 1 : 0);
        drawButton(model.buttons.left.origin, this.#theme.idle, 0);
        drawButton(model.buttons.right.up, this.#theme.rightFace.up, state.Y, this.#theme.rightFacePressed.up);
        drawButton(model.buttons.right.right, this.#theme.rightFace.right, state.B, this.#theme.rightFacePressed.right);
        drawButton(model.buttons.right.left, this.#theme.rightFace.left, state.X, this.#theme.rightFacePressed.left);
        drawButton(model.buttons.right.down, this.#theme.rightFace.down, state.A, this.#theme.rightFacePressed.down);
        drawButton(model.buttons.left.analogArea, this.#theme.black, 0);
        drawButton(model.buttons.right.analogArea, this.#theme.black, 0);
    }

    #buildSticks(state) {
        const model = this.#model;
        const stickVerts = this.#stickVerts;
        const stickCols = this.#stickColors;
        stickVerts.length = 0;
        stickCols.length = 0;
        const pushStick = (region, color) => {
            const lut = this.#getCircleLut(36);
            for (let i = 0; i < 36; i += 1) {
                const p0 = lut[i];
                const p1 = lut[(i + 1) % 36];
                stickVerts.push(region.center.x, region.center.y, region.center.x + p0[0] * region.halfSize.x, region.center.y + p0[1] * region.halfSize.y, region.center.x + p1[0] * region.halfSize.x, region.center.y + p1[1] * region.halfSize.y);
                for (let j = 0; j < 3; j += 1) {
                    stickCols.push(color[0], color[1], color[2], color[3]);
                }
            }
        };
        const borderPx = Math.max(2.5, this.#model.borderWidth);
        const leftOffset = clampNormalizedOffsetToEllipse({offset: {x: state.LX, y: state.LY}, halfSize: model.leftLayout.origin.halfSize});
        const rightOffset = clampNormalizedOffsetToEllipse({offset: {x: state.RX, y: state.RY}, halfSize: model.rightLayout.origin.halfSize});
        const leftStick = model.buttons.left.analogStick.region.clone().update({topLeft: model.buttons.left.analogStick.region.topLeft.clone().add(leftOffset)});
        const rightStick = model.buttons.right.analogStick.region.clone().update({topLeft: model.buttons.right.analogStick.region.topLeft.clone().add(rightOffset)});
        const leftStickRing = model.buttons.left.analogStickRing.region.clone().update({topLeft: model.buttons.left.analogStickRing.region.topLeft.clone().add(leftOffset)});
        const rightStickRing = model.buttons.right.analogStickRing.region.clone().update({topLeft: model.buttons.right.analogStickRing.region.topLeft.clone().add(rightOffset)});
        const leftFill = this.#mix(this.#theme.idle, state.LS);
        const rightFill = this.#mix(this.#theme.idle, state.RS);
        const drawRing = (ring, fill) => {
            const whiteOuter = this.#expandRegion(ring, borderPx);
            const whiteInner = this.#insetRegion(whiteOuter, borderPx * 0.5);
            const blackOuter = whiteInner;
            const blackInner = this.#insetRegion(blackOuter, borderPx * 0.5);
            pushStick(whiteOuter, this.#theme.borderOuter);
            pushStick(whiteInner, fill);
            pushStick(blackOuter, this.#theme.borderInner);
            pushStick(blackInner, fill);
        };
        pushStick(this.#expandRegion(leftStick, borderPx), this.#theme.borderOuter);
        pushStick(this.#expandRegion(leftStick, borderPx * 0.5), this.#theme.borderInner);
        pushStick(leftStick, leftFill);
        drawRing(leftStickRing, leftFill);
        pushStick(this.#expandRegion(rightStick, borderPx), this.#theme.borderOuter);
        pushStick(this.#expandRegion(rightStick, borderPx * 0.5), this.#theme.borderInner);
        pushStick(rightStick, rightFill);
        drawRing(rightStickRing, rightFill);
    }

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
        const buildStart = performance.now();
        this.#buildDynamicButtons(this.#model.state);
        const uploadStart = performance.now();
        this.#dynamicStream.upload(this.#vertices, this.#colors);
        this.#buildSticks(this.#model.state);
        this.#stickStream.upload(this.#stickVerts, this.#stickColors);
        this.#renderStreams();
        const drawEnd = performance.now();
        this.#perf.addFrame({
            buildMs: (uploadStart - buildStart),
            uploadMs: (drawEnd - uploadStart),
            dynamicVertices: this.#dynamicStream.vertexCount,
            stickVertices: this.#stickStream.vertexCount,
        });
    }
}
