const RasterCore = OverlayCore;

function parseCssRgbTriplet(value, fallback) {
    const parts = String(value || "").split(",").map((p) => Number.parseFloat(p.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        return fallback.slice();
    }
    return parts.map((n) => Math.max(0, Math.min(255, n)));
}

function colorToCss(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
}

function mixColor(a, b, t) {
    const p = Math.max(0, Math.min(1, t));
    return [
        a[0] + (b[0] - a[0]) * p,
        a[1] + (b[1] - a[1]) * p,
        a[2] + (b[2] - a[2]) * p,
        a[3] + (b[3] - a[3]) * p,
    ];
}

function createRasterOverlayModel({buttonLength = 132, buttonWidth = 132, borderWidth = 8, gap = 1, betweenHalvesGap = 0}) {
    const topLeft = new RasterCore.Vector2({x: 0, y: 0});
    const gapPixels = gap * borderWidth;
    const betweenHalvesGapPixels = betweenHalvesGap * borderWidth;
    const leftTopLeft = topLeft.clone().add(RasterCore.Vector2.splat(borderWidth));
    const leftLayout = new RasterCore.DpadLayout({buttonLength, buttonWidth, topLeft: leftTopLeft});
    const rightLayout = new RasterCore.DpadLayout({
        buttonLength,
        buttonWidth,
        topLeft: leftTopLeft.clone().add(new RasterCore.Vector2({
            x: leftLayout.size.x + borderWidth * 2 + gapPixels + betweenHalvesGapPixels,
            y: 0,
        })),
    });

    const width = rightLayout.topRight.bottomRight.x - topLeft.x + borderWidth;
    const height = leftLayout.bottomLeft.bottomRight.y - topLeft.y + borderWidth;

    const half = (r, sx, sy) => RasterCore.Region.fromCenter({center: r.center, size: new RasterCore.Vector2({x: r.size.x * sx, y: r.size.y * sy})});
    const cornerCompensation = gapPixels + borderWidth * 2;
    const applyCornerCompensation = (region, regionName, compensation, compensateOuterEdges = true) => {
        const x = Math.max(0, compensation.x);
        const y = Math.max(0, compensation.y);
        const insets = {top: 0, right: 0, bottom: 0, left: 0};
        switch (regionName) {
            case "topLeft":
                insets.right += x;
                insets.bottom += y;
                if (compensateOuterEdges) { insets.left += x; insets.top += y; }
                break;
            case "topRight":
                insets.left += x;
                insets.bottom += y;
                if (compensateOuterEdges) { insets.right += x; insets.top += y; }
                break;
            case "bottomLeft":
                insets.right += x;
                insets.top += y;
                if (compensateOuterEdges) { insets.left += x; insets.bottom += y; }
                break;
            case "bottomRight":
                insets.left += x;
                insets.top += y;
                if (compensateOuterEdges) { insets.right += x; insets.bottom += y; }
                break;
            default:
                break;
        }
        return new RasterCore.Region({
            topLeft: region.topLeft.clone().add({x: insets.left, y: insets.top}),
            size: new RasterCore.Vector2({
                x: Math.max(0, region.size.x - insets.left - insets.right),
                y: Math.max(0, region.size.y - insets.top - insets.bottom),
            }),
        });
    };
    const cornerButtonRegion = (layout, regionName, sx, sy) => {
        const compensated = applyCornerCompensation(
            layout[regionName],
            regionName,
            RasterCore.Vector2.splat(cornerCompensation),
            true
        );
        return half(compensated, sx, sy);
    };

    const buttons = {
        left: {
            up: {region: leftLayout.up, shape: "rect", pressMode: "digital", cornerRadiusPercent: 0},
            right: {region: leftLayout.right, shape: "rect", pressMode: "digital", cornerRadiusPercent: 0},
            down: {region: leftLayout.down, shape: "rect", pressMode: "digital", cornerRadiusPercent: 0},
            left: {region: leftLayout.left, shape: "rect", pressMode: "digital", cornerRadiusPercent: 0},
            origin: {region: leftLayout.origin, shape: "rect", pressMode: "digital", cornerRadiusPercent: 0},
            leftBumper: {region: cornerButtonRegion(leftLayout, "topLeft", 0.9, 0.6), shape: "rect", pressMode: "digital", cornerRadiusPercent: 0.25},
            select: {region: cornerButtonRegion(leftLayout, "topRight", 0.7, 0.7), shape: "ellipse", pressMode: "digital"},
            leftTrigger: {region: cornerButtonRegion(leftLayout, "bottomLeft", 1.0, 1.0), shape: "triDown", pressMode: "analog"},
            analogArea: {region: RasterCore.Region.fromCenter({center: leftLayout.analogRegion.center, size: leftLayout.analogRegion.size.clone()}), shape: "ellipse", pressMode: "none"},
            analogStick: {
                region: RasterCore.Region.fromCenter({
                    center: leftLayout.analogRegion.center,
                    size: leftLayout.analogRegion.size.clone().multiply(RasterCore.Vector2.splat(0.65)),
                }),
                shape: "ellipse",
                pressMode: "digital",
            },
            analogStickRing: {
                region: RasterCore.Region.fromCenter({
                    center: leftLayout.analogRegion.center,
                    size: leftLayout.analogRegion.size.clone().multiply(RasterCore.Vector2.splat(0.65 * 0.75)),
                }),
                shape: "ellipse",
                pressMode: "none",
            },
        },
        right: {
            up: {region: rightLayout.up, shape: "ellipse", pressMode: "digital"},
            right: {region: rightLayout.right, shape: "ellipse", pressMode: "digital"},
            down: {region: rightLayout.down, shape: "ellipse", pressMode: "digital"},
            left: {region: rightLayout.left, shape: "ellipse", pressMode: "digital"},
            origin: null,
            start: {region: cornerButtonRegion(rightLayout, "topLeft", 0.7, 0.7), shape: "ellipse", pressMode: "digital"},
            rightBumper: {region: cornerButtonRegion(rightLayout, "topRight", 0.9, 0.6), shape: "rect", pressMode: "digital", cornerRadiusPercent: 0.25},
            rightTrigger: {region: cornerButtonRegion(rightLayout, "bottomRight", 1.0, 1.0), shape: "triDown", pressMode: "analog"},
            analogArea: {region: RasterCore.Region.fromCenter({center: rightLayout.analogRegion.center, size: rightLayout.analogRegion.size.clone()}), shape: "ellipse", pressMode: "none"},
            analogStick: {
                region: RasterCore.Region.fromCenter({
                    center: rightLayout.analogRegion.center,
                    size: rightLayout.analogRegion.size.clone().multiply(RasterCore.Vector2.splat(0.65)),
                }),
                shape: "ellipse",
                pressMode: "digital",
            },
            analogStickRing: {
                region: RasterCore.Region.fromCenter({
                    center: rightLayout.analogRegion.center,
                    size: rightLayout.analogRegion.size.clone().multiply(RasterCore.Vector2.splat(0.65 * 0.75)),
                }),
                shape: "ellipse",
                pressMode: "none",
            },
        },
    };

    const state = {
        A: 0, B: 0, X: 0, Y: 0, SELECT: 0, START: 0, LB: 0, RB: 0, LS: 0, RS: 0,
        LX: 0, LY: 0, RX: 0, RY: 0, LT: 0, RT: 0, DX: 0, DY: 0,
    };

    return {
        borderWidth,
        leftLayout,
        rightLayout,
        width,
        height,
        buttons,
        state,
    };
}

function applyGamepadStateToModel(model, partialState) {
    const s = normalizeGamepadState(partialState, {deadzoneMode: "none", fixedDeadzone: 0.0});
    Object.assign(model.state, s);
}
