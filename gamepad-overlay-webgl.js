class WebGLGamepadOverlayRenderer {
    #canvas;
    #gl;
    #model;
    #theme;
    #program;
    #posBuffer;
    #colorBuffer;
    #aPos;
    #aColor;
    #uResolution;
    #uColor;

    constructor({canvas, model}) {
        this.#canvas = canvas;
        this.#model = model;
        this.#gl = canvas.getContext("webgl", {alpha: true, antialias: true, preserveDrawingBuffer: false, stencil: true});
        if (!this.#gl) {
            throw new Error("WebGL unavailable in this browser");
        }
        this.#theme = this.#buildTheme();
        this.#initProgram();
        this.resize();
    }

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
        this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
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
    }

    draw() {
        const gl = this.#gl;
        const model = this.#model;
        const s = model.state;
        const vertices = [];
        const colors = [];

        const pushTri = (a, b, c, color) => {
            vertices.push(a.x, a.y, b.x, b.y, c.x, c.y);
            for (let i = 0; i < 3; i += 1) {
                colors.push(color[0], color[1], color[2], color[3]);
            }
        };
        const pushPoly = (points, color) => {
            for (let i = 1; i < points.length - 1; i += 1) {
                pushTri(points[0], points[i], points[i + 1], color);
            }
        };
        const pushEllipse = (region, color, segments = 36) => {
            const c = region.center;
            for (let i = 0; i < segments; i += 1) {
                const a0 = (i / segments) * Math.PI * 2;
                const a1 = ((i + 1) / segments) * Math.PI * 2;
                pushTri(
                    c,
                    new Vector2({x: c.x + Math.cos(a0) * region.halfSize.x, y: c.y + Math.sin(a0) * region.halfSize.y}),
                    new Vector2({x: c.x + Math.cos(a1) * region.halfSize.x, y: c.y + Math.sin(a1) * region.halfSize.y}),
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
        const mix = (base, amt) => {
            const p = Math.max(0, Math.min(1, amt));
            return [
                base[0] + (this.#theme.pressed[0] - base[0]) * p,
                base[1] + (this.#theme.pressed[1] - base[1]) * p,
                base[2] + (this.#theme.pressed[2] - base[2]) * p,
                base[3] + (this.#theme.pressed[3] - base[3]) * p,
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

        const drawButton = (button, base, amt) => {
            if (!button) {
                return;
            }
            const color = mix(base, amt);
            const borderPx = Math.max(2.5, this.#model.borderWidth);

            const drawShape = (shape, region, fillColor) => {
                if (shape === "ellipse") {
                    pushEllipse(region, fillColor);
                } else if (shape === "triDown") {
                    pushPoly([region.bottomCenter, region.topLeft, region.topRight], fillColor);
                } else {
                    pushRoundedRect(region, borderPx * 0.9, fillColor);
                }
            };

            if (button.shape === "triDown") {
                pushPoly(scaleTri(triDownPoints(button.region), 1.18), this.#theme.borderOuter);
                pushPoly(scaleTri(triDownPoints(button.region), 1.09), this.#theme.borderInner);
                pushPoly(triDownPoints(button.region), base);
            } else {
                drawShape(button.shape, expandRegion(button.region, borderPx), this.#theme.borderOuter);
                drawShape(button.shape, expandRegion(button.region, borderPx * 0.5), this.#theme.borderInner);
                drawShape(button.shape, button.region, color);
            }

            if (button.shape === "ellipse") {
                // already drawn via layered fill
            } else if (button.shape === "triDown") {
                if (button.pressMode === "analog" && amt > 0) {
                    const fillTri = triDownPoints(button.region);
                    const fillRegion = new Region({
                        topLeft: new Vector2({
                            x: Math.min(fillTri[0].x, fillTri[1].x, fillTri[2].x),
                            y: Math.min(fillTri[0].y, fillTri[1].y, fillTri[2].y),
                        }),
                        size: new Vector2({
                            x: Math.max(fillTri[0].x, fillTri[1].x, fillTri[2].x) - Math.min(fillTri[0].x, fillTri[1].x, fillTri[2].x),
                            y: Math.max(fillTri[0].y, fillTri[1].y, fillTri[2].y) - Math.min(fillTri[0].y, fillTri[1].y, fillTri[2].y),
                        }),
                    });
                    pushPoly(triFillSlice(fillRegion, amt), this.#theme.pressed);
                }
            }
        };

        pushPoly(model.leftLayout.crossPoints, this.#theme.borderOuter);
        const insetCross = (layout) => layout.crossPoints.map((p) => {
            const c = layout.origin.center;
            const dx = p.x - c.x;
            const dy = p.y - c.y;
            return new Vector2({x: c.x + dx * 0.965, y: c.y + dy * 0.965});
        });
        pushPoly(insetCross(model.leftLayout), this.#theme.borderInner);

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
        drawButton(model.buttons.right.up, this.#theme.rightFace.up, s.Y);
        drawButton(model.buttons.right.right, this.#theme.rightFace.right, s.B);
        drawButton(model.buttons.right.left, this.#theme.rightFace.left, s.X);
        drawButton(model.buttons.right.down, this.#theme.rightFace.down, s.A);
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

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.#aPos);
        gl.vertexAttribPointer(this.#aPos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.#colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.#aColor);
        gl.vertexAttribPointer(this.#aColor, 4, gl.FLOAT, false, 0, 0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);

        const stickVerts = [];
        const stickCols = [];
        const pushStick = (region, color) => {
            const seg = 36;
            for (let i = 0; i < seg; i += 1) {
                const a0 = (i / seg) * Math.PI * 2;
                const a1 = ((i + 1) / seg) * Math.PI * 2;
                stickVerts.push(
                    region.center.x, region.center.y,
                    region.center.x + Math.cos(a0) * region.halfSize.x, region.center.y + Math.sin(a0) * region.halfSize.y,
                    region.center.x + Math.cos(a1) * region.halfSize.x, region.center.y + Math.sin(a1) * region.halfSize.y
                );
                for (let j = 0; j < 3; j += 1) {
                    stickCols.push(color[0], color[1], color[2], color[3]);
                }
            }
        };
        const borderPx = Math.max(2.5, this.#model.borderWidth);
        const leftStickFill = mix(this.#theme.idle, s.LS);
        const rightStickFill = mix(this.#theme.idle, s.RS);

        pushStick(expandRegion(leftStick, borderPx), this.#theme.borderOuter);
        pushStick(expandRegion(leftStick, borderPx * 0.5), this.#theme.borderInner);
        pushStick(leftStick, leftStickFill);
        pushStick(leftStickRing, this.#theme.borderOuter);
        pushStick(insetRegion(leftStickRing, borderPx * 0.5), this.#theme.borderInner);
        pushStick(insetRegion(leftStickRing, borderPx * 0.55), leftStickFill);

        pushStick(expandRegion(rightStick, borderPx), this.#theme.borderOuter);
        pushStick(expandRegion(rightStick, borderPx * 0.5), this.#theme.borderInner);
        pushStick(rightStick, rightStickFill);
        pushStick(rightStickRing, this.#theme.borderOuter);
        pushStick(insetRegion(rightStickRing, borderPx * 0.5), this.#theme.borderInner);
        pushStick(insetRegion(rightStickRing, borderPx * 0.55), rightStickFill);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(stickVerts), gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(this.#aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.#colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(stickCols), gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(this.#aColor, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, stickVerts.length / 2);
    }
}
