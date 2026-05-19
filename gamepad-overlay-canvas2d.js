class Canvas2DGamepadOverlayRenderer {
    #canvas;
    #ctx;
    #model;
    #theme;

    constructor({canvas, model}) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext("2d", {alpha: true, desynchronized: true});
        this.#model = model;
        this.#theme = this.#buildTheme();
        this.resize();
    }

    resize() {
        this.#canvas.width = Math.ceil(this.#model.width);
        this.#canvas.height = Math.ceil(this.#model.height);
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
            rightFace: {
                up: [95, 95, 31, idleAlpha],
                right: [95, 31, 31, idleAlpha],
                left: [31, 31, 95, idleAlpha],
                down: [31, 79, 32, idleAlpha],
            },
        };
    }

    draw() {
        const ctx = this.#ctx;
        const model = this.#model;
        const s = model.state;
        ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);

        this.#drawCrossBorder(model.leftLayout.crossPoints);

        this.#drawButton(model.buttons.left.analogArea, this.#theme.black, 0);
        this.#drawButton(model.buttons.right.analogArea, this.#theme.black, 0);

        this.#drawButton(model.buttons.left.leftBumper, this.#theme.idle, s.LB);
        this.#drawButton(model.buttons.left.select, this.#theme.idle, s.SELECT);
        this.#drawButton(model.buttons.left.leftTrigger, this.#theme.idle, s.LT);
        this.#drawButton(model.buttons.right.start, this.#theme.idle, s.START);
        this.#drawButton(model.buttons.right.rightBumper, this.#theme.idle, s.RB);
        this.#drawButton(model.buttons.right.rightTrigger, this.#theme.idle, s.RT);

        this.#drawButton(model.buttons.left.left, this.#theme.idle, s.DX < 0 ? 1 : 0);
        this.#drawButton(model.buttons.left.right, this.#theme.idle, s.DX > 0 ? 1 : 0);
        this.#drawButton(model.buttons.left.up, this.#theme.idle, s.DY < 0 ? 1 : 0);
        this.#drawButton(model.buttons.left.down, this.#theme.idle, s.DY > 0 ? 1 : 0);
        this.#drawButton(model.buttons.left.origin, this.#theme.idle, 0);

        this.#drawButton(model.buttons.right.up, this.#theme.rightFace.up, s.Y);
        this.#drawButton(model.buttons.right.right, this.#theme.rightFace.right, s.B);
        this.#drawButton(model.buttons.right.left, this.#theme.rightFace.left, s.X);
        this.#drawButton(model.buttons.right.down, this.#theme.rightFace.down, s.A);
        if (model.buttons.right.origin) {
            this.#drawButton(model.buttons.right.origin, this.#theme.idle, 0);
        }

        this.#cutoutShape(model.buttons.left.analogArea);
        this.#cutoutShape(model.buttons.right.analogArea);

        const leftOffset = clampNormalizedOffsetToEllipse({offset: {x: s.LX, y: s.LY}, halfSize: model.leftLayout.origin.halfSize});
        const rightOffset = clampNormalizedOffsetToEllipse({offset: {x: s.RX, y: s.RY}, halfSize: model.rightLayout.origin.halfSize});
        const leftStick = model.buttons.left.analogStick.region.clone().update({topLeft: model.buttons.left.analogStick.region.topLeft.clone().add(leftOffset)});
        const rightStick = model.buttons.right.analogStick.region.clone().update({topLeft: model.buttons.right.analogStick.region.topLeft.clone().add(rightOffset)});
        this.#drawButton({region: leftStick, shape: "ellipse"}, this.#theme.idle, s.LS);
        this.#drawButton({region: rightStick, shape: "ellipse"}, this.#theme.idle, s.RS);
    }

    #drawCrossBorder(points) {
        const ctx = this.#ctx;
        const draw = (color, w) => {
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i += 1) {
                ctx.lineTo(points[i].x, points[i].y);
            }
            ctx.closePath();
            ctx.strokeStyle = colorToCss(color);
            ctx.lineWidth = w;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.stroke();
        };
        draw(this.#theme.borderOuter, this.#model.borderWidth * 2);
        draw(this.#theme.borderInner, this.#model.borderWidth);
    }

    #drawButton(button, baseColor, amount) {
        if (!button) {
            return;
        }
        const color = mixColor(baseColor, this.#theme.pressed, amount);
        const region = button.region;
        const ctx = this.#ctx;
        this.#shapePath(button);
        ctx.fillStyle = colorToCss(color);
        ctx.fill();

        if (button.pressMode === "analog" && button.shape === "triDown" && amount > 0) {
            ctx.save();
            this.#shapePath(button);
            ctx.clip();
            ctx.beginPath();
            const h = region.size.y * Math.max(0, Math.min(1, amount));
            ctx.rect(region.topLeft.x, region.topLeft.y, region.size.x, h);
            ctx.fillStyle = colorToCss(this.#theme.pressed);
            ctx.fill();
            ctx.restore();
        }

        this.#strokeButtonBorder(button);
    }

    #shapePath(button) {
        const region = button.region;
        const ctx = this.#ctx;
        ctx.beginPath();
        if (button.shape === "rect") {
            ctx.roundRect(region.topLeft.x, region.topLeft.y, region.size.x, region.size.y, 4);
        } else if (button.shape === "ellipse") {
            ctx.ellipse(region.center.x, region.center.y, region.halfSize.x, region.halfSize.y, 0, 0, Math.PI * 2);
        } else {
            ctx.moveTo(region.bottomCenter.x, region.bottomCenter.y);
            ctx.lineTo(region.topLeft.x, region.topLeft.y);
            ctx.lineTo(region.topRight.x, region.topRight.y);
            ctx.closePath();
        }
    }

    #strokeButtonBorder(button) {
        const ctx = this.#ctx;
        this.#shapePath(button);
        ctx.strokeStyle = colorToCss(this.#theme.borderOuter);
        ctx.lineWidth = this.#model.borderWidth * 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
        this.#shapePath(button);
        ctx.strokeStyle = colorToCss(this.#theme.borderInner);
        ctx.lineWidth = this.#model.borderWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    }

    #cutoutShape(button) {
        const ctx = this.#ctx;
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        this.#shapePath(button);
        ctx.fillStyle = "rgba(0,0,0,1)";
        ctx.fill();
        ctx.restore();
    }
}
